//! 无状态 HMAC 会话编解码。
//!
//! 会话是自包含的签名 cookie:`base64url(json).base64url(HMAC-SHA256(payload))`。
//! 登出仅清除浏览器 cookie——旧值在 `exp` 前重放仍然有效,这是有意取舍。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_COOKIE: &str = "cloudllm_session";
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 3600;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionData {
    pub user_id: String,
    pub exp: i64,
}

/// 编码:base64url(json) + "." + base64url(HMAC-SHA256(payload))
pub fn encode_session(data: &SessionData, secret: &str) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(data).expect("序列化会话"));
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥");
    mac.update(payload.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

/// 解码并校验签名与过期。now 由调用方传入(可测试)。
pub fn decode_session(raw: &str, secret: &str, now: i64) -> Option<SessionData> {
    let (payload, sig) = raw.split_once('.')?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig_bytes).ok()?; // 常数时间比较
    let data: SessionData = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    (data.exp > now).then_some(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-session-secret-0123456789abcdef";

    fn session(exp: i64) -> SessionData {
        SessionData {
            user_id: "u-1".into(),
            exp,
        }
    }

    #[test]
    fn roundtrip() {
        let raw = encode_session(&session(2_000_000_000), SECRET);
        let got = decode_session(&raw, SECRET, 1_900_000_000).unwrap();
        assert_eq!(got, session(2_000_000_000));
    }

    #[test]
    fn tampered_payload_rejected() {
        let raw = encode_session(&session(2_000_000_000), SECRET);
        let (payload, sig) = raw.split_once('.').unwrap();
        // 改 payload 任一字符
        let mut chars: Vec<char> = payload.chars().collect();
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        let tampered = format!("{}.{sig}", chars.into_iter().collect::<String>());
        assert!(decode_session(&tampered, SECRET, 0).is_none());
    }

    #[test]
    fn wrong_secret_rejected() {
        let raw = encode_session(&session(2_000_000_000), SECRET);
        assert!(decode_session(&raw, "another-secret-0123456789abcdefgh", 0).is_none());
    }

    #[test]
    fn expired_rejected() {
        let raw = encode_session(&session(1_000), SECRET);
        assert!(decode_session(&raw, SECRET, 1_001).is_none());
        assert!(decode_session(&raw, SECRET, 999).is_some());
    }

    #[test]
    fn garbage_rejected() {
        assert!(decode_session("", SECRET, 0).is_none());
        assert!(decode_session("no-dot", SECRET, 0).is_none());
        assert!(decode_session("a.b", SECRET, 0).is_none());
    }
}
