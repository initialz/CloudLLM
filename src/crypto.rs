use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, ensure, Result};
use argon2::password_hash::{
    rand_core::OsRng as PwOsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

/// API Key 前缀。与 TS 版/已发放 Key 保持一致,不可更改。
pub const API_KEY_PREFIX: &str = "sk-cloudllm-";
/// key_prefix 字段长度(后台识别用,与 TS 版一致)
const KEY_PREFIX_LEN: usize = 15;
/// 密码长度上限:防 argon2 计算型 DoS(对 hash 与 verify 统一适用)
const MAX_PASSWORD_LEN: usize = 1024;

pub struct GeneratedApiKey {
    /// 完整明文,仅创建时返回一次
    pub plaintext: String,
    /// SHA-256 hex,入库字段
    pub key_hash: String,
    /// 前 15 字符,后台识别用
    pub key_prefix: String,
}

pub fn hash_password(password: &str) -> Result<String> {
    // 上限防 argon2 计算型 DoS(与 TS 版一致);argon2 对超长输入会全量哈希
    if password.len() > MAX_PASSWORD_LEN {
        return Err(anyhow!("密码过长(上限 {MAX_PASSWORD_LEN} 字符)"));
    }
    let salt = SaltString::generate(&mut PwOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("argon2 哈希失败: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    // 超长直接 false,不跑 argon2;上限对所有输入统一适用,不构成枚举信号
    if password.len() > MAX_PASSWORD_LEN {
        return false;
    }
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

pub fn generate_api_key() -> GeneratedApiKey {
    let mut raw = [0u8; 24];
    OsRng.fill_bytes(&mut raw);
    let plaintext = format!("{API_KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(raw));
    GeneratedApiKey {
        key_hash: hash_api_key(&plaintext),
        key_prefix: plaintext[..KEY_PREFIX_LEN].to_string(),
        plaintext,
    }
}

pub fn hash_api_key(plaintext: &str) -> String {
    let digest = Sha256::digest(plaintext.as_bytes());
    hex_encode(&digest)
}

/// 小写 hex(避免为此引入 hex crate)
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const NONCE_LEN: usize = 12;

/// 信封加密:输出 = nonce(12B) || ciphertext+tag。
/// AAD 必填(渠道行 UUID)——密文与行绑定,拷到别的行解不开。
///
/// 注:有意不沿用 TS 版(packages/shared/envelope.ts)的双层 data-key 信封——
/// spec 明确不迁移旧数据、两侧不共库,且凭证轮换 = 整条重新加密,
/// data-key 层的「轮换主密钥只重加密 data-key」优势用不上,单层更简。
/// 当前为 v1 单一格式(无版本字节);未来若换算法/格式,需在 blob 头引入
/// 版本标识并纳入 AAD,避免降级混淆。
pub fn encrypt_secret(plaintext: &str, master_key: &[u8; 32], aad: &str) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(master_key.into());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("信封加密失败"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt_secret(blob: &[u8], master_key: &[u8; 32], aad: &str) -> Result<String> {
    ensure!(blob.len() > NONCE_LEN, "密文过短");
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(master_key.into());
    let pt = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("信封解密失败(密钥或 AAD 不匹配)"))?;
    String::from_utf8(pt).map_err(|_| anyhow!("解密结果不是 UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let h = hash_password("S3cret!pass").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("S3cret!pass", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn verify_garbage_hash_is_false_not_panic() {
        assert!(!verify_password("x", "not-a-phc-string"));
    }

    #[test]
    fn hash_password_rejects_overlong() {
        let long = "x".repeat(1025);
        assert!(hash_password(&long).is_err());
        assert!(hash_password(&"x".repeat(1024)).is_ok());
    }

    #[test]
    fn verify_password_overlong_is_false_without_hashing() {
        let h = hash_password("normal").unwrap();
        assert!(!verify_password(&"x".repeat(1025), &h));
    }

    #[test]
    fn api_key_shape() {
        let k = generate_api_key();
        // sk-cloudllm- + 24 字节 base64url = 32 字符
        assert!(k.plaintext.starts_with(API_KEY_PREFIX));
        assert_eq!(k.plaintext.len(), API_KEY_PREFIX.len() + 32);
        assert_eq!(k.key_prefix, &k.plaintext[..15]);
        assert_eq!(k.key_hash, hash_api_key(&k.plaintext));
        assert_ne!(generate_api_key().plaintext, k.plaintext);
    }

    #[test]
    fn api_key_hash_fixed_vector() {
        // 与 TS 版 packages/shared 固定向量一致(改名后重算的值)
        assert_eq!(
            hash_api_key("sk-cloudllm-test"),
            "3c5f08c276e14e1f46791c5b08f7f4d41831b792f799f821650d4079ae4e5435"
        );
    }

    #[test]
    fn envelope_roundtrip() {
        let mk = [9u8; 32];
        let blob = encrypt_secret("sk-upstream-secret", &mk, "channel-uuid-1").unwrap();
        assert_ne!(blob, b"sk-upstream-secret");
        let pt = decrypt_secret(&blob, &mk, "channel-uuid-1").unwrap();
        assert_eq!(pt, "sk-upstream-secret");
    }

    #[test]
    fn envelope_nonce_is_random() {
        let mk = [9u8; 32];
        let a = encrypt_secret("same", &mk, "aad").unwrap();
        let b = encrypt_secret("same", &mk, "aad").unwrap();
        assert_ne!(a, b, "相同明文两次加密必须产生不同密文(随机 nonce)");
    }

    #[test]
    fn envelope_rejects_wrong_aad() {
        let mk = [9u8; 32];
        let blob = encrypt_secret("s", &mk, "channel-A").unwrap();
        assert!(decrypt_secret(&blob, &mk, "channel-B").is_err());
    }

    #[test]
    fn envelope_rejects_wrong_key() {
        let blob = encrypt_secret("s", &[9u8; 32], "aad").unwrap();
        assert!(decrypt_secret(&blob, &[8u8; 32], "aad").is_err());
    }

    #[test]
    fn envelope_rejects_truncated() {
        assert!(decrypt_secret(&[0u8; 8], &[9u8; 32], "aad").is_err());
    }

    #[test]
    fn envelope_rejects_nonce_only_blob() {
        // 恰好 12 字节 = 只有 nonce、零密文:走长度防护分支拒绝
        assert!(decrypt_secret(&[0u8; 12], &[9u8; 32], "aad").is_err());
    }
}
