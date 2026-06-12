//! 成员自助接入页:GET / 返回嵌入式静态页,服务端注入启用模型清单。
//! Key 的拼接全在浏览器本地完成,本模块绝不接触任何 Key。

use crate::AppState;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

const GUIDE_HTML: &str = include_str!("guide.html");
/// 模板中的注入点:注释 + 空数组,未替换时模板本身仍是合法 JS
const MODELS_PLACEHOLDER: &str = "/*__MODELS_JSON__*/[]";

#[derive(serde::Serialize, sqlx::FromRow)]
struct GuideModel {
    slug: String,
    provider_type: String,
}

pub async fn serve_guide(State(state): State<AppState>) -> Response {
    // 查库失败降级为空清单:页面照常可用(模型框退化为手填),错误只进日志
    let models = fetch_active_models(&state).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "接入页查询模型清单失败,降级为空");
        Vec::new()
    });
    let json = serde_json::to_string(&models).unwrap_or_else(|_| "[]".into());
    // 防 </script> 逃逸:JSON 字符串值里出现的 "</" 转义为 "<\/"(JS 字符串语义不变)
    let json = json.replace("</", "<\\/");
    let html = GUIDE_HTML.replace(MODELS_PLACEHOLDER, &json);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

async fn fetch_active_models(state: &AppState) -> anyhow::Result<Vec<GuideModel>> {
    Ok(sqlx::query_as(
        "SELECT slug, provider_type FROM models WHERE status = 'active' ORDER BY slug",
    )
    .fetch_all(&state.db)
    .await?)
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{insert_model, test_state};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn get_root(state: crate::AppState) -> (StatusCode, String, String, String) {
        let resp = app(state)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let ct = resp
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let cc = resp
            .headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, ct, cc, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn root_serves_html_page() {
        let state = test_state().await;
        let (status, ct, cc, body) = get_root(state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ct, "text/html; charset=utf-8");
        assert_eq!(cc, "no-cache");
        assert!(body.contains("CloudLLM"));
        assert!(body.contains("window.__MODELS__"));
    }

    #[tokio::test]
    async fn injects_active_models_only() {
        let state = test_state().await;
        insert_model(
            &state.db,
            "openai/gpt-live",
            "openai",
            "gpt-live",
            1,
            1,
            0,
            0,
        )
        .await;
        insert_model(
            &state.db,
            "anthropic/claude-x",
            "anthropic",
            "claude-x",
            1,
            1,
            0,
            0,
        )
        .await;
        insert_model(
            &state.db,
            "openai/gpt-dead",
            "openai",
            "gpt-dead",
            1,
            1,
            0,
            0,
        )
        .await;
        sqlx::query("UPDATE models SET status = 'disabled' WHERE slug = 'openai/gpt-dead'")
            .execute(&state.db)
            .await
            .unwrap();
        let (_, _, _, body) = get_root(state).await;
        assert!(body.contains("openai/gpt-live"));
        assert!(body.contains("anthropic/claude-x"));
        assert!(!body.contains("openai/gpt-dead"), "禁用模型不得注入");
    }

    #[tokio::test]
    async fn injected_models_json_parseable() {
        let state = test_state().await;
        insert_model(
            &state.db,
            "openai/gpt-live",
            "openai",
            "gpt-live",
            1,
            1,
            0,
            0,
        )
        .await;
        let (_, _, _, body) = get_root(state).await;
        let start = body.find("window.__MODELS__ = ").unwrap() + "window.__MODELS__ = ".len();
        let end = body[start..].find(";</script>").unwrap() + start;
        let parsed: serde_json::Value = serde_json::from_str(&body[start..end]).unwrap();
        assert_eq!(parsed[0]["slug"], "openai/gpt-live");
        assert_eq!(parsed[0]["provider_type"], "openai");
    }

    #[tokio::test]
    async fn db_failure_degrades_to_empty_list() {
        let state = test_state().await;
        state.db.close().await;
        let (status, _, _, body) = get_root(state).await;
        assert_eq!(status, StatusCode::OK, "查库失败页面必须照常 200");
        assert!(body.contains("window.__MODELS__ = []"));
    }

    #[tokio::test]
    async fn script_close_tag_in_slug_is_escaped() {
        let state = test_state().await;
        // 管理面校验会拦这种 slug,但防御纵深:直插恶意值验证转义
        insert_model(&state.db, "x/</script><img>", "openai", "m", 1, 1, 0, 0).await;
        let (_, _, _, body) = get_root(state).await;
        assert!(
            !body.contains("</script><img>"),
            "JSON 注入区不得出现未转义的 </"
        );
        assert!(body.contains("<\\/script>"), "应转义为 <\\/");
    }

    #[tokio::test]
    async fn gateway_404_semantics_unchanged() {
        let state = test_state().await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
