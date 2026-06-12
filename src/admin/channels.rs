//! 渠道资源:列表/创建/改属性/轮换凭证。
//! 凭证只在 handler 栈帧存活——信封加密只写不读:落库即 encrypt(AAD=行 id),
//! 出参/列表/audit 永不含 credential_encrypted 列(从 SELECT 起就排除,而非取出后过滤)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/channels", get(list).post(create))
        .route("/channels/:id", patch(update))
        .route("/channels/:id/rotate", post(rotate))
}

/// 列表/回读共用的 SELECT 列——**有意不含 credential_encrypted**:凭证只写不读,
/// 从 SELECT 就排除,杜绝密文意外流入出参/序列化的可能。
const CHANNEL_SELECT: &str = "SELECT id, provider_type, name, base_url, weight, status, \
            cooldown_until, cooldown_level, created_at FROM channels";

/// 出参/列表行;与库行同构(无凭证列)。
#[derive(Serialize, sqlx::FromRow)]
struct ChannelRow {
    id: String,
    provider_type: String,
    name: String,
    base_url: String,
    weight: i64,
    status: String,
    cooldown_until: Option<i64>,
    cooldown_level: i64,
    created_at: i64,
}

/// 回读单行(创建后 / PATCH 后),不含凭证。
async fn fetch_channel_row(
    db: &sqlx::SqlitePool,
    id: &str,
) -> Result<Option<ChannelRow>, ApiError> {
    sqlx::query_as(&format!("{CHANNEL_SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(ApiError::internal)
}

/// base_url 规整:去尾部斜杠后必须匹配 ^https?://.+/v1$。返回规整后的值(无尾斜杠)。
/// 手写校验不引正则库:协议头 + 中段非空 + 以 /v1 收尾。
fn normalize_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    // 去掉末尾 /v1 后中段必须非空(即 .+),保证 ^https?://.+/v1$ 的 .+ 不为空。
    let middle = rest.strip_suffix("/v1")?;
    if middle.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 次级键 id 兜底:created_at 为秒级,同秒创建的行单凭它排序不稳定。
    let rows: Vec<ChannelRow> =
        sqlx::query_as(&format!("{CHANNEL_SELECT} ORDER BY created_at, id"))
            .fetch_all(&state.db)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "channels": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    provider_type: String,
    name: String,
    base_url: String,
    credential: String,
    #[serde(default)]
    weight: Option<i64>,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<ChannelRow>), ApiError> {
    if !["openai", "anthropic"].contains(&req.provider_type.as_str()) {
        return Err(ApiError::bad_request("供应商类型无效"));
    }
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("渠道名称不能为空"));
    }
    // 凭证非空判定在 trim 前:留白凭证无意义,但存原文(不 trim,上游 token 可能含特殊字符)。
    if req.credential.trim().is_empty() {
        return Err(ApiError::bad_request("凭证不能为空"));
    }
    let base_url = normalize_base_url(&req.base_url).ok_or_else(|| {
        ApiError::bad_request("baseUrl 必须以 /v1 结尾(如 https://api.openai.com/v1)")
    })?;
    let weight = req.weight.unwrap_or(1);
    if weight < 1 {
        return Err(ApiError::bad_request("weight 必须为正整数"));
    }

    // 先生成行 id 再加密:AAD = 行 id,密文与行绑定,拷到别的行解不开。
    let id = uuid::Uuid::new_v4().to_string();
    let blob =
        crate::crypto::encrypt_secret(&req.credential, &state.config.master_key_bytes(), &id)
            .map_err(ApiError::internal)?;
    let created_at = now_epoch();
    sqlx::query(
        "INSERT INTO channels (id, provider_type, name, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, 0, ?)",
    )
    .bind(&id)
    .bind(&req.provider_type)
    .bind(&name)
    .bind(&base_url)
    .bind(&blob)
    .bind(weight)
    .bind(created_at)
    .execute(&state.db)
    .await
    .map_err(ApiError::internal)?;

    // audit detail 绝不含凭证;只记常规属性。
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "channel.create",
        Some(&id),
        serde_json::json!({"name": name, "provider_type": req.provider_type, "base_url": base_url}),
    )
    .await;

    let row = fetch_channel_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("创建后回读渠道失败")))?;
    Ok((StatusCode::CREATED, Json(row)))
}

#[derive(Deserialize)]
struct UpdateReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    weight: Option<i64>,
    #[serde(default)]
    status: Option<String>,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<ChannelRow>, ApiError> {
    if req.name.is_none() && req.weight.is_none() && req.status.is_none() {
        return Err(ApiError::bad_request("没有需要更新的字段"));
    }
    // status 仅许 active/disabled:cooldown 是网关内部态,不许管理员手设。
    let mut clear_cooldown = false;
    if let Some(s) = &req.status {
        if !["active", "disabled"].contains(&s.as_str()) {
            return Err(ApiError::bad_request("无效状态"));
        }
        // status→active = 管理员手动启用,同时解除冷却惩罚(冷却态归位)。
        clear_cooldown = s == "active";
    }
    let name = match &req.name {
        Some(n) => {
            let n = n.trim().to_string();
            if n.is_empty() {
                return Err(ApiError::bad_request("渠道名称不能为空"));
            }
            Some(n)
        }
        None => None,
    };
    if let Some(w) = req.weight {
        if w < 1 {
            return Err(ApiError::bad_request("weight 必须为正整数"));
        }
    }

    // COALESCE 只写出现的字段;active 时附带清冷却(cooldown_until=NULL, cooldown_level=0)。
    let res = sqlx::query(
        "UPDATE channels SET name = COALESCE(?, name), weight = COALESCE(?, weight), \
             status = COALESCE(?, status), \
             cooldown_until = CASE WHEN ? THEN NULL ELSE cooldown_until END, \
             cooldown_level = CASE WHEN ? THEN 0 ELSE cooldown_level END \
         WHERE id = ?",
    )
    .bind(&name)
    .bind(req.weight)
    .bind(&req.status)
    .bind(clear_cooldown)
    .bind(clear_cooldown)
    .bind(&id)
    .execute(&state.db)
    .await
    .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("渠道不存在"));
    }

    // audit 只记实际写入的字段。
    let mut detail = serde_json::Map::new();
    if let Some(n) = &name {
        detail.insert("name".into(), serde_json::json!(n));
    }
    if let Some(w) = req.weight {
        detail.insert("weight".into(), serde_json::json!(w));
    }
    if let Some(s) = &req.status {
        detail.insert("status".into(), serde_json::json!(s));
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "channel.update",
        Some(&id),
        serde_json::Value::Object(detail),
    )
    .await;

    let row = fetch_channel_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("渠道不存在"))?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct RotateReq {
    credential: String,
}

async fn rotate(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<RotateReq>, ApiError>,
) -> Result<StatusCode, ApiError> {
    if req.credential.trim().is_empty() {
        return Err(ApiError::bad_request("新凭证不能为空"));
    }
    // 复用原行 id 作 AAD 重加密(轮换 = 整条凭证重新加密)。
    let blob =
        crate::crypto::encrypt_secret(&req.credential, &state.config.master_key_bytes(), &id)
            .map_err(ApiError::internal)?;
    let res = sqlx::query("UPDATE channels SET credential_encrypted = ? WHERE id = ?")
        .bind(&blob)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("渠道不存在"));
    }
    // detail 空对象:凭证绝不入 audit。
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "channel.rotate",
        Some(&id),
        serde_json::json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::crypto::decrypt_secret;
    use crate::test_util::{admin_session, authed_request, body_json};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    /// 经 API 建渠道,返回 (status, body)。
    async fn create_channel(
        state: &crate::AppState,
        cookie: &str,
        payload: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/channels",
                cookie,
                Some(payload),
            ))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[tokio::test]
    async fn create_channel_validates_and_encrypts() {
        let (state, cookie) = admin_session().await;
        let (status, body) = create_channel(
            &state,
            &cookie,
            json!({
                "provider_type": "openai",
                "name": "  主渠道  ",
                "base_url": "https://api.openai.com/v1",
                "credential": "sk-upstream-secret",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["name"], "主渠道"); // trim
        assert_eq!(body["weight"], 1); // 缺省 1
        assert_eq!(body["status"], "active");
        // 响应序列化串不含凭证原文,也不含 "credential" 字段名
        let s = body.to_string();
        assert!(!s.contains("sk-upstream-secret"), "响应不得回显凭证: {s}");
        assert!(!s.contains("credential"), "响应不得含 credential 字段: {s}");

        // SELECT credential_encrypted 用 AAD=id 解密,还原 == 原文(AAD 正确)
        let id = body["id"].as_str().unwrap();
        let (blob,): (Vec<u8>,) =
            sqlx::query_as("SELECT credential_encrypted FROM channels WHERE id = ?")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        let mk = state.config.master_key_bytes();
        assert_eq!(
            decrypt_secret(&blob, &mk, id).unwrap(),
            "sk-upstream-secret"
        );
    }

    #[tokio::test]
    async fn create_channel_bad_base_url_400() {
        let (state, cookie) = admin_session().await;
        for bad in ["https://api.openai.com", "http://x/v2"] {
            let (status, _) = create_channel(
                &state,
                &cookie,
                json!({"provider_type": "openai", "name": "n", "base_url": bad, "credential": "c"}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "坏 base_url 应 400: {bad}");
        }
        // 尾斜杠 → 201 且落库去尾斜杠
        let (status, body) = create_channel(
            &state,
            &cookie,
            json!({"provider_type": "openai", "name": "n", "base_url": "https://x/v1/", "credential": "c"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["base_url"], "https://x/v1");
    }

    #[tokio::test]
    async fn patch_status_active_clears_cooldown() {
        let (state, cookie) = admin_session().await;
        let mk = state.config.master_key_bytes();
        let id = crate::test_util::insert_channel(
            &state.db,
            &mk,
            "openai",
            "https://x/v1",
            "sk-up",
            1,
            "active",
        )
        .await;
        // 手动改成 cooldown 态
        let now = crate::now_epoch();
        sqlx::query(
            "UPDATE channels SET status='cooldown', cooldown_until=?, cooldown_level=3 WHERE id=?",
        )
        .bind(now + 600)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/channels/{id}"),
                &cookie,
                Some(json!({"status": "active"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["status"], "active");
        assert!(body["cooldown_until"].is_null());
        assert_eq!(body["cooldown_level"], 0);
    }

    #[tokio::test]
    async fn patch_channel_validation() {
        let (state, cookie) = admin_session().await;
        let mk = state.config.master_key_bytes();
        let id = crate::test_util::insert_channel(
            &state.db,
            &mk,
            "openai",
            "https://x/v1",
            "sk-up",
            1,
            "active",
        )
        .await;
        let patch = |body: serde_json::Value, target: String| {
            let app = app(state.clone());
            let cookie = cookie.clone();
            async move {
                app.oneshot(authed_request(
                    "PATCH",
                    &format!("/admin/api/channels/{target}"),
                    &cookie,
                    Some(body),
                ))
                .await
                .unwrap()
                .status()
            }
        };
        // status:"cooldown" → 400(内部态不许手设)
        assert_eq!(
            patch(json!({"status": "cooldown"}), id.clone()).await,
            StatusCode::BAD_REQUEST
        );
        // 空 patch → 400
        assert_eq!(patch(json!({}), id.clone()).await, StatusCode::BAD_REQUEST);
        // weight 0 → 400
        assert_eq!(
            patch(json!({"weight": 0}), id.clone()).await,
            StatusCode::BAD_REQUEST
        );
        // 不存在 → 404
        assert_eq!(
            patch(json!({"weight": 2}), "nope".into()).await,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn rotate_reencrypts_with_same_aad() {
        let (state, cookie) = admin_session().await;
        let mk = state.config.master_key_bytes();
        let id = crate::test_util::insert_channel(
            &state.db,
            &mk,
            "openai",
            "https://x/v1",
            "sk-old",
            1,
            "active",
        )
        .await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/channels/{id}/rotate"),
                &cookie,
                Some(json!({"credential": "sk-new-secret"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // decrypt(新 blob, AAD=id) == 新凭证
        let (blob,): (Vec<u8>,) =
            sqlx::query_as("SELECT credential_encrypted FROM channels WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(decrypt_secret(&blob, &mk, &id).unwrap(), "sk-new-secret");

        // audit channel.rotate 落行,detail 不含凭证
        let (detail,): (String,) =
            sqlx::query_as("SELECT detail FROM audit_events WHERE action='channel.rotate'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(
            !detail.contains("sk-new-secret"),
            "audit 不得含凭证: {detail}"
        );

        // 空凭证 → 400;不存在 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/channels/{id}/rotate"),
                &cookie,
                Some(json!({"credential": "  "})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/channels/nope/rotate",
                &cookie,
                Some(json!({"credential": "sk-x"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_excludes_credential() {
        let (state, cookie) = admin_session().await;
        let mk = state.config.master_key_bytes();
        crate::test_util::insert_channel(
            &state.db,
            &mk,
            "openai",
            "https://x/v1",
            "sk-list-secret",
            1,
            "active",
        )
        .await;
        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/channels", &cookie, None))
            .await
            .unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["channels"].as_array().unwrap().len(), 1);
        assert!(
            !body.to_string().contains("sk-list-secret"),
            "列表不得回显凭证"
        );
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/channels",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
