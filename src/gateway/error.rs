//! 网关错误:协议感知渲染。OpenAI 与 Anthropic 错误体结构不同,
//! 同一逻辑错误按所在协议序列化。错误码用 TS 实际词汇(budget_exhausted 等)。

use crate::gateway::Protocol;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct GatewayError {
    pub protocol: Protocol,
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl GatewayError {
    fn new(
        protocol: Protocol,
        status: u16,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol,
            status: StatusCode::from_u16(status).expect("合法状态码"),
            code,
            message: message.into(),
        }
    }

    pub fn invalid_request(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 400, "invalid_request", message)
    }
    pub fn protocol_mismatch(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 400, "protocol_mismatch", message)
    }
    pub fn invalid_api_key(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 401, "invalid_api_key", message)
    }
    pub fn model_not_allowed(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 403, "model_not_allowed", message)
    }
    pub fn model_not_found(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 404, "model_not_found", message)
    }
    pub fn budget_exhausted(protocol: Protocol, message: impl Into<String>) -> Self {
        Self::new(protocol, 429, "budget_exhausted", message)
    }
    pub fn no_channel(protocol: Protocol) -> Self {
        Self::new(protocol, 502, "no_channel", "该模型暂无可用渠道")
    }
    pub fn upstream_failed(protocol: Protocol) -> Self {
        Self::new(
            protocol,
            502,
            "upstream_failed",
            "上游渠道全部失败,请稍后重试",
        )
    }
    pub fn internal(protocol: Protocol) -> Self {
        Self::new(protocol, 500, "internal_error", "网关内部错误")
    }

    /// Anthropic 错误类型映射(按状态码)
    fn anthropic_error_type(&self) -> &'static str {
        match self.status.as_u16() {
            401 => "authentication_error",
            403 => "permission_error",
            404 => "not_found_error",
            429 => "rate_limit_error",
            s if s >= 500 => "api_error",
            _ => "invalid_request_error",
        }
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let body = match self.protocol {
            Protocol::Openai => json!({
                "error": { "message": self.message, "type": "invalid_request_error", "code": self.code }
            }),
            Protocol::Anthropic => json!({
                "type": "error",
                "error": { "type": self.anthropic_error_type(), "message": self.message }
            }),
        };
        // axum::Json 负责设置 content-type: application/json
        (self.status, axum::Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::body_json;

    #[tokio::test]
    async fn openai_render_shape() {
        let err = GatewayError::invalid_api_key(Protocol::Openai, "API Key 无效或已停用");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let body = body_json(resp).await;
        assert_eq!(body["error"]["type"], "invalid_request_error");
        assert_eq!(body["error"]["code"], "invalid_api_key");
        assert_eq!(body["error"]["message"], "API Key 无效或已停用");
    }

    #[tokio::test]
    async fn anthropic_render_maps_status_to_type() {
        let cases = [
            (
                GatewayError::invalid_api_key(Protocol::Anthropic, "x"),
                401,
                "authentication_error",
            ),
            (
                GatewayError::model_not_allowed(Protocol::Anthropic, "x"),
                403,
                "permission_error",
            ),
            (
                GatewayError::model_not_found(Protocol::Anthropic, "x"),
                404,
                "not_found_error",
            ),
            (
                GatewayError::budget_exhausted(Protocol::Anthropic, "x"),
                429,
                "rate_limit_error",
            ),
            (
                GatewayError::upstream_failed(Protocol::Anthropic),
                502,
                "api_error",
            ),
            (
                GatewayError::internal(Protocol::Anthropic),
                500,
                "api_error",
            ),
            (
                GatewayError::invalid_request(Protocol::Anthropic, "x"),
                400,
                "invalid_request_error",
            ),
        ];
        for (err, status, ty) in cases {
            let resp = err.into_response();
            assert_eq!(resp.status().as_u16(), status);
            let body = body_json(resp).await;
            assert_eq!(body["type"], "error");
            assert_eq!(body["error"]["type"], ty, "status {status} 应映射 {ty}");
        }
    }

    #[tokio::test]
    async fn code_vocabulary_and_statuses() {
        // 逐码断言:status + code 与词汇表一致
        let pairs: [(GatewayError, u16, &str); 8] = [
            (
                GatewayError::invalid_request(Protocol::Openai, "x"),
                400,
                "invalid_request",
            ),
            (
                GatewayError::protocol_mismatch(Protocol::Openai, "x"),
                400,
                "protocol_mismatch",
            ),
            (
                GatewayError::invalid_api_key(Protocol::Openai, "x"),
                401,
                "invalid_api_key",
            ),
            (
                GatewayError::model_not_allowed(Protocol::Openai, "x"),
                403,
                "model_not_allowed",
            ),
            (
                GatewayError::model_not_found(Protocol::Openai, "x"),
                404,
                "model_not_found",
            ),
            (
                GatewayError::budget_exhausted(Protocol::Openai, "x"),
                429,
                "budget_exhausted",
            ),
            (
                GatewayError::no_channel(Protocol::Openai),
                502,
                "no_channel",
            ),
            (
                GatewayError::upstream_failed(Protocol::Openai),
                502,
                "upstream_failed",
            ),
        ];
        for (err, status, code) in pairs {
            assert_eq!(err.status.as_u16(), status);
            assert_eq!(err.code, code);
        }
    }
}
