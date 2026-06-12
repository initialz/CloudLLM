//! 预算资源:列表/下拉数据源/创建/部分更新。
//! 预算主体三类:key/user/team,每个主体每 period 只能有一条(UNIQUE(subject_type,subject_id,period))。
//! subject_label 经三路 LEFT JOIN 取展示名;主体被删后降级回 subject_id(软引用,不阻止删主体)。

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
        .route("/budgets", get(list).post(create))
        .route("/budgets/subjects", get(subjects))
        .route("/budgets/:id", patch(update))
}

/// 列表/回读共用的 SELECT 列;subject_label = CASE subject_type 三路 LEFT JOIN,
/// 主体被删(JOIN 落空)时 COALESCE 降级回 subject_id。
const BUDGET_SELECT: &str = "SELECT b.id, b.subject_type, b.subject_id, \
            COALESCE( \
              CASE b.subject_type \
                WHEN 'user' THEN u.email \
                WHEN 'team' THEN t.name \
                WHEN 'key'  THEN k.key_prefix || ' ' || k.name \
              END, \
              b.subject_id \
            ) AS subject_label, \
            b.period, b.limit_micro, b.used_micro, b.period_start, b.alert_threshold, b.status, b.created_at \
     FROM budgets b \
     LEFT JOIN users u ON b.subject_type = 'user' AND u.id = b.subject_id \
     LEFT JOIN teams t ON b.subject_type = 'team' AND t.id = b.subject_id \
     LEFT JOIN api_keys k ON b.subject_type = 'key' AND k.id = b.subject_id";

/// 出参/列表行;含 JOIN 出来的 subject_label。
#[derive(Serialize, sqlx::FromRow)]
struct BudgetRow {
    id: String,
    subject_type: String,
    subject_id: String,
    subject_label: String,
    period: String,
    limit_micro: i64,
    used_micro: i64,
    period_start: i64,
    alert_threshold: Option<f64>,
    status: String,
    created_at: i64,
}

/// 回读单行(创建后 / PATCH 后),含 subject_label。
async fn fetch_budget_row(db: &sqlx::SqlitePool, id: &str) -> Result<Option<BudgetRow>, ApiError> {
    sqlx::query_as(&format!("{BUDGET_SELECT} WHERE b.id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(ApiError::internal)
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 次级键 id 兜底:created_at 为秒级,同秒创建的行单凭它排序不稳定。降序最新在前。
    let rows: Vec<BudgetRow> = sqlx::query_as(&format!(
        "{BUDGET_SELECT} ORDER BY b.created_at DESC, b.id DESC"
    ))
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "budgets": rows })))
}

/// 下拉候选项:供前端选「给谁建预算」。type/id/label 三字段。
#[derive(Serialize, sqlx::FromRow)]
struct Subject {
    #[sqlx(rename = "subject_type")]
    r#type: String,
    id: String,
    label: String,
}

async fn subjects(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 数据源:active users(label=email)+ 全部 teams(label=name)+ active keys(label=`prefix name`)。
    // UNION ALL 保留三类各自顺序;外层按 subject_type 排成 users→teams→keys,组内按 created_at,id 稳定。
    // subject_type 字面量已是字典序 key<team<user,故显式 CASE 排序避免依赖巧合。
    let rows: Vec<Subject> = sqlx::query_as(
        "SELECT subject_type, id, label, ord FROM ( \
            SELECT 'user' AS subject_type, id, email AS label, 0 AS ord, created_at FROM users WHERE status = 'active' \
            UNION ALL \
            SELECT 'team' AS subject_type, id, name AS label, 1 AS ord, created_at FROM teams \
            UNION ALL \
            SELECT 'key' AS subject_type, id, key_prefix || ' ' || name AS label, 2 AS ord, created_at FROM api_keys WHERE status = 'active' \
         ) ORDER BY ord, created_at, id",
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "subjects": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    subject_type: String,
    subject_id: String,
    period: String,
    limit_cny: String,
    #[serde(default)]
    alert_threshold: Option<f64>,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<BudgetRow>), ApiError> {
    let now = now_epoch();
    // 主体类型必须合法,否则下方的主体存在性查询无表可查。
    let subject_table = match req.subject_type.as_str() {
        "user" => "users",
        "team" => "teams",
        "key" => "api_keys",
        _ => return Err(ApiError::bad_request("无效的主体类型")),
    };
    // 主体必须存在,否则 subject_label 会落到兜底 id 且引用悬空(建即坏)。
    let exists: Option<(String,)> =
        sqlx::query_as(&format!("SELECT id FROM {subject_table} WHERE id = ?"))
            .bind(&req.subject_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
    if exists.is_none() {
        return Err(ApiError::not_found("主体不存在"));
    }
    if !["monthly", "total"].contains(&req.period.as_str()) {
        return Err(ApiError::bad_request("period 必须为 monthly 或 total"));
    }
    // 格式错与「非正数」分两条文案:格式错优先(parse 失败),通过后再判 >0。
    let limit_micro = crate::billing::parse_cny_to_micro(&req.limit_cny)
        .map_err(|_| ApiError::bad_request("限额格式无效(示例: 100 或 100.50,最多 6 位小数)"))?;
    if limit_micro <= 0 {
        return Err(ApiError::bad_request("限额必须为正数"));
    }
    if let Some(t) = req.alert_threshold {
        if !(0.0..=1.0).contains(&t) {
            return Err(ApiError::bad_request("告警阈值必须在 0~1 之间(如 0.8)"));
        }
    }
    // monthly 用月初口径(翻转任务依赖它);total 用创建时刻。
    let period_start = if req.period == "monthly" {
        crate::jobs::month_start_epoch(now)
    } else {
        now
    };

    // 预检唯一约束:同主体同 period 已有 → 409(预检给出更友好的并发外文案)。
    let dup: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM budgets WHERE subject_type = ? AND subject_id = ? AND period = ?",
    )
    .bind(&req.subject_type)
    .bind(&req.subject_id)
    .bind(&req.period)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?;
    if dup.is_some() {
        return Err(ApiError::conflict(format!(
            "该主体已存在 {} 预算,每个主体每 period 只能有一条",
            req.period
        )));
    }

    let id = uuid::Uuid::new_v4().to_string();
    // from_db_unique 兜底:预检与插入间的并发窗口仍可能撞 UNIQUE 约束。
    // conflict_msg 必须 'static,故兜底文案不含 period 插值(预检路径已覆盖含 period 的友好文案)。
    sqlx::query(
        "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, used_micro, period_start, alert_threshold, status, created_at) \
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?)",
    )
    .bind(&id)
    .bind(&req.subject_type)
    .bind(&req.subject_id)
    .bind(&req.period)
    .bind(limit_micro)
    .bind(period_start)
    .bind(req.alert_threshold)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::from_db_unique(e, "该主体该 period 预算已存在,每个主体每 period 只能有一条"))?;

    // audit detail:只记实际写入的字段(alert_threshold 缺省则缺席)。
    let mut detail = serde_json::json!({
        "subject_type": req.subject_type,
        "subject_id": req.subject_id,
        "period": req.period,
        "limit_micro": limit_micro,
    });
    if let Some(t) = req.alert_threshold {
        detail["alert_threshold"] = serde_json::json!(t);
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "budget.create",
        Some(&id),
        detail,
    )
    .await;

    let row = fetch_budget_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("创建后回读预算失败")))?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// 区分「字段缺失」与「显式 null」:缺失=不更新,null=清空。
fn double_option<'de, D>(d: D) -> Result<Option<Option<f64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct UpdateReq {
    #[serde(default)]
    limit_cny: Option<String>,
    // 三态:缺省(None,不动)/ 显式 null(Some(None),清空)/ 值(Some(Some(v)),写入)。
    #[serde(default, deserialize_with = "double_option")]
    alert_threshold: Option<Option<f64>>,
    #[serde(default)]
    status: Option<String>,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<BudgetRow>, ApiError> {
    if req.limit_cny.is_none() && req.alert_threshold.is_none() && req.status.is_none() {
        return Err(ApiError::bad_request("没有需要更新的字段"));
    }

    // limit_cny:同建预算的两条文案(格式错优先,再判 >0)。
    let limit_micro: Option<i64> = match &req.limit_cny {
        Some(cny) => {
            let m = crate::billing::parse_cny_to_micro(cny).map_err(|_| {
                ApiError::bad_request("限额格式无效(示例: 100 或 100.50,最多 6 位小数)")
            })?;
            if m <= 0 {
                return Err(ApiError::bad_request("限额必须为正数"));
            }
            Some(m)
        }
        None => None,
    };
    // alert_threshold:仅在「显式给值」时校验 0~1;显式 null(清空)无需校验。
    if let Some(Some(t)) = req.alert_threshold {
        if !(0.0..=1.0).contains(&t) {
            return Err(ApiError::bad_request("告警阈值必须在 0~1 之间(如 0.8)"));
        }
    }
    if let Some(s) = &req.status {
        if !["active", "disabled"].contains(&s.as_str()) {
            return Err(ApiError::bad_request("无效状态"));
        }
    }

    // 动态构造 PATCH:只写出现的字段;alert_threshold 区分清空(写 NULL)与赋值。
    // SQLite 占位符按出现顺序绑定,故 SET 片段与 bind 顺序严格对应。
    let mut sets: Vec<&str> = Vec::new();
    if limit_micro.is_some() {
        sets.push("limit_micro = ?");
    }
    // alert_threshold:None=不动(不进 SET);Some(_) 进 SET——清空与赋值都写,绑定的值不同。
    if req.alert_threshold.is_some() {
        sets.push("alert_threshold = ?");
    }
    if req.status.is_some() {
        sets.push("status = ?");
    }
    let sql = format!("UPDATE budgets SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(m) = limit_micro {
        q = q.bind(m);
    }
    if let Some(inner) = req.alert_threshold {
        // Some(None) → 绑定 None(写 NULL,清空);Some(Some(v)) → 绑定 v。
        q = q.bind(inner);
    }
    if let Some(s) = &req.status {
        q = q.bind(s);
    }
    let res = q
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("预算不存在"));
    }

    // audit 只记实际写入的字段;alert_threshold 清空记 null、未传则缺席。
    let mut detail = serde_json::Map::new();
    if let Some(m) = limit_micro {
        detail.insert("limit_micro".into(), serde_json::json!(m));
    }
    if let Some(inner) = req.alert_threshold {
        // 清空 → null;赋值 → 数值。两者都记(字段出现表示「确有写入」)。
        detail.insert("alert_threshold".into(), serde_json::json!(inner));
    }
    if let Some(s) = &req.status {
        detail.insert("status".into(), serde_json::json!(s));
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "budget.update",
        Some(&id),
        serde_json::Value::Object(detail),
    )
    .await;

    let row = fetch_budget_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("预算不存在"))?;
    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json, insert_api_key, insert_user};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    /// 经 API 建预算,返回 (status, body)。
    async fn create_budget(
        state: &crate::AppState,
        cookie: &str,
        payload: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/budgets",
                cookie,
                Some(payload),
            ))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    /// 直插一个 team(无 API 助手),返回 team_id。
    async fn insert_team(db: &sqlx::SqlitePool, name: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(name)
            .bind(crate::now_epoch())
            .execute(db)
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn create_budget_full_fields() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "member@x.com", "memberpw1", "user", "active").await;
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({
                "subject_type": "user",
                "subject_id": uid,
                "period": "monthly",
                "limit_cny": "100",
                "alert_threshold": 0.8,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["limit_micro"], 100_000_000_i64);
        assert_eq!(body["used_micro"], 0);
        assert_eq!(
            body["period_start"].as_i64().unwrap(),
            crate::jobs::month_start_epoch(crate::now_epoch())
        );
        assert_eq!(body["subject_label"], "member@x.com");
        assert_eq!(body["alert_threshold"], 0.8);

        // audit budget.create 落行,detail 含 limit_micro 与 alert_threshold
        let (detail,): (String,) =
            sqlx::query_as("SELECT detail FROM audit_events WHERE action='budget.create'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(detail.contains("limit_micro"), "应记 limit_micro: {detail}");
        assert!(
            detail.contains("alert_threshold"),
            "给了阈值应记 alert_threshold: {detail}"
        );
    }

    #[tokio::test]
    async fn create_budget_total_period_start_now() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let before = crate::now_epoch();
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "total", "limit_cny": "50"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        // total:period_start ≈ now(>= 调用前 now)
        assert!(
            body["period_start"].as_i64().unwrap() >= before,
            "total 预算 period_start 应为创建时刻"
        );
        // 缺省 alert_threshold → null
        assert!(body["alert_threshold"].is_null());
    }

    #[tokio::test]
    async fn create_budget_validation() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;

        // 坏 subject_type → 400
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "org", "subject_id": uid, "period": "monthly", "limit_cny": "10"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("主体类型"));

        // 不存在的主体 → 404
        let (status, _) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": "ghost", "period": "monthly", "limit_cny": "10"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 坏 period → 400
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "weekly", "limit_cny": "10"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("monthly"));

        // limit "abc" → 400 格式错
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "monthly", "limit_cny": "abc"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"].as_str().unwrap().contains("格式"));

        // limit "0" → 400 非正数
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "monthly", "limit_cny": "0"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"].as_str().unwrap().contains("正数"));

        // threshold 1.5 → 400
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "monthly", "limit_cny": "10", "alert_threshold": 1.5}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"].as_str().unwrap().contains("0~1"));
    }

    #[tokio::test]
    async fn create_budget_duplicate_conflict() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let payload = json!({"subject_type": "user", "subject_id": uid, "period": "monthly", "limit_cny": "10"});
        let (status, _) = create_budget(&state, &cookie, payload.clone()).await;
        assert_eq!(status, StatusCode::CREATED);
        // 同主体同 period 二次 → 409,文案含 period
        let (status, body) = create_budget(&state, &cookie, payload).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("monthly"),
            "409 文案应含 period: {body}"
        );
    }

    #[tokio::test]
    async fn patch_budget_three_states() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "user", "subject_id": uid, "period": "monthly", "limit_cny": "100", "alert_threshold": 0.5}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();

        let patch = |body: serde_json::Value| {
            let app = app(state.clone());
            let cookie = cookie.clone();
            let id = id.clone();
            async move {
                app.oneshot(authed_request(
                    "PATCH",
                    &format!("/admin/api/budgets/{id}"),
                    &cookie,
                    Some(body),
                ))
                .await
                .unwrap()
            }
        };

        // 只改 limit:200 → 200_000_000,threshold 不动(仍 0.5)
        let resp = patch(json!({"limit_cny": "200"})).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let b = body_json(resp).await;
        assert_eq!(b["limit_micro"], 200_000_000_i64);
        assert_eq!(b["alert_threshold"], 0.5);

        // 显式 alert_threshold: null → 清空(回读 NULL)
        let resp = patch(json!({"alert_threshold": null})).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(body_json(resp).await["alert_threshold"].is_null());
        // 直查库确认列为 NULL
        let (at,): (Option<f64>,) =
            sqlx::query_as("SELECT alert_threshold FROM budgets WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(at.is_none(), "显式 null 应将列清为 NULL");

        // 改 status disabled → 200
        let resp = patch(json!({"status": "disabled"})).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "disabled");

        // 空 patch {} → 400
        let resp = patch(json!({})).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // 不存在 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                "/admin/api/budgets/nope",
                &cookie,
                Some(json!({"status": "active"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn budgets_subjects_dropdown() {
        let (state, cookie) = admin_session().await;
        // admin@x.com 已由 admin_session 建,再加一个 active user 与一个 disabled user
        let uid = insert_user(&state.db, "active@x.com", "memberpw1", "user", "active").await;
        insert_user(&state.db, "off@x.com", "memberpw1", "user", "disabled").await;
        let tid = insert_team(&state.db, "团队甲").await;
        let (kid, _) = insert_api_key(&state.db, "user", &uid, None, false, "active", None).await;

        let resp = app(state.clone())
            .oneshot(authed_request(
                "GET",
                "/admin/api/budgets/subjects",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        let subjects = body["subjects"].as_array().unwrap();

        // disabled user 不出现
        assert!(
            !subjects.iter().any(|s| s["label"] == "off@x.com"),
            "disabled user 不应出现在下拉"
        );
        // user(active@x.com)出现,type=user label=email
        let u = subjects
            .iter()
            .find(|s| s["id"] == uid)
            .expect("active user 应在下拉");
        assert_eq!(u["type"], "user");
        assert_eq!(u["label"], "active@x.com");
        // team 出现,label=name
        let t = subjects
            .iter()
            .find(|s| s["id"] == tid)
            .expect("team 应在下拉");
        assert_eq!(t["type"], "team");
        assert_eq!(t["label"], "团队甲");
        // key 出现,label="prefix name" 格式
        let k = subjects
            .iter()
            .find(|s| s["id"] == kid)
            .expect("key 应在下拉");
        assert_eq!(k["type"], "key");
        let label = k["label"].as_str().unwrap();
        assert!(
            label.contains(' ') && label.ends_with("test-key"),
            "key label 应为 `prefix name` 格式: {label}"
        );
        // 顺序:users 在 teams 前,teams 在 keys 前
        let pos = |id: &str| subjects.iter().position(|s| s["id"] == id).unwrap();
        assert!(pos(&uid) < pos(&tid), "users 应排在 teams 前");
        assert!(pos(&tid) < pos(&kid), "teams 应排在 keys 前");
    }

    #[tokio::test]
    async fn subject_label_degrades_after_delete() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "owner@x.com", "memberpw1", "user", "active").await;
        let (kid, _) = insert_api_key(&state.db, "user", &uid, None, false, "active", None).await;
        // 对 key 建预算
        let (status, body) = create_budget(
            &state,
            &cookie,
            json!({"subject_type": "key", "subject_id": kid, "period": "monthly", "limit_cny": "10"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        // 建时 subject_label 为 "prefix name"
        assert!(body["subject_label"]
            .as_str()
            .unwrap()
            .ends_with("test-key"));

        // 手工删 api_keys 行 → subject_label 降级回 subject_id
        sqlx::query("DELETE FROM api_keys WHERE id = ?")
            .bind(&kid)
            .execute(&state.db)
            .await
            .unwrap();
        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/budgets", &cookie, None))
            .await
            .unwrap();
        let list = body_json(resp).await;
        assert_eq!(
            list["budgets"][0]["subject_label"], kid,
            "删主体后应降级回 subject_id"
        );
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/budgets",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
