//! API Key 资源:列表/签发/吊销/审计开关。
//! 签发是单事务(INSERT api_keys + 可选 INSERT budgets);明文与 handout 仅签发响应一次返回,
//! 之后永不可回读(库里只存 sha256 哈希)。明文/哈希绝不进 audit detail 与日志。

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
        .route("/keys", get(list).post(create))
        .route("/keys/:id/revoke", post(revoke))
        .route("/keys/:id", patch(update))
}

/// 列表/签发响应共用的 Key 行。owner_label 经 LEFT JOIN 取 email/name,allowed_models 反序列化为数组或 null。
#[derive(Serialize)]
struct KeyRow {
    id: String,
    key_prefix: String,
    name: String,
    owner_type: String,
    owner_id: String,
    owner_label: String,
    allowed_models: Option<serde_json::Value>,
    audit: bool,
    expires_at: Option<i64>,
    status: String,
    created_at: i64,
}

/// 直读库行(allowed_models 取原始 TEXT,audit 取 INTEGER),再转 KeyRow 出参。
#[derive(sqlx::FromRow)]
struct KeyRowRaw {
    id: String,
    key_prefix: String,
    name: String,
    owner_type: String,
    owner_id: String,
    owner_label: Option<String>,
    allowed_models: Option<String>,
    audit: i64,
    expires_at: Option<i64>,
    status: String,
    created_at: i64,
}

/// 列表与回读共用的 SELECT 列(含 owner_label 的 LEFT JOIN COALESCE)。
const KEY_SELECT: &str = "SELECT k.id, k.key_prefix, k.name, k.owner_type, k.owner_id, \
            COALESCE(u.email, t.name, k.owner_id) AS owner_label, \
            k.allowed_models, k.audit, k.expires_at, k.status, k.created_at \
     FROM api_keys k \
     LEFT JOIN users u ON k.owner_type = 'user' AND u.id = k.owner_id \
     LEFT JOIN teams t ON k.owner_type = 'team' AND t.id = k.owner_id";

/// 回读单行 Key(签发后 / PATCH 后)。owner_label = COALESCE(用户邮箱, 团队名, owner_id 兜底)。
async fn fetch_key_row(db: &sqlx::SqlitePool, id: &str) -> Result<Option<KeyRow>, ApiError> {
    let row: Option<KeyRowRaw> = sqlx::query_as(&format!("{KEY_SELECT} WHERE k.id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(ApiError::internal)?;
    Ok(row.map(row_to_key))
}

/// 库行转出参行;allowed_models 文本反序列化为 JSON 数组(NULL→null)。
fn row_to_key(r: KeyRowRaw) -> KeyRow {
    KeyRow {
        id: r.id,
        key_prefix: r.key_prefix,
        name: r.name,
        owner_type: r.owner_type,
        owner_id: r.owner_id,
        owner_label: r.owner_label.unwrap_or_default(),
        allowed_models: r
            .allowed_models
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
        audit: r.audit != 0,
        expires_at: r.expires_at,
        status: r.status,
        created_at: r.created_at,
    }
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 次级键 id 兜底:created_at 为秒级,同秒签发的行单凭它排序不稳定。降序最新在前。
    let rows: Vec<KeyRowRaw> = sqlx::query_as(&format!(
        "{KEY_SELECT} ORDER BY k.created_at DESC, k.id DESC"
    ))
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    let keys: Vec<KeyRow> = rows.into_iter().map(row_to_key).collect();
    Ok(Json(serde_json::json!({ "keys": keys })))
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
    owner_type: String,
    owner_id: String,
    #[serde(default)]
    allowed_models: Option<Vec<String>>,
    #[serde(default)]
    audit: Option<bool>,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    budget_limit_cny: Option<String>,
    #[serde(default)]
    budget_period: Option<String>,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let now = now_epoch();
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("名称不能为空"));
    }
    if !["user", "team"].contains(&req.owner_type.as_str()) {
        return Err(ApiError::bad_request("无效主体类型"));
    }
    // 主体必须存在,否则 owner_label 会落到兜底 id 上且引用悬空。
    let owner_table = if req.owner_type == "user" {
        "users"
    } else {
        "teams"
    };
    let owner_exists: Option<(String,)> =
        sqlx::query_as(&format!("SELECT id FROM {owner_table} WHERE id = ?"))
            .bind(&req.owner_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
    if owner_exists.is_none() {
        return Err(ApiError::not_found("主体不存在"));
    }

    // allowed_models:空数组 / 缺省 = NULL(不限);否则逐 slug 校验存在于 models。
    let allowed: Option<Vec<String>> = match req.allowed_models {
        Some(v) if !v.is_empty() => {
            for slug in &v {
                let m: Option<(String,)> = sqlx::query_as("SELECT slug FROM models WHERE slug = ?")
                    .bind(slug)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(ApiError::internal)?;
                if m.is_none() {
                    return Err(ApiError::bad_request(format!("模型 {slug} 不存在")));
                }
            }
            Some(v)
        }
        _ => None,
    };

    // 过期时间必须是未来(传 None 表示永不过期)。
    if let Some(exp) = req.expires_at {
        if exp <= now {
            return Err(ApiError::bad_request("过期时间必须是未来时间"));
        }
    }

    // 预算可选;给了 budget_limit_cny 才落 budgets 行。
    let mut budget_micro: Option<i64> = None;
    let mut period = String::from("monthly");
    if let Some(cny) = req.budget_limit_cny.as_deref() {
        period = req
            .budget_period
            .clone()
            .unwrap_or_else(|| "monthly".into());
        if !["monthly", "total"].contains(&period.as_str()) {
            return Err(ApiError::bad_request("预算周期必须为 monthly 或 total"));
        }
        // 格式错与「非正数」分两条文案:格式错优先(parse 失败),通过后再判 >0。
        let micro = crate::billing::parse_cny_to_micro(cny).map_err(|_| {
            ApiError::bad_request("预算金额格式无效(示例: 100 或 100.50,最多 6 位小数)")
        })?;
        if micro <= 0 {
            return Err(ApiError::bad_request("预算限额必须为正数"));
        }
        budget_micro = Some(micro);
    }

    let gen = crate::crypto::generate_api_key();
    let key_id = uuid::Uuid::new_v4().to_string();
    let allowed_json = allowed
        .as_ref()
        .map(|v| serde_json::to_string(v).expect("序列化白名单"));
    // 单事务:api_keys + (可选) budgets 一起落,失败整体回滚(无孤儿 budgets)。
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO api_keys (id, key_hash, key_prefix, name, owner_type, owner_id, allowed_models, audit, status, expires_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .bind(&key_id)
    .bind(&gen.key_hash)
    .bind(&gen.key_prefix)
    .bind(&name)
    .bind(&req.owner_type)
    .bind(&req.owner_id)
    .bind(&allowed_json)
    .bind(req.audit.unwrap_or(false) as i64)
    .bind(req.expires_at)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some(limit_micro) = budget_micro {
        // monthly 用月初口径作 period_start(翻转任务依赖它);total 用签发时刻。
        let period_start = if period == "monthly" {
            crate::jobs::month_start_epoch(now)
        } else {
            now
        };
        sqlx::query(
            "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, used_micro, period_start, alert_threshold, status, created_at) \
             VALUES (?, 'key', ?, ?, ?, 0, ?, NULL, 'active', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&key_id)
        .bind(&period)
        .bind(limit_micro)
        .bind(period_start)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;

    // handout 网关地址:优先配置的对外地址;未配置时回退 http://localhost:{listen 端口}。
    let (gateway_url, gateway_url_configured) = match &state.config.gateway_public_url {
        Some(u) => (u.clone(), true),
        None => {
            let port = state.config.listen.rsplit(':').next().unwrap_or("7200");
            (format!("http://localhost:{port}"), false)
        }
    };
    let handout = super::handout::build_handout(
        &gateway_url,
        &gen.plaintext,
        allowed.as_deref().unwrap_or(&[]),
    );

    // audit detail:绝不含明文/hash;有预算才放 budget_micro。
    let mut detail = serde_json::json!({
        "name": name,
        "owner_type": req.owner_type,
        "owner_id": req.owner_id,
    });
    if let Some(m) = budget_micro {
        detail["budget_micro"] = serde_json::json!(m);
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "key.create",
        Some(&key_id),
        detail,
    )
    .await;

    // 回读完整行(含 owner_label),与列表行结构一致。
    let row = fetch_key_row(&state.db, &key_id)
        .await?
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("签发后回读 Key 失败")))?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "plaintext": gen.plaintext,
            "handout": handout,
            "gateway_url_configured": gateway_url_configured,
            "key": row,
        })),
    ))
}

async fn revoke(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 幂等:已 disabled 再 revoke 仍 200;仅「不存在」回 404。
    let res = sqlx::query("UPDATE api_keys SET status = 'disabled' WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        // rows_affected 0 可能是「不存在」或「已是 disabled 但值未变」;SQLite 下 UPDATE 命中行即计 1,
        // 故 0 行只可能是不存在。
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM api_keys WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
        if exists.is_none() {
            return Err(ApiError::not_found("Key 不存在"));
        }
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "key.revoke",
        Some(&id),
        serde_json::json!({}),
    )
    .await;
    Ok(Json(serde_json::json!({ "status": "disabled" })))
}

#[derive(Deserialize)]
struct UpdateReq {
    audit: bool,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<KeyRow>, ApiError> {
    let res = sqlx::query("UPDATE api_keys SET audit = ? WHERE id = ?")
        .bind(req.audit as i64)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        // 命中行即计 1(即便 audit 值未变);0 行只可能是不存在。
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM api_keys WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
        if exists.is_none() {
            return Err(ApiError::not_found("Key 不存在"));
        }
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "key.update",
        Some(&id),
        serde_json::json!({"audit": req.audit}),
    )
    .await;
    let row = fetch_key_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Key 不存在"))?;
    Ok(Json(row))
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{
        admin_session, authed_request, body_json, insert_channel, insert_model, insert_user,
    };
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use serde_json::json;
    use tower::ServiceExt;

    /// 经 API 签发一把 Key,返回 (响应 status, 响应 body)。
    async fn create_key(
        state: &crate::AppState,
        cookie: &str,
        payload: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/keys",
                cookie,
                Some(payload),
            ))
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[tokio::test]
    async fn create_key_returns_plaintext_once_and_handout() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "member@x.com", "memberpw1", "user", "active").await;
        insert_model(
            &state.db,
            "openai/gpt-4o",
            "openai",
            "gpt-4o-real",
            1,
            1,
            0,
            0,
        )
        .await;

        let (status, body) = create_key(
            &state,
            &cookie,
            json!({
                "name": "测试 Key",
                "owner_type": "user",
                "owner_id": uid,
                "allowed_models": ["openai/gpt-4o"],
                "budget_limit_cny": "100",
                "budget_period": "monthly",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let plaintext = body["plaintext"].as_str().unwrap();
        assert!(plaintext.starts_with("sk-cloudllm-"));
        // handout 含明文;gateway_url_configured 字段存在
        assert!(body["handout"].as_str().unwrap().contains(plaintext));
        assert!(body["gateway_url_configured"].is_boolean());
        // key 行含 owner_label = user email,allowed_models 反序列化为数组
        assert_eq!(body["key"]["owner_label"], "member@x.com");
        assert_eq!(body["key"]["allowed_models"][0], "openai/gpt-4o");

        let key_id = body["key"]["id"].as_str().unwrap().to_string();
        // budgets 落行:subject_type='key',limit_micro=100_000_000,period_start==month_start_epoch(now)
        let (subj_type, limit_micro, period_start): (String, i64, i64) = sqlx::query_as(
            "SELECT subject_type, limit_micro, period_start FROM budgets WHERE subject_id = ?",
        )
        .bind(&key_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(subj_type, "key");
        assert_eq!(limit_micro, 100_000_000);
        assert_eq!(
            period_start,
            crate::jobs::month_start_epoch(crate::now_epoch())
        );

        // audit key.create 落行且 detail 不含明文
        let (detail,): (String,) =
            sqlx::query_as("SELECT detail FROM audit_events WHERE action='key.create'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(
            !detail.contains("sk-cloudllm-"),
            "audit detail 绝不含明文: {detail}"
        );
        assert!(detail.contains("budget_micro"), "有预算应记 budget_micro");

        // 列表 GET 响应序列化串不含 plaintext(明文永不回读)
        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/keys", &cookie, None))
            .await
            .unwrap();
        let list = body_json(resp).await;
        assert!(!list.to_string().contains(plaintext), "列表不得回显明文");
        assert_eq!(list["keys"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_key_invalid_budget_no_orphan() {
        // budget_limit_cny 格式错 → 400 且 api_keys 0 行(事务前校验,无孤儿)。
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "user", "owner_id": uid, "budget_limit_cny": "abc"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"].as_str().unwrap().contains("格式"));
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM api_keys")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 0, "校验失败不得落 api_keys 行");
    }

    #[tokio::test]
    async fn create_key_validation_errors() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;

        // 未知主体 → 404
        let (status, _) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "user", "owner_id": "ghost"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 未知模型 → 400「模型 {slug} 不存在」
        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "user", "owner_id": uid, "allowed_models": ["openai/nope"]}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("不存在"));

        // 过期时间在过去 → 400
        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "user", "owner_id": uid, "expires_at": 1}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"].as_str().unwrap().contains("未来"));

        // 无效预算周期 → 400
        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "user", "owner_id": uid, "budget_limit_cny": "10", "budget_period": "weekly"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("monthly"));

        // 名称空 → 400;无效主体类型 → 400
        let (status, _) = create_key(
            &state,
            &cookie,
            json!({"name": "   ", "owner_type": "user", "owner_id": uid}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = create_key(
            &state,
            &cookie,
            json!({"name": "x", "owner_type": "org", "owner_id": uid}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn revoked_key_rejected_by_gateway() {
        // 端到端:签发 → 网关接受(非 401)→ revoke → 网关 401 invalid_api_key → 再 revoke 幂等 200。
        let (state, cookie) = admin_session().await;
        let mk = state.config.master_key_bytes();
        insert_channel(
            &state.db,
            &mk,
            "openai",
            "http://127.0.0.1:1/v1", // 上游不可达;只验证鉴权层是否放行(非 401 即可)
            "sk-up",
            1,
            "active",
        )
        .await;
        let slug = insert_model(&state.db, "gpt-x", "openai", "gpt-4o-real", 1, 1, 0, 0).await;
        let uid = insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;

        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "e2e", "owner_type": "user", "owner_id": uid}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let plaintext = body["plaintext"].as_str().unwrap().to_string();
        let key_id = body["key"]["id"].as_str().unwrap().to_string();

        // 用明文打网关:鉴权通过(可能因上游不可达回 5xx,但绝不是 401)
        let gw = |pt: String| {
            let app = app(state.clone());
            let slug = slug.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/chat/completions")
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(header::AUTHORIZATION, format!("Bearer {pt}"))
                        .body(Body::from(
                            json!({"model": slug, "messages": []}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };
        let resp = gw(plaintext.clone()).await;
        assert_ne!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "有效 Key 不应被鉴权拒绝"
        );

        // revoke → 200
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/keys/{key_id}/revoke"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "disabled");

        // 同请求 → 401 invalid_api_key
        let resp = gw(plaintext).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["code"], "invalid_api_key");

        // 再 revoke 一次仍 200(幂等)
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/keys/{key_id}/revoke"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // revoke 不存在 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/keys/nope/revoke",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn toggle_audit_and_list() {
        let (state, cookie) = admin_session().await;
        let uid = insert_user(&state.db, "member@x.com", "memberpw1", "user", "active").await;
        let (status, body) = create_key(
            &state,
            &cookie,
            json!({"name": "k", "owner_type": "user", "owner_id": uid}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["key"]["audit"], false);
        let key_id = body["key"]["id"].as_str().unwrap().to_string();

        // PATCH {audit:true} → 200 audit==true
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/keys/{key_id}"),
                &cookie,
                Some(json!({"audit": true})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["audit"], true);

        // PATCH 不存在 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                "/admin/api/keys/nope",
                &cookie,
                Some(json!({"audit": true})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // GET 列表含 owner_label = user email
        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/keys", &cookie, None))
            .await
            .unwrap();
        let list = body_json(resp).await;
        assert_eq!(list["keys"][0]["owner_label"], "member@x.com");
        assert_eq!(list["keys"][0]["audit"], true);
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request(
                "GET",
                "/admin/api/keys",
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
