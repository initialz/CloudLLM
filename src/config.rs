use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use std::path::Path;

/// CloudLLM 主配置。来源:TOML 文件 → CLOUDLLM_* 环境变量覆盖 → validate()。
/// 启动即校验失败即退出;不做运行期惰性校验。
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: String,
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// 渠道凭证信封加密主密钥,base64(32 字节)
    pub master_key: String,
    /// 管理会话 HMAC 密钥,≥32 字符
    pub session_secret: String,
    #[serde(default)]
    pub gateway_public_url: Option<String>,
}

fn default_listen() -> String {
    "0.0.0.0:7100".into()
}
fn default_db_path() -> String {
    "./cloudllm.db".into()
}

impl Config {
    pub fn load(path: &Path) -> Result<Config> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("读取配置文件 {}", path.display()))?;
        let mut cfg: Config =
            toml::from_str(&raw).with_context(|| format!("解析配置文件 {}", path.display()))?;
        cfg.apply_overrides(|k| std::env::var(k).ok());
        cfg.validate()?;
        Ok(cfg)
    }

    /// 用注入的查找函数覆盖配置(生产传 std::env::var,测试传闭包——
    /// 避免测试改进程级环境变量导致并行用例互相污染)
    pub fn apply_overrides(&mut self, lookup: impl Fn(&str) -> Option<String>) {
        if let Some(v) = lookup("CLOUDLLM_LISTEN") {
            self.listen = v;
        }
        if let Some(v) = lookup("CLOUDLLM_DB_PATH") {
            self.db_path = v;
        }
        if let Some(v) = lookup("CLOUDLLM_MASTER_KEY") {
            self.master_key = v;
        }
        if let Some(v) = lookup("CLOUDLLM_SESSION_SECRET") {
            self.session_secret = v;
        }
        if let Some(v) = lookup("CLOUDLLM_GATEWAY_PUBLIC_URL") {
            self.gateway_public_url = Some(v);
        }
    }

    pub fn validate(&self) -> Result<()> {
        let mk = B64
            .decode(&self.master_key)
            .context("master_key 不是合法 base64")?;
        ensure!(
            mk.len() == 32,
            "master_key 解码后必须是 32 字节,实际 {} 字节",
            mk.len()
        );
        ensure!(
            self.session_secret.len() >= 32,
            "session_secret 必须 ≥32 字符,实际 {} 字符",
            self.session_secret.len()
        );
        self.listen
            .parse::<std::net::SocketAddr>()
            .with_context(|| format!("listen 不是合法地址: {}", self.listen))?;
        Ok(())
    }

    /// 已 validate 的前提下取主密钥字节
    pub fn master_key_bytes(&self) -> [u8; 32] {
        let v = B64.decode(&self.master_key).expect("validate 后调用");
        v.try_into().expect("validate 保证 32 字节")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MK: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // base64([7u8;32])
    const SS: &str = "test-session-secret-0123456789abcdef"; // 36 字符

    fn base_toml() -> String {
        format!("master_key = \"{MK}\"\nsession_secret = \"{SS}\"\n")
    }

    #[test]
    fn parse_with_defaults() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|_| None);
        cfg.validate().unwrap();
        assert_eq!(cfg.listen, "0.0.0.0:7100");
        assert_eq!(cfg.db_path, "./cloudllm.db");
        assert_eq!(cfg.master_key_bytes(), [7u8; 32]);
    }

    #[test]
    fn env_overrides_win() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|k| match k {
            "CLOUDLLM_LISTEN" => Some("127.0.0.1:9000".into()),
            "CLOUDLLM_DB_PATH" => Some("/data/x.db".into()),
            "CLOUDLLM_GATEWAY_PUBLIC_URL" => Some("https://llm.corp".into()),
            _ => None,
        });
        cfg.validate().unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:9000");
        assert_eq!(cfg.db_path, "/data/x.db");
        assert_eq!(cfg.gateway_public_url.as_deref(), Some("https://llm.corp"));
    }

    #[test]
    fn bad_master_key_rejected() {
        // 31 字节
        let mk31 = B64.encode([7u8; 31]);
        let toml_text = format!("master_key = \"{mk31}\"\nsession_secret = \"{SS}\"\n");
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("master_key"), "实际错误: {err}");
    }

    #[test]
    fn short_session_secret_rejected() {
        let toml_text = format!("master_key = \"{MK}\"\nsession_secret = \"short\"\n");
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("session_secret"));
    }

    #[test]
    fn bad_listen_rejected() {
        let toml_text = format!("listen = \"not-an-addr\"\n{}", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg.validate().unwrap_err().to_string().contains("listen"));
    }

    #[test]
    fn load_reads_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cloudllm.toml");
        std::fs::write(&p, base_toml()).unwrap();
        let cfg = Config::load(&p).unwrap();
        assert_eq!(cfg.session_secret, SS);
    }
}
