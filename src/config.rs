use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use std::path::Path;

/// CloudLLM 主配置。来源:TOML 文件 → CLOUDLLM_* 环境变量覆盖 → validate()。
/// 启动即校验失败即退出;不做运行期惰性校验。
#[derive(Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: String,
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// 渠道凭证信封加密主密钥,base64(32 字节)
    pub master_key: String,
    /// 管理会话 HMAC 密钥,≥32 字节
    pub session_secret: String,
    #[serde(default)]
    pub gateway_public_url: Option<String>,
    /// 上游 TCP 连接超时(秒)
    #[serde(default = "default_upstream_connect_timeout_secs")]
    pub upstream_connect_timeout_secs: u64,
    /// 非流式上游请求总超时(秒);流式不设总超时
    #[serde(default = "default_upstream_timeout_secs")]
    pub upstream_timeout_secs: u64,
    /// 冷却指数退避基数(秒)
    #[serde(default = "default_cooldown_base_secs")]
    pub cooldown_base_secs: i64,
    /// 冷却退避上限(秒)
    #[serde(default = "default_cooldown_max_secs")]
    pub cooldown_max_secs: i64,
    /// 审计体截断上限(字节)
    #[serde(default = "default_audit_body_limit")]
    pub audit_body_limit: usize,
    /// 审计体保留天数(超过则清空 request_body/response_body)
    #[serde(default = "default_audit_retention_days")]
    pub audit_retention_days: i64,
    /// 客户端请求体上限(字节);超出 413
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    /// 优雅停机排水时长上限(秒)
    #[serde(default = "default_shutdown_drain_secs")]
    pub shutdown_drain_secs: u64,
    /// 会话 cookie 是否带 Secure 属性(仅 HTTPS 下传)。
    /// 默认 false:开发/内网 HTTP 下也能登录;生产经 TLS 终结时置 true。
    #[serde(default)]
    pub cookie_secure: bool,
}

// 手写 Debug:master_key / session_secret 是明文密钥,绝不能随 {:?} 进日志或 backtrace
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("db_path", &self.db_path)
            .field("master_key", &"<redacted>")
            .field("session_secret", &"<redacted>")
            .field("gateway_public_url", &self.gateway_public_url)
            .field("cookie_secure", &self.cookie_secure)
            .finish()
    }
}

fn default_listen() -> String {
    "0.0.0.0:7200".into()
}
fn default_db_path() -> String {
    "./cloudllm.db".into()
}
fn default_upstream_connect_timeout_secs() -> u64 {
    10
}
fn default_upstream_timeout_secs() -> u64 {
    300
}
fn default_cooldown_base_secs() -> i64 {
    30
}
fn default_cooldown_max_secs() -> i64 {
    600
}
fn default_audit_body_limit() -> usize {
    65536
}
fn default_audit_retention_days() -> i64 {
    30
}
fn default_max_body_bytes() -> usize {
    2 * 1024 * 1024
}
fn default_shutdown_drain_secs() -> u64 {
    25
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
        if let Some(v) =
            lookup("CLOUDLLM_UPSTREAM_CONNECT_TIMEOUT_SECS").and_then(|s| s.parse().ok())
        {
            self.upstream_connect_timeout_secs = v;
        }
        if let Some(v) = lookup("CLOUDLLM_UPSTREAM_TIMEOUT_SECS").and_then(|s| s.parse().ok()) {
            self.upstream_timeout_secs = v;
        }
        if let Some(v) = lookup("CLOUDLLM_COOLDOWN_BASE_SECS").and_then(|s| s.parse().ok()) {
            self.cooldown_base_secs = v;
        }
        if let Some(v) = lookup("CLOUDLLM_COOLDOWN_MAX_SECS").and_then(|s| s.parse().ok()) {
            self.cooldown_max_secs = v;
        }
        if let Some(v) = lookup("CLOUDLLM_AUDIT_BODY_LIMIT").and_then(|s| s.parse().ok()) {
            self.audit_body_limit = v;
        }
        if let Some(v) = lookup("CLOUDLLM_AUDIT_RETENTION_DAYS").and_then(|s| s.parse().ok()) {
            self.audit_retention_days = v;
        }
        if let Some(v) = lookup("CLOUDLLM_MAX_BODY_BYTES").and_then(|s| s.parse().ok()) {
            self.max_body_bytes = v;
        }
        if let Some(v) = lookup("CLOUDLLM_SHUTDOWN_DRAIN_SECS").and_then(|s| s.parse().ok()) {
            self.shutdown_drain_secs = v;
        }
        if let Some(v) = lookup("CLOUDLLM_COOKIE_SECURE") {
            // "true"/"1" 为真,其余(含空串)置 false——显式给值即覆盖
            self.cookie_secure = matches!(v.trim(), "true" | "1");
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
            "session_secret 必须 ≥32 字节,实际 {} 字节",
            self.session_secret.len()
        );
        self.listen
            .parse::<std::net::SocketAddr>()
            .with_context(|| format!("listen 不是合法地址: {}", self.listen))?;
        ensure!(
            self.audit_retention_days > 0,
            "audit_retention_days 必须 >0,实际 {};0 或负值会把全部 audit 体一夜清空",
            self.audit_retention_days
        );
        ensure!(
            self.cooldown_base_secs > 0,
            "cooldown_base_secs 必须 >0,实际 {}",
            self.cooldown_base_secs
        );
        ensure!(
            self.cooldown_max_secs >= self.cooldown_base_secs,
            "cooldown_max_secs({})必须 ≥ cooldown_base_secs({})",
            self.cooldown_max_secs,
            self.cooldown_base_secs
        );
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
        assert_eq!(cfg.listen, "0.0.0.0:7200");
        assert_eq!(cfg.db_path, "./cloudllm.db");
        assert_eq!(cfg.master_key_bytes(), [7u8; 32]);
    }

    #[test]
    fn env_overrides_win() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|k| match k {
            "CLOUDLLM_LISTEN" => Some("127.0.0.1:9000".into()),
            "CLOUDLLM_DB_PATH" => Some("/data/x.db".into()),
            "CLOUDLLM_MASTER_KEY" => Some("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=".into()),
            "CLOUDLLM_SESSION_SECRET" => Some("override-session-secret-0123456789ab".into()),
            "CLOUDLLM_GATEWAY_PUBLIC_URL" => Some("https://llm.corp".into()),
            _ => None,
        });
        cfg.validate().unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:9000");
        assert_eq!(cfg.db_path, "/data/x.db");
        assert_eq!(cfg.master_key_bytes(), [9u8; 32]);
        assert_eq!(cfg.session_secret, "override-session-secret-0123456789ab");
        assert_eq!(cfg.gateway_public_url.as_deref(), Some("https://llm.corp"));
    }

    #[test]
    fn debug_redacts_secrets() {
        let cfg: Config = toml::from_str(&base_toml()).unwrap();
        let s = format!("{cfg:?}");
        assert!(s.contains("<redacted>"));
        assert!(!s.contains(MK), "Debug 输出不得包含 master_key 明文");
        assert!(!s.contains(SS), "Debug 输出不得包含 session_secret 明文");
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
    fn gateway_defaults_present() {
        let cfg: Config = toml::from_str(&base_toml()).unwrap();
        assert_eq!(cfg.upstream_connect_timeout_secs, 10);
        assert_eq!(cfg.upstream_timeout_secs, 300);
        assert_eq!(cfg.cooldown_base_secs, 30);
        assert_eq!(cfg.cooldown_max_secs, 600);
        assert_eq!(cfg.audit_body_limit, 65536);
        assert_eq!(cfg.audit_retention_days, 30);
        assert_eq!(cfg.max_body_bytes, 2 * 1024 * 1024);
        assert_eq!(cfg.shutdown_drain_secs, 25);
    }

    #[test]
    fn gateway_env_overrides_win() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|k| match k {
            "CLOUDLLM_UPSTREAM_TIMEOUT_SECS" => Some("120".into()),
            "CLOUDLLM_COOLDOWN_BASE_SECS" => Some("5".into()),
            "CLOUDLLM_AUDIT_BODY_LIMIT" => Some("4096".into()),
            "CLOUDLLM_SHUTDOWN_DRAIN_SECS" => Some("15".into()),
            _ => None,
        });
        cfg.validate().unwrap();
        assert_eq!(cfg.upstream_timeout_secs, 120);
        assert_eq!(cfg.cooldown_base_secs, 5);
        assert_eq!(cfg.audit_body_limit, 4096);
        assert_eq!(cfg.shutdown_drain_secs, 15);
    }

    #[test]
    fn cookie_secure_defaults_false() {
        let cfg: Config = toml::from_str(&base_toml()).unwrap();
        assert!(!cfg.cookie_secure);
    }

    #[test]
    fn cookie_secure_env_override_true() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|k| match k {
            "CLOUDLLM_COOKIE_SECURE" => Some("true".into()),
            _ => None,
        });
        cfg.validate().unwrap();
        assert!(cfg.cookie_secure);
    }

    #[test]
    fn zero_audit_retention_rejected() {
        let toml_text = format!("{}\naudit_retention_days = 0\n", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("audit_retention_days"));
    }

    #[test]
    fn negative_audit_retention_rejected() {
        let toml_text = format!("{}\naudit_retention_days = -1\n", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("audit_retention_days"));
    }

    #[test]
    fn zero_cooldown_base_rejected() {
        let toml_text = format!("{}\ncooldown_base_secs = 0\n", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("cooldown_base_secs"));
    }

    #[test]
    fn cooldown_max_below_base_rejected() {
        let toml_text = format!(
            "{}\ncooldown_base_secs = 100\ncooldown_max_secs = 50\n",
            base_toml()
        );
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert!(cfg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("cooldown_max_secs"));
    }

    #[test]
    fn gateway_toml_overrides_default() {
        let toml_text = format!("{}\ncooldown_max_secs = 1200\n", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert_eq!(cfg.cooldown_max_secs, 1200);
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
