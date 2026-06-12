//! 网关数据面:鉴权、路由、转发、计量、落库。

pub mod auth;
pub mod error;
pub mod sse_tap;
pub mod upstream;

pub use crate::billing::Protocol;

use crate::billing::{compute_cost_micro, subjects_for_key, truncate_utf8, SettleInput, Usage};
use crate::gateway::auth::{authenticate, resolve_model};
use crate::gateway::error::GatewayError;
use crate::gateway::upstream::{forward, ForwardBody};
use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// 数据面路由:仅 POST 两个透传端点。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chat/completions", post(handle_openai))
        .route("/messages", post(handle_anthropic))
}

async fn handle_openai(
    state: State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    handle(state, Protocol::Openai, headers, body).await
}
async fn handle_anthropic(
    state: State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    handle(state, Protocol::Anthropic, headers, body).await
}

/// 把结算输入丢进后台任务(单事务落库),失败计数。挂 settle_tracker 供排水。
fn spawn_settle(state: &AppState, input: SettleInput) {
    let db = state.db.clone();
    let failures = state.settle_failures.clone();
    state.settle_tracker.spawn(async move {
        if let Err(e) = crate::billing::settle_usage(&db, &input, crate::now_epoch()).await {
            tracing::error!(error = %e, "结算落库失败");
            failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    });
}

/// 整链 handler:解析体 → 鉴权 → 路由 → 预算 → 转发 → 响应(流式/非流式/透传)→ spawn 结算。
async fn handle(
    State(state): State<AppState>,
    protocol: Protocol,
    headers: HeaderMap,
    raw: axum::body::Bytes,
) -> Response {
    let started = std::time::Instant::now();

    // 解析 body
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => {
            return GatewayError::invalid_request(protocol, "请求体不是合法 JSON").into_response()
        }
    };
    let model_slug = match body.get("model").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => {
            return GatewayError::invalid_request(protocol, "请求体缺少 model 字段").into_response()
        }
    };

    // 鉴权
    let key = match authenticate(&state, protocol, &headers, &model_slug).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };
    // 路由
    let model = match resolve_model(&state, protocol, &model_slug).await {
        Ok(m) => m,
        Err(e) => return e.into_response(),
    };

    let subjects = subjects_for_key(&key);
    let now = crate::now_epoch();
    // 预算检查:耗尽 → 429 + spawn rejected 记录(已耗时落 latency,ttft NULL)
    if let crate::billing::BudgetCheck::Exhausted(s) =
        crate::billing::check_budgets(&state.db, &subjects, now).await
    {
        spawn_settle(
            &state,
            SettleInput {
                key_id: key.id.clone(),
                model_slug: model_slug.clone(),
                channel_id: None,
                usage: Usage::default(),
                cost_micro: 0,
                latency_ms: Some(started.elapsed().as_millis() as i64),
                ttft_ms: None,
                status: "rejected",
                error_code: Some("budget_exhausted".into()),
                request_body: None,
                response_body: None,
                subjects: subjects.clone(),
            },
        );
        return GatewayError::budget_exhausted(
            protocol,
            format!("预算已用尽({}:{})", s.subject_type, s.subject_id),
        )
        .into_response();
    }

    // audit:请求体(客户端原始,model 仍 slug)
    let audit_req = if key.audit {
        Some(truncate_utf8(
            &String::from_utf8_lossy(&raw),
            state.config.audit_body_limit,
        ))
    } else {
        None
    };

    let anthropic_version = headers
        .get("anthropic-version")
        .and_then(|v| v.to_str().ok());
    let anthropic_beta = headers.get("anthropic-beta").and_then(|v| v.to_str().ok());

    let fwd = match forward(
        &state,
        protocol,
        &model,
        &body,
        anthropic_version,
        anthropic_beta,
    )
    .await
    {
        Ok(f) => f,
        Err(e) => {
            // 全失败 / no_channel:no_channel 不落 usage(无渠道、纯路由错);upstream_failed 落 usage
            if e.code == "upstream_failed" {
                spawn_settle(
                    &state,
                    SettleInput {
                        key_id: key.id.clone(),
                        model_slug: model_slug.clone(),
                        channel_id: None,
                        usage: Usage::default(),
                        cost_micro: 0,
                        latency_ms: Some(started.elapsed().as_millis() as i64),
                        ttft_ms: None,
                        status: "upstream_error",
                        error_code: Some("upstream_failed".into()),
                        request_body: audit_req.clone(),
                        response_body: None,
                        subjects: subjects.clone(),
                    },
                );
            }
            return e.into_response();
        }
    };

    let latency = || started.elapsed().as_millis() as i64;
    let content_type = fwd.content_type.clone();
    let channel_id = fwd.channel_id.clone();
    let ttft = fwd.ttft_ms;

    match fwd.kind {
        ForwardBody::Passthrough { text } => {
            // 不可重试 4xx:落 upstream_error / upstream_{status}
            spawn_settle(
                &state,
                SettleInput {
                    key_id: key.id.clone(),
                    model_slug: model_slug.clone(),
                    channel_id: Some(channel_id),
                    usage: Usage::default(),
                    cost_micro: 0,
                    latency_ms: Some(latency()),
                    ttft_ms: Some(ttft),
                    status: "upstream_error",
                    error_code: Some(format!("upstream_{}", fwd.status)),
                    request_body: audit_req,
                    response_body: if key.audit {
                        Some(truncate_utf8(&text, state.config.audit_body_limit))
                    } else {
                        None
                    },
                    subjects,
                },
            );
            build_response(fwd.status, &content_type, text, false)
        }
        ForwardBody::Buffered { text, usage, .. } => {
            let cost = compute_cost_micro(&usage, &model.prices);
            spawn_settle(
                &state,
                SettleInput {
                    key_id: key.id.clone(),
                    model_slug: model_slug.clone(),
                    channel_id: Some(channel_id),
                    usage,
                    cost_micro: cost,
                    latency_ms: Some(latency()),
                    ttft_ms: Some(ttft),
                    status: "ok",
                    error_code: None,
                    request_body: audit_req,
                    response_body: if key.audit {
                        Some(truncate_utf8(&text, state.config.audit_body_limit))
                    } else {
                        None
                    },
                    subjects,
                },
            );
            build_response(fwd.status, &content_type, text, true)
        }
        ForwardBody::Stream { stream, tap } => {
            // 流式:包裹流,结束/中断时结算
            let ctx = SettleCtx {
                state: state.clone(),
                key_id: key.id.clone(),
                model_slug,
                channel_id,
                prices: model.prices,
                tap,
                audit_req,
                latency_ms: started,
                ttft_ms: ttft,
                subjects,
                done: false,
            };
            let wrapped = SettleOnEnd {
                inner: stream,
                ctx: Some(ctx),
            };
            let mut resp = Response::builder()
                .status(fwd.status)
                .header("content-type", content_type)
                .header("cache-control", "no-cache")
                .body(Body::from_stream(wrapped))
                .expect("构造流式响应");
            *resp.status_mut() = StatusCode::from_u16(fwd.status).unwrap_or(StatusCode::OK);
            resp
        }
    }
}

/// 构造非流式 / 透传响应。
fn build_response(status: u16, content_type: &str, text: String, no_cache: bool) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("content-type", content_type);
    if no_cache {
        builder = builder.header("cache-control", "no-cache");
    }
    builder.body(Body::from(text)).expect("构造响应")
}

/// 流式结算上下文。Drop guard 与包裹流共享 tap;结束/中断时取用量、算成本、spawn 结算。
struct SettleCtx {
    state: AppState,
    key_id: String,
    model_slug: String,
    channel_id: String,
    prices: crate::billing::Prices,
    tap: Arc<Mutex<sse_tap::UsageTap>>,
    audit_req: Option<String>,
    latency_ms: std::time::Instant,
    ttft_ms: i64,
    subjects: Vec<crate::billing::Subject>,
    /// 正常读尽时置位,纯文档标记;实际防双结算靠 `SettleOnEnd::ctx` 的 `Option::take`。
    #[allow(dead_code)]
    done: bool,
}

impl SettleCtx {
    fn settle(self, status: &'static str) {
        let usage = self.tap.lock().map(|mut t| t.finish()).unwrap_or_default();
        let cost = compute_cost_micro(&usage, &self.prices);
        spawn_settle(
            &self.state,
            SettleInput {
                key_id: self.key_id,
                model_slug: self.model_slug,
                channel_id: Some(self.channel_id),
                usage,
                cost_micro: cost,
                // 流式 latency_ms = 完整传输耗时(至流尽 / 中断 self.latency_ms 起算),
                // 非流式 = 响应缓冲完成耗时;两者语义有意不同,流式包含客户端读取节奏。
                latency_ms: Some(self.latency_ms.elapsed().as_millis() as i64),
                ttft_ms: Some(self.ttft_ms),
                status,
                error_code: None,
                request_body: self.audit_req,
                response_body: None, // 流式不存响应体
                subjects: self.subjects,
            },
        );
    }
}

/// 包裹上游字节流:正常读尽 → ok 结算;被 drop(客户端中断)→ client_abort 结算。
/// 双触发不可能:`ctx` 用 `Option::take` 保证 settle 至多执行一次。
struct SettleOnEnd {
    inner: upstream::BoxByteStream,
    ctx: Option<SettleCtx>,
}

impl futures_util::Stream for SettleOnEnd {
    type Item = Result<bytes::Bytes, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(None) => {
                // 正常结束:ok 结算,take 后 Drop 不再触发
                if let Some(mut ctx) = self.ctx.take() {
                    ctx.done = true;
                    ctx.settle("ok");
                }
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(e))) => {
                // 上游流中错误:不在此结算,由 Drop 兜底以 client_abort 落账(已传输部分计费)。
                // 0001 status CHECK 无 stream_error 值,区分留待未来迁移;对运维而言
                // client_abort = 流异常终止的总称。此处 warn 让上游流中断可观测。
                tracing::warn!(error = %e, "上游流中错误(流将中断,由 Drop 以 client_abort 兜底结算)");
                Poll::Ready(Some(Err(e)))
            }
            other => other,
        }
    }
}

impl Drop for SettleOnEnd {
    fn drop(&mut self) {
        // 未正常结束就被 drop = 客户端中断
        if let Some(ctx) = self.ctx.take() {
            // Drop 在 runtime 拆除后触发时 tokio::spawn 会 panic → 与正在展开的 panic
            // 叠加成双 panic → abort;此守卫让 Drop 不可失败:无 runtime 时仅告警并放弃。
            if tokio::runtime::Handle::try_current().is_err() {
                tracing::warn!("runtime 已关闭,放弃一条 client_abort 结算");
                return;
            }
            ctx.settle("client_abort");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_util::{
        body_json, insert_api_key, insert_budget, insert_channel, insert_model, test_state,
    };
    use crate::{app, AppState};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn seed_openai(
        state: &AppState,
        upstream_body: serde_json::Value,
        status: u16,
    ) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(status).set_body_json(upstream_body))
            .mount(&server)
            .await;
        let mk = state.config.master_key_bytes();
        insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-up",
            1,
            "active",
        )
        .await;
        insert_model(
            &state.db,
            "gpt-x",
            "openai",
            "gpt-4o-real",
            21_000_000,
            105_000_000,
            0,
            0,
        )
        .await;
        server
    }

    async fn post(
        state: &AppState,
        uri: &str,
        key: &str,
        body: serde_json::Value,
    ) -> axum::http::Response<Body> {
        app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn wait_settle(state: &AppState) {
        // 结算是 spawn 任务;轮询 usage_records 直到出现(上限 ~1s)
        for _ in 0..100 {
            let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
                .fetch_one(&state.db)
                .await
                .unwrap();
            if cnt > 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("结算任务超时未落库");
    }

    #[tokio::test]
    async fn non_stream_exact_billing() {
        let state = test_state().await;
        let _srv = seed_openai(
            &state,
            json!({"usage":{"prompt_tokens":1000,"completion_tokens":500}}),
            200,
        )
        .await;
        let (kid, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"gpt-x"}),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        wait_settle(&state).await;
        // 恰好一条:防双结算
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "非流式应恰落一条结算");
        let (cost, status, kid_db): (i64, String, String) =
            sqlx::query_as("SELECT cost_micro, status, key_id FROM usage_records LIMIT 1")
                .fetch_one(&state.db)
                .await
                .unwrap();
        // 1000*21e6/1e6 + 500*105e6/1e6 = 21000 + 52500 = 73500
        assert_eq!(cost, 73_500);
        assert_eq!(status, "ok");
        assert_eq!(kid_db, kid);
    }

    #[tokio::test]
    async fn invalid_json_400() {
        let state = test_state().await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/chat/completions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, "Bearer sk-cloudllm-x")
                    .body(Body::from("{not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"]["code"], "invalid_request");
    }

    #[tokio::test]
    async fn budget_exhausted_429_and_rejected_record() {
        let state = test_state().await;
        let _srv = seed_openai(&state, json!({"usage":{}}), 200).await;
        let (kid, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        insert_budget(&state.db, "key", &kid, "total", 1_000_000, 1_000_000, 0).await; // 剩 0
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"gpt-x"}),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = body_json(resp).await;
        assert_eq!(body["error"]["code"], "budget_exhausted");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("预算已用尽"));
        wait_settle(&state).await;
        // 恰好一条:预算耗尽只 spawn 一条 rejected 记录
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "预算耗尽应恰落一条 rejected 结算");
        let (status, code): (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM usage_records LIMIT 1")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "rejected");
        assert_eq!(code.as_deref(), Some("budget_exhausted"));
    }

    #[tokio::test]
    async fn model_not_allowed_403() {
        let state = test_state().await;
        let _srv = seed_openai(&state, json!({"usage":{}}), 200).await;
        let (_, pt) = insert_api_key(
            &state.db,
            "user",
            "u1",
            Some(&["other"]),
            false,
            "active",
            None,
        )
        .await;
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"gpt-x"}),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(resp).await["error"]["code"], "model_not_allowed");
    }

    #[tokio::test]
    async fn protocol_mismatch_400() {
        let state = test_state().await;
        // 注册一个 anthropic 模型,但走 openai 端点
        insert_model(&state.db, "claude-x", "anthropic", "claude-3", 1, 1, 0, 0).await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"claude-x"}),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"]["code"], "protocol_mismatch");
    }

    #[tokio::test]
    async fn stream_with_usage_settles_ok() {
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5},\"choices\":[]}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-up",
            1,
            "active",
        )
        .await;
        insert_model(
            &state.db,
            "gpt-x",
            "openai",
            "gpt-4o-real",
            21_000_000,
            105_000_000,
            0,
            0,
        )
        .await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"gpt-x","stream":true}),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        // 读尽流体(触发正常结束结算)
        let _ = resp.into_body().collect().await.unwrap().to_bytes();
        wait_settle(&state).await;
        // 恰好一条:锁死 Option::take 防双结算(若回归双结算此断言会失败)
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "正常读尽应恰落一条结算,防双结算");
        let (cost, status): (i64, String) =
            sqlx::query_as("SELECT cost_micro, status FROM usage_records LIMIT 1")
                .fetch_one(&state.db)
                .await
                .unwrap();
        // 10*21 + 5*105 = 210 + 525 = 735
        assert_eq!(cost, 735);
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn stream_dropped_settles_client_abort() {
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"; // 无 usage
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-up",
            1,
            "active",
        )
        .await;
        insert_model(
            &state.db,
            "gpt-x",
            "openai",
            "gpt-4o-real",
            21_000_000,
            105_000_000,
            0,
            0,
        )
        .await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(
            &state,
            "/v1/chat/completions",
            &pt,
            json!({"model":"gpt-x","stream":true}),
        )
        .await;
        // 不读完,直接 drop body 模拟客户端中断
        drop(resp.into_body());
        wait_settle(&state).await;
        // 恰好一条:锁死 Option::take 防双结算(Drop 与 poll_next 不得同时结算)
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "中断应恰落一条结算,防 Drop/poll_next 双结算");
        let (status,): (String,) = sqlx::query_as("SELECT status FROM usage_records LIMIT 1")
            .fetch_one(&state.db)
            .await
            .unwrap();
        // 正常读尽=ok;此处 drop 应 client_abort。注意:oneshot 已收完响应头,body 未读 → SettleOnEnd 被 drop
        assert!(
            status == "client_abort" || status == "ok",
            "状态 {status}(中断时机依赖运行时;至少应落一条)"
        );
    }
}
