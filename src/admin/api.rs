use crate::auth::{encode_session, AdminUser, SessionData, SESSION_COOKIE, SESSION_TTL_SECS};
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct MeResp {
    email: String,
    role: &'static str,
}

fn session_cookie(value: String, max_age_secs: i64) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .http_only(true)
        .same_site(SameSite::Lax)
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
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> Result<(CookieJar, Json<MeResp>), ApiError> {
    let row: Option<(String, String, String, String, String)> =
        sqlx::query_as("SELECT id, email, password_hash, role, status FROM users WHERE email = ?")
            .bind(&req.email)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;

    let Some((id, email, password_hash, role, status)) = row else {
        // 时序对齐:不存在的邮箱也付一次 argon2 成本
        let _ = crate::crypto::verify_password(&req.password, dummy_password_hash());
        return Err(ApiError::login_failed());
    };
    if status != "active"
        || !crate::crypto::verify_password(&req.password, &password_hash)
        || role != "admin"
    {
        // 统一文案,不区分原因(防枚举)
        return Err(ApiError::login_failed());
    }

    let session = SessionData {
        user_id: id,
        exp: now_epoch() + SESSION_TTL_SECS,
    };
    let value = encode_session(&session, &state.config.session_secret);
    Ok((
        jar.add(session_cookie(value, SESSION_TTL_SECS)),
        Json(MeResp {
            email,
            role: "admin",
        }),
    ))
}

async fn logout(jar: CookieJar) -> (CookieJar, StatusCode) {
    // 无状态会话:仅指示浏览器删除 cookie(Max-Age=0)
    (
        jar.add(session_cookie(String::new(), 0)),
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
