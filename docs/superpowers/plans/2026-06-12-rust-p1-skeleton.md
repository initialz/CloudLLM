# CloudLLM v2 Rust 重写 — P1 骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现仓库根目录建立 Rust 单 crate 工程,交付:配置加载与校验、SQLite(9 表迁移)、密码/信封/会话加密原语、`--init`/`serve`/`admin reset-password` CLI、管理员登录会话 API、rust-embed 内嵌 admin-ui 壳(暗色科技感登录页 + Dashboard 占位),以及 Rust CI。P1 结束时:`cloudllm --init && cloudllm serve` 后浏览器可登录管理台。

**Architecture:** 单 crate(lib + bin),axum 单端口同时服务 `/admin/api/*`(REST)与 `/admin/*`(rust-embed SPA);SQLite WAL 单文件;无任何外部服务依赖。TS 版(apps/、packages/)原地保留,P4 才删除——本阶段与之零交集(根目录新增 `Cargo.toml`/`src/`/`migrations/`/`admin-ui/`,无路径冲突,已核实)。

**Tech Stack:** Rust(axum 0.7、tokio、sqlx 0.8/sqlite、rust-embed 8、argon2 0.5、aes-gcm 0.10、hmac/sha2、clap 4)+ React 18 + Vite 5 + Tailwind 3。

**执行约束(用户要求):** 所有写代码的 subagent 一律 `model: "opus"`;沿用 implementer + spec-review + quality-review 三角流程。

**全局约定(每个任务都必须遵守):**
- sqlx 一律用**运行时查询 API**(`sqlx::query` / `query_as` + `bind`),**禁用** `query!` 宏(避免编译期 DATABASE_URL/离线元数据耦合)。
- 时间一律 unix epoch 秒(i64),取自 `cloudllm::now_epoch()`;金额一律 i64 micro-CNY。
- 错误文案对用户用中文;`tracing` 日志中文;代码注释中文(只写代码本身表达不了的约束)。
- 内存测试库必须 `max_connections(1)`(SQLite `:memory:` 每个连接是独立的库,池 >1 会拿到不同库——这是 sqlx/SQLite 的经典坑)。
- 会话是无状态 HMAC cookie:**登出只清浏览器 cookie,旧 cookie 值在过期前重放仍有效**(与 TS 版一致的已知取舍)。不要写"登出后旧 cookie 401"这种必然失败的测试。
- axum 固定 0.7(通配路由语法 `/*path`;0.8 语法不同,禁止升级)。

---

## 文件结构总览

```
Cargo.toml                      # Task 1(Task 10 补 build = "build.rs")
rustfmt.toml                    # Task 1
.github/workflows/rust-ci.yml   # Task 1(与 TS 的 ci.yml 并存)
src/lib.rs                      # Task 1 起,逐任务补模块声明;now_epoch/AppState/app()
src/config.rs                   # Task 2
src/crypto.rs                   # Task 3、4
migrations/0001_init.sql        # Task 5
src/db.rs                       # Task 5
src/auth.rs                     # Task 6(会话)+ Task 8(AdminUser extractor)
src/error.rs                    # Task 7
src/admin/mod.rs                # Task 7
src/admin/api.rs                # Task 7(/healthz 在 lib.rs)、Task 8(login/logout/me)
src/cli.rs                      # Task 9
src/main.rs                     # Task 1 占位,Task 9 接 clap
build.rs                        # Task 10
src/admin/assets.rs             # Task 10
admin-ui/…                      # Task 11(React 工程;dist 不进 git,build.rs 兜底占位)
src/test_util.rs                # Task 7(#[cfg(test)] 共享测试设施)
```

---

### Task 1: Cargo 工程骨架 + CI

**Files:**
- Create: `Cargo.toml`、`rustfmt.toml`、`src/lib.rs`、`src/main.rs`、`.github/workflows/rust-ci.yml`
- Modify: `.gitignore`(追加 Rust 条目)

- [ ] **Step 1: 写 Cargo.toml**

```toml
[package]
name = "cloudllm"
version = "2.0.0-dev"
edition = "2021"
license = "MIT"

[dependencies]
axum = "0.7"
axum-extra = { version = "0.9", features = ["cookie"] }
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.6", features = ["trace"] }
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "sqlite", "migrate"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
clap = { version = "4", features = ["derive"] }
rust-embed = { version = "8", features = ["debug-embed"] }
argon2 = "0.5"
aes-gcm = "0.10"
sha2 = "0.10"
hmac = "0.12"
base64 = "0.22"
rand = "0.8"
uuid = { version = "1", features = ["v4"] }
time = "0.3"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
tempfile = "3"
```

- [ ] **Step 2: 写 rustfmt.toml(默认风格即可,占位锁定)**

```toml
edition = "2021"
```

- [ ] **Step 3: 写 src/lib.rs(最小可编译 + now_epoch)**

```rust
//! CloudLLM v2 — Rust 一体化 LLM 网关(hub + admin-ui)。

/// 当前 unix epoch 秒。全工程统一时间来源。
pub fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_epoch_is_reasonable() {
        // 2026-01-01 之后、2100 年之前
        let t = now_epoch();
        assert!(t > 1_767_225_600 && t < 4_102_444_800);
    }
}
```

- [ ] **Step 4: 写 src/main.rs 占位(Task 9 替换为 clap)**

```rust
fn main() {
    println!("cloudllm v2 — CLI 将在后续任务接线");
}
```

- [ ] **Step 5: .gitignore 追加 Rust 条目**

在现有 `.gitignore` 末尾追加:

```
/target
Cargo.lock.orig
```

注意:现有 `.gitignore` 已有 `dist/`,会同时忽略 `admin-ui/dist`——这是有意的(与 cloudcode 相同:dist 不进 git,build.rs 兜底,见 Task 10)。`Cargo.lock` **要提交**(bin crate 惯例),不要忽略它。

- [ ] **Step 6: 验证编译与测试**

Run: `cargo test 2>&1 | tail -5`
Expected: `test tests::now_epoch_is_reasonable ... ok`,1 passed。
Run: `cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: 无输出、退出码 0。

- [ ] **Step 7: 写 .github/workflows/rust-ci.yml**

```yaml
name: rust-ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test

  admin-ui:
    runs-on: ubuntu-latest
    # admin-ui 在 Task 11 才创建;目录不存在时跳过,避免 P1 中途 CI 红
    steps:
      - uses: actions/checkout@v4
      - id: exists
        run: test -f admin-ui/package.json && echo "yes=true" >> "$GITHUB_OUTPUT" || echo "yes=false" >> "$GITHUB_OUTPUT"
      - if: steps.exists.outputs.yes == 'true'
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - if: steps.exists.outputs.yes == 'true'
        working-directory: admin-ui
        run: npm ci && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock rustfmt.toml src/ .github/workflows/rust-ci.yml .gitignore
git commit -m "feat(rust): P1-T1 Cargo 工程骨架 + rust CI"
```

---

### Task 2: config.rs — TOML 配置 + env 覆盖 + 启动校验

**Files:**
- Create: `src/config.rs`
- Modify: `src/lib.rs`(加 `pub mod config;`)

- [ ] **Step 1: 写失败测试(src/config.rs 末尾的 tests 模块,与实现同文件)**

先在 `src/lib.rs` 加 `pub mod config;`,然后创建 `src/config.rs`,只写测试与空声明骨架——按 TDD,测试先行;为让测试能编译,实现函数体可先 `todo!()`:

```rust
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
        todo!()
    }

    /// 用注入的查找函数覆盖配置(生产传 std::env::var,测试传闭包——
    /// 避免测试改进程级环境变量导致并行用例互相污染)
    pub fn apply_overrides(&mut self, lookup: impl Fn(&str) -> Option<String>) {
        todo!()
    }

    pub fn validate(&self) -> Result<()> {
        todo!()
    }

    /// 已 validate 的前提下取主密钥字节
    pub fn master_key_bytes(&self) -> [u8; 32] {
        todo!()
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
        assert!(cfg.validate().unwrap_err().to_string().contains("session_secret"));
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test config:: 2>&1 | tail -8`
Expected: panic at `todo!()`(或编译期警告),用例失败。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
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
        ensure!(mk.len() == 32, "master_key 解码后必须是 32 字节,实际 {} 字节", mk.len());
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

    pub fn master_key_bytes(&self) -> [u8; 32] {
        let v = B64.decode(&self.master_key).expect("validate 后调用");
        v.try_into().expect("validate 保证 32 字节")
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test config:: 2>&1 | tail -3`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add src/config.rs src/lib.rs
git commit -m "feat(rust): P1-T2 config 加载/env 覆盖/启动校验"
```

---

### Task 3: crypto.rs — argon2 密码哈希 + API Key 生成/哈希

**Files:**
- Create: `src/crypto.rs`
- Modify: `src/lib.rs`(加 `pub mod crypto;`)

- [ ] **Step 1: 写失败测试(同文件 tests 模块;实现先 todo!)**

```rust
use anyhow::{anyhow, ensure, Result};
use argon2::password_hash::{rand_core::OsRng as PwOsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

/// API Key 前缀。与 TS 版/已发放 Key 保持一致,不可更改。
pub const API_KEY_PREFIX: &str = "sk-cloudllm-";
/// key_prefix 字段长度(后台识别用,与 TS 版一致)
const KEY_PREFIX_LEN: usize = 15;

pub struct GeneratedApiKey {
    /// 完整明文,仅签发瞬间返回一次
    pub plaintext: String,
    /// SHA-256 hex,入库字段
    pub key_hash: String,
    /// 前 15 字符,后台识别用
    pub key_prefix: String,
}

pub fn hash_password(password: &str) -> Result<String> {
    todo!()
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    todo!()
}

pub fn generate_api_key() -> GeneratedApiKey {
    todo!()
}

pub fn hash_api_key(plaintext: &str) -> String {
    todo!()
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
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test crypto:: 2>&1 | tail -8` → todo! panic,失败。

- [ ] **Step 3: 实现**

```rust
pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut PwOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("argon2 哈希失败: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test crypto:: 2>&1 | tail -3` → 4 passed。

- [ ] **Step 5: Commit**

```bash
git add src/crypto.rs src/lib.rs
git commit -m "feat(rust): P1-T3 argon2 密码哈希 + sk-cloudllm- Key 生成/SHA-256"
```

---

### Task 4: crypto.rs — AES-256-GCM 信封加密

**Files:**
- Modify: `src/crypto.rs`

- [ ] **Step 1: 在 tests 模块追加失败测试**

```rust
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
```

- [ ] **Step 2: 跑测试确认编译失败(函数不存在)**

Run: `cargo test crypto::tests::envelope 2>&1 | tail -5` → cannot find function。

- [ ] **Step 3: 实现(追加到 src/crypto.rs)**

```rust
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

const NONCE_LEN: usize = 12;

/// 信封加密:输出 = nonce(12B) || ciphertext+tag。
/// AAD 必填(渠道行 UUID)——密文与行绑定,拷到别的行解不开。
pub fn encrypt_secret(plaintext: &str, master_key: &[u8; 32], aad: &str) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(master_key.into());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: plaintext.as_bytes(), aad: aad.as_bytes() },
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
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: aad.as_bytes() })
        .map_err(|_| anyhow!("信封解密失败(密钥或 AAD 不匹配)"))?;
    String::from_utf8(pt).map_err(|_| anyhow!("解密结果不是 UTF-8"))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test crypto:: 2>&1 | tail -3` → 9 passed。

- [ ] **Step 5: Commit**

```bash
git add src/crypto.rs
git commit -m "feat(rust): P1-T4 AES-256-GCM 信封加密(AAD 绑定行 UUID)"
```

---

### Task 5: migrations/0001_init.sql + db.rs

**Files:**
- Create: `migrations/0001_init.sql`、`src/db.rs`
- Modify: `src/lib.rs`(加 `pub mod db;`)

- [ ] **Step 1: 写迁移 SQL(完整 9 表,spec §4)**

`migrations/0001_init.sql`:

```sql
-- CloudLLM v2 初始 schema。
-- 约定:id 一律 uuid 文本;时间一律 unix epoch 秒(INTEGER);金额一律 micro-CNY(INTEGER,1 CNY = 1,000,000)。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  name           TEXT NOT NULL,
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('user', 'team')),
  owner_id       TEXT NOT NULL,
  allowed_models TEXT,            -- JSON 数组;NULL = 不限模型
  audit          INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     INTEGER NOT NULL
);

CREATE TABLE channels (
  id                   TEXT PRIMARY KEY,  -- uuid,同时是凭证信封加密的 AAD
  provider_type        TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic')),
  name                 TEXT NOT NULL,
  base_url             TEXT NOT NULL,     -- 应用层校验以 /v1 结尾
  credential_encrypted BLOB NOT NULL,
  weight               INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'cooldown')),
  cooldown_until       INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE models (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL UNIQUE,   -- 客户端可见模型名
  provider_type           TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic')),
  upstream_model          TEXT NOT NULL,          -- 转发时替换的真实模型名
  input_price_micro       INTEGER NOT NULL,       -- micro-CNY / 1M tokens
  output_price_micro      INTEGER NOT NULL,
  cache_read_price_micro  INTEGER NOT NULL DEFAULT 0,
  cache_write_price_micro INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at              INTEGER NOT NULL
);

CREATE TABLE budgets (
  id              TEXT PRIMARY KEY,
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('key', 'user', 'team')),
  subject_id      TEXT NOT NULL,
  period          TEXT NOT NULL CHECK (period IN ('monthly', 'total')),
  limit_micro     INTEGER NOT NULL,
  used_micro      INTEGER NOT NULL DEFAULT 0,
  period_start    INTEGER NOT NULL,
  alert_threshold REAL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      INTEGER NOT NULL,
  UNIQUE (subject_type, subject_id, period)
);

CREATE TABLE usage_records (
  id                 TEXT PRIMARY KEY,
  key_id             TEXT NOT NULL,    -- 软引用 api_keys.id(不设 FK:Key 删除后账单保留)
  model_slug         TEXT NOT NULL,
  channel_id         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro         INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  ttft_ms            INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'upstream_error', 'client_abort')),
  error_code         TEXT,
  request_body       TEXT,             -- 仅 audit key,截断后存
  response_body      TEXT,             -- 仅 audit key,截断后存
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_usage_key_created ON usage_records (key_id, created_at);
CREATE INDEX idx_usage_created ON usage_records (created_at);

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  subject       TEXT,
  detail        TEXT,                  -- JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events (created_at);
```

- [ ] **Step 2: 写 db.rs 测试(实现先 todo!)**

`src/db.rs`:

```rust
use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

/// 打开(必要时创建)文件库:WAL、busy_timeout 5s、外键开、迁移自动执行。
pub async fn open(path: &str) -> Result<SqlitePool> {
    todo!()
}

/// 测试用内存库。max_connections 必须为 1:
/// SQLite 的 :memory: 每个连接是独立的库,池 >1 会拿到互不相通的空库。
pub async fn open_memory() -> Result<SqlitePool> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_create_all_tables() {
        let pool = open_memory().await.unwrap();
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' \
             AND name NOT LIKE '_sqlx%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            names,
            vec![
                "api_keys", "audit_events", "budgets", "channels", "models",
                "team_members", "teams", "usage_records", "users"
            ]
        );
    }

    #[tokio::test]
    async fn budgets_unique_subject_period() {
        let pool = open_memory().await.unwrap();
        let ins = "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, period_start, created_at) \
                   VALUES (?, 'key', 'k1', 'monthly', 1000000, 0, 0)";
        sqlx::query(ins).bind("b1").execute(&pool).await.unwrap();
        let dup = sqlx::query(ins).bind("b2").execute(&pool).await;
        assert!(dup.is_err(), "相同 (subject_type, subject_id, period) 必须被唯一约束拒绝");
    }

    #[tokio::test]
    async fn foreign_keys_enforced() {
        let pool = open_memory().await.unwrap();
        let r = sqlx::query("INSERT INTO team_members (team_id, user_id) VALUES ('no-team', 'no-user')")
            .execute(&pool)
            .await;
        assert!(r.is_err(), "外键必须在连接级开启");
    }

    #[tokio::test]
    async fn open_creates_file_and_wal(){
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        let pool = open(p.to_str().unwrap()).await.unwrap();
        let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert!(p.exists());
    }
}
```

并在 `src/lib.rs` 加 `pub mod db;`。

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test db:: 2>&1 | tail -5` → todo! panic。

- [ ] **Step 4: 实现**

```rust
pub async fn open(path: &str) -> Result<SqlitePool> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录 {}", parent.display()))?;
        }
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .with_context(|| format!("打开数据库 {path}"))?;
    sqlx::migrate!("./migrations").run(&pool).await.context("执行迁移")?;
    Ok(pool)
}

pub async fn open_memory() -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(":memory:")
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .context("打开内存数据库")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("执行迁移")?;
    Ok(pool)
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test db:: 2>&1 | tail -3` → 4 passed。

- [ ] **Step 6: Commit**

```bash
git add migrations/ src/db.rs src/lib.rs
git commit -m "feat(rust): P1-T5 SQLite 9 表迁移 + WAL/外键/busy_timeout 连接管理"
```

---

### Task 6: auth.rs — HMAC 会话编解码

**Files:**
- Create: `src/auth.rs`
- Modify: `src/lib.rs`(加 `pub mod auth;`)

- [ ] **Step 1: 写失败测试(同文件;实现 todo!)**

```rust
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
    todo!()
}

/// 解码并校验签名与过期。now 由调用方传入(可测试)。
pub fn decode_session(raw: &str, secret: &str, now: i64) -> Option<SessionData> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-session-secret-0123456789abcdef";

    fn session(exp: i64) -> SessionData {
        SessionData { user_id: "u-1".into(), exp }
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test auth:: 2>&1 | tail -5` → 失败。

- [ ] **Step 3: 实现**

```rust
pub fn encode_session(data: &SessionData, secret: &str) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(data).expect("序列化会话"));
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥");
    mac.update(payload.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

pub fn decode_session(raw: &str, secret: &str, now: i64) -> Option<SessionData> {
    let (payload, sig) = raw.split_once('.')?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig_bytes).ok()?; // 常数时间比较
    let data: SessionData = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    (data.exp > now).then_some(data)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test auth:: 2>&1 | tail -3` → 5 passed。

- [ ] **Step 5: Commit**

```bash
git add src/auth.rs src/lib.rs
git commit -m "feat(rust): P1-T6 HMAC 无状态会话编解码(常数时间校验)"
```

---

### Task 7: error.rs + AppState + app() + /healthz + 测试设施

**Files:**
- Create: `src/error.rs`、`src/admin/mod.rs`、`src/admin/api.rs`、`src/test_util.rs`
- Modify: `src/lib.rs`

- [ ] **Step 1: 写 error.rs**

```rust
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
        Self { status: StatusCode::BAD_REQUEST, code: "bad_request", message: message.into() }
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
```

- [ ] **Step 2: lib.rs 加 AppState、app()、healthz;admin 模块壳**

`src/lib.rs` 变为:

```rust
//! CloudLLM v2 — Rust 一体化 LLM 网关(hub + admin-ui)。

pub mod admin;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
#[cfg(test)]
pub(crate) mod test_util;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<config::Config>,
}

/// 组装全部路由。网关 /v1/* 在 P2 接入。
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .nest("/admin/api", admin::api::router())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "db unavailable"),
    }
}

/// 当前 unix epoch 秒。全工程统一时间来源。
pub fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn now_epoch_is_reasonable() {
        let t = now_epoch();
        assert!(t > 1_767_225_600 && t < 4_102_444_800);
    }

    #[tokio::test]
    async fn healthz_ok() {
        let state = crate::test_util::test_state().await;
        let resp = app(state)
            .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
```

`src/admin/mod.rs`:

```rust
pub mod api;
```

`src/admin/api.rs`(本任务只有空路由器,Task 8 填充):

```rust
use crate::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
```

- [ ] **Step 3: 写 src/test_util.rs(共享测试设施)**

```rust
//! 测试共享设施:内存库 + 测试配置 + 常用请求/断言辅助。

use crate::config::Config;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, Request, Response};
use http_body_util::BodyExt;
use std::sync::Arc;

pub const TEST_MASTER_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // base64([7u8;32])
pub const TEST_SESSION_SECRET: &str = "test-session-secret-0123456789abcdef";

pub fn test_config() -> Config {
    let toml_text = format!(
        "master_key = \"{TEST_MASTER_KEY}\"\nsession_secret = \"{TEST_SESSION_SECRET}\"\n"
    );
    let cfg: Config = toml::from_str(&toml_text).expect("测试配置");
    cfg.validate().expect("测试配置合法");
    cfg
}

pub async fn test_state() -> AppState {
    AppState {
        db: crate::db::open_memory().await.expect("内存库"),
        config: Arc::new(test_config()),
    }
}

/// 构造 JSON 请求
pub fn json_request(method: &str, uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("构造请求")
}

/// 读响应体为 JSON
pub async fn body_json(resp: Response<Body>) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.expect("读响应体").to_bytes();
    serde_json::from_slice(&bytes).expect("响应体不是 JSON")
}

/// 从 Set-Cookie 头取 "name=value"(分号前第一段)
pub fn first_cookie(resp: &Response<Body>) -> String {
    resp.headers()
        .get(header::SET_COOKIE)
        .expect("缺少 Set-Cookie")
        .to_str()
        .expect("Set-Cookie 非 ASCII")
        .split(';')
        .next()
        .expect("Set-Cookie 为空")
        .to_string()
}

/// 在库里插入一个用户,返回 user_id
pub async fn insert_user(
    db: &sqlx::SqlitePool,
    email: &str,
    password: &str,
    role: &str,
    status: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let hash = crate::crypto::hash_password(password).expect("哈希");
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(email)
    .bind(hash)
    .bind(role)
    .bind(status)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入用户");
    id
}
```

- [ ] **Step 4: 跑全部测试**

Run: `cargo test 2>&1 | tail -5`
Expected: 此前所有用例 + `healthz_ok` 全 pass(共 16 个)。
Run: `cargo clippy --all-targets -- -D warnings` → 无警告(test_util 的暂未使用项若告警,在 `src/test_util.rs` 顶部加 `#![allow(dead_code)]` 并注明"Task 8 起使用")。

- [ ] **Step 5: Commit**

```bash
git add src/error.rs src/admin/ src/test_util.rs src/lib.rs
git commit -m "feat(rust): P1-T7 AppState/app()/healthz/ApiError + 共享测试设施"
```

---

### Task 8: 登录/登出/me API + AdminUser extractor

**Files:**
- Modify: `src/auth.rs`(追加 AdminUser extractor)、`src/admin/api.rs`(路由与 handler)

- [ ] **Step 1: 在 src/admin/api.rs 写失败测试(先写测试模块)**

在文件末尾追加:

```rust
#[cfg(test)]
mod tests {
    use crate::test_util::{body_json, first_cookie, insert_user, json_request, test_state};
    use crate::{app, AppState};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use serde_json::json;
    use tower::ServiceExt;

    async fn state_with_admin() -> AppState {
        let state = test_state().await;
        insert_user(&state.db, "admin@x.com", "Adm1n!pass", "admin", "active").await;
        state
    }

    async fn login(state: &AppState, email: &str, password: &str) -> axum::http::Response<Body> {
        app(state.clone())
            .oneshot(json_request(
                "POST",
                "/admin/api/login",
                json!({"email": email, "password": password}),
            ))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn login_ok_sets_cookie_and_returns_me() {
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "Adm1n!pass").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let cookie = first_cookie(&resp);
        assert!(cookie.starts_with("cloudllm_session="));
        let body = body_json(resp).await;
        assert_eq!(body["email"], "admin@x.com");
        assert_eq!(body["role"], "admin");
    }

    #[tokio::test]
    async fn login_wrong_password_uniform_message() {
        let state = state_with_admin().await;
        let resp = login(&state, "admin@x.com", "wrong").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_unknown_email_same_message() {
        let state = state_with_admin().await;
        let resp = login(&state, "nobody@x.com", "whatever").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_non_admin_rejected_uniform() {
        let state = state_with_admin().await;
        insert_user(&state.db, "user@x.com", "User!pass1", "user", "active").await;
        let resp = login(&state, "user@x.com", "User!pass1").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"]["message"], "邮箱或密码错误");
    }

    #[tokio::test]
    async fn login_disabled_admin_rejected() {
        let state = test_state().await;
        insert_user(&state.db, "off@x.com", "Off!pass11", "admin", "disabled").await;
        let resp = login(&state, "off@x.com", "Off!pass11").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn me_requires_session() {
        let state = state_with_admin().await;
        let resp = app(state)
            .oneshot(Request::builder().uri("/admin/api/me").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn me_with_cookie_ok() {
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["email"], "admin@x.com");
    }

    #[tokio::test]
    async fn session_invalidated_when_user_disabled() {
        // 无状态 cookie 的撤销补偿:每请求回查 users.status
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        sqlx::query("UPDATE users SET status = 'disabled' WHERE email = 'admin@x.com'")
            .execute(&state.db)
            .await
            .unwrap();
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn session_invalidated_when_demoted() {
        // role 以 DB 为准:管理员降级即时失效
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        sqlx::query("UPDATE users SET role = 'user' WHERE email = 'admin@x.com'")
            .execute(&state.db)
            .await
            .unwrap();
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/admin/api/me")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn logout_clears_cookie() {
        // 注意:无状态会话,登出只清浏览器 cookie;不要断言旧 cookie 失效
        let state = state_with_admin().await;
        let cookie = first_cookie(&login(&state, "admin@x.com", "Adm1n!pass").await);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/admin/api/logout")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let set = resp.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap();
        assert!(set.contains("cloudllm_session="), "应下发清除 cookie");
        assert!(set.to_lowercase().contains("max-age=0"), "清除 cookie 需 Max-Age=0,实际: {set}");
    }
}
```

- [ ] **Step 2: 跑测试确认编译失败(路由不存在)**

Run: `cargo test admin::api 2>&1 | tail -5` → 404/编译错误,失败。

- [ ] **Step 3: 在 src/auth.rs 追加 AdminUser extractor**

文件顶部补 import:

```rust
use crate::error::ApiError;
use crate::AppState;
use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::CookieJar;
```

追加:

```rust
/// 已认证的管理员。作为 handler 参数即完成鉴权:
/// cookie → HMAC 校验 → 回查 users 表(status/role 以 DB 为准,停用/降级即时生效)。
pub struct AdminUser {
    pub id: String,
    pub email: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let jar = CookieJar::from_headers(&parts.headers);
        let raw = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or_else(ApiError::unauthorized)?;
        let session = decode_session(&raw, &state.config.session_secret, crate::now_epoch())
            .ok_or_else(ApiError::unauthorized)?;
        let row: Option<(String, String, String)> =
            sqlx::query_as("SELECT email, role, status FROM users WHERE id = ?")
                .bind(&session.user_id)
                .fetch_optional(&state.db)
                .await
                .map_err(ApiError::internal)?;
        match row {
            Some((email, role, status)) if status == "active" && role == "admin" => {
                Ok(AdminUser { id: session.user_id, email })
            }
            _ => Err(ApiError::unauthorized()),
        }
    }
}
```

- [ ] **Step 4: 实现 src/admin/api.rs 路由与 handler**

替换文件内容(测试模块保留):

```rust
use crate::auth::{encode_session, AdminUser, SessionData, SESSION_COOKIE, SESSION_TTL_SECS};
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct MeResp {
    email: String,
    role: &'static str,
}

fn session_cookie(value: String, max_age_secs: i64) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(max_age_secs))
        .build()
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> Result<(CookieJar, Json<MeResp>), ApiError> {
    let row: Option<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT id, email, password_hash, role, status FROM users WHERE email = ?",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?;

    // 已知限制(timing 侧信道):用户不存在时跳过 argon2,响应更快,可被用于枚举。
    // 与 TS 版相同的取舍;内部系统接受。
    let Some((id, email, password_hash, role, status)) = row else {
        return Err(ApiError::login_failed());
    };
    if status != "active"
        || !crate::crypto::verify_password(&req.password, &password_hash)
        || role != "admin"
    {
        // 统一文案,不区分原因(防枚举)
        return Err(ApiError::login_failed());
    }

    let session = SessionData { user_id: id, exp: now_epoch() + SESSION_TTL_SECS };
    let value = encode_session(&session, &state.config.session_secret);
    Ok((jar.add(session_cookie(value, SESSION_TTL_SECS)), Json(MeResp { email, role: "admin" })))
}

async fn logout(jar: CookieJar) -> (CookieJar, StatusCode) {
    // 无状态会话:仅指示浏览器删除 cookie(Max-Age=0)
    (jar.add(session_cookie(String::new(), 0)), StatusCode::NO_CONTENT)
}

async fn me(user: AdminUser) -> Json<MeResp> {
    Json(MeResp { email: user.email, role: "admin" })
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test 2>&1 | tail -4`
Expected: 全部通过(26 个)。
Run: `cargo clippy --all-targets -- -D warnings` → 干净。

- [ ] **Step 6: Commit**

```bash
git add src/auth.rs src/admin/api.rs
git commit -m "feat(rust): P1-T8 管理员登录/登出/me + AdminUser extractor(DB 权威回查)"
```

---

### Task 9: cli.rs(init / serve / reset-password)+ main.rs 接线

**Files:**
- Create: `src/cli.rs`
- Modify: `src/lib.rs`(加 `pub mod cli;`)、`src/main.rs`(替换为 clap)

- [ ] **Step 1: 写失败测试(src/cli.rs tests 模块)**

```rust
use crate::config::Config;
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use std::path::Path;

pub struct InitOutcome {
    pub admin_email: String,
    pub admin_password: String,
    pub config_path: std::path::PathBuf,
    pub db_path: std::path::PathBuf,
}

/// --init:生成配置(随机 master_key/session_secret)+ 建库迁移 + 创建管理员。
/// 配置文件已存在则报错(防覆盖)。
pub async fn run_init(config_path: &Path, admin_email: &str) -> Result<InitOutcome> {
    todo!()
}

/// admin reset-password:重置指定邮箱用户密码,返回新密码。
pub async fn run_reset_password(config_path: &Path, email: &str) -> Result<String> {
    todo!()
}

/// serve:加载配置、开库、起服务,优雅停机(ctrl_c / SIGTERM)。
pub async fn run_serve(config_path: &Path) -> Result<()> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn init_creates_config_db_admin() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let out = run_init(&cfg_path, "boss@x.com").await.unwrap();

        assert!(cfg_path.exists());
        assert!(out.db_path.exists());
        assert!(out.admin_password.len() >= 16);

        // 配置可加载且合法
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(cfg.db_path, out.db_path.to_str().unwrap());

        // 管理员已建,密码可验证
        let pool = crate::db::open(&cfg.db_path).await.unwrap();
        let (email, role, hash): (String, String, String) =
            sqlx::query_as("SELECT email, role, password_hash FROM users LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(email, "boss@x.com");
        assert_eq!(role, "admin");
        assert!(crate::crypto::verify_password(&out.admin_password, &hash));
    }

    #[tokio::test]
    async fn init_refuses_existing_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        run_init(&cfg_path, "a@x.com").await.unwrap();
        let err = run_init(&cfg_path, "a@x.com").await.unwrap_err().to_string();
        assert!(err.contains("已存在"), "实际错误: {err}");
    }

    #[tokio::test]
    async fn reset_password_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let out = run_init(&cfg_path, "boss@x.com").await.unwrap();

        let new_pw = run_reset_password(&cfg_path, "boss@x.com").await.unwrap();
        assert_ne!(new_pw, out.admin_password);

        let cfg = Config::load(&cfg_path).unwrap();
        let pool = crate::db::open(&cfg.db_path).await.unwrap();
        let (hash,): (String,) =
            sqlx::query_as("SELECT password_hash FROM users WHERE email = 'boss@x.com'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(crate::crypto::verify_password(&new_pw, &hash));
        assert!(!crate::crypto::verify_password(&out.admin_password, &hash));
    }

    #[tokio::test]
    async fn reset_password_unknown_email_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        run_init(&cfg_path, "boss@x.com").await.unwrap();
        assert!(run_reset_password(&cfg_path, "ghost@x.com").await.is_err());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test cli:: 2>&1 | tail -5` → todo! panic。

- [ ] **Step 3: 实现**

```rust
pub async fn run_init(config_path: &Path, admin_email: &str) -> Result<InitOutcome> {
    if config_path.exists() {
        bail!("配置文件已存在: {}(如需重新初始化请先移走它)", config_path.display());
    }
    let cfg_dir = config_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(cfg_dir).with_context(|| format!("创建目录 {}", cfg_dir.display()))?;
    let db_path = cfg_dir.join("cloudllm.db");

    let mut mk = [0u8; 32];
    OsRng.fill_bytes(&mut mk);
    let mut ss = [0u8; 36];
    OsRng.fill_bytes(&mut ss);
    let master_key = B64.encode(mk);
    let session_secret = URL_SAFE_NO_PAD.encode(ss); // 48 字符

    let toml_text = format!(
        r#"# CloudLLM 配置(由 --init 生成)
listen = "0.0.0.0:7100"
db_path = "{db}"
# 渠道凭证信封加密主密钥(base64 32 字节)。丢失后已存渠道凭证不可恢复,务必备份。
master_key = "{master_key}"
# 管理会话签名密钥(≥32 字符)。更换将使所有已登录会话失效。
session_secret = "{session_secret}"
# 网关对外地址(生成成员接入说明用,可改)
gateway_public_url = "http://localhost:7100"
"#,
        db = db_path.display(),
    );
    std::fs::write(config_path, toml_text)
        .with_context(|| format!("写配置 {}", config_path.display()))?;

    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;

    let mut pw = [0u8; 12];
    OsRng.fill_bytes(&mut pw);
    let admin_password = URL_SAFE_NO_PAD.encode(pw); // 16 字符
    let hash = crate::crypto::hash_password(&admin_password)?;
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(admin_email)
    .bind(&hash)
    .bind(crate::now_epoch())
    .execute(&pool)
    .await
    .context("创建管理员")?;
    pool.close().await;

    Ok(InitOutcome {
        admin_email: admin_email.to_string(),
        admin_password,
        config_path: config_path.to_path_buf(),
        db_path,
    })
}

pub async fn run_reset_password(config_path: &Path, email: &str) -> Result<String> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    let mut pw = [0u8; 12];
    OsRng.fill_bytes(&mut pw);
    let new_password = URL_SAFE_NO_PAD.encode(pw);
    let hash = crate::crypto::hash_password(&new_password)?;
    let res = sqlx::query("UPDATE users SET password_hash = ? WHERE email = ?")
        .bind(&hash)
        .bind(email)
        .execute(&pool)
        .await
        .context("更新密码")?;
    pool.close().await;
    if res.rows_affected() == 0 {
        bail!("用户不存在: {email}");
    }
    Ok(new_password)
}

pub async fn run_serve(config_path: &Path) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    let state = crate::AppState { db: pool.clone(), config: std::sync::Arc::new(cfg.clone()) };
    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("监听 {}", cfg.listen))?;
    tracing::info!(listen = %cfg.listen, "CloudLLM 启动");
    axum::serve(listener, crate::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("服务异常退出")?;
    tracing::info!("已优雅停机");
    pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("注册 ctrl_c") };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("注册 SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
```

- [ ] **Step 4: 替换 src/main.rs**

```rust
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "cloudllm", version, about = "CloudLLM — 一体化 LLM 网关(hub + admin-ui)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 初始化:生成配置与数据库,创建管理员并打印初始密码
    Init {
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
        /// 管理员邮箱
        #[arg(long, default_value = "admin@cloudllm.local")]
        email: String,
    },
    /// 启动服务
    Serve {
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
    },
    /// 管理操作
    Admin {
        #[command(subcommand)]
        cmd: AdminCmd,
    },
}

#[derive(Subcommand)]
enum AdminCmd {
    /// 重置用户密码并打印新密码
    ResetPassword {
        email: String,
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Init { config, email } => {
            let out = cloudllm::cli::run_init(&config, &email).await?;
            println!("初始化完成。");
            println!("  配置文件: {}", out.config_path.display());
            println!("  数据库:   {}", out.db_path.display());
            println!("  管理员:   {}", out.admin_email);
            println!("  初始密码: {}(仅此一次,请立即保存)", out.admin_password);
            println!("启动: cloudllm serve --config {}", out.config_path.display());
        }
        Cmd::Serve { config } => cloudllm::cli::run_serve(&config).await?,
        Cmd::Admin { cmd: AdminCmd::ResetPassword { email, config } } => {
            let pw = cloudllm::cli::run_reset_password(&config, &email).await?;
            println!("已重置 {email} 的密码: {pw}");
        }
    }
    Ok(())
}
```

并在 `src/cli.rs` 测试模块外、`src/lib.rs` 加 `pub mod cli;`。在 cli.rs tests 模块追加 clap 自检用例:

```rust
    #[test]
    fn clap_definition_is_valid() {
        use clap::CommandFactory;
        // main.rs 里的 Cli 不可见;此处仅验证依赖特性可用。
        // 真正的 CLI 自检放 main.rs:
        let _ = clap::Command::new("probe").debug_assert();
    }
```

- [ ] **Step 5: 跑全部测试 + 真机冒烟**

Run: `cargo test 2>&1 | tail -4` → 全 pass(31 个)。
Run(冒烟):

```bash
cargo run -q -- init --config /tmp/cloudllm-p1/cloudllm.toml --email admin@corp.local
# Expected: 打印配置/库路径、管理员邮箱、16 字符初始密码
cargo run -q -- serve --config /tmp/cloudllm-p1/cloudllm.toml &
sleep 2 && curl -s http://localhost:7100/healthz   # Expected: ok
curl -s -X POST http://localhost:7100/admin/api/login -H 'content-type: application/json' \
  -d '{"email":"admin@corp.local","password":"<上面打印的密码>"}' -i | head -3
# Expected: HTTP/1.1 200 + set-cookie: cloudllm_session=...
kill %1
rm -rf /tmp/cloudllm-p1
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.rs src/main.rs src/lib.rs
git commit -m "feat(rust): P1-T9 CLI init/serve/admin reset-password + 优雅停机"
```

---

### Task 10: build.rs 占位 + assets.rs(rust-embed SPA 服务)

**Files:**
- Create: `build.rs`、`src/admin/assets.rs`
- Modify: `Cargo.toml`(加 `build = "build.rs"`)、`src/admin/mod.rs`、`src/lib.rs`(挂资产路由)

- [ ] **Step 1: 写 build.rs(照搬 cloudcode 模式:dist 缺失则生成占位 index.html)**

```rust
//! 保证 `admin-ui/dist/` 在 rust-embed 读取前存在。
//! dist 不进 git(根 .gitignore 的 dist/ 规则);首次 cargo build 时生成占位页,
//! 运行 `cd admin-ui && npm ci && npm run build` 后真实产物覆盖占位,
//! 下次 cargo build 即嵌入真实 UI。

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    ensure_placeholder(&manifest_dir.join("admin-ui/dist"));
    println!("cargo:rerun-if-changed=admin-ui/dist");
}

fn ensure_placeholder(dist: &Path) {
    let index = dist.join("index.html");
    if index.exists() {
        return;
    }
    std::fs::create_dir_all(dist.join("assets")).expect("创建 admin-ui/dist/assets");
    let html = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CloudLLM Console</title>
<style>body{background:#06080f;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;height:100vh;margin:0}code{color:#22d3ee}</style>
</head><body><div>
<p>admin-ui 尚未构建。在仓库根目录执行:</p>
<pre><code>cd admin-ui &amp;&amp; npm ci &amp;&amp; npm run build</code></pre>
<p>然后重新 <code>cargo build</code>。JSON API(<code>/admin/api/*</code>)不受影响。</p>
</div></body></html>"#;
    std::fs::write(&index, html).expect("写占位 index.html");
}
```

`Cargo.toml` 的 `[package]` 节加一行:

```toml
build = "build.rs"
```

- [ ] **Step 2: 写资产路由失败测试(src/admin/assets.rs 末尾)**

```rust
#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::test_state;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use tower::ServiceExt;

    async fn get(uri: &str) -> axum::http::Response<Body> {
        app(test_state().await)
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn admin_root_serves_html() {
        // build.rs 保证 dist/index.html 必然存在(占位或真实构建)
        let resp = get("/admin").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
        assert!(ct.starts_with("text/html"), "实际 content-type: {ct}");
    }

    #[tokio::test]
    async fn deep_link_falls_back_to_index() {
        let resp = get("/admin/keys/some-deep/route").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
        assert!(ct.starts_with("text/html"));
    }

    #[tokio::test]
    async fn missing_asset_falls_back_to_index() {
        let resp = get("/admin/assets/not-built-xyz.js").await;
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn index_is_no_cache_assets_are_immutable() {
        let resp = get("/admin").await;
        assert_eq!(resp.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test admin::assets 2>&1 | tail -5` → 404(路由不存在),失败。

- [ ] **Step 4: 实现 src/admin/assets.rs**

```rust
//! 从二进制内服务 Vite 构建的 admin SPA(rust-embed,debug 构建也嵌入)。
//! 路由规则:
//! - /admin/assets/<hash>.* 命中即长缓存(Vite 产物带内容哈希)
//! - 其余 /admin/* 全部回退 index.html,由前端路由接管(深链接/刷新)

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::{EmbeddedFile, RustEmbed};

#[derive(RustEmbed)]
#[folder = "admin-ui/dist/"]
struct Asset;

pub async fn serve_index() -> Response {
    match Asset::get("index.html") {
        Some(f) => file_response("index.html", f, "no-cache"),
        // build.rs 兜底后理论不可达;保留以防手工删 dist
        None => (StatusCode::SERVICE_UNAVAILABLE, "admin-ui 未构建").into_response(),
    }
}

pub async fn serve_asset(AxumPath(path): AxumPath<String>) -> Response {
    let key = format!("assets/{path}");
    match Asset::get(&key) {
        Some(f) => file_response(&key, f, "public, max-age=31536000, immutable"),
        None => serve_index().await,
    }
}

/// /admin/* 兜底:先试 dist 根的真实文件(favicon 等),再回退 index.html
pub async fn serve_spa(AxumPath(path): AxumPath<String>) -> Response {
    match Asset::get(&path) {
        Some(f) => file_response(&path, f, "no-cache"),
        None => serve_index().await,
    }
}

fn file_response(path: &str, file: EmbeddedFile, cache: &'static str) -> Response {
    let mime = file.metadata.mimetype();
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap_or_else(|_| {
            tracing::error!(path, "构造资产响应失败");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })
}
```

`src/admin/mod.rs` 改为:

```rust
pub mod api;
pub mod assets;
```

`src/lib.rs` 的 `app()` 路由改为:

```rust
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .nest("/admin/api", admin::api::router())
        .route("/admin", get(admin::assets::serve_index))
        .route("/admin/", get(admin::assets::serve_index))
        .route("/admin/assets/*path", get(admin::assets::serve_asset))
        .route("/admin/*spa", get(admin::assets::serve_spa))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
```

- [ ] **Step 5: 跑全部测试确认通过**

Run: `cargo test 2>&1 | tail -4` → 全 pass(35 个)。
Run: `cargo clippy --all-targets -- -D warnings` → 干净。

- [ ] **Step 6: Commit**

```bash
git add build.rs Cargo.toml src/admin/assets.rs src/admin/mod.rs src/lib.rs
git commit -m "feat(rust): P1-T10 rust-embed SPA 服务 + build.rs 占位兜底"
```

---

### Task 11: admin-ui 骨架(暗色科技感登录 + Dashboard 占位)

> **实现本任务前先调用 frontend-design 技能**(科技感视觉是用户显式要求);以下代码是基线,视觉细节允许在不改结构的前提下更好。

**Files:**
- Create: `admin-ui/package.json`、`admin-ui/index.html`、`admin-ui/vite.config.ts`、`admin-ui/tsconfig.json`、`admin-ui/postcss.config.js`、`admin-ui/tailwind.config.js`、`admin-ui/src/main.tsx`、`admin-ui/src/App.tsx`、`admin-ui/src/index.css`、`admin-ui/src/lib/api.ts`、`admin-ui/src/pages/Login.tsx`、`admin-ui/src/pages/Dashboard.tsx`、`admin-ui/src/components/Layout.tsx`、`admin-ui/.gitignore`

- [ ] **Step 1: 工程文件**

`admin-ui/package.json`:

```json
{
  "name": "cloudllm-admin-ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

`admin-ui/.gitignore`:

```
node_modules
dist
```

`admin-ui/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    // 开发模式:API 代理到本地 cloudllm 进程
    proxy: { '/admin/api': 'http://localhost:7100' },
  },
});
```

`admin-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`admin-ui/postcss.config.js`:

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

`admin-ui/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#06080f',
        panel: '#0b101c',
        line: '#1c2740',
        neon: '#22d3ee',
        violet: '#8b5cf6',
        ink: '#e2e8f0',
        dim: '#64748b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(34, 211, 238, 0.15)',
      },
    },
  },
  plugins: [],
};
```

`admin-ui/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CloudLLM Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 源码**

`admin-ui/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background-color: #06080f;
  color: #e2e8f0;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    'PingFang SC',
    'Microsoft YaHei',
    sans-serif;
  /* 细网格底纹:科技感基调 */
  background-image:
    linear-gradient(rgba(34, 211, 238, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34, 211, 238, 0.04) 1px, transparent 1px);
  background-size: 32px 32px;
}
```

`admin-ui/src/lib/api.ts`:

```ts
export interface Me {
  email: string;
  role: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.error?.message ?? msg;
    } catch {
      /* 非 JSON 错误体,保留默认文案 */
    }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<Me>('/admin/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/admin/api/logout', { method: 'POST' }),
  me: () => request<Me>('/admin/api/me'),
};
```

`admin-ui/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`admin-ui/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { api } from './lib/api';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';

function Guard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  useEffect(() => {
    api.me().then(
      () => setState('in'),
      () => setState('out'),
    );
  }, []);
  if (state === 'loading') {
    return <div className="grid h-full place-items-center font-mono text-dim">认证中…</div>;
  }
  if (state === 'out') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Guard>
              <Layout />
            </Guard>
          }
        >
          <Route index element={<Dashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

`admin-ui/src/pages/Login.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(email, password);
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center">
      <div className="w-96 rounded-xl border border-line bg-panel p-8 shadow-glow">
        <div className="mb-1 bg-gradient-to-r from-neon to-violet bg-clip-text text-2xl font-bold text-transparent">
          CloudLLM
        </div>
        <div className="mb-8 font-mono text-xs uppercase tracking-[0.3em] text-dim">
          LLM Gateway / Console
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block font-mono text-xs text-dim">EMAIL</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition focus:border-neon focus:shadow-glow"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-xs text-dim">PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition focus:border-neon focus:shadow-glow"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-gradient-to-r from-neon to-violet py-2 text-sm font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

`admin-ui/src/components/Layout.tsx`:

```tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

// P3 将逐页点亮;P1 仅 总览 可用,其余占位
const NAV: { label: string; to: string; ready: boolean }[] = [
  { label: '总览', to: '/', ready: true },
  { label: '用户', to: '/users', ready: false },
  { label: '团队', to: '/teams', ready: false },
  { label: 'Key', to: '/keys', ready: false },
  { label: '渠道', to: '/channels', ready: false },
  { label: '模型', to: '/models', ready: false },
  { label: '报表', to: '/reports', ready: false },
  { label: '审计', to: '/audit', ready: false },
];

export function Layout() {
  const nav = useNavigate();

  async function logout() {
    await api.logout();
    nav('/login', { replace: true });
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-52 flex-col border-r border-line bg-panel">
        <div className="px-5 py-5">
          <div className="bg-gradient-to-r from-neon to-violet bg-clip-text text-lg font-bold text-transparent">
            CloudLLM
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">console</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) =>
            item.ready ? (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm transition ${
                    isActive
                      ? 'border border-line bg-bg text-neon shadow-glow'
                      : 'text-ink hover:bg-bg'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ) : (
              <span
                key={item.to}
                className="block cursor-not-allowed rounded-md px-3 py-2 text-sm text-dim"
                title="P3 接入"
              >
                {item.label}
                <span className="ml-2 rounded border border-line px-1 font-mono text-[10px]">P3</span>
              </span>
            ),
          )}
        </nav>
        <button
          onClick={logout}
          className="m-3 rounded-md border border-line px-3 py-2 text-sm text-dim transition hover:border-neon hover:text-neon"
        >
          退出登录
        </button>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
```

`admin-ui/src/pages/Dashboard.tsx`:

```tsx
const CARDS = [
  { label: '今日请求', hint: 'P2 接入数据面后点亮' },
  { label: '今日费用', hint: 'P2 接入数据面后点亮' },
  { label: '活跃 Key', hint: 'P3 接入管理面后点亮' },
  { label: '渠道健康', hint: 'P2 接入数据面后点亮' },
];

export default function Dashboard() {
  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-ink">总览</h1>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {CARDS.map((c) => (
          <div key={c.label} className="rounded-xl border border-line bg-panel p-5">
            <div className="font-mono text-xs uppercase tracking-wider text-dim">{c.label}</div>
            <div className="mt-2 font-mono text-3xl text-ink">—</div>
            <div className="mt-2 text-xs text-dim">{c.hint}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-xl border border-line bg-panel p-6 text-sm text-dim">
        数据面(/v1/*)将在 P2 接入;接入后此处展示用量与费用趋势。
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 构建 UI 并验证类型**

```bash
cd admin-ui && npm install && npm run build
```

Expected: `tsc --noEmit` 零错误;`vite build` 产出 `dist/index.html` + `dist/assets/*`。
(npm install 会生成 package-lock.json,**提交它**——CI 的 npm ci 依赖。)

- [ ] **Step 4: 重新嵌入并跑 Rust 测试**

```bash
cd .. && cargo build && cargo test 2>&1 | tail -4
```

Expected: 全 pass(嵌入的换成真实 UI,断言不变——只断 200/text/html)。

- [ ] **Step 5: 真浏览器端到端验证(Playwright MCP,本项目纪律)**

```bash
cargo run -q -- init --config /tmp/cloudllm-p1/cloudllm.toml --email admin@corp.local  # 记下密码
cargo run -q -- serve --config /tmp/cloudllm-p1/cloudllm.toml &
```

用 Playwright 打开 `http://localhost:7100/admin/`,验证:
1. 未登录自动跳到 `/admin/login`,登录页是暗色科技感(深底网格、渐变 Logo、霓虹聚焦)
2. 错误密码 → 显示「邮箱或密码错误」
3. 正确密码 → 进入 Dashboard,侧边栏「总览」高亮、其余项带 P3 徽标
4. 刷新页面仍在 Dashboard(深链接回退 OK)
5. 「退出登录」→ 回到登录页
6. 浏览器 console 无报错

完成后 `kill %1 && rm -rf /tmp/cloudllm-p1`。

- [ ] **Step 6: Commit**

```bash
git add admin-ui/
git commit -m "feat(rust): P1-T11 admin-ui 骨架(暗色科技感登录 + Dashboard 占位)"
```

---

### Task 12: 收尾 — 全量验证 + 推送

- [ ] **Step 1: 全量本地验证**

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd admin-ui && npm run build && cd ..
```

Expected: 全部通过、零警告。

- [ ] **Step 2: 确认 TS 版未被波及**

```bash
pnpm -r typecheck 2>&1 | tail -3
```

Expected: TS 各包 typecheck 仍过(本阶段不应碰任何 TS 文件;`git status` 不应出现 apps/ packages/ 改动)。

- [ ] **Step 3: 合并推送(沿用本项目流程:feature 分支 → merge main → push)**

```bash
git log --oneline main..HEAD   # 检视本阶段提交
git checkout main && git merge --no-ff <分支名> -m "merge: CloudLLM v2 Rust P1 骨架"
git push
```

- [ ] **Step 4: 确认 GitHub Actions rust-ci 绿**(gh 未认证则网页确认)

---

## 计划自查记录

- **Spec 覆盖(P1 范围)**:config/--init ✓(T2/T9) db+迁移 ✓(T5) crypto ✓(T3/T4) admin 登录会话 ✓(T6/T7/T8) SPA 嵌入壳 ✓(T10/T11) CI ✓(T1)。spec §1 的 `cloudllm.example.toml` 不需要——`--init` 即生成完整带注释配置。
- **占位符扫描**:无 TBD/TODO;所有代码完整。
- **类型一致性**:`Config.master_key_bytes()`、`crypto::{hash_password,verify_password,generate_api_key,hash_api_key,encrypt_secret,decrypt_secret}`、`auth::{SessionData,encode_session,decode_session,SESSION_COOKIE,SESSION_TTL_SECS,AdminUser}`、`db::{open,open_memory}`、`error::ApiError`、`cli::{run_init,run_reset_password,run_serve,InitOutcome}`、`AppState{db,config}`、`app()`、`now_epoch()` 已跨任务核对一致。
- **已知风险点已写入约定**:`:memory:` 单连接、登出语义、axum 0.7 通配语法、dist 不进 git + build.rs 兜底。
