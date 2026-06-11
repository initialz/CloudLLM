//! 测试共享设施:内存库 + 测试配置 + 常用请求/断言辅助。
#![allow(dead_code)] // 部分辅助自 Task 8 起使用

use crate::config::Config;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, Request, Response};
use http_body_util::BodyExt;
use std::sync::Arc;

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
    AppState {
        db: crate::db::open_memory().await.expect("内存库"),
        config: Arc::new(test_config()),
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
