use axum::extract::rejection::{JsonRejection, QueryRejection};
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

    /// 登录限速触发(防爆破/探测):不区分维度,统一文案防探测。
    pub fn too_many_attempts() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "too_many_attempts",
            message: "尝试次数过多,请稍后再试".into(),
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

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
            detail: None,
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
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

    /// DB 写入错误归类:UNIQUE 冲突 → 409 conflict,其余 → 500 internal。
    /// 配合「SELECT 预检 + INSERT 兜底」模式:预检给常态下干净的 409,这里关掉竞态窗口。
    pub fn from_db_unique(err: sqlx::Error, conflict_msg: &'static str) -> Self {
        if let Some(dberr) = err.as_database_error() {
            if dberr.is_unique_violation() {
                return Self::conflict(conflict_msg);
            }
        }
        Self::internal(err)
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

impl From<QueryRejection> for ApiError {
    fn from(rej: QueryRejection) -> Self {
        // 查询串反序列化失败(缺必填字段/类型不符)→ 400;同 JSON 路径不回显 serde 细节
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: "查询参数无效或缺失".into(),
            detail: Some(rej.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Some(detail) = &self.detail {
            // 仅 5xx 是服务端故障;4xx(如 JSON rejection)是客户端问题,降级记录,避免污染告警
            if self.status.is_server_error() {
                tracing::error!(error = %detail, code = self.code, "管理面内部错误");
            } else {
                tracing::debug!(error = %detail, code = self.code, "客户端请求被拒");
            }
        }
        let body = Json(json!({"error": {"code": self.code, "message": self.message}}));
        (self.status, body).into_response()
    }
}
