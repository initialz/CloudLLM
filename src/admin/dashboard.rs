//! 控制台首页聚合:本月费用/请求量、落账失败计数(P2 告警透出)、Top 模型、渠道总览、近 30 天趋势。
//! 纯只读——不写 audit。本月窗口起点对齐 month_start_epoch。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use std::sync::atomic::Ordering;

pub fn router() -> Router<AppState> {
    Router::new().route("/dashboard", get(dashboard))
}

/// Top 模型条目:本月按 cost 排序的前 5。
#[derive(Serialize, sqlx::FromRow)]
struct TopModel {
    slug: String,
    cost_micro: i64,
    requests: i64,
}

/// 渠道总览条目(全量,健康面板用)。
#[derive(Serialize, sqlx::FromRow)]
struct ChannelRow {
    id: String,
    name: String,
    provider_type: String,
    status: String,
    cooldown_until: Option<i64>,
    weight: i64,
}

/// 近 30 天每日费用/请求量(趋势图;按日期升序)。
#[derive(Serialize, sqlx::FromRow)]
struct DailyRow {
    date: String,
    cost_micro: i64,
    requests: i64,
}

async fn dashboard(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let now = now_epoch();
    let month_start = crate::jobs::month_start_epoch(now);

    // 本月汇总:费用 + 请求数(created_at >= 月首)。
    let (month_cost_micro, month_requests): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(cost_micro), 0), COUNT(*) FROM usage_records WHERE created_at >= ?",
    )
    .bind(month_start)
    .fetch_one(&state.db)
    .await
    .map_err(ApiError::internal)?;

    // 落账失败计数:P2 结算路径累加的进程内计数器(Relaxed 足够,仅做告警展示)。
    let settle_failures = state.settle_failures.load(Ordering::Relaxed) as i64;

    // Top 5 模型:本月按 cost 降序。
    let top_models: Vec<TopModel> = sqlx::query_as(
        "SELECT model_slug AS slug, \
                COALESCE(SUM(cost_micro), 0) AS cost_micro, \
                COUNT(*) AS requests \
         FROM usage_records \
         WHERE created_at >= ? \
         GROUP BY model_slug \
         ORDER BY cost_micro DESC \
         LIMIT 5",
    )
    .bind(month_start)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;

    // 渠道全量:按 created_at,id 升序稳定。
    let channels: Vec<ChannelRow> = sqlx::query_as(
        "SELECT id, name, provider_type, status, cooldown_until, weight \
         FROM channels ORDER BY created_at, id",
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;

    // 近 30 天每日趋势:created_at >= now - 30 天,按日期串升序。
    let since = now - 30 * 86400;
    let daily: Vec<DailyRow> = sqlx::query_as(
        "SELECT date(created_at, 'unixepoch') AS date, \
                COALESCE(SUM(cost_micro), 0) AS cost_micro, \
                COUNT(*) AS requests \
         FROM usage_records \
         WHERE created_at >= ? \
         GROUP BY date \
         ORDER BY date ASC",
    )
    .bind(since)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;

    Ok(Json(serde_json::json!({
        "month_cost_micro": month_cost_micro,
        "month_requests": month_requests,
        "settle_failures": settle_failures,
        "top_models": top_models,
        "channels": channels,
        "daily": daily,
    })))
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json};
    use axum::http::StatusCode;
    use std::sync::atomic::Ordering;
    use tower::ServiceExt;

    async fn insert_usage(db: &sqlx::SqlitePool, model: &str, cost: i64, created_at: i64) {
        sqlx::query(
            "INSERT INTO usage_records (id, key_id, model_slug, cost_micro, status, created_at) \
             VALUES (?, 'k1', ?, ?, 'ok', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(model)
        .bind(cost)
        .bind(created_at)
        .execute(db)
        .await
        .expect("插入用量");
    }

    async fn insert_channel(db: &sqlx::SqlitePool, name: &str) {
        sqlx::query(
            "INSERT INTO channels (id, provider_type, name, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level, created_at) \
             VALUES (?, 'openai', ?, 'https://x/v1', X'00', 3, 'active', NULL, 0, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(name)
        .bind(crate::now_epoch())
        .execute(db)
        .await
        .expect("插入渠道");
    }

    #[tokio::test]
    async fn dashboard_aggregates() {
        let (state, cookie) = admin_session().await;
        let now = crate::now_epoch();
        let month_start = crate::jobs::month_start_epoch(now);

        // 本月内 2 行(不同模型)+ 上月 1 行(月首前 10 秒,落在上月)
        insert_usage(&state.db, "m-a", 500, now).await;
        insert_usage(&state.db, "m-b", 300, now).await;
        insert_usage(&state.db, "m-a", 999, month_start - 10).await;

        // settle_failures 先 +3,断言回显 3
        state.settle_failures.fetch_add(3, Ordering::Relaxed);

        insert_channel(&state.db, "渠道甲").await;

        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/dashboard", &cookie, None))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;

        // month_* 只含本月两行:cost=800,requests=2(上月 999 不计)
        assert_eq!(body["month_cost_micro"], 800);
        assert_eq!(body["month_requests"], 2);

        // settle_failures 回显 3
        assert_eq!(body["settle_failures"], 3);

        // top_models ≤5 且含本月模型(m-a 本月 500 在前,m-b 300 在后)
        let top = body["top_models"].as_array().unwrap();
        assert!(top.len() <= 5);
        assert_eq!(top[0]["slug"], "m-a");
        assert_eq!(top[0]["cost_micro"], 500); // 上月 999 不计入本月 Top
        assert_eq!(top[1]["slug"], "m-b");

        // daily 含今天日期串
        let today = body["daily"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["date"].as_str().map(|s| s.len() == 10).unwrap_or(false));
        assert!(today, "daily 应含今天日期串");

        // channels 含手插渠道,weight/status 回显
        let chs = body["channels"].as_array().unwrap();
        let ch = chs
            .iter()
            .find(|c| c["name"] == "渠道甲")
            .expect("应含渠道甲");
        assert_eq!(ch["provider_type"], "openai");
        assert_eq!(ch["status"], "active");
        assert_eq!(ch["weight"], 3);
        assert!(ch["cooldown_until"].is_null());
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/dashboard",
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
