//! CloudLLM v2 — Rust 一体化 LLM 网关(hub + admin-ui)。

pub mod admin;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
#[cfg(test)]
pub(crate) mod test_util;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<config::Config>,
}

/// 组装全部路由。网关 /v1/* 在 P2 接入。
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .nest("/admin/api", admin::api::router())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "db unavailable"),
    }
}

/// 当前 unix epoch 秒。全工程统一时间来源。
pub fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn now_epoch_is_reasonable() {
        let t = now_epoch();
        assert!(t > 1_767_225_600 && t < 4_102_444_800);
    }

    #[tokio::test]
    async fn healthz_ok() {
        let state = crate::test_util::test_state().await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn healthz_db_down_is_503() {
        let state = crate::test_util::test_state().await;
        state.db.close().await; // 单连接内存池,关闭后 SELECT 1 必失败
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
