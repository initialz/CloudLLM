use crate::auth::{encode_session, AdminUser, SessionData, SESSION_COOKIE, SESSION_TTL_SECS};
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .merge(super::users::router())
        .merge(super::teams::router())
        .merge(super::keys::router())
        // 未匹配的 /admin/api/* 必须是 JSON 404,不得回退到 SPA HTML
        .fallback(api_not_found)
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("接口不存在")
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

// role 硬编码 "admin":AdminUser extractor 已保证仅 admin 可达。
// 若未来 extractor 放宽多角色,此处必须改为携带真实 role。
#[derive(Serialize)]
struct MeResp {
    email: String,
    role: &'static str,
}

fn session_cookie(value: String, max_age_secs: i64, secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .path("/")
        .max_age(time::Duration::seconds(max_age_secs))
        .build()
}

/// 用户不存在时跑一次同等成本的 dummy 校验,对齐「邮箱存在/不存在」两条路径的时序,
/// 防止以响应时间枚举账号(统一文案只防文案枚举,防不了时序)。
fn dummy_password_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        crate::crypto::hash_password("cloudllm-dummy-timing-alignment").expect("dummy 哈希")
    })
}

async fn login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    jar: CookieJar,
    WithRejection(Json(req), _): WithRejection<Json<LoginReq>, ApiError>,
) -> Result<(CookieJar, Json<MeResp>), ApiError> {
    let now = now_epoch();
    // 来源:XFF 第一跳(可伪造,内网单实例威胁模型下接受;主防线是邮箱维度)
    let source = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "direct".into());
    // 限速桶按规范化邮箱聚合:trim + 小写。与 DB 查询的大小写敏感性无关——
    // 这里只要求「同一账号的所有大小写/空格变体落进同一计数桶」,
    // 否则 Admin@x.com / admin@x.com 会是两个桶,可被大小写变体绕过限速。
    let email_key = format!("email:{}", req.email.trim().to_lowercase());
    let source_key = format!("source:{source}");
    // 限速检查必须在 DB 查询前:被锁时直接拒,不暴露查询/时序差异
    if state.login_limiter.check(&email_key, now).is_err()
        || state.login_limiter.check(&source_key, now).is_err()
    {
        return Err(ApiError::too_many_attempts());
    }

    // 失败收口:计两个维度 + 写审计(actor=None,subject=email,detail={source})。
    // 两个失败出口共用,避免复制。返回统一文案 ApiError。
    let on_failure = || async {
        // 失败响应同步等 audit 落库:相对前面 argon2 校验的成本可忽略,且失败路径慢一点无碍
        state.login_limiter.record_failure(&email_key, now);
        state.login_limiter.record_failure(&source_key, now);
        crate::audit::record(
            &state.db,
            None,
            "auth.login_failed",
            Some(&req.email),
            serde_json::json!({"source": source}),
        )
        .await;
        ApiError::login_failed()
    };

    let row: Option<(String, String, String, String, String)> =
        sqlx::query_as("SELECT id, email, password_hash, role, status FROM users WHERE email = ?")
            .bind(&req.email)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;

    let Some((id, email, password_hash, role, status)) = row else {
        // 时序对齐:不存在的邮箱也付一次 argon2 成本
        let _ = crate::crypto::verify_password(&req.password, dummy_password_hash());
        return Err(on_failure().await);
    };
    // 注:status!=active 时 || 短路跳过 verify,「存在但停用」账号响应略快——
    // 内部威胁模型下接受此时序差(修复需 disabled 路径也跑 dummy verify,不值得)。
    if status != "active"
        || !crate::crypto::verify_password(&req.password, &password_hash)
        || role != "admin"
    {
        // 统一文案,不区分原因(防枚举)
        return Err(on_failure().await);
    }

    // 成功:清零两个维度(在签发 cookie 前)
    state.login_limiter.clear(&email_key);
    state.login_limiter.clear(&source_key);

    let session = SessionData {
        user_id: id,
        exp: now + SESSION_TTL_SECS,
    };
    let value = encode_session(&session, &state.config.session_secret);
    Ok((
        jar.add(session_cookie(
            value,
            SESSION_TTL_SECS,
            state.config.cookie_secure,
        )),
        Json(MeResp {
            email,
            role: "admin",
        }),
    ))
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> (CookieJar, StatusCode) {
    // 无状态会话:仅指示浏览器删除 cookie(Max-Age=0)。
    // 清除 cookie 也带上与下发时一致的 Secure,确保浏览器能匹配并删除原 cookie。
    (
        jar.add(session_cookie(String::new(), 0, state.config.cookie_secure)),
        StatusCode::NO_CONTENT,
    )
}

async fn me(user: AdminUser) -> Json<MeResp> {
    Json(MeResp {
        email: user.email,
        role: "admin",
    })
}

#[cfg(test)]
mod tests {
    use crate::test_util::{body_json, first_cookie, insert_user, json_request, test_state};
    use crate::{app, AppState};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use serde_json::json;
    use tower::ServiceExt;

    async fn state_with_admin() -> AppState {
        let state = test_state().await;
        insert_user(&state.db, "admin@x.com", "Adm1n!pass", "admin", "active").await;
        state
    }

    async fn login(state: &AppState, email: &str, password: &str) -> axum::http::Response<Body> {
        app(state.clone())
            .oneshot(json_request(
                "POST",
                "/admin/api/login",
                json!({"email": email, "password": password}),
            ))
            .await
            .unwrap()
    }

    // 带 XFF 来源的登录:用于把 source 维度按客户端 IP 区分,从而隔离 email 维度。
    async fn login_from(
        state: &AppState,
        email: &str,
        password: &str,
        xff: &str,
    ) -> axum::http::Response<Body> {
        let req = json_request(
            "POST",
            "/admin/api/login",
            json!({"email": email, "password": password}),
        );
        let (mut parts, body) = req.into_parts();
        parts.headers.insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_str(xff).unwrap(),
        );
        app(state.clone())
            .oneshot(Request::from_parts(parts, body))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn login_ok_sets_cookie_and_returns_me() {
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "Adm1n!pass").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cookie = first_cookie(&resp);
        assert!(cookie.starts_with("cloudllm_session="));
        let body = body_json(resp).await;
        assert_eq!(body["email"], "admin@x.com");
        assert_eq!(body["role"], "admin");
    }

    #[tokio::test]
    async fn login_wrong_password_uniform_message() {
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "wrong").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_unknown_email_same_message() {
        let state = state_with_admin().await;
        let resp = login(&state, "nobody@x.com", "whatever").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_non_admin_rejected_uniform() {
        let state = state_with_admin().await;
        insert_user(&state.db, "user@x.com", "User!pass1", "user", "active").await;
        let resp = login(&state, "user@x.com", "User!pass1").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_disabled_admin_rejected() {
        let state = test_state().await;
        insert_user(&state.db, "off@x.com", "Off!pass11", "admin", "disabled").await;
        let resp = login(&state, "off@x.com", "Off!pass11").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn me_requires_session() {
        let state = state_with_admin().await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn me_with_cookie_ok() {
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["email"], "admin@x.com");
    }

    #[tokio::test]
    async fn session_invalidated_when_user_disabled() {
        // 无状态 cookie 的撤销补偿:每请求回查 users.status
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        sqlx::query("UPDATE users SET status = 'disabled' WHERE email = 'admin@x.com'")
            .execute(&state.db)
            .await
            .unwrap();
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn session_invalidated_when_demoted() {
        // role 以 DB 为准:管理员降级即时失效
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        sqlx::query("UPDATE users SET role = 'user' WHERE email = 'admin@x.com'")
            .execute(&state.db)
            .await
            .unwrap();
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn login_malformed_json_unified_error() {
        let state = state_with_admin().await;
        let req = Request::builder()
            .method("POST")
            .uri("/admin/api/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{not json"))
            .unwrap();
        let resp = app(state).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await; // 必须是 JSON 信封,text/plain 会在此 panic
        assert_eq!(body["error"]["code"], "bad_request");
        let msg = body["error"]["message"].as_str().unwrap();
        assert!(!msg.contains("line"), "不得回显 serde 行列号: {msg}");
    }

    #[tokio::test]
    async fn login_missing_field_unified_error() {
        let state = state_with_admin().await;
        let resp = app(state)
            .oneshot(json_request(
                "POST",
                "/admin/api/login",
                json!({"email": "a@b.com"}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = body_json(resp).await;
        assert_eq!(body["error"]["code"], "bad_request");
        assert!(
            !body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("password"),
            "不得回显缺失字段名"
        );
    }

    #[tokio::test]
    async fn login_empty_credentials_unified_401() {
        let state = state_with_admin().await;
        let resp = login(&state, "", "").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_locked_after_five_failures() {
        // 同邮箱连错 5 次 → 第 6 次即使密码正确也被限速 429
        let state = state_with_admin().await;
        for _ in 0..5 {
            let resp = login(&state, "admin@x.com", "wrong").await;
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        let resp = login(&state, "admin@x.com", "Adm1n!pass").await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body_json(resp).await["error"]["code"], "too_many_attempts");
    }

    #[tokio::test]
    async fn login_source_locked_across_distinct_emails() {
        // source 维度独立锁定:5 个不同邮箱各失败一次(同来源 direct,均不带 XFF)
        // → 第 6 个全新邮箱即触发 source 桶限速 429,证明来源维度与邮箱维度独立计数
        let state = state_with_admin().await;
        for i in 0..5 {
            let resp = login(&state, &format!("ghost{i}@x.com"), "wrong").await;
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        // 全新邮箱(其 email 桶为空),命中的只可能是同来源的 source 桶
        let resp = login(&state, "fresh@x.com", "wrong").await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body_json(resp).await["error"]["code"], "too_many_attempts");
    }

    #[tokio::test]
    async fn login_email_case_variants_share_limiter_bucket() {
        // 邮箱规范化防大小写绕过:同一账号 5 种大小写变体各失败一次。
        // 每次来源 IP(XFF)都不同 → source 桶各计 1 不触发,隔离出 email 维度;
        // 因 email 桶按小写聚合,5 个变体累加进同一桶 → 第 6 次该邮箱触发 429。
        // (未规范化时这是 6 个独立 email 桶,均不达阈值,第 6 次会放行 200。)
        let state = state_with_admin().await;
        let variants = [
            "Admin@x.com",
            "ADMIN@x.com",
            "admin@X.COM",
            "aDmIn@x.com",
            "Admin@X.Com",
        ];
        for (i, v) in variants.iter().enumerate() {
            let resp = login_from(&state, v, "wrong", &format!("10.0.0.{i}")).await;
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "变体 {v} 应是 401");
        }
        // 第 6 次:全新来源 IP(source 桶为空)+ 正确密码,只可能被 email 桶锁
        let resp = login_from(&state, "admin@x.com", "Adm1n!pass", "10.0.0.99").await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body_json(resp).await["error"]["code"], "too_many_attempts");
    }

    #[tokio::test]
    async fn login_failure_writes_audit() {
        // 失败一次写 auth.login_failed 审计,subject=邮箱
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "wrong").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let (action, subject): (String, Option<String>) = sqlx::query_as(
            "SELECT action, subject FROM audit_events WHERE action='auth.login_failed'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(action, "auth.login_failed");
        assert_eq!(subject.as_deref(), Some("admin@x.com"));
    }

    #[tokio::test]
    async fn login_success_not_limited_after_clear() {
        // 错 4 次 → 成功一次(清零)→ 再错 4 次仍不锁
        let state = state_with_admin().await;
        for _ in 0..4 {
            let resp = login(&state, "admin@x.com", "wrong").await;
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        let ok = login(&state, "admin@x.com", "Adm1n!pass").await;
        assert_eq!(ok.status(), StatusCode::OK);
        for _ in 0..4 {
            let resp = login(&state, "admin@x.com", "wrong").await;
            assert_eq!(
                resp.status(),
                StatusCode::UNAUTHORIZED,
                "成功后已清零,再错 4 次不应触发限速"
            );
        }
    }

    #[tokio::test]
    async fn unknown_api_path_is_json_404() {
        let state = test_state().await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(resp).await["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn login_default_cookie_not_secure() {
        // 默认配置 cookie_secure=false:Set-Cookie 不应含 Secure 属性
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "Adm1n!pass").await;
        let set = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_lowercase();
        assert!(!set.contains("secure"), "默认不应带 Secure: {set}");
    }

    #[tokio::test]
    async fn login_cookie_secure_when_configured() {
        // cookie_secure=true:Set-Cookie 含 Secure
        let mut cfg = crate::test_util::test_config();
        cfg.cookie_secure = true;
        let state = crate::test_util::test_state_with_config(cfg).await;
        insert_user(&state.db, "admin@x.com", "Adm1n!pass", "admin", "active").await;
        let resp = login(&state, "admin@x.com", "Adm1n!pass").await;
        let set = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_lowercase();
        assert!(set.contains("secure"), "配置开启时应带 Secure: {set}");
    }

    #[tokio::test]
    async fn logout_clears_cookie() {
        // 注意:无状态会话,登出只清浏览器 cookie;不要断言旧 cookie 失效
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/admin/api/logout")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let set = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set.contains("cloudllm_session="), "应下发清除 cookie");
        assert!(
            set.to_lowercase().contains("max-age=0"),
            "清除 cookie 需 Max-Age=0,实际: {set}"
        );
    }
}
