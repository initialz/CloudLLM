//! 数据面鉴权 + 路由查询。纯 DB 读,返回鉴权后的 Key 与模型信息。

use crate::billing::{Prices, Protocol};
use crate::gateway::error::GatewayError;
use crate::AppState;
use axum::http::HeaderMap;

/// 鉴权后的 Key 视图。
#[derive(Debug, Clone)]
pub struct AuthedKey {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    /// None = 不限模型
    pub allowed_models: Option<Vec<String>>,
    pub audit: bool,
}

/// 路由解析后的模型信息。
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub slug: String,
    pub provider_type: Protocol,
    pub upstream_model: String,
    pub prices: Prices,
}

/// 从请求头提取原始 Key 文本(已去 Bearer 前缀)。
pub fn extract_raw_key(protocol: Protocol, headers: &HeaderMap) -> Option<String> {
    match protocol {
        Protocol::Openai => {
            let v = headers.get("authorization")?.to_str().ok()?;
            // 去掉大小写不敏感的 "Bearer " 前缀
            let trimmed = v.trim();
            let rest = trimmed
                .strip_prefix("Bearer ")
                .or_else(|| trimmed.strip_prefix("bearer "))
                .or_else(|| {
                    // 容忍多空格/混合大小写:正则 ^Bearer\s+ 的等价处理
                    let lower = trimmed.to_ascii_lowercase();
                    if lower.starts_with("bearer") {
                        // starts_with("bearer") 保证前 6 字节为 ASCII,字节索引 6 必为字符边界,切片不会 panic
                        Some(trimmed[6..].trim_start())
                    } else {
                        None
                    }
                })
                .unwrap_or(trimmed);
            Some(rest.trim().to_string())
        }
        Protocol::Anthropic => Some(headers.get("x-api-key")?.to_str().ok()?.to_string()),
    }
}

/// 鉴权:前缀校验 → hash → 查 active 且未过期的 Key → 白名单。
pub async fn authenticate(
    state: &AppState,
    protocol: Protocol,
    headers: &HeaderMap,
    model_slug: &str,
) -> Result<AuthedKey, GatewayError> {
    let raw = extract_raw_key(protocol, headers);
    let raw = match raw {
        Some(r) if r.starts_with(crate::crypto::API_KEY_PREFIX) => r,
        _ => {
            return Err(GatewayError::invalid_api_key(
                protocol,
                "缺少或非法的 API Key",
            ));
        }
    };
    let key_hash = crate::crypto::hash_api_key(&raw);
    let now = crate::now_epoch();
    let row: Option<(String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, owner_type, owner_id, allowed_models, audit FROM api_keys \
         WHERE key_hash = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(&key_hash)
    .bind(now)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 api_keys 失败");
        GatewayError::internal(protocol)
    })?;

    let (id, owner_type, owner_id, allowed_json, audit) =
        row.ok_or_else(|| GatewayError::invalid_api_key(protocol, "API Key 无效或已停用"))?;

    let allowed_models: Option<Vec<String>> = match allowed_json {
        // 白名单数据损坏时宁拒不放:解析失败 → 视为空白名单 Some(vec![]),任何模型都 403。
        // TS 版是原生类型数组无此边界,这是 Rust 引入 JSON 列后的显式 fail-closed 决策。
        Some(j) => match serde_json::from_str::<Vec<String>>(&j) {
            Ok(list) => Some(list),
            Err(e) => {
                tracing::error!(key_id = %id, error = %e, "allowed_models JSON 损坏,fail-closed 为空白名单");
                Some(Vec::new())
            }
        },
        None => None,
    };
    if let Some(ref list) = allowed_models {
        if !list.iter().any(|m| m == model_slug) {
            return Err(GatewayError::model_not_allowed(
                protocol,
                format!("该 Key 无权使用模型 {model_slug}"),
            ));
        }
    }
    Ok(AuthedKey {
        id,
        owner_type,
        owner_id,
        allowed_models,
        audit: audit != 0,
    })
}

/// 路由:查模型 + 协议匹配。
pub async fn resolve_model(
    state: &AppState,
    protocol: Protocol,
    model_slug: &str,
) -> Result<ModelInfo, GatewayError> {
    let row: Option<(String, String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider_type, upstream_model, input_price_micro, output_price_micro, \
                cache_read_price_micro, cache_write_price_micro \
         FROM models WHERE slug = ? AND status = 'active'",
    )
    .bind(model_slug)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 models 失败");
        GatewayError::internal(protocol)
    })?;

    let (provider_type, upstream_model, in_p, out_p, cr_p, cw_p) = row
        .ok_or_else(|| GatewayError::model_not_found(protocol, format!("未知模型 {model_slug}")))?;

    let model_protocol = match provider_type.as_str() {
        "openai" => Protocol::Openai,
        "anthropic" => Protocol::Anthropic,
        other => {
            tracing::error!(provider_type = other, "models.provider_type 非法");
            return Err(GatewayError::internal(protocol));
        }
    };
    if model_protocol != protocol {
        return Err(GatewayError::protocol_mismatch(
            protocol,
            format!("模型 {model_slug} 须经 {provider_type} 协议端点调用(v1 同构透传)"),
        ));
    }
    Ok(ModelInfo {
        slug: model_slug.to_string(),
        provider_type: model_protocol,
        upstream_model,
        prices: Prices {
            input_micro: in_p,
            output_micro: out_p,
            cache_read_micro: cr_p,
            cache_write_micro: cw_p,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{insert_api_key, insert_model, test_state};
    use axum::http::{HeaderMap, HeaderValue};

    fn headers_bearer(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_str(v).unwrap());
        h
    }
    fn headers_xapikey(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-api-key", HeaderValue::from_str(v).unwrap());
        h
    }

    #[test]
    fn extract_strips_bearer_case_insensitive() {
        let h = headers_bearer("bearer sk-cloudllm-abc");
        assert_eq!(
            extract_raw_key(Protocol::Openai, &h).as_deref(),
            Some("sk-cloudllm-abc")
        );
        let h = headers_xapikey("sk-cloudllm-xyz");
        assert_eq!(
            extract_raw_key(Protocol::Anthropic, &h).as_deref(),
            Some("sk-cloudllm-xyz")
        );
    }

    #[tokio::test]
    async fn missing_or_bad_prefix_401() {
        let state = test_state().await;
        // 无头
        let err = authenticate(&state, Protocol::Openai, &HeaderMap::new(), "m")
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
        assert_eq!(err.code, "invalid_api_key");
        assert_eq!(err.message, "缺少或非法的 API Key");
        // 错前缀
        let err = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer("Bearer sk-wrong-x"),
            "m",
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "缺少或非法的 API Key");
    }

    #[tokio::test]
    async fn unknown_key_401() {
        let state = test_state().await;
        let h = headers_bearer("Bearer sk-cloudllm-doesnotexist");
        let err = authenticate(&state, Protocol::Openai, &h, "m")
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
        assert_eq!(err.message, "API Key 无效或已停用");
    }

    #[tokio::test]
    async fn disabled_key_401() {
        let state = test_state().await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "disabled", None).await;
        let err = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "m",
        )
        .await
        .unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
    }

    #[tokio::test]
    async fn expired_key_401() {
        let state = test_state().await;
        let past = crate::now_epoch() - 10;
        let (_, pt) =
            insert_api_key(&state.db, "user", "u1", None, false, "active", Some(past)).await;
        let err = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "m",
        )
        .await
        .unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
    }

    #[tokio::test]
    async fn not_yet_expired_key_ok() {
        let state = test_state().await;
        let future = crate::now_epoch() + 3600;
        let (id, pt) =
            insert_api_key(&state.db, "user", "u1", None, true, "active", Some(future)).await;
        let key = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "m",
        )
        .await
        .unwrap();
        assert_eq!(key.id, id);
        assert_eq!(key.owner_type, "user");
        assert!(key.audit);
        assert!(key.allowed_models.is_none());
    }

    #[tokio::test]
    async fn allowed_models_whitelist_403() {
        let state = test_state().await;
        let (_, pt) = insert_api_key(
            &state.db,
            "user",
            "u1",
            Some(&["gpt-allowed"]),
            false,
            "active",
            None,
        )
        .await;
        // 不在白名单
        let err = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "gpt-other",
        )
        .await
        .unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
        assert_eq!(err.code, "model_not_allowed");
        assert_eq!(err.message, "该 Key 无权使用模型 gpt-other");
        // 在白名单
        let key = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "gpt-allowed",
        )
        .await
        .unwrap();
        assert_eq!(key.owner_id, "u1");
    }

    #[tokio::test]
    async fn corrupt_allowed_models_fail_closed_403() {
        let state = test_state().await;
        let (id, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        // 手工把白名单列写成非法 JSON,模拟数据损坏
        sqlx::query("UPDATE api_keys SET allowed_models = 'not-json' WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await
            .unwrap();
        // 损坏时 fail-closed:任意模型都被拒
        let err = authenticate(
            &state,
            Protocol::Openai,
            &headers_bearer(&format!("Bearer {pt}")),
            "any-model",
        )
        .await
        .unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
        assert_eq!(err.code, "model_not_allowed");
    }

    #[tokio::test]
    async fn resolve_unknown_model_404() {
        let state = test_state().await;
        let err = resolve_model(&state, Protocol::Openai, "ghost")
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 404);
        assert_eq!(err.code, "model_not_found");
        assert_eq!(err.message, "未知模型 ghost");
    }

    #[tokio::test]
    async fn resolve_protocol_mismatch_400() {
        let state = test_state().await;
        insert_model(&state.db, "claude-x", "anthropic", "claude-3", 1, 1, 0, 0).await;
        // 用 openai 协议端点调 anthropic 模型
        let err = resolve_model(&state, Protocol::Openai, "claude-x")
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 400);
        assert_eq!(err.code, "protocol_mismatch");
        assert!(err.message.contains("anthropic"));
    }

    #[tokio::test]
    async fn resolve_ok_returns_prices_and_upstream() {
        let state = test_state().await;
        insert_model(
            &state.db,
            "gpt-x",
            "openai",
            "gpt-4o-real",
            21_000_000,
            105_000_000,
            7,
            9,
        )
        .await;
        let m = resolve_model(&state, Protocol::Openai, "gpt-x")
            .await
            .unwrap();
        assert_eq!(m.upstream_model, "gpt-4o-real");
        assert_eq!(m.provider_type, Protocol::Openai);
        assert_eq!(m.prices.input_micro, 21_000_000);
        assert_eq!(m.prices.cache_write_micro, 9);
    }
}
