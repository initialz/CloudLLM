use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// 管理面 API 统一错误。响应体:{"error": {"code", "message"}}
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// 仅日志可见的内部细节(原始错误),绝不进响应体
    detail: Option<String>,
}

impl ApiError {
    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "未登录或会话已失效".into(),
            detail: None,
        }
    }

    /// 登录失败统一文案(防账号枚举):不区分"邮箱不存在/密码错/非管理员/已停用"
    pub fn login_failed() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "login_failed",
            message: "邮箱或密码错误".into(),
            detail: None,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
            detail: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
            detail: None,
        }
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: "内部错误".into(),
            detail: Some(err.to_string()),
        }
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rej: JsonRejection) -> Self {
        // 不回显 serde 细节(字段名/行列号),只给统一文案;原始原因进日志可见的 detail
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: "请求体不是合法 JSON 或字段缺失".into(),
            detail: Some(rej.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Some(detail) = &self.detail {
            tracing::error!(error = %detail, code = self.code, "管理面内部错误");
        }
        let body = Json(json!({"error": {"code": self.code, "message": self.message}}));
        (self.status, body).into_response()
    }
}
