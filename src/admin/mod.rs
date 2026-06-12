pub mod api;
pub mod assets;
pub mod limiter;
pub mod teams;
pub mod users;

/// 邮箱格式校验,供各资源共用(避免多处复制后漂移)。
/// 与 TS 版同一正则语义:本地部分@域.后缀,均不含空白/@。
/// 入参应为已 trim + lowercase 的字符串。
pub(crate) fn is_valid_email(s: &str) -> bool {
    let parts: Vec<&str> = s.split('@').collect();
    parts.len() == 2
        && !parts[0].is_empty()
        && parts[1].contains('.')
        && !parts[1].starts_with('.')
        && !parts[1].ends_with('.')
        && !s.chars().any(char::is_whitespace)
}
