//! 报表聚合:按模型/Key/天三维度对 usage_records 做时间窗内 GROUP BY 聚合。
//! 纯只读查询——不写 audit。展示名经 LEFT JOIN api_keys 取(Key 被删则降级回 key_id)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::AppState;
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new().route("/reports", get(reports))
}

/// 查询参数:dimension 枚举 + 必填时间窗 [from, to)(epoch 秒)。
/// from/to 缺失时 Query 反序列化失败 → 经 WithRejection 映射为 400。
#[derive(Deserialize)]
struct ReportQuery {
    dimension: String,
    from: i64,
    to: i64,
}

/// 聚合行;bucket 随维度而异(模型 slug / `prefix name` / YYYY-MM-DD 日期串)。
#[derive(Serialize, sqlx::FromRow)]
struct ReportRow {
    bucket: String,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    cost_micro: i64,
}

async fn reports(
    _user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Query(q), _): WithRejection<Query<ReportQuery>, ApiError>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 时间窗必须有正跨度;from>=to 无意义(空窗或反窗)。
    if q.from >= q.to {
        return Err(ApiError::bad_request("时间窗无效"));
    }

    // 三维度各自的 bucket 表达式与排序:
    // - model:bucket=model_slug,按 cost 降序(花钱多的在前)
    // - key:  bucket=`prefix name`(LEFT JOIN,Key 删则降级回 key_id),按 cost 降序
    // - day:  bucket=date(created_at),按日期串升序(趋势图按时间轴)
    // 共用聚合列;仅 SELECT 的 bucket 表达式、FROM 的 JOIN、GROUP BY/ORDER BY 不同。
    let sql = match q.dimension.as_str() {
        "model" => {
            "SELECT u.model_slug AS bucket, \
                    COUNT(*) AS requests, \
                    COALESCE(SUM(u.input_tokens), 0)       AS input_tokens, \
                    COALESCE(SUM(u.output_tokens), 0)      AS output_tokens, \
                    COALESCE(SUM(u.cache_read_tokens), 0)  AS cache_read_tokens, \
                    COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens, \
                    COALESCE(SUM(u.cost_micro), 0)         AS cost_micro \
             FROM usage_records u \
             WHERE u.created_at >= ? AND u.created_at < ? \
             GROUP BY bucket \
             ORDER BY cost_micro DESC"
        }
        "key" => {
            "SELECT COALESCE(k.key_prefix || ' ' || k.name, u.key_id) AS bucket, \
                    COUNT(*) AS requests, \
                    COALESCE(SUM(u.input_tokens), 0)       AS input_tokens, \
                    COALESCE(SUM(u.output_tokens), 0)      AS output_tokens, \
                    COALESCE(SUM(u.cache_read_tokens), 0)  AS cache_read_tokens, \
                    COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens, \
                    COALESCE(SUM(u.cost_micro), 0)         AS cost_micro \
             FROM usage_records u \
             LEFT JOIN api_keys k ON k.id = u.key_id \
             WHERE u.created_at >= ? AND u.created_at < ? \
             GROUP BY bucket \
             ORDER BY cost_micro DESC"
        }
        "day" => {
            "SELECT date(u.created_at, 'unixepoch') AS bucket, \
                    COUNT(*) AS requests, \
                    COALESCE(SUM(u.input_tokens), 0)       AS input_tokens, \
                    COALESCE(SUM(u.output_tokens), 0)      AS output_tokens, \
                    COALESCE(SUM(u.cache_read_tokens), 0)  AS cache_read_tokens, \
                    COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens, \
                    COALESCE(SUM(u.cost_micro), 0)         AS cost_micro \
             FROM usage_records u \
             WHERE u.created_at >= ? AND u.created_at < ? \
             GROUP BY bucket \
             ORDER BY bucket ASC"
        }
        _ => return Err(ApiError::bad_request("无效维度")),
    };

    let rows: Vec<ReportRow> = sqlx::query_as(sql)
        .bind(q.from)
        .bind(q.to)
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
    use tower::ServiceExt;

    /// 直插一行 usage_records(报表只读这些列)。created_at 决定落入哪个时间窗/哪天。
    #[allow(clippy::too_many_arguments)]
    async fn insert_usage(
        db: &sqlx::SqlitePool,
        key_id: &str,
        model_slug: &str,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
        cost: i64,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO usage_records \
             (id, key_id, model_slug, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro, status, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(key_id)
        .bind(model_slug)
        .bind(input)
        .bind(output)
        .bind(cache_read)
        .bind(cache_write)
        .bind(cost)
        .bind(created_at)
        .execute(db)
        .await
        .expect("插入用量");
    }

    /// GET /admin/api/reports?... 取 (status, body)。
    async fn get_reports(
        state: &crate::AppState,
        cookie: &str,
        query: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "GET",
                &format!("/admin/api/reports?{query}"),
                cookie,
                None,
            ))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    // 确定的两天:day1 在第 N 天内,day2 在第 N+1 天内(各取当天正午,避开边界)。
    const DAY1: i64 = 86400 * 20000 + 43200; // 某天正午
    const DAY2: i64 = 86400 * 20001 + 43200; // 次日正午

    #[tokio::test]
    async fn reports_three_dimensions() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "o@x.com", "memberpw1", "user", "active").await;
        let (k1, _) = insert_api_key(&state.db, "user", &uid, None, false, "active", None).await;
        let (k2, _) = insert_api_key(&state.db, "user", &uid, None, false, "active", None).await;

        // 4 行:两模型 / 两 Key / 跨两天;cache tokens 非零。
        // m-pricey 总 cost 高于 m-cheap,用于验证 model 维度降序。
        insert_usage(&state.db, &k1, "m-cheap", 10, 5, 1, 2, 100, DAY1).await;
        insert_usage(&state.db, &k1, "m-pricey", 20, 10, 3, 4, 900, DAY1).await;
        insert_usage(&state.db, &k2, "m-cheap", 30, 15, 5, 6, 50, DAY2).await;
        insert_usage(&state.db, &k2, "m-pricey", 40, 20, 7, 8, 700, DAY2).await;

        let from = DAY1 - 86400;
        let to = DAY2 + 86400;

        // dimension=model:两行,按 cost 降序(m-pricey=1600 在前,m-cheap=150 在后)
        let (st, body) = get_reports(
            &state,
            &cookie,
            &format!("dimension=model&from={from}&to={to}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let rows = body["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["bucket"], "m-pricey");
        assert_eq!(rows[0]["cost_micro"], 1600);
        assert_eq!(rows[0]["requests"], 2);
        assert_eq!(rows[0]["input_tokens"], 60); // 20+40
        assert_eq!(rows[0]["cache_read_tokens"], 10); // 3+7
        assert_eq!(rows[0]["cache_write_tokens"], 12); // 4+8
        assert_eq!(rows[1]["bucket"], "m-cheap");
        assert_eq!(rows[1]["cost_micro"], 150);

        // dimension=key:两行,bucket="prefix name",按 cost 降序
        let (st, body) = get_reports(
            &state,
            &cookie,
            &format!("dimension=key&from={from}&to={to}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let rows = body["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        // k1 cost=1000,k2 cost=750 → k1 在前
        let top = rows[0]["bucket"].as_str().unwrap();
        assert!(
            top.contains(' ') && top.ends_with("test-key"),
            "key bucket 应为 `prefix name`: {top}"
        );
        assert_eq!(rows[0]["cost_micro"], 1000);
        assert_eq!(rows[1]["cost_micro"], 750);

        // dimension=day:两天,按日期串升序;格式 YYYY-MM-DD
        let (st, body) = get_reports(
            &state,
            &cookie,
            &format!("dimension=day&from={from}&to={to}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let rows = body["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let d0 = rows[0]["bucket"].as_str().unwrap();
        let d1 = rows[1]["bucket"].as_str().unwrap();
        assert_eq!(d0.len(), 10, "日期串应为 YYYY-MM-DD: {d0}");
        assert_eq!(&d0[4..5], "-");
        assert!(d0 < d1, "day 维度应按日期升序: {d0} vs {d1}");
        // 第一天 = m-cheap(100)+m-pricey(900) = 1000
        assert_eq!(rows[0]["cost_micro"], 1000);
        assert_eq!(rows[0]["requests"], 2);
        assert_eq!(rows[1]["cost_micro"], 750);
    }

    #[tokio::test]
    async fn reports_window_filters() {
        let (state, cookie) = admin_session().await;
        // 窗内一行 + 窗外一行(更早)
        insert_usage(&state.db, "k1", "m1", 10, 5, 0, 0, 100, DAY1).await;
        insert_usage(&state.db, "k1", "m1", 10, 5, 0, 0, 999, DAY1 - 86400 * 5).await;

        let from = DAY1 - 3600;
        let to = DAY1 + 3600;
        let (st, body) = get_reports(
            &state,
            &cookie,
            &format!("dimension=model&from={from}&to={to}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        let rows = body["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "窗外行不应计入");
        assert_eq!(rows[0]["cost_micro"], 100);
        assert_eq!(rows[0]["requests"], 1);
    }

    #[tokio::test]
    async fn reports_validation() {
        let (state, cookie) = admin_session().await;

        // 坏 dimension → 400「无效维度」
        let (st, body) = get_reports(&state, &cookie, "dimension=bogus&from=0&to=100").await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("无效维度"));

        // from >= to → 400「时间窗无效」
        let (st, body) = get_reports(&state, &cookie, "dimension=model&from=100&to=100").await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("时间窗无效"));

        // 缺 from → Query 反序列化失败 → 400
        let (st, _) = get_reports(&state, &cookie, "dimension=model&to=100").await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn reports_key_dimension_degrades() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "o@x.com", "memberpw1", "user", "active").await;
        let (kid, _) = insert_api_key(&state.db, "user", &uid, None, false, "active", None).await;
        insert_usage(&state.db, &kid, "m1", 10, 5, 0, 0, 100, DAY1).await;

        // 删 api_keys 行 → LEFT JOIN 落空 → bucket 降级回 key_id
        sqlx::query("DELETE FROM api_keys WHERE id = ?")
            .bind(&kid)
            .execute(&state.db)
            .await
            .unwrap();

        let from = DAY1 - 3600;
        let to = DAY1 + 3600;
        let (st, body) = get_reports(
            &state,
            &cookie,
            &format!("dimension=key&from={from}&to={to}"),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            body["rows"][0]["bucket"], kid,
            "删 Key 后 bucket 应降级回 key_id"
        );
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/reports?dimension=model&from=0&to=1",
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
