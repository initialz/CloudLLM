//! 用户资源:列表/创建/状态与角色变更。Console 仅 admin 可登录;user 角色用户是记账主体(持 Key 不登录)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list).post(create))
        .route("/users/:id", patch(update))
}

#[derive(Serialize, sqlx::FromRow)]
struct UserRow {
    id: String,
    email: String,
    role: String,
    status: String,
    created_at: i64,
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows: Vec<UserRow> =
        sqlx::query_as("SELECT id, email, role, status, created_at FROM users ORDER BY created_at")
            .fetch_all(&state.db)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "users": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    email: String,
    password: String,
    #[serde(default)]
    role: Option<String>,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<UserRow>), ApiError> {
    let email = req.email.trim().to_lowercase();
    // 与 TS 版同一正则语义:本地部分@域.后缀,均不含空白/@
    let valid = {
        let parts: Vec<&str> = email.split('@').collect();
        parts.len() == 2
            && !parts[0].is_empty()
            && parts[1].contains('.')
            && !parts[1].starts_with('.')
            && !parts[1].ends_with('.')
            && !email.chars().any(char::is_whitespace)
    };
    if !valid {
        return Err(ApiError::bad_request("请输入有效邮箱地址"));
    }
    if req.password.len() < 8 {
        return Err(ApiError::bad_request("密码至少 8 位"));
    }
    let role = req.role.unwrap_or_else(|| "user".into());
    if !["admin", "user"].contains(&role.as_str()) {
        return Err(ApiError::bad_request("无效角色"));
    }
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if exists.is_some() {
        return Err(ApiError::conflict("该邮箱已注册"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let hash = crate::crypto::hash_password(&req.password).map_err(ApiError::internal)?;
    let created_at = now_epoch();
    sqlx::query("INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .bind(&id).bind(&email).bind(&hash).bind(&role).bind(created_at)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "user.create",
        Some(&id),
        serde_json::json!({"email": email, "role": role}),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(UserRow {
            id,
            email,
            role,
            status: "active".into(),
            created_at,
        }),
    ))
}

#[derive(Deserialize)]
struct UpdateReq {
    status: Option<String>,
    role: Option<String>,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<UserRow>, ApiError> {
    if req.status.is_none() && req.role.is_none() {
        return Err(ApiError::bad_request("没有需要更新的字段"));
    }
    if let Some(s) = &req.status {
        if !["active", "disabled"].contains(&s.as_str()) {
            return Err(ApiError::bad_request("无效状态"));
        }
        if s == "disabled" && id == user.id {
            return Err(ApiError::forbidden("不能停用自己的账号"));
        }
    }
    if let Some(r) = &req.role {
        if !["admin", "user"].contains(&r.as_str()) {
            return Err(ApiError::bad_request("无效角色"));
        }
        if r == "user" && id == user.id {
            return Err(ApiError::forbidden("不能降级自己的角色"));
        }
    }
    let res = sqlx::query(
        "UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role) WHERE id = ?",
    )
    .bind(&req.status)
    .bind(&req.role)
    .bind(&id)
    .execute(&state.db)
    .await
    .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("用户不存在"));
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "user.update",
        Some(&id),
        serde_json::json!({"status": req.status, "role": req.role}),
    )
    .await;
    let row: UserRow =
        sqlx::query_as("SELECT id, email, role, status, created_at FROM users WHERE id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    #[tokio::test]
    async fn create_and_list_users() {
        let (state, cookie) = admin_session().await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/users",
                &cookie,
                Some(json!({"email": "  Member@X.com ", "password": "memberpw1"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = body_json(resp).await;
        assert_eq!(body["email"], "member@x.com"); // trim + lowercase
        assert_eq!(body["role"], "user"); // 默认 user

        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/users", &cookie, None))
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["users"].as_array().unwrap().len(), 2); // admin + member
                                                                // 审计落行
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='user.create'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn create_user_validation() {
        let (state, cookie) = admin_session().await;
        for (body, frag) in [
            (json!({"email": "bad", "password": "longenough"}), "邮箱"),
            (json!({"email": "a@b.com", "password": "short"}), "8"),
            (
                json!({"email": "a@b.com", "password": "longenough", "role": "root"}),
                "角色",
            ),
        ] {
            let resp = app(state.clone())
                .oneshot(authed_request(
                    "POST",
                    "/admin/api/users",
                    &cookie,
                    Some(body),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            let msg = body_json(resp).await["error"]["message"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(msg.contains(frag), "文案应含「{frag}」: {msg}");
        }
    }

    #[tokio::test]
    async fn duplicate_email_conflict() {
        let (state, cookie) = admin_session().await;
        let payload = json!({"email": "dup@x.com", "password": "longenough"});
        app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/users",
                &cookie,
                Some(payload.clone()),
            ))
            .await
            .unwrap();
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/users",
                &cookie,
                Some(payload),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn cannot_disable_or_demote_self() {
        let (state, cookie) = admin_session().await;
        let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email='admin@x.com'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        for patch in [json!({"status": "disabled"}), json!({"role": "user"})] {
            let resp = app(state.clone())
                .oneshot(authed_request(
                    "PATCH",
                    &format!("/admin/api/users/{id}"),
                    &cookie,
                    Some(patch),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn patch_status_and_role() {
        let (state, cookie) = admin_session().await;
        let uid =
            crate::test_util::insert_user(&state.db, "m@x.com", "memberpw1", "user", "active")
                .await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/users/{uid}"),
                &cookie,
                Some(json!({"status": "disabled"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "disabled");
        // 不存在 → 404;空 patch → 400
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                "/admin/api/users/nope",
                &cookie,
                Some(json!({"status": "disabled"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/users/{uid}"),
                &cookie,
                Some(json!({})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/users",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
