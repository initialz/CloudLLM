//! 从二进制内服务 Vite 构建的 admin SPA(rust-embed,debug 构建也嵌入)。
//! 路由规则:
//! - /admin/assets/<hash>.* 命中即长缓存(Vite 产物带内容哈希)
//! - 其余 /admin/* 全部回退 index.html,由前端路由接管(深链接/刷新)

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::{EmbeddedFile, RustEmbed};

#[derive(RustEmbed)]
#[folder = "admin-ui/dist/"]
struct Asset;

pub async fn serve_index() -> Response {
    match Asset::get("index.html") {
        Some(f) => file_response("index.html", f, "no-cache"),
        // build.rs 兜底后理论不可达;保留以防手工删 dist
        None => (StatusCode::SERVICE_UNAVAILABLE, "admin-ui 未构建").into_response(),
    }
}

pub async fn serve_asset(AxumPath(path): AxumPath<String>) -> Response {
    let key = format!("assets/{path}");
    match Asset::get(&key) {
        Some(f) => file_response(&key, f, "public, max-age=31536000, immutable"),
        // 内容寻址的哈希资产缺失 = 客户端持有过期 index(stale deploy),
        // 必须 404 令其硬刷新;回退 HTML 会让 module script MIME 校验失败、整页白屏
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// /admin/* 兜底:先试 dist 根的真实文件(favicon 等),再回退 index.html
pub async fn serve_spa(AxumPath(path): AxumPath<String>) -> Response {
    // /admin/api/* 未匹配路径会落到这个 catch-all(它比 nest 的 fallback 更"具体"地
    // 命中 /admin/*spa),必须仍是 JSON 404,绝不能回退 SPA HTML
    if path == "api" || path.starts_with("api/") {
        return crate::error::ApiError::not_found("接口不存在").into_response();
    }
    match Asset::get(&path) {
        Some(f) => file_response(&path, f, "no-cache"),
        None => serve_index().await,
    }
}

fn file_response(path: &str, file: EmbeddedFile, cache: &'static str) -> Response {
    let mime = file.metadata.mimetype();
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data))
        .unwrap_or_else(|_| {
            tracing::error!(path, "构造资产响应失败");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::test_state;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use tower::ServiceExt;

    async fn get(uri: &str) -> axum::http::Response<Body> {
        app(test_state().await)
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn admin_root_serves_html() {
        // build.rs 保证 dist/index.html 必然存在(占位或真实构建)
        let resp = get("/admin").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.starts_with("text/html"), "实际 content-type: {ct}");
    }

    #[tokio::test]
    async fn deep_link_falls_back_to_index() {
        let resp = get("/admin/keys/some-deep/route").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.starts_with("text/html"));
    }

    #[tokio::test]
    async fn missing_asset_is_404() {
        let resp = get("/admin/assets/not-built-xyz.js").await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn hashed_asset_hit_is_immutable_js() {
        let resp = get("/admin/assets/cloudllm-probe-cafebabe.js").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cc = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cc.contains("immutable"), "实际: {cc}");
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.contains("javascript"), "实际: {ct}");
    }

    #[tokio::test]
    async fn index_is_no_cache_assets_are_immutable() {
        let resp = get("/admin").await;
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
    }
}
