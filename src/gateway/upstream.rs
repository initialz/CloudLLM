//! 上游转发:渠道选择、加权洗牌、凭证解密、体/头改写、reqwest 发送、可重试判定、
//! 指数退避冷却、故障切换。

use crate::billing::Protocol;
use crate::gateway::auth::ModelInfo;
use crate::gateway::error::GatewayError;
use crate::gateway::sse_tap::UsageTap;
use crate::AppState;
use rand::Rng;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// 一个候选渠道(已从 DB 读出,凭证仍是密文)。
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub base_url: String,
    pub credential_encrypted: Vec<u8>,
    pub weight: i64,
}

/// 转发成功结果。
pub struct ForwardOk {
    pub channel_id: String,
    pub status: u16,
    /// 上游 content-type(原样回传)
    pub content_type: String,
    pub kind: ForwardBody,
    pub ttft_ms: i64,
}

pub enum ForwardBody {
    /// 非流式:完整文本 + 已解析用量 + 响应 JSON(审计用)
    Buffered {
        text: String,
        usage: crate::billing::Usage,
        response_json: Option<Value>,
    },
    /// 流式:字节流(已 tap 包装)+ 共享 tap(handler 在流结束后取 usage)
    Stream {
        stream: BoxByteStream,
        tap: Arc<Mutex<UsageTap>>,
    },
    /// 不可重试 4xx:原样透传上游错误体(零用量)
    Passthrough { text: String },
}

// 手写 Debug:BoxByteStream / UsageTap 不实现 Debug;`forward` 在测试里被 `.unwrap_err()`
// 要求 `Ok` 变体可 Debug,故对流式字段以占位符渲染,其余原样。
impl std::fmt::Debug for ForwardOk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardOk")
            .field("channel_id", &self.channel_id)
            .field("status", &self.status)
            .field("content_type", &self.content_type)
            .field("kind", &self.kind)
            .field("ttft_ms", &self.ttft_ms)
            .finish()
    }
}

impl std::fmt::Debug for ForwardBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForwardBody::Buffered {
                text,
                usage,
                response_json,
            } => f
                .debug_struct("Buffered")
                .field("text", text)
                .field("usage", usage)
                .field("response_json", response_json)
                .finish(),
            ForwardBody::Stream { .. } => f.debug_struct("Stream").finish_non_exhaustive(),
            ForwardBody::Passthrough { text } => {
                f.debug_struct("Passthrough").field("text", text).finish()
            }
        }
    }
}

pub type BoxByteStream = std::pin::Pin<
    Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>,
>;

/// 查该 provider_type 下未禁用的渠道。
/// 返回 (candidate, status, cooldown_until_or_-1, cooldown_level)
pub async fn load_candidates(
    state: &AppState,
    provider_type: Protocol,
) -> Result<Vec<(Candidate, String, i64, i64)>, GatewayError> {
    let pt = match provider_type {
        Protocol::Openai => "openai",
        Protocol::Anthropic => "anthropic",
    };
    // 一次性 DB 行元组,仅在本函数内解构;为其单独命名类型无收益,显式 allow 复杂度。
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, Vec<u8>, i64, String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level \
         FROM channels WHERE provider_type = ? AND status != 'disabled'",
    )
    .bind(pt)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 channels 失败");
        GatewayError::internal(provider_type)
    })?;
    Ok(rows
        .into_iter()
        .map(|(id, base_url, cred, weight, status, cu, level)| {
            (
                Candidate {
                    id,
                    base_url,
                    credential_encrypted: cred,
                    weight,
                },
                status,
                cu.unwrap_or(-1),
                level,
            )
        })
        .collect())
}

/// 加权不放回洗牌。weight<=0 视为 1。
pub fn weighted_shuffle<R: Rng>(mut items: Vec<Candidate>, rng: &mut R) -> Vec<Candidate> {
    let mut result = Vec::with_capacity(items.len());
    while !items.is_empty() {
        // weight<=0 视为 1;total >= items.len() >= 1,保证 gen_range 区间非空
        let total: i64 = items.iter().map(|c| c.weight.max(1)).sum();
        let mut pick = rng.gen_range(0..total);
        let mut idx = items.len() - 1;
        for (i, c) in items.iter().enumerate() {
            pick -= c.weight.max(1);
            if pick < 0 {
                idx = i;
                break;
            }
        }
        result.push(items.remove(idx));
    }
    result
}

/// 可重试判定(状态码维度);网络错误/超时/解密失败由调用点直接当可重试。
fn is_retryable_status(status: u16) -> bool {
    status == 401 || status == 403 || status == 408 || status == 429 || status >= 500
}

/// 冷却一个渠道:指数退避写库。
/// cooldown_until = now + min(base * 2^level, max);level+1;status='cooldown'。
/// 冷却 UPDATE 即时落库(不等结算任务):下一渠道选择与并发请求要立即看到冷却。
pub async fn mark_cooldown(state: &AppState, channel_id: &str, current_level: i64) {
    let base = state.config.cooldown_base_secs;
    let max = state.config.cooldown_max_secs;
    // min(base * 2^level, max);移位防溢出:shift>=63 时 checked_shl 返回 None → i64::MAX,
    // 再 saturating_mul 与 .min(max) 收口,绝不溢出 panic。
    let shift = current_level.clamp(0, 32) as u32;
    let backoff = base
        .saturating_mul(1i64.checked_shl(shift).unwrap_or(i64::MAX))
        .min(max);
    let until = crate::now_epoch() + backoff;
    let new_level = current_level + 1;
    if let Err(e) = sqlx::query(
        "UPDATE channels SET status='cooldown', cooldown_until=?, cooldown_level=? WHERE id=?",
    )
    .bind(until)
    .bind(new_level)
    .bind(channel_id)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, "写冷却状态失败");
    }
}

/// 成功后重置冷却(仅当当前非 active/level>0,避免每请求空写)。
pub async fn reset_cooldown(
    state: &AppState,
    channel_id: &str,
    current_level: i64,
    current_status: &str,
) {
    // 仅当原值非默认才写(避免每个成功请求空写)
    if current_level == 0 && current_status == "active" {
        return;
    }
    if let Err(e) = sqlx::query(
        "UPDATE channels SET status='active', cooldown_until=NULL, cooldown_level=0 WHERE id=?",
    )
    .bind(channel_id)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, "重置冷却状态失败");
    }
}

/// 主入口:对模型选渠道并故障切换转发。
pub async fn forward(
    state: &AppState,
    protocol: Protocol,
    model: &ModelInfo,
    request_body: &Value,
    anthropic_version: Option<&str>,
    anthropic_beta: Option<&str>,
) -> Result<ForwardOk, GatewayError> {
    let all = load_candidates(state, protocol).await?;
    if all.is_empty() {
        // DB 零行 → no_channel(502)
        return Err(GatewayError::no_channel(protocol));
    }
    let now = crate::now_epoch();
    // 过滤冷却中(status='cooldown' AND cooldown_until > now);
    // 保留每渠道的 (level, status) 供成功/透传后重置。
    let mut meta: std::collections::HashMap<String, (i64, String)> =
        std::collections::HashMap::new();
    let usable: Vec<Candidate> = all
        .into_iter()
        .filter_map(|(c, status, cu, level)| {
            let cooling = status == "cooldown" && cu > now;
            meta.insert(c.id.clone(), (level, status));
            if cooling {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    if usable.is_empty() {
        // 有渠道但全在冷却 → upstream_failed(502)
        return Err(GatewayError::upstream_failed(protocol));
    }

    // rng 限定在洗牌块内即时 drop:ThreadRng 持有 Rc(非 Send),若跨下方 await 存活
    // 会让整个 forward future 变成 !Send,从而无法挂进要求 Send 的 axum Handler(T8 暴露)。
    let ordered = {
        let mut rng = rand::thread_rng();
        weighted_shuffle(usable, &mut rng)
    };
    let is_stream = request_body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // 主密钥对所有候选一致,提到循环外一次性解码(避免每渠道重复 base64 解码)。
    // 语义不变:master_key_bytes() 在 validate 后调用,解码失败仍按原路径 panic。
    let mk = state.config.master_key_bytes();

    for channel in ordered {
        let (level, status) = meta
            .get(&channel.id)
            .cloned()
            .unwrap_or((0, "active".into()));

        // 解密凭证:失败按渠道故障处理(可重试),冷却并切下一个;细节只进 tracing。
        let credential = match crate::crypto::decrypt_secret(
            &channel.credential_encrypted,
            &mk,
            &channel.id,
        ) {
            Ok(c) => c,
            Err(_) => {
                tracing::error!(channel_id = %channel.id, "渠道凭证解密失败(疑似主密钥轮换/数据损坏)");
                mark_cooldown(state, &channel.id, level).await;
                continue;
            }
        };

        // 体改写:model → upstream_model;OpenAI 流式注入 stream_options.include_usage=true
        //(保留客户端原有 stream_options 字段)。
        let mut body = request_body.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("model".into(), Value::String(model.upstream_model.clone()));
            if protocol == Protocol::Openai && is_stream {
                let mut so = obj
                    .get("stream_options")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                so.insert("include_usage".into(), Value::Bool(true));
                obj.insert("stream_options".into(), Value::Object(so));
            }
        }

        // URL:base_url 去尾 `/`;OpenAI /chat/completions,Anthropic /messages
        let base = channel.base_url.trim_end_matches('/');
        let url = match protocol {
            Protocol::Openai => format!("{base}/chat/completions"),
            Protocol::Anthropic => format!("{base}/messages"),
        };

        // 头:content-type=json;OpenAI authorization Bearer;Anthropic x-api-key + anthropic-version
        //(默认 2023-06-01)+ anthropic-beta(客户端给才透传)。其余客户端头不透传。
        let mut req = state
            .http
            .post(&url)
            .header("content-type", "application/json");
        match protocol {
            Protocol::Openai => {
                req = req.header("authorization", format!("Bearer {credential}"));
            }
            Protocol::Anthropic => {
                req = req.header("x-api-key", credential).header(
                    "anthropic-version",
                    anthropic_version.unwrap_or("2023-06-01"),
                );
                if let Some(beta) = anthropic_beta {
                    req = req.header("anthropic-beta", beta);
                }
            }
        }
        // 非流式设 per-request 总超时;流式不设(connect_timeout 在 Client 上兜底)。
        if !is_stream {
            req = req.timeout(std::time::Duration::from_secs(
                state.config.upstream_timeout_secs,
            ));
        }

        let started = std::time::Instant::now();
        let resp = match req
            .body(serde_json::to_vec(&body).expect("序列化请求体"))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // 网络错误/超时:可重试,冷却切换。
                tracing::warn!(channel_id = %channel.id, error = %e, "渠道请求失败");
                mark_cooldown(state, &channel.id, level).await;
                continue;
            }
        };

        let status_code = resp.status().as_u16();
        if is_retryable_status(status_code) {
            // 401/403/408/429/>=500:可重试,冷却切换。
            mark_cooldown(state, &channel.id, level).await;
            continue;
        }
        let ttft_ms = started.elapsed().as_millis() as i64;
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();

        if !resp.status().is_success() {
            // 不可重试 4xx(如 400):原样透传(状态码 + body),不冷却,不计费。
            let text = resp.text().await.unwrap_or_default();
            // 渠道本身可用(只是该请求被上游拒),清掉历史冷却。
            // 有意决策:4xx 虽是上游拒绝,但连接已建立、渠道本身健康,据此清历史冷却;
            // 若上游以 400 表达配额耗尽会误清,接受该边缘(TS 版同样不冷却 4xx)。
            reset_cooldown(state, &channel.id, level, &status).await;
            return Ok(ForwardOk {
                channel_id: channel.id,
                status: status_code,
                content_type,
                kind: ForwardBody::Passthrough { text },
                ttft_ms,
            });
        }

        // 成功:重置冷却(仅当原 level/status 非默认)。
        reset_cooldown(state, &channel.id, level, &status).await;

        if !is_stream {
            let text = resp.text().await.unwrap_or_default();
            let json: Option<Value> = serde_json::from_str(&text).ok();
            let usage = json
                .as_ref()
                .map(|j| crate::billing::extract_usage_from_json(protocol, j))
                .unwrap_or_default();
            return Ok(ForwardOk {
                channel_id: channel.id,
                status: status_code,
                content_type,
                kind: ForwardBody::Buffered {
                    text,
                    usage,
                    response_json: json,
                },
                ttft_ms,
            });
        }

        // 流式:包装字节流,旁路喂 tap;handler 在流读尽/Drop 后 tap.lock().finish() 取用量(T8)。
        let tap = Arc::new(Mutex::new(UsageTap::new(protocol)));
        let tap_for_stream = tap.clone();
        use futures_util::StreamExt;
        let byte_stream = resp.bytes_stream().map(move |chunk| match chunk {
            Ok(bytes) => {
                if let Ok(mut t) = tap_for_stream.lock() {
                    t.feed(&bytes);
                }
                Ok(bytes)
            }
            Err(e) => Err(std::io::Error::other(e)),
        });
        return Ok(ForwardOk {
            channel_id: channel.id,
            status: status_code,
            content_type,
            kind: ForwardBody::Stream {
                stream: Box::pin(byte_stream),
                tap,
            },
            ttft_ms,
        });
    }

    // 所有候选都失败(全可重试错误)→ upstream_failed(502)
    Err(GatewayError::upstream_failed(protocol))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{insert_channel, insert_model, test_state};
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn openai_model(upstream: &str) -> ModelInfo {
        ModelInfo {
            slug: "gpt-x".into(),
            provider_type: Protocol::Openai,
            upstream_model: upstream.into(),
            prices: crate::billing::Prices {
                input_micro: 0,
                output_micro: 0,
                cache_read_micro: 0,
                cache_write_micro: 0,
            },
        }
    }

    #[test]
    fn weighted_shuffle_returns_all_once() {
        let items: Vec<Candidate> = (0..5)
            .map(|i| Candidate {
                id: format!("c{i}"),
                base_url: "x".into(),
                credential_encrypted: vec![],
                weight: 1,
            })
            .collect();
        let mut rng = StdRng::seed_from_u64(42);
        let out = weighted_shuffle(items.clone(), &mut rng);
        assert_eq!(out.len(), 5);
        let mut ids: Vec<String> = out.iter().map(|c| c.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["c0", "c1", "c2", "c3", "c4"]);
    }

    #[test]
    fn weighted_shuffle_zero_weight_treated_as_one() {
        // 不该 panic(total>0);单元素 weight=0 也能返回
        let items = vec![Candidate {
            id: "a".into(),
            base_url: "x".into(),
            credential_encrypted: vec![],
            weight: 0,
        }];
        let mut rng = StdRng::seed_from_u64(1);
        assert_eq!(weighted_shuffle(items, &mut rng).len(), 1);
    }

    #[test]
    fn retryable_status_matrix() {
        for s in [401, 403, 408, 429, 500, 502, 503] {
            assert!(is_retryable_status(s), "{s} 应可重试");
        }
        for s in [400, 404, 422] {
            assert!(!is_retryable_status(s), "{s} 不应可重试");
        }
    }

    #[tokio::test]
    async fn no_channel_when_db_empty() {
        let state = test_state().await;
        let m = openai_model("gpt-4o");
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "no_channel");
        assert_eq!(err.status.as_u16(), 502);
    }

    #[tokio::test]
    async fn non_stream_success_buffers_usage() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "usage": {"prompt_tokens": 100, "completion_tokens": 20}
            })))
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
        let m = openai_model("gpt-4o");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x","stream":false}),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, 200);
        match ok.kind {
            ForwardBody::Buffered { usage, .. } => {
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 20);
            }
            _ => panic!("应为 Buffered"),
        }
    }

    #[tokio::test]
    async fn fails_over_on_5xx_then_succeeds() {
        let bad = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&bad)
            .await;
        let good = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}})),
            )
            .mount(&good)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        // forward 内用 thread_rng 加权洗牌,无法播种;给 bad 渠道压倒性权重
        //(1_000_000 vs 1),使其几乎必然被先选中,从而确定性地走「bad 5xx → failover → good 成功」
        //(同权时洗牌顺序随机会让本断言约 50% 概率落空,实测在全量并行下偶发 FAIL)。
        let bad_id = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", bad.uri()),
            "sk-bad",
            1_000_000,
            "active",
        )
        .await;
        insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", good.uri()),
            "sk-good",
            1,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, 200);
        // bad 渠道应被冷却
        let (status, level): (String, i64) =
            sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id = ?")
                .bind(&bad_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "cooldown");
        assert_eq!(level, 1);
    }

    #[tokio::test]
    async fn both_channels_5xx_cascades_cooldown_then_upstream_failed() {
        // 级联失败:两个渠道上游都 503 → 逐个冷却 → 候选耗尽 → upstream_failed。
        let bad1 = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&bad1)
            .await;
        let bad2 = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&bad2)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        // 权重随意;无论洗牌顺序,两个渠道都会被各试一次后双双冷却。
        let id1 = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", bad1.uri()),
            "sk-bad1",
            1,
            "active",
        )
        .await;
        let id2 = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", bad2.uri()),
            "sk-bad2",
            5,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "upstream_failed");
        // 两个渠道都应被冷却:status='cooldown'、level=1、cooldown_until>now
        let now = crate::now_epoch();
        for id in [&id1, &id2] {
            let (status, level, until): (String, i64, Option<i64>) = sqlx::query_as(
                "SELECT status, cooldown_level, cooldown_until FROM channels WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&state.db)
            .await
            .unwrap();
            assert_eq!(status, "cooldown", "渠道 {id} 应冷却");
            assert_eq!(level, 1, "渠道 {id} 冷却层级应为 1");
            assert!(
                until.is_some_and(|u| u > now),
                "渠道 {id} cooldown_until 应在未来,实际 {until:?}"
            );
        }
    }

    #[tokio::test]
    async fn cooldown_401_credential_invalid() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-x",
            1,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "upstream_failed");
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "cooldown");
    }

    #[tokio::test]
    async fn decrypt_failure_cools_and_continues() {
        // 渠道凭证用「错误的 master_key」加密:本进程解不开 → 当可重试,冷却切换
        let state = test_state().await;
        let wrong_mk = [1u8; 32]; // 与 test master_key([7u8;32]) 不同
        let id = insert_channel(
            &state.db,
            &wrong_mk,
            "openai",
            "http://127.0.0.1:1/v1",
            "sk-x",
            1,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "upstream_failed");
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "cooldown");
    }

    #[tokio::test]
    async fn non_retryable_400_passthrough_no_cooldown() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string("{\"error\":\"bad request from upstream\"}"),
            )
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-x",
            1,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, 400);
        match ok.kind {
            ForwardBody::Passthrough { text } => {
                assert!(text.contains("bad request from upstream"))
            }
            _ => panic!("应为 Passthrough"),
        }
        // 不冷却
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "active");
    }

    #[tokio::test]
    async fn success_resets_cooldown_level() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}})),
            )
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-x",
            1,
            "active",
        )
        .await;
        // 预置成 cooldown level 3、cooldown_until 已过期(可被选中)
        sqlx::query(
            "UPDATE channels SET status='cooldown', cooldown_level=3, cooldown_until=? WHERE id=?",
        )
        .bind(crate::now_epoch() - 1)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();
        let m = openai_model("gpt-4o");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, 200);
        let (status, level): (String, i64) =
            sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(status, "active");
        assert_eq!(level, 0);
    }

    #[tokio::test]
    async fn all_cooling_yields_upstream_failed() {
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(
            &state.db,
            &mk,
            "openai",
            "http://127.0.0.1:1/v1",
            "sk-x",
            1,
            "active",
        )
        .await;
        // 未来冷却中
        sqlx::query("UPDATE channels SET status='cooldown', cooldown_until=? WHERE id=?")
            .bind(crate::now_epoch() + 600)
            .bind(&id)
            .execute(&state.db)
            .await
            .unwrap();
        let m = openai_model("gpt-4o");
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "upstream_failed");
    }

    #[tokio::test]
    async fn anthropic_headers_and_body_rewrite() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(wiremock::matchers::header("x-api-key", "sk-up"))
            .and(wiremock::matchers::header(
                "anthropic-version",
                "2023-06-01",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"usage":{"input_tokens":3,"output_tokens":4}})),
            )
            .mount(&server)
            .await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(
            &state.db,
            &mk,
            "anthropic",
            &format!("{}/v1", server.uri()),
            "sk-up",
            1,
            "active",
        )
        .await;
        let m = ModelInfo {
            slug: "claude-x".into(),
            provider_type: Protocol::Anthropic,
            upstream_model: "claude-3-real".into(),
            prices: crate::billing::Prices {
                input_micro: 0,
                output_micro: 0,
                cache_read_micro: 0,
                cache_write_micro: 0,
            },
        };
        let ok = forward(
            &state,
            Protocol::Anthropic,
            &m,
            &json!({"model":"claude-x"}),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok.status, 200);
    }

    #[tokio::test]
    async fn upstream_body_rewrites_model_to_upstream() {
        // 断言体改写:客户端 model=gpt-x → 上游收到 upstream_model=gpt-4o-real
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(
                json!({"model": "gpt-4o-real"}),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}})),
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
        let m = openai_model("gpt-4o-real");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x"}),
            None,
            None,
        )
        .await
        .unwrap();
        // mock 仅匹配 model=gpt-4o-real;若体未改写则上游 404 → 该测试失败
        assert_eq!(ok.status, 200);
    }

    #[tokio::test]
    async fn openai_stream_injects_include_usage() {
        // 断言 OpenAI 流式注入 stream_options.include_usage=true,且保留客户端原有 stream_options 字段
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(json!({
                "stream_options": {"include_usage": true, "keep_me": "yes"}
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: [DONE]\n\n"),
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
        let m = openai_model("gpt-4o");
        let ok = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x","stream":true,"stream_options":{"keep_me":"yes"}}),
            None,
            None,
        )
        .await
        .unwrap();
        // mock 仅匹配带 include_usage=true 且保留 keep_me 的体;不符则上游 404
        assert_eq!(ok.status, 200);
        // 流式应为 Stream 变体
        assert!(matches!(ok.kind, ForwardBody::Stream { .. }));
    }

    #[tokio::test]
    async fn non_stream_applies_per_request_timeout() {
        // 评审硬要求:非流式路径必须真的应用 upstream_timeout_secs。
        // wiremock 慢响应(2s)+ 配置 1s 超时 → 超时按可重试处理 → 渠道冷却、整体 upstream_failed。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}}))
                    .set_delay(std::time::Duration::from_secs(2)),
            )
            .mount(&server)
            .await;
        let mut state = test_state().await;
        // 把超时压到 1s(<2s 上游延迟)
        let mut cfg = (*state.config).clone();
        cfg.upstream_timeout_secs = 1;
        state.config = std::sync::Arc::new(cfg);
        let mk = state.config.master_key_bytes();
        let id = insert_channel(
            &state.db,
            &mk,
            "openai",
            &format!("{}/v1", server.uri()),
            "sk-x",
            1,
            "active",
        )
        .await;
        let m = openai_model("gpt-4o");
        let started = std::time::Instant::now();
        let err = forward(
            &state,
            Protocol::Openai,
            &m,
            &json!({"model":"gpt-x","stream":false}),
            None,
            None,
        )
        .await
        .unwrap_err();
        let elapsed = started.elapsed();
        // 超时按可重试 → 唯一渠道失败 → upstream_failed
        assert_eq!(err.code, "upstream_failed");
        // 真应用了 1s 超时:整体耗时应远小于上游 2s 延迟(留余量到 1.8s)
        assert!(
            elapsed < std::time::Duration::from_millis(1800),
            "应在 ~1s 超时返回,实际 {elapsed:?}"
        );
        // 超时按可重试 → 渠道被冷却
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(status, "cooldown");
    }

    // 让 insert_model 在本模块被引用(避免 unused 警告;部分用例不直接用它)
    #[tokio::test]
    async fn insert_model_helper_smoke() {
        let state = test_state().await;
        let slug = insert_model(&state.db, "m-smoke", "openai", "up-m", 1, 1, 0, 0).await;
        assert_eq!(slug, "m-smoke");
    }
}
