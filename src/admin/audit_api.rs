//! 双审计流:请求审计(usage_records 中带请求/响应体的行)+ 操作审计(audit_events)。
//! 纯只读——本身不写 audit。展示名经 LEFT JOIN 取(主体被删则降级回 id / null)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::AppState;
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/audit/requests", get(requests))
        .route("/audit/events", get(events))
}

/// 分页缺省 50,上限 100;超传按 100 截顶。offset 缺省 0。
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;

/// 把可选 limit 收敛到 (0, 100]:缺省 50,超上限按 100。
fn clamp_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(n) if n > MAX_LIMIT => MAX_LIMIT,
        Some(n) if n > 0 => n,
        _ => DEFAULT_LIMIT,
    }
}

/// 请求审计查询:可选 key_id 过滤 + 分页。
#[derive(Deserialize)]
struct RequestQuery {
    #[serde(default)]
    key_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

/// 请求审计行:仅带请求/响应体的 usage_records;key_label 经 LEFT JOIN 取。
#[derive(Serialize, sqlx::FromRow)]
struct RequestRow {
    id: String,
    created_at: i64,
    model_slug: String,
    key_label: String,
    cost_micro: i64,
    status: String,
    request_body: Option<String>,
    response_body: Option<String>,
}

async fn requests(
    _user: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<RequestQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = clamp_limit(q.limit);
    let offset = q.offset.filter(|n| *n >= 0).unwrap_or(0);

    // 仅取带体的行(audit Key 才存体);可选 key_id 过滤。
    // key_label:LEFT JOIN api_keys,Key 删则降级回 key_id。
    // created_at 降序、id 次级:同秒行稳定。
    let rows: Vec<RequestRow> = sqlx::query_as(
        "SELECT u.id, u.created_at, u.model_slug, \
                COALESCE(k.key_prefix || ' ' || k.name, u.key_id) AS key_label, \
                u.cost_micro, u.status, u.request_body, u.response_body \
         FROM usage_records u \
         LEFT JOIN api_keys k ON k.id = u.key_id \
         WHERE (u.request_body IS NOT NULL OR u.response_body IS NOT NULL) \
           AND (? IS NULL OR u.key_id = ?) \
         ORDER BY u.created_at DESC, u.id DESC \
         LIMIT ? OFFSET ?",
    )
    .bind(&q.key_id)
    .bind(&q.key_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

/// 操作审计查询:仅分页。
#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

/// 操作审计行:actor_email 经 LEFT JOIN users 取(actor_user_id NULL 或用户已删 → null)。
#[derive(Serialize, sqlx::FromRow)]
struct EventRow {
    id: String,
    actor_email: Option<String>,
    action: String,
    subject: Option<String>,
    detail: Option<String>,
    created_at: i64,
}

async fn events(
    _user: AdminUser,
    State(state): State<AppState>,
    Query(q): Query<EventQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = clamp_limit(q.limit);
    let offset = q.offset.filter(|n| *n >= 0).unwrap_or(0);

    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT e.id, u.email AS actor_email, e.action, e.subject, e.detail, e.created_at \
         FROM audit_events e \
         LEFT JOIN users u ON u.id = e.actor_user_id \
         ORDER BY e.created_at DESC, e.id DESC \
         LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json, insert_api_key, insert_user};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    /// 插一行 usage_records;has_body 决定是否带请求/响应体。
    async fn insert_usage(db: &sqlx::SqlitePool, key_id: &str, has_body: bool, created_at: i64) {
        let (req, resp): (Option<&str>, Option<&str>) = if has_body {
            (Some("REQ"), Some("RESP"))
        } else {
            (None, None)
        };
        sqlx::query(
            "INSERT INTO usage_records (id, key_id, model_slug, cost_micro, status, request_body, response_body, created_at) \
             VALUES (?, ?, 'm1', 10, 'ok', ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(key_id)
        .bind(req)
        .bind(resp)
        .bind(created_at)
        .execute(db)
        .await
        .expect("插入用量");
    }

    async fn get(
        state: &crate::AppState,
        cookie: &str,
        uri: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request("GET", uri, cookie, None))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[tokio::test]
    async fn audit_requests_filters_and_caps() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "o@x.com", "memberpw1", "user", "active").await;
        let (k1, _) = insert_api_key(&state.db, "user", &uid, None, true, "active", None).await;
        let (k2, _) = insert_api_key(&state.db, "user", &uid, None, true, "active", None).await;

        // 2 行有体(k1、k2 各一)+ 1 行无体(k1)→ 无体行不出现
        insert_usage(&state.db, &k1, true, 1000).await;
        insert_usage(&state.db, &k2, true, 1001).await;
        insert_usage(&state.db, &k1, false, 1002).await;

        // 默认:仅 2 行有体
        let (st, body) = get(&state, &cookie, "/admin/api/audit/requests").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["rows"].as_array().unwrap().len(), 2, "无体行应被排除");
        // key_label 为 `prefix name`
        let lbl = body["rows"][0]["key_label"].as_str().unwrap();
        assert!(
            lbl.ends_with("test-key"),
            "key_label 应为 prefix name: {lbl}"
        );

        // key_id 过滤:仅 k1 的有体行(1 行)
        let (st, body) = get(
            &state,
            &cookie,
            &format!("/admin/api/audit/requests?key_id={k1}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["rows"].as_array().unwrap().len(),
            1,
            "key_id 过滤应只留 k1 有体行"
        );

        // cap:插 102 行有体(共 104 行),limit=200 实传 → 返回 ≤100
        for i in 0..102 {
            insert_usage(&state.db, &k1, true, 2000 + i).await;
        }
        let (st, body) = get(&state, &cookie, "/admin/api/audit/requests?limit=200").await;
        assert_eq!(st, StatusCode::OK);
        let n = body["rows"].as_array().unwrap().len();
        assert!(n <= 100, "limit 上限应为 100,实际 {n}");
        assert_eq!(n, 100, "104 行有体、limit=200 截顶应返回 100");
    }

    #[tokio::test]
    async fn audit_requests_default_limit_50() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "o@x.com", "memberpw1", "user", "active").await;
        let (k1, _) = insert_api_key(&state.db, "user", &uid, None, true, "active", None).await;
        // 60 行有体,缺省 limit → 50
        for i in 0..60 {
            insert_usage(&state.db, &k1, true, 3000 + i).await;
        }
        let (st, body) = get(&state, &cookie, "/admin/api/audit/requests").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["rows"].as_array().unwrap().len(),
            50,
            "缺省 limit 应为 50"
        );
    }

    #[tokio::test]
    async fn audit_events_actor_email() {
        let (state, cookie) = admin_session().await;
        // 走真实 API 建用户 → 产生 user.create 事件,actor=admin
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/users",
                &cookie,
                Some(json!({"email": "newbie@x.com", "password": "memberpw1"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // 手插一行 actor_user_id=NULL 的事件 → actor_email==null
        sqlx::query(
            "INSERT INTO audit_events (id, actor_user_id, action, subject, detail, created_at) \
             VALUES (?, NULL, 'system.tick', NULL, NULL, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(crate::now_epoch())
        .execute(&state.db)
        .await
        .unwrap();

        let (st, body) = get(&state, &cookie, "/admin/api/audit/events").await;
        assert_eq!(st, StatusCode::OK);
        let rows = body["rows"].as_array().unwrap();

        // user.create 行 actor_email == admin@x.com
        let create = rows
            .iter()
            .find(|r| r["action"] == "user.create")
            .expect("应含 user.create 事件");
        assert_eq!(create["actor_email"], "admin@x.com");

        // system.tick 行 actor_email == null(actor_user_id NULL)
        let tick = rows
            .iter()
            .find(|r| r["action"] == "system.tick")
            .expect("应含 system.tick 事件");
        assert!(tick["actor_email"].is_null(), "NULL actor 应回 null email");
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        for uri in ["/admin/api/audit/requests", "/admin/api/audit/events"] {
            let resp = app(state.clone())
                .oneshot(crate::test_util::json_request("GET", uri, json!({})))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
    }
}
