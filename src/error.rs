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
}

impl ApiError {
    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "未登录或会话已失效".into(),
        }
    }

    /// 登录失败统一文案(防账号枚举):不区分"邮箱不存在/密码错/非管理员/已停用"
    pub fn login_failed() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "login_failed",
            message: "邮箱或密码错误".into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
        }
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!(error = %err, "管理面内部错误");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: "内部错误".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({"error": {"code": self.code, "message": self.message}}));
        (self.status, body).into_response()
    }
}
