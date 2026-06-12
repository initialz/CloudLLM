//! 模型资源:列表/创建/改状态/删除。
//! 价格入参走 CNY 字符串(parse_cny_to_micro),出参 micro;slug 唯一,删除直接删行
//! (usage_records.model_slug 是软引用,历史账单保留)。

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
        .route("/models", get(list).post(create))
        .route("/models/:id", patch(update).delete(remove))
}

/// 列表/回读共用的 SELECT 列。
const MODEL_SELECT: &str = "SELECT id, slug, provider_type, upstream_model, input_price_micro, \
            output_price_micro, cache_read_price_micro, cache_write_price_micro, status, created_at \
     FROM models";

/// 出参/列表行;价格出参为 micro。
#[derive(Serialize, sqlx::FromRow)]
struct ModelRow {
    id: String,
    slug: String,
    provider_type: String,
    upstream_model: String,
    input_price_micro: i64,
    output_price_micro: i64,
    cache_read_price_micro: i64,
    cache_write_price_micro: i64,
    status: String,
    created_at: i64,
}

async fn fetch_model_row(db: &sqlx::SqlitePool, id: &str) -> Result<Option<ModelRow>, ApiError> {
    sqlx::query_as(&format!("{MODEL_SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(ApiError::internal)
}

/// slug 格式:恰一个 '/',两段非空且字符集 [A-Za-z0-9_.-]。手写校验不引正则库。
fn is_valid_slug(s: &str) -> bool {
    let Some((a, b)) = s.split_once('/') else {
        return false;
    };
    // split_once 只切首个 '/';b 若仍含 '/' 即多于一个,拒。
    if b.contains('/') {
        return false;
    }
    let seg_ok = |seg: &str| {
        !seg.is_empty()
            && seg
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
    };
    seg_ok(a) && seg_ok(b)
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows: Vec<ModelRow> = sqlx::query_as(&format!("{MODEL_SELECT} ORDER BY slug"))
        .fetch_all(&state.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "models": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    slug: String,
    provider_type: String,
    upstream_model: String,
    input_price_cny: String,
    output_price_cny: String,
    #[serde(default)]
    cache_read_price_cny: Option<String>,
    #[serde(default)]
    cache_write_price_cny: Option<String>,
}

/// 解析 CNY 价格(≥0);格式错回字段定制文案。
fn parse_price(field: &str, raw: &str) -> Result<i64, ApiError> {
    let micro = crate::billing::parse_cny_to_micro(raw).map_err(|_| {
        ApiError::bad_request(format!("{field} 格式无效(示例: 21 或 21.5,最多 6 位小数)"))
    })?;
    Ok(micro)
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<ModelRow>), ApiError> {
    let slug = req.slug.trim().to_string();
    if !is_valid_slug(&slug) {
        return Err(ApiError::bad_request("slug 格式无效(示例: openai/gpt-4o)"));
    }
    if !["openai", "anthropic"].contains(&req.provider_type.as_str()) {
        return Err(ApiError::bad_request("供应商类型无效"));
    }
    let upstream_model = req.upstream_model.trim().to_string();
    if upstream_model.is_empty() {
        return Err(ApiError::bad_request("上游模型不能为空"));
    }
    let input_micro = parse_price("input_price_cny", &req.input_price_cny)?;
    let output_micro = parse_price("output_price_cny", &req.output_price_cny)?;
    // cache 两档缺省 "0"。
    let cache_read_micro = parse_price(
        "cache_read_price_cny",
        req.cache_read_price_cny.as_deref().unwrap_or("0"),
    )?;
    let cache_write_micro = parse_price(
        "cache_write_price_cny",
        req.cache_write_price_cny.as_deref().unwrap_or("0"),
    )?;

    // slug 重复预检(给常态下干净 409);并发窗口由 from_db_unique 兜底。
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM models WHERE slug = ?")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if exists.is_some() {
        return Err(ApiError::conflict(format!("slug \"{slug}\" 已存在")));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_epoch();
    sqlx::query(
        "INSERT INTO models (id, slug, provider_type, upstream_model, input_price_micro, output_price_micro, cache_read_price_micro, cache_write_price_micro, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .bind(&id)
    .bind(&slug)
    .bind(&req.provider_type)
    .bind(&upstream_model)
    .bind(input_micro)
    .bind(output_micro)
    .bind(cache_read_micro)
    .bind(cache_write_micro)
    .bind(created_at)
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::from_db_unique(e, "slug 已存在"))?;

    crate::audit::record(
        &state.db,
        Some(&user.id),
        "model.create",
        Some(&id),
        serde_json::json!({"slug": slug, "provider_type": req.provider_type}),
    )
    .await;

    let row = fetch_model_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("创建后回读模型失败")))?;
    Ok((StatusCode::CREATED, Json(row)))
}

#[derive(Deserialize)]
struct UpdateReq {
    status: String,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<ModelRow>, ApiError> {
    if !["active", "disabled"].contains(&req.status.as_str()) {
        return Err(ApiError::bad_request("无效状态"));
    }
    let res = sqlx::query("UPDATE models SET status = ? WHERE id = ?")
        .bind(&req.status)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        // 命中行即计 1(即便 status 值未变);0 行只可能是不存在。
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM models WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
        if exists.is_none() {
            return Err(ApiError::not_found("模型不存在"));
        }
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "model.update",
        Some(&id),
        serde_json::json!({"status": req.status}),
    )
    .await;
    let row = fetch_model_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("模型不存在"))?;
    Ok(Json(row))
}

async fn remove(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // 直接删行;usage_records.model_slug 是软引用(无 FK),历史账单保留。
    let res = sqlx::query("DELETE FROM models WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("模型不存在"));
    }
    // subject=资源 id;detail 记 slug 便于审计追溯(删除后行已不在,故先取)。
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "model.delete",
        Some(&id),
        serde_json::json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    async fn create_model(
        state: &crate::AppState,
        cookie: &str,
        payload: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/models",
                cookie,
                Some(payload),
            ))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[tokio::test]
    async fn create_model_slug_and_prices() {
        let (state, cookie) = admin_session().await;
        let (status, body) = create_model(
            &state,
            &cookie,
            json!({
                "slug": "openai/gpt-4o",
                "provider_type": "openai",
                "upstream_model": "gpt-4o-real",
                "input_price_cny": "21.5",
                "output_price_cny": "0",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        // "21.5" → 21_500_000 micro
        assert_eq!(body["input_price_micro"], 21_500_000_i64);
        // cache 两档缺省 0
        assert_eq!(body["cache_read_price_micro"], 0);
        assert_eq!(body["cache_write_price_micro"], 0);

        // slug 重复 → 409
        let (status, body) = create_model(
            &state,
            &cookie,
            json!({
                "slug": "openai/gpt-4o",
                "provider_type": "openai",
                "upstream_model": "x",
                "input_price_cny": "1",
                "output_price_cny": "1",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("已存在"));

        // 坏 slug 各形态 → 400
        for bad in ["noSlash", "a//b", "a/b c"] {
            let (status, _) = create_model(
                &state,
                &cookie,
                json!({
                    "slug": bad,
                    "provider_type": "openai",
                    "upstream_model": "x",
                    "input_price_cny": "1",
                    "output_price_cny": "1",
                }),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "坏 slug 应 400: {bad}");
        }
    }

    #[tokio::test]
    async fn delete_model_keeps_usage() {
        let (state, cookie) = admin_session().await;
        let (status, body) = create_model(
            &state,
            &cookie,
            json!({
                "slug": "openai/gpt-4o",
                "provider_type": "openai",
                "upstream_model": "gpt-4o-real",
                "input_price_cny": "1",
                "output_price_cny": "1",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();
        let slug = body["slug"].as_str().unwrap().to_string();

        // 手插一行 usage_records 引用该 slug
        sqlx::query(
            "INSERT INTO usage_records (id, key_id, model_slug, status, created_at) VALUES (?, 'k1', ?, 'ok', 0)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&slug)
        .execute(&state.db)
        .await
        .unwrap();

        // DELETE → 204
        let resp = app(state.clone())
            .oneshot(authed_request(
                "DELETE",
                &format!("/admin/api/models/{id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // usage 行还在
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM usage_records WHERE model_slug = ?")
                .bind(&slug)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1, "历史账单必须保留");

        // 再 DELETE → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "DELETE",
                &format!("/admin/api/models/{id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn model_patch_status() {
        let (state, cookie) = admin_session().await;
        let (status, body) = create_model(
            &state,
            &cookie,
            json!({
                "slug": "openai/gpt-4o",
                "provider_type": "openai",
                "upstream_model": "gpt-4o-real",
                "input_price_cny": "1",
                "output_price_cny": "1",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();
        assert_eq!(body["status"], "active");

        // active → disabled → 200
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/models/{id}"),
                &cookie,
                Some(json!({"status": "disabled"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "disabled");

        // audit model.update 落行
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='model.update'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1);

        // 不存在 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                "/admin/api/models/nope",
                &cookie,
                Some(json!({"status": "disabled"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/models",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
