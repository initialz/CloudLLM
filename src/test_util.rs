//! 测试共享设施:内存库 + 测试配置 + 常用请求/断言辅助。
#![allow(dead_code)] // 部分辅助自 Task 8 起使用

use crate::config::Config;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, Request, Response};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

pub const TEST_MASTER_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // base64([7u8;32])
pub const TEST_SESSION_SECRET: &str = "test-session-secret-0123456789abcdef";

pub fn test_config() -> Config {
    let toml_text =
        format!("master_key = \"{TEST_MASTER_KEY}\"\nsession_secret = \"{TEST_SESSION_SECRET}\"\n");
    let cfg: Config = toml::from_str(&toml_text).expect("测试配置");
    cfg.validate().expect("测试配置合法");
    cfg
}

pub async fn test_state() -> AppState {
    test_state_with_config(test_config()).await
}

/// 用指定配置建测试 AppState(如开启 cookie_secure 验证 Set-Cookie 行为)。
pub async fn test_state_with_config(config: Config) -> AppState {
    let config = Arc::new(config);
    AppState {
        db: crate::db::open_memory().await.expect("内存库"),
        http: crate::build_http_client(&config),
        config,
        settle_tracker: tokio_util::task::TaskTracker::new(),
        settle_failures: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        login_limiter: Arc::new(crate::admin::limiter::LoginLimiter::default()),
    }
}

/// 构造 JSON 请求
pub fn json_request(method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("构造请求")
}

/// 读响应体为 JSON
pub async fn body_json(resp: Response<Body>) -> serde_json::Value {
    let bytes = resp
        .into_body()
        .collect()
        .await
        .expect("读响应体")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("响应体不是 JSON")
}

/// 从 Set-Cookie 头取 "name=value"(分号前第一段)
pub fn first_cookie(resp: &Response<Body>) -> String {
    resp.headers()
        .get(header::SET_COOKIE)
        .expect("缺少 Set-Cookie")
        .to_str()
        .expect("Set-Cookie 非 ASCII")
        .split(';')
        .next()
        .expect("Set-Cookie 为空")
        .to_string()
}

/// 在库里插入一个用户,返回 user_id
pub async fn insert_user(
    db: &sqlx::SqlitePool,
    email: &str,
    password: &str,
    role: &str,
    status: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let hash = crate::crypto::hash_password(password).expect("哈希");
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(email)
    .bind(hash)
    .bind(role)
    .bind(status)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入用户");
    id
}

/// 插入渠道,返回 channel_id。credential 用 master_key 信封加密(AAD=channel_id)。
pub async fn insert_channel(
    db: &sqlx::SqlitePool,
    master_key: &[u8; 32],
    provider_type: &str,
    base_url: &str,
    credential: &str,
    weight: i64,
    status: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let blob = crate::crypto::encrypt_secret(credential, master_key, &id).expect("加密凭证");
    sqlx::query(
        "INSERT INTO channels (id, provider_type, name, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)",
    )
    .bind(&id)
    .bind(provider_type)
    .bind(format!("ch-{provider_type}"))
    .bind(base_url)
    .bind(blob)
    .bind(weight)
    .bind(status)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入渠道");
    id
}

/// 插入模型,价格单位 micro-CNY / 1M tokens。返回 slug(原样回传方便链式)。
#[allow(clippy::too_many_arguments)]
pub async fn insert_model(
    db: &sqlx::SqlitePool,
    slug: &str,
    provider_type: &str,
    upstream_model: &str,
    input_price_micro: i64,
    output_price_micro: i64,
    cache_read_price_micro: i64,
    cache_write_price_micro: i64,
) -> String {
    sqlx::query(
        "INSERT INTO models (id, slug, provider_type, upstream_model, input_price_micro, output_price_micro, cache_read_price_micro, cache_write_price_micro, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(slug)
    .bind(provider_type)
    .bind(upstream_model)
    .bind(input_price_micro)
    .bind(output_price_micro)
    .bind(cache_read_price_micro)
    .bind(cache_write_price_micro)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入模型");
    slug.to_string()
}

/// 插入 API Key。返回 (key_id, plaintext)。allowed_models 传 None=不限;Some(slugs)=白名单。
pub async fn insert_api_key(
    db: &sqlx::SqlitePool,
    owner_type: &str,
    owner_id: &str,
    allowed_models: Option<&[&str]>,
    audit: bool,
    status: &str,
    expires_at: Option<i64>,
) -> (String, String) {
    let id = uuid::Uuid::new_v4().to_string();
    let gen = crate::crypto::generate_api_key();
    let allowed = allowed_models.map(|m| serde_json::to_string(m).expect("序列化白名单"));
    sqlx::query(
        "INSERT INTO api_keys (id, key_hash, key_prefix, name, owner_type, owner_id, allowed_models, audit, status, expires_at, created_at) \
         VALUES (?, ?, ?, 'test-key', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&gen.key_hash)
    .bind(&gen.key_prefix)
    .bind(owner_type)
    .bind(owner_id)
    .bind(allowed)
    .bind(audit as i64)
    .bind(status)
    .bind(expires_at)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入 Key");
    (id, gen.plaintext)
}

/// 插入预算行。金额 micro-CNY;period_start 传 epoch 秒。
#[allow(clippy::too_many_arguments)]
pub async fn insert_budget(
    db: &sqlx::SqlitePool,
    subject_type: &str,
    subject_id: &str,
    period: &str,
    limit_micro: i64,
    used_micro: i64,
    period_start: i64,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, used_micro, period_start, alert_threshold, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?)",
    )
    .bind(&id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(period)
    .bind(limit_micro)
    .bind(used_micro)
    .bind(period_start)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入预算");
    id
}

/// 建管理员 + 登录,返回 (AppState, Cookie 串)。后续 admin API 测试的标准开场。
pub async fn admin_session() -> (AppState, String) {
    let state = test_state().await;
    insert_user(&state.db, "admin@x.com", "Adm1n!pass", "admin", "active").await;
    let resp = crate::app(state.clone())
        .oneshot(json_request(
            "POST",
            "/admin/api/login",
            serde_json::json!({"email": "admin@x.com", "password": "Adm1n!pass"}),
        ))
        .await
        .unwrap();
    let cookie = first_cookie(&resp);
    (state, cookie)
}

/// 带会话 cookie 的 JSON 请求
pub fn authed_request(
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json");
    match body {
        Some(v) => b.body(Body::from(v.to_string())).expect("构造请求"),
        None => b.body(Body::empty()).expect("构造请求"),
    }
}
