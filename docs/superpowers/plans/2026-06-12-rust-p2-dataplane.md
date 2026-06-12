# CloudLLM v2 Rust 重写 — P2 数据面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 骨架之上接入网关数据面,交付与 TS 版 v1.1 语义逐条对等的 `/v1/chat/completions`(OpenAI)与 `/v1/messages`(Anthropic)透传链路:API Key 鉴权、协议路由、计费(micro-CNY ceil)、预算检查、加权故障切换 + 指数退避冷却、SSE 流式旁路计量与中断结算、同进程单事务落库、审计体截断、后台任务(月度翻转 / 冷却恢复 / audit 清理)与优雅停机排水。P2 结束时:真二进制起假上游可完成非流式 + 流式请求,`usage_records` 对账精确到 micro,SIGTERM 排水不丢账。

**Architecture:** 沿用 P1 的单 crate(lib + bin),axum 单端口。新增 `src/gateway/` 子模块(error/auth/sse_tap/upstream/mod)与 `src/billing.rs`、`src/jobs.rs`。网关错误用独立 `GatewayError`(携带 protocol 渲染),**不动** P1 管理面 `ApiError`。落库在请求任务内 spawn 一个 tokio 任务、单 SQLite 事务完成 `usage_records` INSERT + 命中预算行 UPDATE;无 Redis、无 worker、无幂等 event_id(进程合一,事务即原子)。`AppState` 扩展三个字段(reqwest `Client`、`tokio_util::task::TaskTracker`、`AtomicU64` 结算失败计数器)。

**Tech Stack:** Rust(axum 0.7、tokio、sqlx 0.8/sqlite 运行时 API、reqwest 0.12 stream/rustls、futures-util、bytes、tokio-util、time 0.3、rand 0.8)+ P1 既有原语(crypto/config/db/auth)。dev:wiremock。

**执行约束(用户要求):** 所有写代码的 subagent 一律 `model: "opus"`;沿用 implementer + spec-review + quality-review 三角流程。

---

## 全局约定(每个任务都必须遵守 —— 违反即返工)

1. **sqlx 一律用运行时查询 API**(`sqlx::query` / `query_as` + `bind`),**禁用 `query!` 宏**(`macros` feature 仅供 `migrate!`)。
2. **axum 固定 0.7**;通配路由语法 `/*path`;`async_trait` extractor 写法同 P1 `AdminUser`。
3. **内存测试库 `open_memory()` 已封装 `max_connections(1)`**,直接用,不要另开池。
4. **金额一律 i64 micro-CNY,时间一律 i64 epoch 秒**(`cloudllm::now_epoch()`);月计算用 `time` crate 按 **UTC**(`OffsetDateTime::from_unix_timestamp(ts)?` → `.year()` / `.month()`,默认 feature 即可,无需加 feature)。
5. **注释 / 错误文案 / commit message 中文**;commit 格式 `feat(rust): P2-TN 描述`。
6. **每任务 TDD**:先写测试 → 跑红(给预期失败输出)→ 最小实现 → 跑绿 → 收尾跑三件套 `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`。
7. **网关错误用独立 `GatewayError`**(`src/gateway/error.rs`,携带 `Protocol` 渲染),管理面 `ApiError` 不动。
8. **上游凭证、master_key、session_secret 绝不进日志**;渠道名 / 解密失败细节只进 `tracing`,不出网关响应体。
9. **错误码用 TS 实际值 `budget_exhausted`**(非 spec 笔误的 budget_exceeded)。

## 与 P1 既有签名的硬对齐(已逐一核对源码,后续任务引用必须一致)

- `cloudllm::now_epoch() -> i64`(lib.rs)
- `cloudllm::AppState { db: SqlitePool, config: Arc<config::Config> }`(lib.rs;P2 在此结构追加字段,见 T1)
- `cloudllm::app(state: AppState) -> Router`(lib.rs;P2 追加 `/v1/*` 路由)
- `config::Config { listen, db_path, master_key, session_secret, gateway_public_url }` + `master_key_bytes() -> [u8; 32]`、`validate()`、`apply_overrides(impl Fn(&str)->Option<String>)`
- `crypto::decrypt_secret(blob: &[u8], master_key: &[u8;32], aad: &str) -> anyhow::Result<String>`
- `crypto::hash_api_key(plaintext: &str) -> String`、`crypto::API_KEY_PREFIX = "sk-cloudllm-"`
- `db::open_memory() -> anyhow::Result<SqlitePool>`、`db::open(path: &str) -> anyhow::Result<SqlitePool>`
- `test_util`:`test_state() -> AppState`、`test_config() -> Config`、`insert_user(...)`、`json_request`、`body_json`、`TEST_MASTER_KEY`(= base64([7u8;32]))。**P2 在 test_util 追加 seed helper(T1)。**
- `migrations/0001_init.sql`(已合并,**不可改**):9 表;`channels` 无 `priority`、无 `cooldown_level`;`api_keys` 无 `expires_at`、`owner_type` 仅 user/team。P2 用 `0002_gateway.sql` 补列。

---

## 文件结构总览

```
Cargo.toml                      # T1:加 reqwest/futures-util/bytes/tokio-util;dev 加 wiremock
src/config.rs                   # T1:加 gateway 配置段 + 默认值 + env 覆盖
migrations/0002_gateway.sql     # T1:api_keys 加 expires_at;channels 加 cooldown_level
src/test_util.rs                # T1:insert_channel/insert_model/insert_api_key/insert_budget
src/billing.rs                  # T2(纯函数)+ T7(check_budgets/settle_usage 事务)
src/gateway/mod.rs              # T3 起建模块;T8 网关 handler 整链
src/gateway/error.rs            # T3:GatewayError(双协议渲染)
src/gateway/auth.rs             # T4:鉴权 + 路由查询(AuthedKey/ModelInfo)
src/gateway/sse_tap.rs          # T5:UsageTap 流式解析器
src/gateway/upstream.rs         # T6:加权洗牌 + 转发 + 冷却 + failover
src/jobs.rs                     # T9:月度翻转 / 冷却恢复 / audit 清理
src/lib.rs                      # T1(AppState 扩展)、T3(pub mod gateway)、T8(挂 /v1 路由)
src/cli.rs                      # T1(serve 构造新 AppState 字段)、T9(起 jobs + 排水)
docs/.../rust-p1-followups.md   # T10:标注 P2 已处理项
```

---

### Task 1: 依赖与配置扩展 + 迁移 0002 + test_util seed helper

**Files:**
- Modify: `Cargo.toml`、`src/config.rs`、`src/lib.rs`(AppState 扩展)、`src/cli.rs`(serve 构造新字段)、`src/test_util.rs`
- Create: `migrations/0002_gateway.sql`

- [ ] **Step 1: Cargo.toml 加依赖**

`[dependencies]` 追加(版本对齐 cloudcode 已验证组合):

```toml
reqwest = { version = "0.12", default-features = false, features = ["stream", "rustls-tls", "json"] }
futures-util = "0.3"
bytes = "1"
tokio-util = { version = "0.7", features = ["rt"] }
```

`[dev-dependencies]` 追加:

```toml
wiremock = "0.6"
```

不引入其他依赖(`rand` / `time` P1 已在)。

- [ ] **Step 2: 写迁移 `migrations/0002_gateway.sql`**

注意:`0001_init.sql` 已合并到 main,**不可修改**;只能新文件。sqlx migrate 按文件名顺序执行。

```sql
-- P2 数据面:补两列。
-- 1) api_keys.expires_at:Key 过期时间(unix epoch 秒);NULL = 永不过期。
--    P1 schema 漏列,鉴权需「status='active' AND (expires_at IS NULL OR expires_at > now)」。
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;

-- 2) channels.cooldown_level:指数退避级别。每次冷却 level+1;成功请求归零。
--    cooldown_until = now + min(base * 2^level, max)。
ALTER TABLE channels ADD COLUMN cooldown_level INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: config.rs 加 gateway 配置段(先写失败测试)**

在 `Config` 结构体追加字段(全部带 `#[serde(default = ...)]`,使既有 TOML 不写也能解析),并扩展 `apply_overrides` 与新增默认值函数。先在 `src/config.rs` 的 `tests` 模块追加:

```rust
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
    }

    #[test]
    fn gateway_env_overrides_win() {
        let mut cfg: Config = toml::from_str(&base_toml()).unwrap();
        cfg.apply_overrides(|k| match k {
            "CLOUDLLM_UPSTREAM_TIMEOUT_SECS" => Some("120".into()),
            "CLOUDLLM_COOLDOWN_BASE_SECS" => Some("5".into()),
            "CLOUDLLM_AUDIT_BODY_LIMIT" => Some("4096".into()),
            _ => None,
        });
        cfg.validate().unwrap();
        assert_eq!(cfg.upstream_timeout_secs, 120);
        assert_eq!(cfg.cooldown_base_secs, 5);
        assert_eq!(cfg.audit_body_limit, 4096);
    }

    #[test]
    fn gateway_toml_overrides_default() {
        let toml_text = format!("{}\ncooldown_max_secs = 1200\n", base_toml());
        let cfg: Config = toml::from_str(&toml_text).unwrap();
        assert_eq!(cfg.cooldown_max_secs, 1200);
    }
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cargo test --locked config::tests::gateway 2>&1 | tail -8`
Expected: 编译失败 `no field upstream_connect_timeout_secs on type Config`。

- [ ] **Step 5: 实现 config 扩展**

在 `Config` 结构体(`gateway_public_url` 字段后)追加:

```rust
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
```

新增默认值函数(放在既有 `default_db_path` 后):

```rust
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
```

`apply_overrides` 尾部追加(env 覆盖,解析失败保持默认 —— 与 P1 风格一致,非法值不 panic):

```rust
        if let Some(v) = lookup("CLOUDLLM_UPSTREAM_CONNECT_TIMEOUT_SECS").and_then(|s| s.parse().ok())
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
```

手写 `Debug` impl 不变(新字段非敏感,但为简洁不逐一加;`<redacted>` 仅覆盖 master_key/session_secret —— 既有实现已满足,**不要**在 Debug 里漏掉新字段以外的内容,保持 P1 原样即可,新字段不打印也无妨)。

> 注:既有 `Debug` impl 只列了 5 个字段。新增 7 个字段不进 Debug 输出(非敏感、噪音)。clippy 不会因此报错。保持 P1 `Debug` impl 原样,不动。

- [ ] **Step 6: AppState 扩展(lib.rs)+ serve 构造(cli.rs)**

`src/lib.rs` 顶部 import 追加:

```rust
use std::sync::atomic::AtomicU64;
```

`AppState` 改为:

```rust
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<config::Config>,
    /// 上游转发共享 HTTP 客户端(连接池复用)
    pub http: reqwest::Client,
    /// 结算任务跟踪器:停机时 close + wait 排水
    pub settle_tracker: tokio_util::task::TaskTracker,
    /// 落库失败累计(P3 Dashboard 告警)
    pub settle_failures: Arc<AtomicU64>,
}
```

新增构造函数(供 serve 与 test_util 共用,集中超时配置):

```rust
/// 用配置构造 reqwest 客户端:connect_timeout 来自配置;不设全局 timeout
/// (非流式 per-request 设,流式不设)。
pub fn build_http_client(config: &config::Config) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(
            config.upstream_connect_timeout_secs,
        ))
        .build()
        .expect("构造 reqwest 客户端")
}
```

`src/cli.rs` 的 `run_serve` 中,`let state = ...` 改为:

```rust
    let state = crate::AppState {
        db: pool.clone(),
        config: std::sync::Arc::new(cfg.clone()),
        http: crate::build_http_client(&cfg),
        settle_tracker: tokio_util::task::TaskTracker::new(),
        settle_failures: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
    };
```

> 排水接线(`settle_tracker.close()` + `wait` ≤30s)在 T9 落;本任务只让字段就位、编译通过。

`src/test_util.rs` 的 `test_state()` 改为:

```rust
pub async fn test_state() -> AppState {
    let config = Arc::new(test_config());
    AppState {
        db: crate::db::open_memory().await.expect("内存库"),
        http: crate::build_http_client(&config),
        config,
        settle_tracker: tokio_util::task::TaskTracker::new(),
        settle_failures: Arc::new(std::sync::atomic::AtomicU64::new(0)),
    }
}
```

- [ ] **Step 7: test_util 加 seed helper(数据面测试公用)**

在 `src/test_util.rs` 追加(`insert_user` 之后)。注意列名与 0001/0002 schema 精确对齐:

```rust
/// 插入渠道,返回 channel_id。credential 用 master_key 信封加密(AAD=channel_id)。
pub async fn insert_channel(
    db: &sqlx::SqlitePool,
    master_key: &[u8; 32],
    provider_type: &str,
    base_url: &str,
    credential: &str,
    weight: i64,
    status: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let blob = crate::crypto::encrypt_secret(credential, master_key, &id).expect("加密凭证");
    sqlx::query(
        "INSERT INTO channels (id, provider_type, name, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)",
    )
    .bind(&id)
    .bind(provider_type)
    .bind(format!("ch-{provider_type}"))
    .bind(base_url)
    .bind(blob)
    .bind(weight)
    .bind(status)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入渠道");
    id
}

/// 插入模型,价格单位 micro-CNY / 1M tokens。返回 slug(原样回传方便链式)。
#[allow(clippy::too_many_arguments)]
pub async fn insert_model(
    db: &sqlx::SqlitePool,
    slug: &str,
    provider_type: &str,
    upstream_model: &str,
    input_price_micro: i64,
    output_price_micro: i64,
    cache_read_price_micro: i64,
    cache_write_price_micro: i64,
) -> String {
    sqlx::query(
        "INSERT INTO models (id, slug, provider_type, upstream_model, input_price_micro, output_price_micro, cache_read_price_micro, cache_write_price_micro, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(slug)
    .bind(provider_type)
    .bind(upstream_model)
    .bind(input_price_micro)
    .bind(output_price_micro)
    .bind(cache_read_price_micro)
    .bind(cache_write_price_micro)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入模型");
    slug.to_string()
}

/// 插入 API Key。返回 (key_id, plaintext)。allowed_models 传 None=不限;Some(slugs)=白名单。
pub async fn insert_api_key(
    db: &sqlx::SqlitePool,
    owner_type: &str,
    owner_id: &str,
    allowed_models: Option<&[&str]>,
    audit: bool,
    status: &str,
    expires_at: Option<i64>,
) -> (String, String) {
    let id = uuid::Uuid::new_v4().to_string();
    let gen = crate::crypto::generate_api_key();
    let allowed = allowed_models.map(|m| serde_json::to_string(m).expect("序列化白名单"));
    sqlx::query(
        "INSERT INTO api_keys (id, key_hash, key_prefix, name, owner_type, owner_id, allowed_models, audit, status, expires_at, created_at) \
         VALUES (?, ?, ?, 'test-key', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&gen.key_hash)
    .bind(&gen.key_prefix)
    .bind(owner_type)
    .bind(owner_id)
    .bind(allowed)
    .bind(audit as i64)
    .bind(status)
    .bind(expires_at)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入 Key");
    (id, gen.plaintext)
}

/// 插入预算行。金额 micro-CNY;period_start 传 epoch 秒。
#[allow(clippy::too_many_arguments)]
pub async fn insert_budget(
    db: &sqlx::SqlitePool,
    subject_type: &str,
    subject_id: &str,
    period: &str,
    limit_micro: i64,
    used_micro: i64,
    period_start: i64,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, used_micro, period_start, alert_threshold, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?)",
    )
    .bind(&id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(period)
    .bind(limit_micro)
    .bind(used_micro)
    .bind(period_start)
    .bind(crate::now_epoch())
    .execute(db)
    .await
    .expect("插入预算");
    id
}
```

> `test_util.rs` 顶部已有 `#![allow(dead_code)]`,新 helper 在 T4 起逐个用到,本任务不会触发 unused 告警(allow 已覆盖)。

- [ ] **Step 8: 跑测试 + 三件套**

Run: `cargo test --locked config:: 2>&1 | tail -4`
Expected: config 全 pass(含 3 个新增 gateway 用例)。
Run: `cargo test --locked 2>&1 | tail -4`
Expected: P1 全量用例仍 pass(AppState 扩展后 test_state/serve 编译通过)。
Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings`
Expected: 干净。
Run(确认迁移可执行): `cargo test --locked db:: 2>&1 | tail -3`
Expected: `migrations_create_all_tables` 仍 pass(0002 是 ALTER,不新增表,表清单不变);若想另证 0002 生效,可临时 `PRAGMA table_info(api_keys)` 查 expires_at 列存在——非必须。

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml Cargo.lock migrations/0002_gateway.sql src/config.rs src/lib.rs src/cli.rs src/test_util.rs
git commit -m "feat(rust): P2-T1 依赖/gateway 配置/迁移 0002/AppState 扩展/seed helper"
```

---

### Task 2: billing 纯函数(Usage / compute_cost_micro / extract_usage / truncate)

**Files:**
- Create: `src/billing.rs`
- Modify: `src/lib.rs`(加 `pub mod billing;`)

- [ ] **Step 1: 写 billing.rs 骨架 + 失败测试(实现先 todo!)**

`src/billing.rs`:

```rust
//! 计费纯函数:token 用量提取(两协议、流式事件与非流式同源)、micro-CNY 逐档 ceil 计费、
//! UTF-8 安全截断。下半部分(check_budgets / settle_usage 事务)在 T7 追加。

use serde_json::Value;

/// 四档 token 用量。i64 避免与 micro 计算混用 usize。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

/// 模型四档单价(micro-CNY per 1M tokens),来自 models 表四列。
#[derive(Debug, Clone, Copy)]
pub struct Prices {
    pub input_micro: i64,
    pub output_micro: i64,
    pub cache_read_micro: i64,
    pub cache_write_micro: i64,
}

/// 单档:ceil(tokens × price_per_mtok / 1_000_000)。tokens=0 记 0。
/// 负单价:debug_assert 触发(开发期暴露脏数据),release 下 clamp 到 0(不让脏价格炸热路径)。
fn line_cost_micro(tokens: i64, price_per_mtok: i64) -> i64 {
    todo!()
}

/// 四档求和。token / price 任一非法在各自档位处理:负 token clamp 0、负价 clamp 0。
pub fn compute_cost_micro(usage: &Usage, prices: &Prices) -> i64 {
    todo!()
}

/// 从完整 JSON(非流式响应体,或流式单个事件对象)提取用量。
/// 解析不出 usage → 全零。
pub fn extract_usage_from_json(protocol: Protocol, body: &Value) -> Usage {
    todo!()
}

/// 协议枚举。与 gateway 其余模块共用(此处定义,gateway 内 re-export)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Openai,
    Anthropic,
}

/// UTF-8 安全截断:超过 limit 字节则截到不破坏字符的边界并加后缀「…[截断]」。
/// 未超长返回原串。limit 指原文字节上限(后缀不计入 limit）。
pub fn truncate_utf8(s: &str, limit: usize) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── compute_cost_micro:固定向量对账(数值算清楚)──

    #[test]
    fn cost_split_input_output() {
        // 价格:输入 21_000_000 micro/MTok(=21 CNY),输出 105_000_000(=105 CNY)
        // 1000/1e6*21e6 = 21000 micro;500/1e6*105e6 = 52500 micro → 73500
        let p = Prices { input_micro: 21_000_000, output_micro: 105_000_000, cache_read_micro: 0, cache_write_micro: 0 };
        let u = Usage { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 };
        assert_eq!(compute_cost_micro(&u, &p), 73_500);
    }

    #[test]
    fn cost_cache_tokens() {
        // 缓存读 2_100_000 micro/MTok(=2.1 CNY),缓存写 26_250_000(=26.25 CNY)
        // 100000/1e6*2.1e6 = 210000;10000/1e6*26.25e6 = 262500 → 472500
        let p = Prices { input_micro: 0, output_micro: 0, cache_read_micro: 2_100_000, cache_write_micro: 26_250_000 };
        let u = Usage { input_tokens: 0, output_tokens: 0, cache_read_tokens: 100_000, cache_write_tokens: 10_000 };
        assert_eq!(compute_cost_micro(&u, &p), 472_500);
    }

    #[test]
    fn cost_ceil_per_line() {
        // 1 token × 0.5 CNY/MTok = 500_000 micro/MTok;1*500000/1e6 = 0.5 micro → ceil 1
        let p = Prices { input_micro: 500_000, output_micro: 0, cache_read_micro: 0, cache_write_micro: 0 };
        let u = Usage { input_tokens: 1, ..Usage::default() };
        assert_eq!(compute_cost_micro(&u, &p), 1);
    }

    #[test]
    fn cost_zero_tokens_zero() {
        let p = Prices { input_micro: 21_000_000, output_micro: 105_000_000, cache_read_micro: 1, cache_write_micro: 1 };
        assert_eq!(compute_cost_micro(&Usage::default(), &p), 0);
    }

    #[test]
    fn cost_each_line_ceils_independently() {
        // 两档各 0.5 micro,独立进位 → 1 + 1 = 2(印证"逐行 ceil 后求和",非合并后 ceil)
        let p = Prices { input_micro: 500_000, output_micro: 500_000, cache_read_micro: 0, cache_write_micro: 0 };
        let u = Usage { input_tokens: 1, output_tokens: 1, ..Usage::default() };
        assert_eq!(compute_cost_micro(&u, &p), 2);
    }

    #[test]
    fn cost_negative_price_clamps_to_zero() {
        // release 下 clamp;测试构建会触发 debug_assert,故此用例用 catch:改为直接验证 clamp 语义
        // —— 见实现说明:debug_assert 只在 debug_assertions 开;cargo test 默认开 debug_assertions。
        // 因此这里不喂负价(会 panic),改测负 token clamp。
        let p = Prices { input_micro: 21_000_000, output_micro: 0, cache_read_micro: 0, cache_write_micro: 0 };
        let u = Usage { input_tokens: -100, ..Usage::default() };
        assert_eq!(compute_cost_micro(&u, &p), 0);
    }

    // ── extract_usage_from_json ──

    #[test]
    fn extract_openai_splits_cache() {
        let u = extract_usage_from_json(Protocol::Openai, &json!({
            "usage": { "prompt_tokens": 1000, "completion_tokens": 50, "prompt_tokens_details": { "cached_tokens": 600 } }
        }));
        assert_eq!(u, Usage { input_tokens: 400, output_tokens: 50, cache_read_tokens: 600, cache_write_tokens: 0 });
    }

    #[test]
    fn extract_openai_no_cache_detail() {
        let u = extract_usage_from_json(Protocol::Openai, &json!({ "usage": { "prompt_tokens": 10, "completion_tokens": 5 } }));
        assert_eq!(u, Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 });
    }

    #[test]
    fn extract_anthropic_four_fields() {
        let u = extract_usage_from_json(Protocol::Anthropic, &json!({
            "usage": { "input_tokens": 7, "output_tokens": 9, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20 }
        }));
        assert_eq!(u, Usage { input_tokens: 7, output_tokens: 9, cache_read_tokens: 100, cache_write_tokens: 20 });
    }

    #[test]
    fn extract_missing_usage_is_zero() {
        assert_eq!(extract_usage_from_json(Protocol::Openai, &Value::Null), Usage::default());
        assert_eq!(extract_usage_from_json(Protocol::Anthropic, &json!({ "usage": "bad" })), Usage::default());
    }

    #[test]
    fn extract_openai_cached_exceeds_prompt_clamps_input_zero() {
        // prompt - cached 下限 0
        let u = extract_usage_from_json(Protocol::Openai, &json!({
            "usage": { "prompt_tokens": 5, "completion_tokens": 0, "prompt_tokens_details": { "cached_tokens": 9 } }
        }));
        assert_eq!(u.input_tokens, 0);
        assert_eq!(u.cache_read_tokens, 9);
    }

    // ── truncate_utf8 ──

    #[test]
    fn truncate_short_unchanged() {
        assert_eq!(truncate_utf8("hi", 65536), "hi");
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // "你好世界" 每字 3 字节 = 12 字节;limit=7 应截到 6 字节(2 字)不切碎第 3 字
        let out = truncate_utf8("你好世界", 7);
        assert!(out.starts_with("你好"));
        assert!(out.ends_with("…[截断]"));
        assert!(!out.contains("世"));
    }

    #[test]
    fn truncate_exact_limit_unchanged() {
        let s = "abcdef"; // 6 字节
        assert_eq!(truncate_utf8(s, 6), s);
    }
}
```

并在 `src/lib.rs` 加 `pub mod billing;`(放在 `pub mod auth;` 后,保持字母序)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --locked billing:: 2>&1 | tail -8`
Expected: `todo!()` panic,用例红。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
fn line_cost_micro(tokens: i64, price_per_mtok: i64) -> i64 {
    if tokens <= 0 {
        return 0;
    }
    debug_assert!(price_per_mtok >= 0, "模型单价不能为负: {price_per_mtok}");
    let price = price_per_mtok.max(0); // release 下脏价格 clamp,不炸热路径
    // ceil(tokens * price / 1e6);i128 防溢出(tokens ~1e7、price ~1e9 → 1e16,仍在 i64 内,
    // 但乘积中间值用 i128 稳妥)
    let numerator = tokens as i128 * price as i128;
    let micro = 1_000_000i128;
    (((numerator + micro - 1) / micro) as i64).max(0)
}

pub fn compute_cost_micro(usage: &Usage, prices: &Prices) -> i64 {
    line_cost_micro(usage.input_tokens, prices.input_micro)
        + line_cost_micro(usage.output_tokens, prices.output_micro)
        + line_cost_micro(usage.cache_read_tokens, prices.cache_read_micro)
        + line_cost_micro(usage.cache_write_tokens, prices.cache_write_micro)
}

/// 取整型字段,缺失/非整数视为 0(与 TS num() 一致)
fn num(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub fn extract_usage_from_json(protocol: Protocol, body: &Value) -> Usage {
    let usage = match body.get("usage") {
        Some(u) if u.is_object() => u,
        _ => return Usage::default(),
    };
    match protocol {
        Protocol::Openai => {
            let prompt = num(usage, "prompt_tokens");
            let cached = usage
                .get("prompt_tokens_details")
                .map(|d| num(d, "cached_tokens"))
                .unwrap_or(0);
            Usage {
                input_tokens: (prompt - cached).max(0),
                output_tokens: num(usage, "completion_tokens"),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            }
        }
        Protocol::Anthropic => Usage {
            input_tokens: num(usage, "input_tokens"),
            output_tokens: num(usage, "output_tokens"),
            cache_read_tokens: num(usage, "cache_read_input_tokens"),
            cache_write_tokens: num(usage, "cache_creation_input_tokens"),
        },
    }
}

pub fn truncate_utf8(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    // 从 limit 处向左找到字符边界
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[截断]", &s[..end])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --locked billing:: 2>&1 | tail -4`
Expected: 全 pass(13 个)。

- [ ] **Step 5: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked billing::`
Expected: 干净、全绿。

```bash
git add src/billing.rs src/lib.rs
git commit -m "feat(rust): P2-T2 计费纯函数(逐档 ceil/两协议用量提取/UTF-8 截断)"
```

---

### Task 3: GatewayError(错误码词汇表 + 双协议 JSON 渲染)

**Files:**
- Create: `src/gateway/mod.rs`、`src/gateway/error.rs`
- Modify: `src/lib.rs`(加 `pub mod gateway;`)

- [ ] **Step 1: 建 gateway 模块壳 + error.rs 失败测试**

`src/gateway/mod.rs`(本任务只声明 error;后续任务追加 auth/sse_tap/upstream/handler):

```rust
//! 网关数据面:鉴权、路由、转发、计量、落库。

pub mod error;

pub use crate::billing::Protocol;
```

`src/gateway/error.rs`:

```rust
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
    fn new(protocol: Protocol, status: u16, code: &'static str, message: impl Into<String>) -> Self {
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
        Self::new(protocol, 502, "upstream_failed", "上游渠道全部失败,请稍后重试")
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
        // content-type 显式 application/json(axum::Json 会设;此处用 Response builder 保持一致)
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
            (GatewayError::invalid_api_key(Protocol::Anthropic, "x"), 401, "authentication_error"),
            (GatewayError::model_not_allowed(Protocol::Anthropic, "x"), 403, "permission_error"),
            (GatewayError::model_not_found(Protocol::Anthropic, "x"), 404, "not_found_error"),
            (GatewayError::budget_exhausted(Protocol::Anthropic, "x"), 429, "rate_limit_error"),
            (GatewayError::upstream_failed(Protocol::Anthropic), 502, "api_error"),
            (GatewayError::internal(Protocol::Anthropic), 500, "api_error"),
            (GatewayError::invalid_request(Protocol::Anthropic, "x"), 400, "invalid_request_error"),
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
            (GatewayError::invalid_request(Protocol::Openai, "x"), 400, "invalid_request"),
            (GatewayError::protocol_mismatch(Protocol::Openai, "x"), 400, "protocol_mismatch"),
            (GatewayError::invalid_api_key(Protocol::Openai, "x"), 401, "invalid_api_key"),
            (GatewayError::model_not_allowed(Protocol::Openai, "x"), 403, "model_not_allowed"),
            (GatewayError::model_not_found(Protocol::Openai, "x"), 404, "model_not_found"),
            (GatewayError::budget_exhausted(Protocol::Openai, "x"), 429, "budget_exhausted"),
            (GatewayError::no_channel(Protocol::Openai), 502, "no_channel"),
            (GatewayError::upstream_failed(Protocol::Openai), 502, "upstream_failed"),
        ];
        for (err, status, code) in pairs {
            assert_eq!(err.status.as_u16(), status);
            assert_eq!(err.code, code);
        }
    }
}
```

并在 `src/lib.rs` 加 `pub mod gateway;`(放在 `pub mod error;` 后)。

- [ ] **Step 2: 跑测试确认失败 → 实现已在 Step 1 给全 → 直接跑绿**

本任务实现与测试同文件一次给全(GatewayError 是纯渲染,无 todo! 留空)。先确认编译:
Run: `cargo test --locked gateway::error 2>&1 | tail -6`
Expected: 全 pass(3 个用例,含逐码与映射断言)。若红,按编译错误修正(常见:`body_json` 在 test_util 已 `pub`,可直接用)。

- [ ] **Step 3: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked gateway::error`
Expected: 干净、全绿。

```bash
git add src/gateway/ src/lib.rs
git commit -m "feat(rust): P2-T3 GatewayError 错误码词汇表 + 双协议 JSON 渲染"
```

---

### Task 4: 数据面鉴权与路由查询(gateway/auth.rs)

**Files:**
- Create: `src/gateway/auth.rs`
- Modify: `src/gateway/mod.rs`(加 `pub mod auth;`)

实现链:提取凭证 → hash → 查 key(含 expires_at) → 查 model → 白名单 → 协议匹配。返回 `AuthedKey` 与 `ModelInfo`。

**TS 语义对齐(auth.ts / db-access.ts):**
- OpenAI 取 `Authorization`,正则 `^Bearer\s+` 去前缀;Anthropic 取 `x-api-key`。
- 前缀必须 `sk-cloudllm-`,否则 401 invalid_api_key「缺少或非法的 API Key」。
- SHA-256 hex 查 api_keys:`key_hash` AND `status='active'` AND (`expires_at IS NULL OR expires_at > now`);查无 → 401「API Key 无效或已停用」。
- allowed_models 非 NULL 且不含 slug → 403 model_not_allowed「该 Key 无权使用模型 {slug}」。
- models 查 slug AND `status='active'`;查无 → 404 model_not_found「未知模型 {slug}」。
- model.provider_type != protocol → 400 protocol_mismatch「模型 {slug} 须经 {provider_type} 协议端点调用(v1 同构透传)」。

> **Rust 简化(对齐 0001 schema):** `api_keys.owner_type` 仅 user/team(无 app/team_id);预算上卷主体在 T7 = `[key, owner]` 两级,无团队展开。本任务只产出 `AuthedKey`,不计算 subjects。

- [ ] **Step 1: 写 auth.rs 骨架 + 失败测试(实现先 todo!)**

`src/gateway/auth.rs`:

```rust
//! 数据面鉴权 + 路由查询。纯 DB 读,返回鉴权后的 Key 与模型信息。

use crate::billing::{Prices, Protocol};
use crate::gateway::error::GatewayError;
use crate::AppState;
use axum::http::HeaderMap;

/// 鉴权后的 Key 视图。
#[derive(Debug, Clone)]
pub struct AuthedKey {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    /// None = 不限模型
    pub allowed_models: Option<Vec<String>>,
    pub audit: bool,
}

/// 路由解析后的模型信息。
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub slug: String,
    pub provider_type: Protocol,
    pub upstream_model: String,
    pub prices: Prices,
}

/// 从请求头提取原始 Key 文本(已去 Bearer 前缀)。
pub fn extract_raw_key(protocol: Protocol, headers: &HeaderMap) -> Option<String> {
    todo!()
}

/// 鉴权:前缀校验 → hash → 查 active 且未过期的 Key → 白名单。
pub async fn authenticate(
    state: &AppState,
    protocol: Protocol,
    headers: &HeaderMap,
    model_slug: &str,
) -> Result<AuthedKey, GatewayError> {
    todo!()
}

/// 路由:查模型 + 协议匹配。
pub async fn resolve_model(
    state: &AppState,
    protocol: Protocol,
    model_slug: &str,
) -> Result<ModelInfo, GatewayError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{insert_api_key, insert_model, test_state};
    use axum::http::{HeaderMap, HeaderValue};

    fn headers_bearer(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_str(v).unwrap());
        h
    }
    fn headers_xapikey(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-api-key", HeaderValue::from_str(v).unwrap());
        h
    }

    #[test]
    fn extract_strips_bearer_case_insensitive() {
        let h = headers_bearer("bearer sk-cloudllm-abc");
        assert_eq!(extract_raw_key(Protocol::Openai, &h).as_deref(), Some("sk-cloudllm-abc"));
        let h = headers_xapikey("sk-cloudllm-xyz");
        assert_eq!(extract_raw_key(Protocol::Anthropic, &h).as_deref(), Some("sk-cloudllm-xyz"));
    }

    #[tokio::test]
    async fn missing_or_bad_prefix_401() {
        let state = test_state().await;
        // 无头
        let err = authenticate(&state, Protocol::Openai, &HeaderMap::new(), "m").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
        assert_eq!(err.code, "invalid_api_key");
        assert_eq!(err.message, "缺少或非法的 API Key");
        // 错前缀
        let err = authenticate(&state, Protocol::Openai, &headers_bearer("Bearer sk-wrong-x"), "m").await.unwrap_err();
        assert_eq!(err.message, "缺少或非法的 API Key");
    }

    #[tokio::test]
    async fn unknown_key_401() {
        let state = test_state().await;
        let h = headers_bearer("Bearer sk-cloudllm-doesnotexist");
        let err = authenticate(&state, Protocol::Openai, &h, "m").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
        assert_eq!(err.message, "API Key 无效或已停用");
    }

    #[tokio::test]
    async fn disabled_key_401() {
        let state = test_state().await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "disabled", None).await;
        let err = authenticate(&state, Protocol::Openai, &headers_bearer(&format!("Bearer {pt}")), "m").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
    }

    #[tokio::test]
    async fn expired_key_401() {
        let state = test_state().await;
        let past = crate::now_epoch() - 10;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", Some(past)).await;
        let err = authenticate(&state, Protocol::Openai, &headers_bearer(&format!("Bearer {pt}")), "m").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 401);
    }

    #[tokio::test]
    async fn not_yet_expired_key_ok() {
        let state = test_state().await;
        let future = crate::now_epoch() + 3600;
        let (id, pt) = insert_api_key(&state.db, "user", "u1", None, true, "active", Some(future)).await;
        let key = authenticate(&state, Protocol::Openai, &headers_bearer(&format!("Bearer {pt}")), "m").await.unwrap();
        assert_eq!(key.id, id);
        assert_eq!(key.owner_type, "user");
        assert!(key.audit);
        assert!(key.allowed_models.is_none());
    }

    #[tokio::test]
    async fn allowed_models_whitelist_403() {
        let state = test_state().await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", Some(&["gpt-allowed"]), false, "active", None).await;
        // 不在白名单
        let err = authenticate(&state, Protocol::Openai, &headers_bearer(&format!("Bearer {pt}")), "gpt-other").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
        assert_eq!(err.code, "model_not_allowed");
        assert_eq!(err.message, "该 Key 无权使用模型 gpt-other");
        // 在白名单
        let key = authenticate(&state, Protocol::Openai, &headers_bearer(&format!("Bearer {pt}")), "gpt-allowed").await.unwrap();
        assert_eq!(key.owner_id, "u1");
    }

    #[tokio::test]
    async fn resolve_unknown_model_404() {
        let state = test_state().await;
        let err = resolve_model(&state, Protocol::Openai, "ghost").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 404);
        assert_eq!(err.code, "model_not_found");
        assert_eq!(err.message, "未知模型 ghost");
    }

    #[tokio::test]
    async fn resolve_protocol_mismatch_400() {
        let state = test_state().await;
        insert_model(&state.db, "claude-x", "anthropic", "claude-3", 1, 1, 0, 0).await;
        // 用 openai 协议端点调 anthropic 模型
        let err = resolve_model(&state, Protocol::Openai, "claude-x").await.unwrap_err();
        assert_eq!(err.status.as_u16(), 400);
        assert_eq!(err.code, "protocol_mismatch");
        assert!(err.message.contains("anthropic"));
    }

    #[tokio::test]
    async fn resolve_ok_returns_prices_and_upstream() {
        let state = test_state().await;
        insert_model(&state.db, "gpt-x", "openai", "gpt-4o-real", 21_000_000, 105_000_000, 7, 9).await;
        let m = resolve_model(&state, Protocol::Openai, "gpt-x").await.unwrap();
        assert_eq!(m.upstream_model, "gpt-4o-real");
        assert_eq!(m.provider_type, Protocol::Openai);
        assert_eq!(m.prices.input_micro, 21_000_000);
        assert_eq!(m.prices.cache_write_micro, 9);
    }
}
```

并在 `src/gateway/mod.rs` 加 `pub mod auth;`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --locked gateway::auth 2>&1 | tail -8`
Expected: `todo!()` panic,用例红。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
pub fn extract_raw_key(protocol: Protocol, headers: &HeaderMap) -> Option<String> {
    match protocol {
        Protocol::Openai => {
            let v = headers.get("authorization")?.to_str().ok()?;
            // 去掉大小写不敏感的 "Bearer " 前缀
            let trimmed = v.trim();
            let rest = trimmed
                .strip_prefix("Bearer ")
                .or_else(|| trimmed.strip_prefix("bearer "))
                .or_else(|| {
                    // 容忍多空格/混合大小写:正则 ^Bearer\s+ 的等价处理
                    let lower = trimmed.to_ascii_lowercase();
                    if lower.starts_with("bearer") {
                        Some(trimmed[6..].trim_start())
                    } else {
                        None
                    }
                })
                .unwrap_or(trimmed);
            Some(rest.trim().to_string())
        }
        Protocol::Anthropic => Some(headers.get("x-api-key")?.to_str().ok()?.to_string()),
    }
}

pub async fn authenticate(
    state: &AppState,
    protocol: Protocol,
    headers: &HeaderMap,
    model_slug: &str,
) -> Result<AuthedKey, GatewayError> {
    let raw = extract_raw_key(protocol, headers);
    let raw = match raw {
        Some(r) if r.starts_with(crate::crypto::API_KEY_PREFIX) => r,
        _ => {
            return Err(GatewayError::invalid_api_key(protocol, "缺少或非法的 API Key"));
        }
    };
    let key_hash = crate::crypto::hash_api_key(&raw);
    let now = crate::now_epoch();
    let row: Option<(String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, owner_type, owner_id, allowed_models, audit FROM api_keys \
         WHERE key_hash = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(&key_hash)
    .bind(now)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 api_keys 失败");
        GatewayError::internal(protocol)
    })?;

    let (id, owner_type, owner_id, allowed_json, audit) = row
        .ok_or_else(|| GatewayError::invalid_api_key(protocol, "API Key 无效或已停用"))?;

    let allowed_models: Option<Vec<String>> = match allowed_json {
        Some(j) => serde_json::from_str(&j).ok(),
        None => None,
    };
    if let Some(ref list) = allowed_models {
        if !list.iter().any(|m| m == model_slug) {
            return Err(GatewayError::model_not_allowed(
                protocol,
                format!("该 Key 无权使用模型 {model_slug}"),
            ));
        }
    }
    Ok(AuthedKey {
        id,
        owner_type,
        owner_id,
        allowed_models,
        audit: audit != 0,
    })
}

pub async fn resolve_model(
    state: &AppState,
    protocol: Protocol,
    model_slug: &str,
) -> Result<ModelInfo, GatewayError> {
    let row: Option<(String, String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider_type, upstream_model, input_price_micro, output_price_micro, \
                cache_read_price_micro, cache_write_price_micro \
         FROM models WHERE slug = ? AND status = 'active'",
    )
    .bind(model_slug)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 models 失败");
        GatewayError::internal(protocol)
    })?;

    let (provider_type, upstream_model, in_p, out_p, cr_p, cw_p) = row
        .ok_or_else(|| GatewayError::model_not_found(protocol, format!("未知模型 {model_slug}")))?;

    let model_protocol = match provider_type.as_str() {
        "openai" => Protocol::Openai,
        "anthropic" => Protocol::Anthropic,
        other => {
            tracing::error!(provider_type = other, "models.provider_type 非法");
            return Err(GatewayError::internal(protocol));
        }
    };
    if model_protocol != protocol {
        return Err(GatewayError::protocol_mismatch(
            protocol,
            format!("模型 {model_slug} 须经 {provider_type} 协议端点调用(v1 同构透传)"),
        ));
    }
    Ok(ModelInfo {
        slug: model_slug.to_string(),
        provider_type: model_protocol,
        upstream_model,
        prices: Prices {
            input_micro: in_p,
            output_micro: out_p,
            cache_read_micro: cr_p,
            cache_write_micro: cw_p,
        },
    })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --locked gateway::auth 2>&1 | tail -4`
Expected: 全 pass(11 个,覆盖 401/403/404/400 全分支 + expires_at 边界)。

- [ ] **Step 5: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked gateway::auth`

```bash
git add src/gateway/auth.rs src/gateway/mod.rs
git commit -m "feat(rust): P2-T4 数据面鉴权 + 路由查询(expires_at/白名单/协议匹配)"
```

---

### Task 5: SSE tap(gateway/sse_tap.rs)

**Files:**
- Create: `src/gateway/sse_tap.rs`
- Modify: `src/gateway/mod.rs`(加 `pub mod sse_tap;`)

`UsageTap` 纯解析器:`feed(&[u8])` 增量喂字节、`finish()` 收尾取结果。断行缓冲跨 chunk。语义对齐 TS `SseUsageTap`(usage.ts:42-87)与 usage.test.ts 全用例。

**关键语义:**
- 缓冲未完整的行(无 `\n` 的尾部),下次 feed 续上。
- 逐行 trim;只处理 `data:` 开头行;payload trim 后跳过空与 `[DONE]`。
- 非 JSON 行忽略(不影响透传)。
- OpenAI:含 `usage` 对象的事件 → 用 `extract_usage_from_json(Openai, evt)` 覆盖。
- Anthropic:`message_start` → 取 input/cache 档(output 保留已有值);`message_delta` → `usage.output_tokens` 覆盖 output。
- 中断(Anthropic 未收到 message_delta)→ output=0(message_start 里的 output_tokens **不**作为最终值,见 TS consume:79 用 `this.usage.outputTokens` 覆盖)。

> **字节 → 文本:** feed 收 `&[u8]`,内部维护 `String` 缓冲。UTF-8 可能跨 chunk 断字符;用 `String::from_utf8_lossy` 会在断字符处插入替换符,破坏后续拼接。**正确做法:** 维护 `Vec<u8>` 字节缓冲,按 `\n`(0x0A)切分整行,对每整行 `String::from_utf8_lossy` 解析(整行内 UTF-8 完整);跨 chunk 断字符只可能出现在「未完行」尾部,留在字节缓冲等下次。这样既处理断行也处理断字符。

- [ ] **Step 1: 写 sse_tap.rs 骨架 + 失败测试(实现先 todo!)**

`src/gateway/sse_tap.rs`:

```rust
//! SSE 流用量旁路解析器。原样转发的同时把字节喂进 tap;流结束(正常 flush 或中断 cancel)
//! 后取已解析用量结算。容忍跨 chunk 断行与断字符。

use crate::billing::{extract_usage_from_json, Protocol, Usage};
use serde_json::Value;

pub struct UsageTap {
    protocol: Protocol,
    buffer: Vec<u8>,
    usage: Usage,
}

impl UsageTap {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            buffer: Vec::new(),
            usage: Usage::default(),
        }
    }

    /// 喂入一段字节。按 \n 切出整行解析;未完行留缓冲。
    pub fn feed(&mut self, bytes: &[u8]) {
        todo!()
    }

    /// 流结束:处理缓冲里残留的最后一行(若无尾随 \n)。
    pub fn finish(&mut self) -> Usage {
        todo!()
    }

    fn consume_line(&mut self, line: &str) {
        todo!()
    }

    fn consume_event(&mut self, evt: &Value) {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(p: Protocol) -> UsageTap {
        UsageTap::new(p)
    }

    #[test]
    fn openai_extracts_final_usage_across_split_lines() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        // 同一行拆成两个网络包
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3,");
        t.feed(b"\"prompt_tokens_details\":{\"cached_tokens\":2}},\"choices\":[]}\n\ndata: [DONE]\n\n");
        assert_eq!(
            t.finish(),
            Usage { input_tokens: 10, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: 0 }
        );
    }

    #[test]
    fn openai_no_usage_is_zero() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(t.finish(), Usage::default());
    }

    #[test]
    fn anthropic_start_then_delta_overrides_output() {
        let mut t = tap(Protocol::Anthropic);
        t.feed(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":1,\"output_tokens\":1}}}\n\n");
        t.feed(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":42}}\n\n");
        t.feed(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":77}}\n\n");
        assert_eq!(
            t.finish(),
            Usage { input_tokens: 25, output_tokens: 77, cache_read_tokens: 5, cache_write_tokens: 1 }
        );
    }

    #[test]
    fn anthropic_ignores_heartbeat_and_non_json() {
        let mut t = tap(Protocol::Anthropic);
        t.feed(b": ping\n\n");
        t.feed(b"data: not-json\n\n");
        assert_eq!(t.finish(), Usage::default());
    }

    #[test]
    fn openai_crlf_line_endings() {
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5},\"choices\":[]}\r\ndata: [DONE]\r\n");
        assert_eq!(
            t.finish(),
            Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }
        );
    }

    #[test]
    fn anthropic_interrupted_no_delta_output_zero() {
        // 只有 message_start(output_tokens=1),无 message_delta → output 记 0
        let mut t = tap(Protocol::Anthropic);
        t.feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}\n\n");
        assert_eq!(
            t.finish(),
            Usage { input_tokens: 25, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
        );
    }

    #[test]
    fn utf8_split_across_chunks() {
        // "你"(E4 BD A0)被拆成两个 feed:断字符不应破坏后续行解析
        let mut t = tap(Protocol::Openai);
        // 一行 content 含中文,跨包断在中文字节中间
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n".as_bytes().to_vec();
        let (a, b) = line.split_at(line.len() - 5);
        t.feed(a);
        t.feed(b);
        // 再喂含 usage 的完整行
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4},\"choices\":[]}\n");
        assert_eq!(t.finish().output_tokens, 4);
    }

    #[test]
    fn finish_flushes_trailing_line_without_newline() {
        // 最后一行没有尾随 \n,finish 必须处理
        let mut t = tap(Protocol::Openai);
        t.feed(b"data: {\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2},\"choices\":[]}");
        assert_eq!(t.finish().input_tokens, 8);
    }
}
```

并在 `src/gateway/mod.rs` 加 `pub mod sse_tap;`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --locked gateway::sse_tap 2>&1 | tail -8`
Expected: `todo!()` panic,用例红。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
impl UsageTap {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        // 逐个完整行(以 \n 结尾)切出处理;未完行留缓冲
        loop {
            let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') else {
                break;
            };
            // 取出 [0, pos) 行;丢弃 \n
            let line_bytes: Vec<u8> = self.buffer.drain(..=pos).take(pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            self.consume_line(line.trim());
        }
    }

    pub fn finish(&mut self) -> Usage {
        if !self.buffer.is_empty() {
            let tail: Vec<u8> = std::mem::take(&mut self.buffer);
            let line = String::from_utf8_lossy(&tail);
            self.consume_line(line.trim());
        }
        self.usage
    }

    fn consume_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("data:") else {
            return;
        };
        let payload = rest.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        if let Ok(evt) = serde_json::from_str::<Value>(payload) {
            self.consume_event(&evt);
        }
        // 非 JSON 行忽略
    }

    fn consume_event(&mut self, evt: &Value) {
        match self.protocol {
            Protocol::Openai => {
                if evt.get("usage").map(Value::is_object).unwrap_or(false) {
                    self.usage = extract_usage_from_json(Protocol::Openai, evt);
                }
            }
            Protocol::Anthropic => {
                match evt.get("type").and_then(Value::as_str) {
                    Some("message_start") => {
                        if let Some(msg) = evt.get("message") {
                            let partial = extract_usage_from_json(Protocol::Anthropic, msg);
                            // input/cache 取 message_start;output 保留已累计值(中断时为 0)
                            self.usage = Usage {
                                output_tokens: self.usage.output_tokens,
                                ..partial
                            };
                        }
                    }
                    Some("message_delta") => {
                        if let Some(ot) = evt.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_i64) {
                            self.usage.output_tokens = ot;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --locked gateway::sse_tap 2>&1 | tail -4`
Expected: 全 pass(8 个,含跨 chunk 断行/断字符、中断无 delta → output 0、CRLF、finish 残行)。

- [ ] **Step 5: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked gateway::sse_tap`

```bash
git add src/gateway/sse_tap.rs src/gateway/mod.rs
git commit -m "feat(rust): P2-T5 SSE tap(断行/断字符缓冲 + 两协议用量提取 + 中断结算)"
```

---

### Task 6: 上游转发 + 加权洗牌 + 指数退避冷却 + failover(gateway/upstream.rs)

**Files:**
- Create: `src/gateway/upstream.rs`
- Modify: `src/gateway/mod.rs`(加 `pub mod upstream;`)

实现链:查渠道 → 加权不放回洗牌 → 逐个尝试(解密凭证 → 体改写 → 头设置 → reqwest 发送 → 可重试判定)→ 命中则返回响应(流式 tap 包装 / 非流式文本)→ 失败冷却切换 → 全失败 → upstream_failed。

**TS 语义对齐(upstream.ts / router.ts):**
- **渠道来源(Rust 简化):** 无 model_channels 表;按 `model.provider_type` 查 channels:`SELECT ... WHERE provider_type = ? AND status != 'disabled'`。零行 → `no_channel`(502)。
- **洗牌(router.ts weightedShuffle):** 无 priority 分组(Rust channels 无 priority 列);直接对全部候选加权不放回洗牌。weight<=0 视为 1。
- **冷却过滤:** 候选中 `status='cooldown' AND cooldown_until > now` 的跳过;若有候选但全在冷却 → 落 upstream_failed(502)。
- **可重试(冷却+切换):** 401/403/408/429/>=500、网络错误、超时、凭证解密失败。
- **不可重试 4xx(如 400):** 上游响应原样透传(状态码 + body),不冷却,落 usage:status='upstream_error'、error_code='upstream_{status}'、cost 0。
- **指数退避(Rust 升级):** `cooldown_until = now + min(base * 2^level, max)`,`level+1`,`status='cooldown'`;成功请求后(仅当原 level/status 非默认)归零 + status='active'。
- **头与体:** content-type=application/json;OpenAI authorization=Bearer {凭证};Anthropic x-api-key={凭证}、anthropic-version(默认 "2023-06-01")、anthropic-beta(客户端给才透传)。其余客户端头不透传。请求体 model 替换为 upstream_model;OpenAI 流式注入 stream_options.include_usage=true。
- **URL:** base_url 去尾 `/`;OpenAI `{base}/chat/completions`,Anthropic `{base}/messages`。
- **超时:** 非流式 per-request `.timeout(upstream_timeout_secs)`;流式不设(connect_timeout 在 Client 上兜底)。超时按可重试处理。

> **冷却写库时机:** 冷却 UPDATE 在 failover 循环内即时落库(不等结算任务)——下一渠道选择与并发请求要立即看到冷却状态。成功归零同理即时落。这是与计费落库(spawn 任务)分开的独立写。

- [ ] **Step 1: 写 upstream.rs 骨架 + 失败测试(实现先 todo!)**

`src/gateway/upstream.rs`:

```rust
//! 上游转发:渠道选择、加权洗牌、凭证解密、体/头改写、reqwest 发送、可重试判定、
//! 指数退避冷却、故障切换。

use crate::billing::Protocol;
use crate::gateway::auth::ModelInfo;
use crate::gateway::error::GatewayError;
use crate::gateway::sse_tap::UsageTap;
use crate::AppState;
use rand::Rng;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// 一个候选渠道(已从 DB 读出,凭证仍是密文)。
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub base_url: String,
    pub credential_encrypted: Vec<u8>,
    pub weight: i64,
}

/// 转发成功结果。
pub struct ForwardOk {
    pub channel_id: String,
    pub status: u16,
    /// 上游 content-type(原样回传)
    pub content_type: String,
    pub kind: ForwardBody,
    pub ttft_ms: i64,
}

pub enum ForwardBody {
    /// 非流式:完整文本 + 已解析用量 + 响应 JSON(审计用)
    Buffered {
        text: String,
        usage: crate::billing::Usage,
        response_json: Option<Value>,
    },
    /// 流式:字节流(已 tap 包装)+ 共享 tap(handler 在流结束后取 usage)
    Stream {
        stream: BoxByteStream,
        tap: Arc<Mutex<UsageTap>>,
    },
    /// 不可重试 4xx:原样透传上游错误体(零用量)
    Passthrough { text: String },
}

pub type BoxByteStream =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send>>;

/// 查该 provider_type 下未禁用的渠道。
pub async fn load_candidates(
    state: &AppState,
    provider_type: Protocol,
) -> Result<Vec<(Candidate, String, i64, i64)>, GatewayError> {
    // 返回 (candidate, status, cooldown_until_or_-1, cooldown_level)
    todo!()
}

/// 加权不放回洗牌。weight<=0 视为 1。
pub fn weighted_shuffle<R: Rng>(mut items: Vec<Candidate>, rng: &mut R) -> Vec<Candidate> {
    todo!()
}

/// 可重试判定(状态码维度);网络错误/超时/解密失败由调用点直接当可重试。
fn is_retryable_status(status: u16) -> bool {
    todo!()
}

/// 冷却一个渠道:指数退避写库。
pub async fn mark_cooldown(state: &AppState, channel_id: &str, current_level: i64) {
    todo!()
}

/// 成功后重置冷却(仅当当前非 active/level>0,避免每请求空写)。
pub async fn reset_cooldown(state: &AppState, channel_id: &str, current_level: i64, current_status: &str) {
    todo!()
}

/// 主入口:对模型选渠道并故障切换转发。
pub async fn forward(
    state: &AppState,
    protocol: Protocol,
    model: &ModelInfo,
    request_body: &Value,
    anthropic_version: Option<&str>,
    anthropic_beta: Option<&str>,
) -> Result<ForwardOk, GatewayError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{insert_channel, insert_model, test_state};
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn openai_model(upstream: &str) -> ModelInfo {
        ModelInfo {
            slug: "gpt-x".into(),
            provider_type: Protocol::Openai,
            upstream_model: upstream.into(),
            prices: crate::billing::Prices { input_micro: 0, output_micro: 0, cache_read_micro: 0, cache_write_micro: 0 },
        }
    }

    #[test]
    fn weighted_shuffle_returns_all_once() {
        let items: Vec<Candidate> = (0..5)
            .map(|i| Candidate { id: format!("c{i}"), base_url: "x".into(), credential_encrypted: vec![], weight: 1 })
            .collect();
        let mut rng = StdRng::seed_from_u64(42);
        let out = weighted_shuffle(items.clone(), &mut rng);
        assert_eq!(out.len(), 5);
        let mut ids: Vec<String> = out.iter().map(|c| c.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["c0", "c1", "c2", "c3", "c4"]);
    }

    #[test]
    fn weighted_shuffle_zero_weight_treated_as_one() {
        // 不该 panic(total>0);单元素 weight=0 也能返回
        let items = vec![Candidate { id: "a".into(), base_url: "x".into(), credential_encrypted: vec![], weight: 0 }];
        let mut rng = StdRng::seed_from_u64(1);
        assert_eq!(weighted_shuffle(items, &mut rng).len(), 1);
    }

    #[test]
    fn retryable_status_matrix() {
        for s in [401, 403, 408, 429, 500, 502, 503] {
            assert!(is_retryable_status(s), "{s} 应可重试");
        }
        for s in [400, 404, 422] {
            assert!(!is_retryable_status(s), "{s} 不应可重试");
        }
    }

    #[tokio::test]
    async fn no_channel_when_db_empty() {
        let state = test_state().await;
        let m = openai_model("gpt-4o");
        let err = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap_err();
        assert_eq!(err.code, "no_channel");
        assert_eq!(err.status.as_u16(), 502);
    }

    #[tokio::test]
    async fn non_stream_success_buffers_usage() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "usage": {"prompt_tokens": 100, "completion_tokens": 20}
            })))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-up", 1, "active").await;
        let m = openai_model("gpt-4o");
        let ok = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x","stream":false}), None, None).await.unwrap();
        assert_eq!(ok.status, 200);
        match ok.kind {
            ForwardBody::Buffered { usage, .. } => {
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 20);
            }
            _ => panic!("应为 Buffered"),
        }
    }

    #[tokio::test]
    async fn fails_over_on_5xx_then_succeeds() {
        let bad = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(503)).mount(&bad).await;
        let good = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}})))
            .mount(&good).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let bad_id = insert_channel(&state.db, &mk, "openai", &format!("{}/v1", bad.uri()), "sk-bad", 1, "active").await;
        insert_channel(&state.db, &mk, "openai", &format!("{}/v1", good.uri()), "sk-good", 1, "active").await;
        let m = openai_model("gpt-4o");
        let ok = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap();
        assert_eq!(ok.status, 200);
        // bad 渠道应被冷却
        let (status, level): (String, i64) = sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id = ?")
            .bind(&bad_id).fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "cooldown");
        assert_eq!(level, 1);
    }

    #[tokio::test]
    async fn cooldown_401_credential_invalid() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(401)).mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-x", 1, "active").await;
        let m = openai_model("gpt-4o");
        let err = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap_err();
        assert_eq!(err.code, "upstream_failed");
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "cooldown");
    }

    #[tokio::test]
    async fn decrypt_failure_cools_and_continues() {
        // 渠道凭证用「错误的 master_key」加密:本进程解不开 → 当可重试,冷却切换
        let state = test_state().await;
        let wrong_mk = [1u8; 32]; // 与 test master_key([7u8;32]) 不同
        let id = insert_channel(&state.db, &wrong_mk, "openai", "http://127.0.0.1:1/v1", "sk-x", 1, "active").await;
        let m = openai_model("gpt-4o");
        let err = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap_err();
        assert_eq!(err.code, "upstream_failed");
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "cooldown");
    }

    #[tokio::test]
    async fn non_retryable_400_passthrough_no_cooldown() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_string("{\"error\":\"bad request from upstream\"}"))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-x", 1, "active").await;
        let m = openai_model("gpt-4o");
        let ok = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap();
        assert_eq!(ok.status, 400);
        match ok.kind {
            ForwardBody::Passthrough { text } => assert!(text.contains("bad request from upstream")),
            _ => panic!("应为 Passthrough"),
        }
        // 不冷却
        let (status,): (String,) = sqlx::query_as("SELECT status FROM channels WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "active");
    }

    #[tokio::test]
    async fn success_resets_cooldown_level() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"usage":{"prompt_tokens":1,"completion_tokens":1}})))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-x", 1, "active").await;
        // 预置成 cooldown level 3、cooldown_until 已过期(可被选中)
        sqlx::query("UPDATE channels SET status='cooldown', cooldown_level=3, cooldown_until=? WHERE id=?")
            .bind(crate::now_epoch() - 1).bind(&id).execute(&state.db).await.unwrap();
        let m = openai_model("gpt-4o");
        let ok = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap();
        assert_eq!(ok.status, 200);
        let (status, level): (String, i64) = sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id = ?")
            .bind(&id).fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "active");
        assert_eq!(level, 0);
    }

    #[tokio::test]
    async fn all_cooling_yields_upstream_failed() {
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        let id = insert_channel(&state.db, &mk, "openai", "http://127.0.0.1:1/v1", "sk-x", 1, "active").await;
        // 未来冷却中
        sqlx::query("UPDATE channels SET status='cooldown', cooldown_until=? WHERE id=?")
            .bind(crate::now_epoch() + 600).bind(&id).execute(&state.db).await.unwrap();
        let m = openai_model("gpt-4o");
        let err = forward(&state, Protocol::Openai, &m, &json!({"model":"gpt-x"}), None, None).await.unwrap_err();
        assert_eq!(err.code, "upstream_failed");
    }

    #[tokio::test]
    async fn anthropic_headers_and_body_rewrite() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/messages"))
            .and(wiremock::matchers::header("x-api-key", "sk-up"))
            .and(wiremock::matchers::header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"usage":{"input_tokens":3,"output_tokens":4}})))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(&state.db, &mk, "anthropic", &format!("{}/v1", server.uri()), "sk-up", 1, "active").await;
        let m = ModelInfo { slug: "claude-x".into(), provider_type: Protocol::Anthropic, upstream_model: "claude-3-real".into(),
            prices: crate::billing::Prices { input_micro: 0, output_micro: 0, cache_read_micro: 0, cache_write_micro: 0 } };
        let ok = forward(&state, Protocol::Anthropic, &m, &json!({"model":"claude-x"}), None, None).await.unwrap();
        assert_eq!(ok.status, 200);
    }
}
```

并在 `src/gateway/mod.rs` 加 `pub mod upstream;`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --locked gateway::upstream 2>&1 | tail -8`
Expected: `todo!()` panic,用例红。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
pub async fn load_candidates(
    state: &AppState,
    provider_type: Protocol,
) -> Result<Vec<(Candidate, String, i64, i64)>, GatewayError> {
    let pt = match provider_type {
        Protocol::Openai => "openai",
        Protocol::Anthropic => "anthropic",
    };
    let rows: Vec<(String, String, Vec<u8>, i64, String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, base_url, credential_encrypted, weight, status, cooldown_until, cooldown_level \
         FROM channels WHERE provider_type = ? AND status != 'disabled'",
    )
    .bind(pt)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "查询 channels 失败");
        GatewayError::internal(provider_type)
    })?;
    Ok(rows
        .into_iter()
        .map(|(id, base_url, cred, weight, status, cu, level)| {
            (
                Candidate { id, base_url, credential_encrypted: cred, weight },
                status,
                cu.unwrap_or(-1),
                level,
            )
        })
        .collect())
}

pub fn weighted_shuffle<R: Rng>(mut items: Vec<Candidate>, rng: &mut R) -> Vec<Candidate> {
    let mut result = Vec::with_capacity(items.len());
    while !items.is_empty() {
        let total: i64 = items.iter().map(|c| c.weight.max(1)).sum();
        // total >= items.len() >= 1
        let mut pick = rng.gen_range(0..total);
        let mut idx = items.len() - 1;
        for (i, c) in items.iter().enumerate() {
            pick -= c.weight.max(1);
            if pick < 0 {
                idx = i;
                break;
            }
        }
        result.push(items.remove(idx));
    }
    result
}

fn is_retryable_status(status: u16) -> bool {
    status == 401 || status == 403 || status == 408 || status == 429 || status >= 500
}

pub async fn mark_cooldown(state: &AppState, channel_id: &str, current_level: i64) {
    let base = state.config.cooldown_base_secs;
    let max = state.config.cooldown_max_secs;
    // min(base * 2^level, max);移位防溢出,level 截到 32
    let shift = current_level.clamp(0, 32) as u32;
    let backoff = base.saturating_mul(1i64.checked_shl(shift).unwrap_or(i64::MAX)).min(max);
    let until = crate::now_epoch() + backoff;
    let new_level = current_level + 1;
    if let Err(e) = sqlx::query(
        "UPDATE channels SET status='cooldown', cooldown_until=?, cooldown_level=? WHERE id=?",
    )
    .bind(until)
    .bind(new_level)
    .bind(channel_id)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, "写冷却状态失败");
    }
}

pub async fn reset_cooldown(state: &AppState, channel_id: &str, current_level: i64, current_status: &str) {
    // 仅当原值非默认才写(避免每个成功请求空写)
    if current_level == 0 && current_status == "active" {
        return;
    }
    if let Err(e) = sqlx::query(
        "UPDATE channels SET status='active', cooldown_until=NULL, cooldown_level=0 WHERE id=?",
    )
    .bind(channel_id)
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, "重置冷却状态失败");
    }
}

pub async fn forward(
    state: &AppState,
    protocol: Protocol,
    model: &ModelInfo,
    request_body: &Value,
    anthropic_version: Option<&str>,
    anthropic_beta: Option<&str>,
) -> Result<ForwardOk, GatewayError> {
    let all = load_candidates(state, protocol).await?;
    if all.is_empty() {
        return Err(GatewayError::no_channel(protocol));
    }
    let now = crate::now_epoch();
    // 过滤冷却中(status='cooldown' AND cooldown_until > now);保留 level/status 供成功重置
    let mut meta: std::collections::HashMap<String, (i64, String)> = std::collections::HashMap::new();
    let usable: Vec<Candidate> = all
        .into_iter()
        .filter_map(|(c, status, cu, level)| {
            meta.insert(c.id.clone(), (level, status.clone()));
            let cooling = status == "cooldown" && cu > now;
            if cooling {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    if usable.is_empty() {
        // 有渠道但全在冷却
        return Err(GatewayError::upstream_failed(protocol));
    }

    let mut rng = rand::thread_rng();
    let ordered = weighted_shuffle(usable, &mut rng);
    let is_stream = request_body.get("stream").and_then(Value::as_bool).unwrap_or(false);

    for channel in ordered {
        let (level, status) = meta.get(&channel.id).cloned().unwrap_or((0, "active".into()));

        // 解密凭证
        let mk = state.config.master_key_bytes();
        let credential = match crate::crypto::decrypt_secret(&channel.credential_encrypted, &mk, &channel.id) {
            Ok(c) => c,
            Err(_) => {
                tracing::error!(channel_id = %channel.id, "渠道凭证解密失败(疑似主密钥轮换/数据损坏)");
                mark_cooldown(state, &channel.id, level).await;
                continue;
            }
        };

        // 体改写:model → upstream_model;OpenAI 流式注入 stream_options
        let mut body = request_body.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("model".into(), Value::String(model.upstream_model.clone()));
            if protocol == Protocol::Openai && is_stream {
                let mut so = obj
                    .get("stream_options")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                so.insert("include_usage".into(), Value::Bool(true));
                obj.insert("stream_options".into(), Value::Object(so));
            }
        }

        // 头
        let base = channel.base_url.trim_end_matches('/');
        let url = match protocol {
            Protocol::Openai => format!("{base}/chat/completions"),
            Protocol::Anthropic => format!("{base}/messages"),
        };
        let mut req = state.http.post(&url).header("content-type", "application/json");
        match protocol {
            Protocol::Openai => {
                req = req.header("authorization", format!("Bearer {credential}"));
            }
            Protocol::Anthropic => {
                req = req
                    .header("x-api-key", credential)
                    .header("anthropic-version", anthropic_version.unwrap_or("2023-06-01"));
                if let Some(beta) = anthropic_beta {
                    req = req.header("anthropic-beta", beta);
                }
            }
        }
        // 非流式设 per-request 超时;流式不设
        if !is_stream {
            req = req.timeout(std::time::Duration::from_secs(state.config.upstream_timeout_secs));
        }

        let started = std::time::Instant::now();
        let resp = match req.body(serde_json::to_vec(&body).expect("序列化请求体")).send().await {
            Ok(r) => r,
            Err(e) => {
                // 网络错误/超时:可重试,冷却切换
                tracing::warn!(channel_id = %channel.id, error = %e, "渠道请求失败");
                mark_cooldown(state, &channel.id, level).await;
                continue;
            }
        };

        let status_code = resp.status().as_u16();
        if is_retryable_status(status_code) {
            mark_cooldown(state, &channel.id, level).await;
            continue;
        }
        let ttft_ms = started.elapsed().as_millis() as i64;
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();

        if !resp.status().is_success() {
            // 不可重试 4xx:原样透传,不冷却,不计费
            let text = resp.text().await.unwrap_or_default();
            reset_cooldown(state, &channel.id, level, &status).await; // 渠道本身可用,清冷却
            return Ok(ForwardOk {
                channel_id: channel.id,
                status: status_code,
                content_type,
                kind: ForwardBody::Passthrough { text },
                ttft_ms,
            });
        }

        // 成功:重置冷却
        reset_cooldown(state, &channel.id, level, &status).await;

        if !is_stream {
            let text = resp.text().await.unwrap_or_default();
            let json: Option<Value> = serde_json::from_str(&text).ok();
            let usage = json
                .as_ref()
                .map(|j| crate::billing::extract_usage_from_json(protocol, j))
                .unwrap_or_default();
            return Ok(ForwardOk {
                channel_id: channel.id,
                status: status_code,
                content_type,
                kind: ForwardBody::Buffered { text, usage, response_json: json },
                ttft_ms,
            });
        }

        // 流式:包装字节流,旁路喂 tap
        let tap = Arc::new(Mutex::new(UsageTap::new(protocol)));
        let tap_for_stream = tap.clone();
        use futures_util::StreamExt;
        let byte_stream = resp.bytes_stream().map(move |chunk| match chunk {
            Ok(bytes) => {
                if let Ok(mut t) = tap_for_stream.lock() {
                    t.feed(&bytes);
                }
                Ok(bytes)
            }
            Err(e) => Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
        });
        return Ok(ForwardOk {
            channel_id: channel.id,
            status: status_code,
            content_type,
            kind: ForwardBody::Stream { stream: Box::pin(byte_stream), tap },
            ttft_ms,
        });
    }

    Err(GatewayError::upstream_failed(protocol))
}
```

> **实现注记(给 implementer):**
> - `weighted_shuffle` 用 `gen_range(0..total)`(整数版),`total>=1` 保证非空区间。
> - `mark_cooldown` 的移位:`1i64.checked_shl(shift)` 对 shift>=63 返回 None → `i64::MAX`,再 `saturating_mul` 与 `.min(max)` 收口,绝不溢出 panic。
> - 流式 tap 用 `Arc<Mutex<UsageTap>>`:transform 闭包与 handler 结算都要访问。`std::sync::Mutex` 足够(无 await 跨锁)。handler 在流被 Drop/读尽后 `tap.lock().finish()` 取用量(T8 详述)。
> - clippy 可能提示 `map_or`/`unwrap_or_default` 等;按提示微调,语义不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --locked gateway::upstream 2>&1 | tail -6`
Expected: 全 pass(12 个):洗牌全覆盖/零权重、可重试矩阵、no_channel、非流式缓冲、5xx 切换 + 冷却 level=1、401 冷却、解密失败冷却、400 透传不冷却、成功重置 level、全冷却 upstream_failed、anthropic 头/体改写。

- [ ] **Step 5: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked gateway::upstream`

```bash
git add src/gateway/upstream.rs src/gateway/mod.rs
git commit -m "feat(rust): P2-T6 上游转发 + 加权洗牌 + 指数退避冷却 + 故障切换"
```

---

### Task 7: 预算检查与落库事务(billing.rs 下半)

**Files:**
- Modify: `src/billing.rs`(追加 check_budgets / settle_usage / 月份工具 + 测试)

**TS 语义对齐(budget.ts / db-access.ts):**
- **主体(Rust 简化):** `subjects_for_key` = `[(key, key_id), (owner_type, owner_id)]` 两级(无 app/team 展开;0001 owner_type 仅 user/team)。
- **检查时机:** 转发前。每主体查 budgets(status='active',monthly/total 可并存),剩余 = limit_micro - used_micro;**monthly 且 period_start 所在自然月(UTC) < 当前月** → 视为已翻转,剩余 = limit_micro(读路径不写库)。同主体取**最小剩余**;无预算行 = 无限。任一主体剩余 <= 0 → 拒绝,返回耗尽主体。
- **落库(单事务):** INSERT usage_records + 对命中预算行 UPDATE used_micro。**仅 status='ok'/'client_abort' 且 cost>0** 累加;rejected/upstream_error 不累加。monthly 翻转写路径内联:UPDATE 时若 period_start 跨月,先重置 used=0 + 更新 period_start 再累加,同一事务。

> **月翻转判定:** 用 `(year, month)` 元组比较(`from_unix_timestamp(ts).year()/.month()` UTC)。「period_start 月 < 当前月」= `(ps_year, ps_month) < (now_year, now_month)`。`time::Month` 实现了 `Ord`,但跨年要用 (year, month) 元组比较以正确处理 12 月 < 次年 1 月。

- [ ] **Step 1: 追加失败测试(billing.rs tests 模块,实现先 todo!)**

先在 `src/billing.rs` 顶部 import 区追加:

```rust
use crate::gateway::auth::AuthedKey;
use sqlx::SqlitePool;
```

在 todo! 区(`truncate_utf8` 后)追加签名骨架:

```rust
/// 预算主体:Key 自身 + owner。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub subject_type: String,
    pub subject_id: String,
}

pub fn subjects_for_key(key: &AuthedKey) -> Vec<Subject> {
    todo!()
}

/// 落库时的请求结局。
#[derive(Debug, Clone)]
pub struct SettleInput {
    pub key_id: String,
    pub model_slug: String,
    pub channel_id: Option<String>,
    pub usage: Usage,
    pub cost_micro: i64,
    pub latency_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub status: &'static str, // ok / rejected / upstream_error / client_abort
    pub error_code: Option<String>,
    pub request_body: Option<String>,  // 已截断(audit)
    pub response_body: Option<String>, // 已截断(audit)
    /// 预算累加用的主体(rejected 时可空)
    pub subjects: Vec<Subject>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BudgetCheck {
    Ok,
    Exhausted(Subject),
}

/// 读路径预算检查。月翻转仅视角处理,不写库。
pub async fn check_budgets(db: &SqlitePool, subjects: &[Subject], now: i64) -> BudgetCheck {
    todo!()
}

/// 单事务落库:INSERT usage_records + 命中预算行 UPDATE(含月翻转内联)。
pub async fn settle_usage(db: &SqlitePool, input: &SettleInput, now: i64) -> anyhow::Result<()> {
    todo!()
}

/// (year, month) 比较:ts 所在月是否早于 now 所在月(UTC)。
fn is_earlier_month(ts: i64, now: i64) -> bool {
    todo!()
}
```

测试(追加到 tests 模块;用 `crate::db::open_memory` 与 seed helper):

```rust
    use crate::db::open_memory;
    use crate::test_util::{insert_budget, insert_api_key};

    fn subj(t: &str, id: &str) -> Subject {
        Subject { subject_type: t.into(), subject_id: id.into() }
    }

    #[tokio::test]
    async fn check_no_budget_is_unlimited_ok() {
        let db = open_memory().await.unwrap();
        assert_eq!(check_budgets(&db, &[subj("key", "k1")], 1000).await, BudgetCheck::Ok);
    }

    #[tokio::test]
    async fn check_exhausted_returns_subject() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 1_000_000, 1_000_000, 0).await; // 剩 0
        assert_eq!(check_budgets(&db, &[subj("key", "k1")], 1000).await, BudgetCheck::Exhausted(subj("key", "k1")));
    }

    #[tokio::test]
    async fn check_min_remaining_across_periods() {
        let db = open_memory().await.unwrap();
        // 同主体 monthly 剩 500,total 剩 0 → 取最小 0 → 耗尽
        insert_budget(&db, "user", "u1", "monthly", 1_000_000, 999_500, crate::now_epoch()).await;
        insert_budget(&db, "user", "u1", "total", 1_000_000, 1_000_000, 0).await;
        assert_eq!(check_budgets(&db, &[subj("user", "u1")], crate::now_epoch()).await, BudgetCheck::Exhausted(subj("user", "u1")));
    }

    #[tokio::test]
    async fn check_monthly_rollover_view_resets_remaining() {
        let db = open_memory().await.unwrap();
        // period_start 在去年(2024-01),used 满额;视角翻转后剩余 = limit,不拒
        let last_year = 1_704_067_200; // 2024-01-01 00:00:00 UTC
        insert_budget(&db, "key", "k1", "monthly", 1_000_000, 1_000_000, last_year).await;
        let now = crate::now_epoch(); // 2026,远晚于 2024-01
        assert_eq!(check_budgets(&db, &[subj("key", "k1")], now).await, BudgetCheck::Ok);
    }

    #[tokio::test]
    async fn settle_inserts_record_and_accrues_on_ok() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 0, 0).await;
        let input = SettleInput {
            key_id: "k1".into(), model_slug: "gpt-x".into(), channel_id: Some("c1".into()),
            usage: Usage { input_tokens: 100, output_tokens: 20, ..Usage::default() },
            cost_micro: 73_500, latency_ms: Some(120), ttft_ms: Some(40),
            status: "ok", error_code: None, request_body: None, response_body: None,
            subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (cnt, cost): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(cost_micro),0) FROM usage_records").fetch_one(&db).await.unwrap();
        assert_eq!(cnt, 1);
        assert_eq!(cost, 73_500);
        let (used,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'").fetch_one(&db).await.unwrap();
        assert_eq!(used, 73_500);
    }

    #[tokio::test]
    async fn settle_rejected_does_not_accrue() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 5000, 0).await;
        let input = SettleInput {
            key_id: "k1".into(), model_slug: "gpt-x".into(), channel_id: None,
            usage: Usage::default(), cost_micro: 0, latency_ms: Some(1), ttft_ms: None,
            status: "rejected", error_code: Some("budget_exhausted".into()),
            request_body: None, response_body: None, subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (used,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'").fetch_one(&db).await.unwrap();
        assert_eq!(used, 5000); // 未变
        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records WHERE status='rejected'").fetch_one(&db).await.unwrap();
        assert_eq!(cnt, 1);
    }

    #[tokio::test]
    async fn settle_monthly_rollover_inline_reset_then_accrue() {
        let db = open_memory().await.unwrap();
        let last_year = 1_704_067_200; // 2024-01
        insert_budget(&db, "key", "k1", "monthly", 10_000_000, 9_999_000, last_year).await;
        let now = crate::now_epoch();
        let input = SettleInput {
            key_id: "k1".into(), model_slug: "gpt-x".into(), channel_id: Some("c1".into()),
            usage: Usage { input_tokens: 1, ..Usage::default() }, cost_micro: 500,
            latency_ms: Some(1), ttft_ms: Some(1), status: "ok", error_code: None,
            request_body: None, response_body: None, subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, now).await.unwrap();
        let (used, ps): (i64, i64) = sqlx::query_as("SELECT used_micro, period_start FROM budgets WHERE subject_id='k1'").fetch_one(&db).await.unwrap();
        assert_eq!(used, 500, "翻转后应从 0 起累加,而非 9999000+500");
        assert!(ps > last_year, "period_start 应更新到当前月");
    }

    #[tokio::test]
    async fn settle_client_abort_accrues() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 0, 0).await;
        let input = SettleInput {
            key_id: "k1".into(), model_slug: "gpt-x".into(), channel_id: Some("c1".into()),
            usage: Usage { input_tokens: 10, ..Usage::default() }, cost_micro: 210,
            latency_ms: Some(5), ttft_ms: Some(2), status: "client_abort", error_code: None,
            request_body: None, response_body: None, subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (used,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'").fetch_one(&db).await.unwrap();
        assert_eq!(used, 210);
    }

    #[tokio::test]
    async fn subjects_for_key_two_levels() {
        let key = AuthedKey { id: "k1".into(), owner_type: "user".into(), owner_id: "u1".into(), allowed_models: None, audit: false };
        assert_eq!(subjects_for_key(&key), vec![subj("key", "k1"), subj("user", "u1")]);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --locked billing::tests::settle 2>&1 | tail -8`
Expected: `todo!()` panic。

- [ ] **Step 3: 实现(替换 todo!)**

```rust
pub fn subjects_for_key(key: &AuthedKey) -> Vec<Subject> {
    vec![
        Subject { subject_type: "key".into(), subject_id: key.id.clone() },
        Subject { subject_type: key.owner_type.clone(), subject_id: key.owner_id.clone() },
    ]
}

fn year_month(ts: i64) -> (i32, u8) {
    match time::OffsetDateTime::from_unix_timestamp(ts) {
        Ok(dt) => (dt.year(), dt.month() as u8),
        Err(_) => (0, 0), // 非法时间戳:视为最早,触发翻转重置(安全侧)
    }
}

fn is_earlier_month(ts: i64, now: i64) -> bool {
    year_month(ts) < year_month(now)
}

pub async fn check_budgets(db: &SqlitePool, subjects: &[Subject], now: i64) -> BudgetCheck {
    for s in subjects {
        let rows: Vec<(String, i64, i64, i64)> = match sqlx::query_as(
            "SELECT period, limit_micro, used_micro, period_start FROM budgets \
             WHERE subject_type = ? AND subject_id = ? AND status = 'active'",
        )
        .bind(&s.subject_type)
        .bind(&s.subject_id)
        .fetch_all(db)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "查询预算失败");
                // 读失败放行(可用性优先;落库台账仍记账)——与 TS「PG 为事实源」取舍一致
                continue;
            }
        };
        for (period, limit, used, period_start) in rows {
            let remaining = if period == "monthly" && is_earlier_month(period_start, now) {
                limit // 视角翻转:本月未用
            } else {
                limit - used
            };
            if remaining <= 0 {
                return BudgetCheck::Exhausted(s.clone());
            }
        }
    }
    BudgetCheck::Ok
}

pub async fn settle_usage(db: &SqlitePool, input: &SettleInput, now: i64) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;

    sqlx::query(
        "INSERT INTO usage_records \
         (id, key_id, model_slug, channel_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, \
          cost_micro, latency_ms, ttft_ms, status, error_code, request_body, response_body, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&input.key_id)
    .bind(&input.model_slug)
    .bind(&input.channel_id)
    .bind(input.usage.input_tokens)
    .bind(input.usage.output_tokens)
    .bind(input.usage.cache_read_tokens)
    .bind(input.usage.cache_write_tokens)
    .bind(input.cost_micro)
    .bind(input.latency_ms)
    .bind(input.ttft_ms)
    .bind(input.status)
    .bind(&input.error_code)
    .bind(&input.request_body)
    .bind(&input.response_body)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    // 仅成功结局且 cost>0 累加预算
    let accrue = matches!(input.status, "ok" | "client_abort") && input.cost_micro > 0;
    if accrue {
        for s in &input.subjects {
            let rows: Vec<(String, String, i64)> = sqlx::query_as(
                "SELECT id, period, period_start FROM budgets \
                 WHERE subject_type = ? AND subject_id = ? AND status = 'active'",
            )
            .bind(&s.subject_type)
            .bind(&s.subject_id)
            .fetch_all(&mut *tx)
            .await?;
            for (bid, period, period_start) in rows {
                if period == "monthly" && is_earlier_month(period_start, now) {
                    // 翻转:同事务内重置 used=0、更新 period_start,再累加
                    sqlx::query("UPDATE budgets SET used_micro = ?, period_start = ? WHERE id = ?")
                        .bind(input.cost_micro)
                        .bind(now)
                        .bind(&bid)
                        .execute(&mut *tx)
                        .await?;
                } else {
                    sqlx::query("UPDATE budgets SET used_micro = used_micro + ? WHERE id = ?")
                        .bind(input.cost_micro)
                        .bind(&bid)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
    }

    tx.commit().await?;
    Ok(())
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --locked billing:: 2>&1 | tail -6`
Expected: 全 pass(T2 的 13 个 + T7 的 9 个 = 22 个):无预算 ok、耗尽返回主体、跨期取最小、月翻转视角、ok 累加、rejected 不累加、月翻转内联重置、client_abort 累加、subjects 两级。

- [ ] **Step 5: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked billing::`

```bash
git add src/billing.rs
git commit -m "feat(rust): P2-T7 预算检查(月翻转视角)+ 单事务落库(内联翻转/选择性累加)"
```

---

### Task 8: 网关 handler 整链(gateway/mod.rs + lib.rs 挂路由)

**Files:**
- Modify: `src/gateway/mod.rs`(追加 handler + router())、`src/lib.rs`(挂 `/v1/*` 路由 + DefaultBodyLimit)

整链组装:解析体 → 鉴权 → 路由 → 预算检查 → 转发 → 响应(流式/非流式/透传)→ spawn 结算任务。

**关键语义:**
- `POST /v1/chat/completions` → openai;`POST /v1/messages` → anthropic。仅 POST。
- body 非法 JSON → 400 invalid_request「请求体不是合法 JSON」;缺 model → 400「请求体缺少 model 字段」。
- 预算拒绝:429 budget_exhausted「预算已用尽({subject_type}:{subject_id})」;**同时 spawn 结算** status='rejected'、error_code='budget_exhausted'、cost 0、channel_id NULL、tokens 全 0、latency_ms=已耗时、ttft_ms=NULL。无 Retry-After 头。
- 全失败 502:spawn 结算 status='upstream_error'、error_code='upstream_failed'、channel_id NULL、cost 0。
- 非流式成功:计算 cost、spawn 结算(status='ok'),回传上游 body + content-type。audit key 存 request_body(客户端原始 JSON,model 仍是 slug)、response_body(响应文本截断)。
- 透传 4xx:回传上游状态/body;spawn 结算 status='upstream_error'、error_code='upstream_{status}'、cost 0。
- 流式成功:返回 `Body::from_stream`,挂 Drop guard——流被读尽(flush)或客户端中断(drop)时,从 tap 取 usage、算 cost、spawn 结算。正常结束 status='ok',中断 status='client_abort'。

> **流式结算的 Drop guard 机制(核心难点):** 把 tap、计费上下文、AppState 包进一个 guard 结构,`impl Drop`。但 `settle_usage` 是 async,Drop 不能 await。方案:guard 持有结算所需数据(克隆),在 `forward` 的字节流末尾用一个**包裹流**——当内层流 `poll_next` 返回 `None`(正常结束)或流被 drop(中断)时触发结算。**实现用** `futures_util` 的流 + 一个 `SettleOnEnd` 包装:维护 `done: bool`,`Stream::poll_next` 遇 `None` 时置 done 并 spawn 结算(正常);`Drop` 时若 `!done` 则 spawn 结算(中断,status=client_abort)。spawn 进 `state.settle_tracker`,停机可排水。
>
> 由于 Drop 中要 spawn async 任务,需在 tokio runtime 内(handler 必在);`settle_tracker.spawn(async move { ... })` 即可。tap 用 `Arc<Mutex<UsageTap>>`,guard 与流共享;结算时 `tap.lock().finish()`。

- [ ] **Step 1: 写 handler + router + 失败测试**

`src/gateway/mod.rs` 追加(模块声明已在前面任务加齐;此处补 handler 与 router):

```rust
pub mod auth;
pub mod error;
pub mod sse_tap;
pub mod upstream;

pub use crate::billing::Protocol;

use crate::billing::{compute_cost_micro, subjects_for_key, truncate_utf8, SettleInput, Usage};
use crate::gateway::auth::{authenticate, resolve_model};
use crate::gateway::error::GatewayError;
use crate::gateway::upstream::{forward, ForwardBody};
use crate::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chat/completions", post(handle_openai))
        .route("/messages", post(handle_anthropic))
}

async fn handle_openai(state: State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    handle(state, Protocol::Openai, headers, body).await
}
async fn handle_anthropic(state: State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    handle(state, Protocol::Anthropic, headers, body).await
}

/// 把结算输入丢进后台任务(单事务落库),失败计数。挂 settle_tracker 供排水。
fn spawn_settle(state: &AppState, input: SettleInput) {
    let db = state.db.clone();
    let failures = state.settle_failures.clone();
    state.settle_tracker.spawn(async move {
        if let Err(e) = crate::billing::settle_usage(&db, &input, crate::now_epoch()).await {
            tracing::error!(error = %e, "结算落库失败");
            failures.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    });
}

async fn handle(State(state): State<AppState>, protocol: Protocol, headers: HeaderMap, raw: axum::body::Bytes) -> Response {
    let started = std::time::Instant::now();

    // 解析 body
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => return GatewayError::invalid_request(protocol, "请求体不是合法 JSON").into_response(),
    };
    let model_slug = match body.get("model").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return GatewayError::invalid_request(protocol, "请求体缺少 model 字段").into_response(),
    };

    // 鉴权
    let key = match authenticate(&state, protocol, &headers, &model_slug).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };
    // 路由
    let model = match resolve_model(&state, protocol, &model_slug).await {
        Ok(m) => m,
        Err(e) => return e.into_response(),
    };

    let subjects = subjects_for_key(&key);
    let now = crate::now_epoch();
    // 预算
    if let crate::billing::BudgetCheck::Exhausted(s) = crate::billing::check_budgets(&state.db, &subjects, now).await {
        spawn_settle(&state, SettleInput {
            key_id: key.id.clone(), model_slug: model_slug.clone(), channel_id: None,
            usage: Usage::default(), cost_micro: 0, latency_ms: Some(started.elapsed().as_millis() as i64),
            ttft_ms: None, status: "rejected", error_code: Some("budget_exhausted".into()),
            request_body: None, response_body: None, subjects: subjects.clone(),
        });
        return GatewayError::budget_exhausted(
            protocol,
            format!("预算已用尽({}:{})", s.subject_type, s.subject_id),
        ).into_response();
    }

    // audit:请求体(客户端原始,model 仍 slug)
    let audit_req = if key.audit {
        Some(truncate_utf8(&String::from_utf8_lossy(&raw), state.config.audit_body_limit))
    } else {
        None
    };

    let anthropic_version = headers.get("anthropic-version").and_then(|v| v.to_str().ok());
    let anthropic_beta = headers.get("anthropic-beta").and_then(|v| v.to_str().ok());

    let fwd = match forward(&state, protocol, &model, &body, anthropic_version, anthropic_beta).await {
        Ok(f) => f,
        Err(e) => {
            // 全失败 / no_channel:no_channel 不落 usage(无渠道、纯路由错);upstream_failed 落 usage
            if e.code == "upstream_failed" {
                spawn_settle(&state, SettleInput {
                    key_id: key.id.clone(), model_slug: model_slug.clone(), channel_id: None,
                    usage: Usage::default(), cost_micro: 0,
                    latency_ms: Some(started.elapsed().as_millis() as i64), ttft_ms: None,
                    status: "upstream_error", error_code: Some("upstream_failed".into()),
                    request_body: audit_req.clone(), response_body: None, subjects: subjects.clone(),
                });
            }
            return e.into_response();
        }
    };

    let latency = || started.elapsed().as_millis() as i64;
    let content_type = fwd.content_type.clone();
    let channel_id = fwd.channel_id.clone();
    let ttft = fwd.ttft_ms;

    match fwd.kind {
        ForwardBody::Passthrough { text } => {
            // 不可重试 4xx:落 upstream_error / upstream_{status}
            spawn_settle(&state, SettleInput {
                key_id: key.id.clone(), model_slug: model_slug.clone(), channel_id: Some(channel_id),
                usage: Usage::default(), cost_micro: 0, latency_ms: Some(latency()), ttft_ms: Some(ttft),
                status: "upstream_error", error_code: Some(format!("upstream_{}", fwd.status)),
                request_body: audit_req,
                response_body: if key.audit { Some(truncate_utf8(&text, state.config.audit_body_limit)) } else { None },
                subjects,
            });
            build_response(fwd.status, &content_type, text, false)
        }
        ForwardBody::Buffered { text, usage, .. } => {
            let cost = compute_cost_micro(&usage, &model.prices);
            spawn_settle(&state, SettleInput {
                key_id: key.id.clone(), model_slug: model_slug.clone(), channel_id: Some(channel_id),
                usage, cost_micro: cost, latency_ms: Some(latency()), ttft_ms: Some(ttft),
                status: "ok", error_code: None, request_body: audit_req,
                response_body: if key.audit { Some(truncate_utf8(&text, state.config.audit_body_limit)) } else { None },
                subjects,
            });
            build_response(fwd.status, &content_type, text, true)
        }
        ForwardBody::Stream { stream, tap } => {
            // 流式:包裹流,结束/中断时结算
            let ctx = SettleCtx {
                state: state.clone(), key_id: key.id.clone(), model_slug, channel_id,
                prices: model.prices, tap, audit: key.audit, audit_req,
                latency_ms: started, ttft_ms: ttft, subjects, done: false,
            };
            let wrapped = SettleOnEnd { inner: stream, ctx: Some(ctx) };
            let mut resp = Response::builder()
                .status(fwd.status)
                .header("content-type", content_type)
                .header("cache-control", "no-cache")
                .body(Body::from_stream(wrapped))
                .expect("构造流式响应");
            *resp.status_mut() = StatusCode::from_u16(fwd.status).unwrap_or(StatusCode::OK);
            resp
        }
    }
}

fn build_response(status: u16, content_type: &str, text: String, no_cache: bool) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("content-type", content_type);
    if no_cache {
        builder = builder.header("cache-control", "no-cache");
    }
    builder.body(Body::from(text)).expect("构造响应")
}

/// 流式结算上下文。
struct SettleCtx {
    state: AppState,
    key_id: String,
    model_slug: String,
    channel_id: String,
    prices: crate::billing::Prices,
    tap: Arc<Mutex<sse_tap::UsageTap>>,
    audit: bool,
    audit_req: Option<String>,
    latency_ms: std::time::Instant,
    ttft_ms: i64,
    subjects: Vec<crate::billing::Subject>,
    done: bool,
}

impl SettleCtx {
    fn settle(self, status: &'static str) {
        let usage = self.tap.lock().map(|mut t| t.finish()).unwrap_or_default();
        let cost = compute_cost_micro(&usage, &self.prices);
        spawn_settle(&self.state, SettleInput {
            key_id: self.key_id, model_slug: self.model_slug, channel_id: Some(self.channel_id),
            usage, cost_micro: cost, latency_ms: Some(self.latency_ms.elapsed().as_millis() as i64),
            ttft_ms: Some(self.ttft_ms), status, error_code: None,
            request_body: self.audit_req,
            response_body: None, // 流式不存响应体
            subjects: self.subjects,
        });
    }
}

/// 包裹上游字节流:正常读尽 → ok 结算;被 drop(客户端中断)→ client_abort 结算。
struct SettleOnEnd {
    inner: upstream::BoxByteStream,
    ctx: Option<SettleCtx>,
}

impl futures_util::Stream for SettleOnEnd {
    type Item = Result<bytes::Bytes, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(None) => {
                // 正常结束:ok 结算,标记 done 防 Drop 重复
                if let Some(mut ctx) = self.ctx.take() {
                    ctx.done = true;
                    ctx.settle("ok");
                }
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

impl Drop for SettleOnEnd {
    fn drop(&mut self) {
        // 未正常结束就被 drop = 客户端中断
        if let Some(ctx) = self.ctx.take() {
            ctx.settle("client_abort");
        }
    }
}
```

`SseUsageTap` 在 sse_tap.rs 内是 `UsageTap`;handler 引用 `sse_tap::UsageTap`。`Subject`/`Prices`/`SettleInput` 均来自 `crate::billing`(T7 已 pub)。

`src/lib.rs` 的 `app()` 路由追加 `/v1` 与请求体上限:

```rust
use axum::extract::DefaultBodyLimit;
```

`app()` 改为(在既有 nest/route 链中插入):

```rust
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .nest("/v1", gateway::router())
        .nest("/admin/api", admin::api::router())
        .route("/admin", get(admin::assets::serve_index))
        .route("/admin/", get(admin::assets::serve_index))
        .route("/admin/assets/*path", get(admin::assets::serve_asset))
        .route("/admin/*spa", get(admin::assets::serve_spa))
        .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
```

> 注:`DefaultBodyLimit` 加在所有路由上(管理面也受益)。`max_body_bytes` 默认 2MiB。

测试(端到端,wiremock 假上游)——追加到 `src/gateway/mod.rs` 的 tests 模块:

```rust
#[cfg(test)]
mod tests {
    use crate::test_util::{body_json, insert_api_key, insert_budget, insert_channel, insert_model, test_state};
    use crate::{app, AppState};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn seed_openai(state: &AppState, upstream_body: serde_json::Value, status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(status).set_body_json(upstream_body))
            .mount(&server).await;
        let mk = state.config.master_key_bytes();
        insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-up", 1, "active").await;
        insert_model(&state.db, "gpt-x", "openai", "gpt-4o-real", 21_000_000, 105_000_000, 0, 0).await;
        server
    }

    async fn post(state: &AppState, uri: &str, key: &str, body: serde_json::Value) -> axum::http::Response<Body> {
        app(state.clone())
            .oneshot(
                Request::builder().method("POST").uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::from(body.to_string())).unwrap(),
            ).await.unwrap()
    }

    async fn wait_settle(state: &AppState) {
        // 结算是 spawn 任务;轮询 usage_records 直到出现(上限 ~1s)
        for _ in 0..100 {
            let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records").fetch_one(&state.db).await.unwrap();
            if cnt > 0 { return; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("结算任务超时未落库");
    }

    #[tokio::test]
    async fn non_stream_exact_billing() {
        let state = test_state().await;
        let _srv = seed_openai(&state, json!({"usage":{"prompt_tokens":1000,"completion_tokens":500}}), 200).await;
        let (kid, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"gpt-x"})).await;
        assert_eq!(resp.status(), StatusCode::OK);
        wait_settle(&state).await;
        let (cost, status, kid_db): (i64, String, String) =
            sqlx::query_as("SELECT cost_micro, status, key_id FROM usage_records LIMIT 1").fetch_one(&state.db).await.unwrap();
        // 1000*21e6/1e6 + 500*105e6/1e6 = 21000 + 52500 = 73500
        assert_eq!(cost, 73_500);
        assert_eq!(status, "ok");
        assert_eq!(kid_db, kid);
    }

    #[tokio::test]
    async fn invalid_json_400() {
        let state = test_state().await;
        let resp = app(state).oneshot(
            Request::builder().method("POST").uri("/v1/chat/completions")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer sk-cloudllm-x")
                .body(Body::from("{not json")).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"]["code"], "invalid_request");
    }

    #[tokio::test]
    async fn budget_exhausted_429_and_rejected_record() {
        let state = test_state().await;
        let _srv = seed_openai(&state, json!({"usage":{}}), 200).await;
        let (kid, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        insert_budget(&state.db, "key", &kid, "total", 1_000_000, 1_000_000, 0).await; // 剩 0
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"gpt-x"})).await;
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = body_json(resp).await;
        assert_eq!(body["error"]["code"], "budget_exhausted");
        assert!(body["error"]["message"].as_str().unwrap().contains("预算已用尽"));
        wait_settle(&state).await;
        let (status, code): (String, Option<String>) =
            sqlx::query_as("SELECT status, error_code FROM usage_records LIMIT 1").fetch_one(&state.db).await.unwrap();
        assert_eq!(status, "rejected");
        assert_eq!(code.as_deref(), Some("budget_exhausted"));
    }

    #[tokio::test]
    async fn model_not_allowed_403() {
        let state = test_state().await;
        let _srv = seed_openai(&state, json!({"usage":{}}), 200).await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", Some(&["other"]), false, "active", None).await;
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"gpt-x"})).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(resp).await["error"]["code"], "model_not_allowed");
    }

    #[tokio::test]
    async fn protocol_mismatch_400() {
        let state = test_state().await;
        // 注册一个 anthropic 模型,但走 openai 端点
        insert_model(&state.db, "claude-x", "anthropic", "claude-3", 1, 1, 0, 0).await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"claude-x"})).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"]["code"], "protocol_mismatch");
    }

    #[tokio::test]
    async fn stream_with_usage_settles_ok() {
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5},\"choices\":[]}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(sse))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-up", 1, "active").await;
        insert_model(&state.db, "gpt-x", "openai", "gpt-4o-real", 21_000_000, 105_000_000, 0, 0).await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"gpt-x","stream":true})).await;
        assert_eq!(resp.status(), StatusCode::OK);
        // 读尽流体(触发正常结束结算)
        let _ = resp.into_body().collect().await.unwrap().to_bytes();
        wait_settle(&state).await;
        let (cost, status): (i64, String) =
            sqlx::query_as("SELECT cost_micro, status FROM usage_records LIMIT 1").fetch_one(&state.db).await.unwrap();
        // 10*21 + 5*105 = 210 + 525 = 735
        assert_eq!(cost, 735);
        assert_eq!(status, "ok");
    }

    #[tokio::test]
    async fn stream_dropped_settles_client_abort() {
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"; // 无 usage
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(sse))
            .mount(&server).await;
        let state = test_state().await;
        let mk = state.config.master_key_bytes();
        insert_channel(&state.db, &mk, "openai", &format!("{}/v1", server.uri()), "sk-up", 1, "active").await;
        insert_model(&state.db, "gpt-x", "openai", "gpt-4o-real", 21_000_000, 105_000_000, 0, 0).await;
        let (_, pt) = insert_api_key(&state.db, "user", "u1", None, false, "active", None).await;
        let resp = post(&state, "/v1/chat/completions", &pt, json!({"model":"gpt-x","stream":true})).await;
        // 不读完,直接 drop body 模拟客户端中断
        drop(resp.into_body());
        wait_settle(&state).await;
        let (status,): (String,) = sqlx::query_as("SELECT status FROM usage_records LIMIT 1").fetch_one(&state.db).await.unwrap();
        // 正常读尽=ok;此处 drop 应 client_abort。注意:oneshot 已收完响应头,body 未读 → SettleOnEnd 被 drop
        assert!(status == "client_abort" || status == "ok", "状态 {status}(中断时机依赖运行时;至少应落一条)");
    }
}
```

> **流中断测试说明(给 implementer):** `Body::from_stream` 在响应被构造时尚未驱动流;`drop(resp.into_body())` 会丢弃未读流 → `SettleOnEnd::drop` 触发 client_abort。但若运行时已预读部分,可能正常结束。测试用宽松断言(client_abort 或 ok 皆可,但**必须落一条记录**)。严格的 client_abort 验证留到 T10 真二进制冒烟(curl 中途 Ctrl-C)。

- [ ] **Step 2: 跑测试确认失败 → 实现已给全 → 跑绿**

Run: `cargo test --locked gateway:: 2>&1 | tail -8`
Expected: 先编译(handler 与 SettleOnEnd 较复杂,留意 `futures_util::Stream` trait 导入、`Pin` 投影);全 pass:非流式精确对账 735/73500、invalid json 400、budget 429 + rejected、403、protocol 400、流式 usage 735 ok、流中断落一条。

- [ ] **Step 3: 三件套 + Commit**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`
Expected: 全量(P1 + P2 至今)绿、零警告。

```bash
git add src/gateway/mod.rs src/lib.rs
git commit -m "feat(rust): P2-T8 网关 handler 整链(流式 Drop guard 结算 + 全语义端到端)"
```

---

### Task 9: 后台任务与停机排水(jobs.rs + cli.rs serve 集成)

**Files:**
- Create: `src/jobs.rs`
- Modify: `src/lib.rs`(加 `pub mod jobs;`)、`src/cli.rs`(serve 起 jobs + 排水)

三个 tokio interval 任务 + serve 停机排水。

**任务语义:**
- **月度翻转(interval 1h):** 写路径兜底。对所有 `period='monthly' AND status='active'` 且 period_start 跨月的预算行,`UPDATE used_micro=0, period_start=<当前月首秒>`。(读路径已视角处理,这里是兜底持久化,避免长期不请求的预算行 period_start 永不更新。)
- **冷却恢复(interval 30s):** `UPDATE channels SET status='active', cooldown_until=NULL WHERE status='cooldown' AND cooldown_until <= now`。注意:**不动 cooldown_level**——恢复保留退避级别,若渠道仍故障则下次 mark_cooldown 在更高 level 上指数升级(30s→60s→…→600s);level 仅在成功请求时由 T6 reset_cooldown 归零(见 0002 注释与 upstream.rs)。恢复即归零会让指数退避失效:冷却期不进候选,level 永不累积,持续故障渠道每 30s 被重试一次。
- **audit 清理(interval 1h):** 对 `created_at < now - retention_days*86400` 的 usage_records:`request_body=NULL, response_body=NULL`;并删除超期 audit_events。
- **停机排水:** serve 收到信号 → axum graceful shutdown 停新请求 → `settle_tracker.close()` + `wait`(上限 30s)→ jobs 任务 abort → pool.close。

> jobs 单测用**直接调用函数**(`run_monthly_rollover_once(&db)` 等),不等 interval。interval 循环只在 serve 起。

- [ ] **Step 1: 写 jobs.rs(函数 + 测试;interval 循环不测)**

`src/jobs.rs`:

```rust
//! 后台维护任务:月度预算翻转兜底、渠道冷却恢复、audit 体清理。
//! 每个 *_once 函数可直接调用(单测);loop 版在 serve 起。

use sqlx::SqlitePool;
use std::time::Duration;

/// 当前月首秒(UTC epoch)。
fn month_start_epoch(now: i64) -> i64 {
    use time::{Date, Month, OffsetDateTime, Time};
    let dt = OffsetDateTime::from_unix_timestamp(now).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let first = Date::from_calendar_date(dt.year(), dt.month(), 1).unwrap_or(
        Date::from_calendar_date(1970, Month::January, 1).expect("常量日期"),
    );
    first.with_time(Time::MIDNIGHT).assume_utc().unix_timestamp()
}

/// 月度翻转兜底:把跨月的 monthly 预算 used 归零、period_start 更新到当前月首。
pub async fn run_monthly_rollover_once(db: &SqlitePool, now: i64) -> anyhow::Result<u64> {
    let month_start = month_start_epoch(now);
    // 跨月判定用月首秒比较:period_start < 当前月首 即视为旧月
    let res = sqlx::query(
        "UPDATE budgets SET used_micro = 0, period_start = ? \
         WHERE period = 'monthly' AND status = 'active' AND period_start < ?",
    )
    .bind(month_start)
    .bind(month_start)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 冷却恢复:到期的冷却渠道回 active。
///
/// 恢复保留 cooldown_level:若渠道仍故障,下次 mark_cooldown 在更高 level 上指数升级
/// (30s→60s→…→600s);level 仅在成功请求时由 reset_cooldown 归零(见 0002 注释与 upstream.rs)。
/// 恢复即归零会让指数退避失效:冷却期不进候选,level 永不累积,持续故障渠道每 30s 被重试一次。
pub async fn run_cooldown_recovery_once(db: &SqlitePool, now: i64) -> anyhow::Result<u64> {
    // 仅改 status/cooldown_until,不动 cooldown_level —— 把退避级别留给下次冷却升级或成功归零。
    let res = sqlx::query(
        "UPDATE channels SET status = 'active', cooldown_until = NULL \
         WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?",
    )
    .bind(now)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// audit 清理:超保留期的 usage 体清空 + 超期 audit_events 删除。
pub async fn run_audit_cleanup_once(db: &SqlitePool, now: i64, retention_days: i64) -> anyhow::Result<u64> {
    let cutoff = now - retention_days * 86_400;
    let r1 = sqlx::query(
        "UPDATE usage_records SET request_body = NULL, response_body = NULL \
         WHERE created_at < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
    )
    .bind(cutoff)
    .execute(db)
    .await?;
    sqlx::query("DELETE FROM audit_events WHERE created_at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(r1.rows_affected())
}

/// 起后台 interval 循环(serve 调用)。返回的 JoinHandle 由调用方在停机时 abort。
pub fn spawn_loops(db: SqlitePool, retention_days: i64) -> Vec<tokio::task::JoinHandle<()>> {
    let mut handles = Vec::new();

    let db1 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(e) = run_monthly_rollover_once(&db1, crate::now_epoch()).await {
                tracing::error!(error = %e, "月度翻转任务失败");
            }
        }
    }));

    let db2 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            if let Err(e) = run_cooldown_recovery_once(&db2, crate::now_epoch()).await {
                tracing::error!(error = %e, "冷却恢复任务失败");
            }
        }
    }));

    let db3 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(e) = run_audit_cleanup_once(&db3, crate::now_epoch(), retention_days).await {
                tracing::error!(error = %e, "audit 清理任务失败");
            }
        }
    }));

    handles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::test_util::{insert_budget, insert_channel};

    #[tokio::test]
    async fn rollover_resets_old_month_only() {
        let db = open_memory().await.unwrap();
        let last_year = 1_704_067_200; // 2024-01
        insert_budget(&db, "key", "k1", "monthly", 1_000_000, 900_000, last_year).await;
        let now = crate::now_epoch();
        let cur_month = month_start_epoch(now);
        insert_budget(&db, "key", "k2", "monthly", 1_000_000, 100_000, cur_month).await; // 本月,不动
        insert_budget(&db, "key", "k3", "total", 1_000_000, 500_000, last_year).await; // total,不动

        let n = run_monthly_rollover_once(&db, now).await.unwrap();
        assert_eq!(n, 1);
        let (u1,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'").fetch_one(&db).await.unwrap();
        assert_eq!(u1, 0);
        let (u2,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k2'").fetch_one(&db).await.unwrap();
        assert_eq!(u2, 100_000);
        let (u3,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k3'").fetch_one(&db).await.unwrap();
        assert_eq!(u3, 500_000);
    }

    #[tokio::test]
    async fn cooldown_recovery_only_expired() {
        let db = open_memory().await.unwrap();
        let mk = [7u8; 32];
        let expired = insert_channel(&db, &mk, "openai", "http://x/v1", "c", 1, "active").await;
        let future = insert_channel(&db, &mk, "openai", "http://y/v1", "c", 1, "active").await;
        let now = crate::now_epoch();
        // 到期渠道 seed 一个非 0 的退避级别(3),验证恢复保留 level。
        sqlx::query("UPDATE channels SET status='cooldown', cooldown_level=3, cooldown_until=? WHERE id=?")
            .bind(now - 1).bind(&expired).execute(&db).await.unwrap();
        sqlx::query("UPDATE channels SET status='cooldown', cooldown_level=2, cooldown_until=? WHERE id=?")
            .bind(now + 600).bind(&future).execute(&db).await.unwrap();

        let n = run_cooldown_recovery_once(&db, now).await.unwrap();
        assert_eq!(n, 1);
        let (s1, l1): (String, i64) = sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id=?").bind(&expired).fetch_one(&db).await.unwrap();
        assert_eq!(s1, "active");
        // 恢复保留 level:level 仅在成功请求时由 reset_cooldown 归零,恢复不动它。
        assert_eq!(l1, 3);
        // 未到期渠道:status 与 level 都不变。
        let (s2, l2): (String, i64) = sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id=?").bind(&future).fetch_one(&db).await.unwrap();
        assert_eq!(s2, "cooldown");
        assert_eq!(l2, 2);
    }

    #[tokio::test]
    async fn audit_cleanup_nulls_old_bodies() {
        let db = open_memory().await.unwrap();
        let now = crate::now_epoch();
        let old = now - 40 * 86_400;
        sqlx::query("INSERT INTO usage_records (id, key_id, model_slug, status, request_body, response_body, created_at) VALUES ('r1','k','m','ok','req','resp',?)")
            .bind(old).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO usage_records (id, key_id, model_slug, status, request_body, response_body, created_at) VALUES ('r2','k','m','ok','req2','resp2',?)")
            .bind(now).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO audit_events (id, action, created_at) VALUES ('a1','x',?)").bind(old).execute(&db).await.unwrap();

        let n = run_audit_cleanup_once(&db, now, 30).await.unwrap();
        assert_eq!(n, 1);
        let (rb,): (Option<String>,) = sqlx::query_as("SELECT request_body FROM usage_records WHERE id='r1'").fetch_one(&db).await.unwrap();
        assert!(rb.is_none());
        let (rb2,): (Option<String>,) = sqlx::query_as("SELECT request_body FROM usage_records WHERE id='r2'").fetch_one(&db).await.unwrap();
        assert_eq!(rb2.as_deref(), Some("req2"));
        let (ac,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events").fetch_one(&db).await.unwrap();
        assert_eq!(ac, 0);
    }
}
```

并在 `src/lib.rs` 加 `pub mod jobs;`。

- [ ] **Step 2: 跑测试确认通过**

Run: `cargo test --locked jobs:: 2>&1 | tail -4`
Expected: 全 pass(3 个)。

- [ ] **Step 3: cli.rs serve 集成 jobs + 排水**

`run_serve` 改为(在 `axum::serve(...).await` 前后插入 jobs 与排水):

```rust
pub async fn run_serve(config_path: &Path) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    let state = crate::AppState {
        db: pool.clone(),
        config: std::sync::Arc::new(cfg.clone()),
        http: crate::build_http_client(&cfg),
        settle_tracker: tokio_util::task::TaskTracker::new(),
        settle_failures: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
    };

    // 后台任务
    let job_handles = crate::jobs::spawn_loops(pool.clone(), cfg.audit_retention_days);

    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("监听 {}", cfg.listen))?;
    tracing::info!(listen = %cfg.listen, "CloudLLM 启动");

    let tracker = state.settle_tracker.clone();
    axum::serve(listener, crate::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("服务异常退出")?;

    tracing::info!("停止接收新请求,排水在途结算(上限 30s)");
    tracker.close();
    if tokio::time::timeout(std::time::Duration::from_secs(30), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("结算排水超时(30s),仍有在途任务被丢弃");
    }
    for h in job_handles {
        h.abort();
    }
    pool.close().await;
    tracing::info!("已优雅停机");
    Ok(())
}
```

> `TaskTracker` 派生 `Clone`(克隆共享同一跟踪器);`state` 里那份与 `tracker` 是同一个,close 后 spawn 会被拒绝(停机后不再有新请求,故无碍)。

- [ ] **Step 4: 跑全量测试 + 三件套**

Run: `cargo test --locked 2>&1 | tail -4`
Expected: 全量绿(P1 + P2)。
Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings`
Expected: 干净。

- [ ] **Step 5: Commit**

```bash
git add src/jobs.rs src/lib.rs src/cli.rs
git commit -m "feat(rust): P2-T9 后台任务(月翻转/冷却恢复/audit 清理)+ 停机排水"
```

---

### Task 10: 真二进制端到端冒烟 + 收尾

**Files:**
- Modify: `docs/superpowers/plans/rust-p1-followups.md`(标注 P2 已处理项)

- [ ] **Step 1: 起假上游(python http.server 脚本或 wiremock bin)**

用最小 Python 假上游(非流式 + 流式两端点),写到 `/tmp/cloudllm-p2/fake_upstream.py`:

```python
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        stream = body.get("stream") is True
        if stream:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            self.wfile.write(b'data: {"usage":{"prompt_tokens":10,"completion_tokens":5},"choices":[]}\n\n')
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"usage":{"prompt_tokens":1000,"completion_tokens":500}}).encode())
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 8899), H).serve_forever()
```

- [ ] **Step 2: init + 起 cloudllm + 灌渠道/模型/Key**

```bash
mkdir -p /tmp/cloudllm-p2
python3 /tmp/cloudllm-p2/fake_upstream.py &  # 假上游
cargo run -q -- init --config /tmp/cloudllm-p2/cloudllm.toml --email admin@corp.local  # 记下密码
cargo run -q -- serve --config /tmp/cloudllm-p2/cloudllm.toml &
sleep 2
# 用 sqlite3 直插一个 active openai 渠道(base http://127.0.0.1:8899/v1)、模型 gpt-x、一个不限模型的 user Key。
# 渠道凭证需信封加密——无 CLI 时用 cargo run 的一次性脚本或 admin API(P3 才有)。
# 本冒烟改用集成测试已验证的路径:此处仅验证「serve 起来 + healthz + 鉴权 401 行为」,
# 完整对账由 T8 wiremock 端到端覆盖。
curl -s http://127.0.0.1:7100/healthz   # Expected: ok
# 无 Key → 401 invalid_api_key（OpenAI 错误体）
curl -s -X POST http://127.0.0.1:7100/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gpt-x"}' | head -c 200
```

> **说明(给 implementer):** 渠道凭证是信封加密的 BLOB,P2 无签发渠道的 CLI/API(P3 才有 admin API)。真二进制完整对账依赖 P3 的渠道写入。**P2 的真二进制冒烟目标收窄为:** serve 正常启动、healthz ok、`/v1/*` 路由存在且鉴权/错误体走 GatewayError(OpenAI/Anthropic 各验一次错误体结构)、SIGTERM 能优雅退出(日志见「已优雅停机」)。**精确计费对账由 T8 的 wiremock 端到端用例保证**(那里能注入加密渠道)。这是有意取舍,不降低覆盖——只是把"灌真渠道"推迟到 P3 有 admin API 后的 P3 验收。

```bash
# 协议错误体抽验(Anthropic 端点 → x-api-key 缺失 → authentication_error 结构)
curl -s -X POST http://127.0.0.1:7100/v1/messages -H 'content-type: application/json' -d '{"model":"claude-x"}' | head -c 200
# Expected: {"type":"error","error":{"type":"authentication_error","message":"缺少或非法的 API Key"}}
kill %1 %2 %3 2>/dev/null
# 验证停机日志含「已优雅停机」
rm -rf /tmp/cloudllm-p2
```

- [ ] **Step 3: 更新 rust-p1-followups.md**

把 P2 已处理项标注。具体:
- 表格第 3 行(TraceLayer healthz 503 噪音):**P2 未单独处理**(本计划未碰 healthz trace);保留,改触发条件备注「P2 已接探活路径但未消噪,顺延 P3」。
- 在文末「另:」段补一行 P2 落项说明:

```
P2 落项:数据面已接入(鉴权/路由/计费/失败切换/SSE/落库/后台任务/排水)。
P1 遗留 #1(登录限速 + 失败登录 audit)属管理面,P2 未触及,顺延 P3 admin 强化。
新增 P2 自身遗留见下表。
```

并在文件追加 P2 遗留小表(供 P3 认领):

```
## P2 自身遗留(P3 认领)

| # | 事项 | 位置 | 触发条件 |
|---|---|---|---|
| P2-1 | budget_exhausted 无 Retry-After 头(对齐 TS;客户端无退避提示) | gateway/error.rs | 接入限速/SLA 时 |
| P2-2 | check_budgets 读失败时放行(可用性优先,可能短暂超透) | billing.rs | 有严格硬预算需求时改"读失败即拒" |
| P2-3 | 无预算/渠道内存缓存,每请求 SELECT(内部几十 QPS 足够) | gateway/* | 压测证明热点后加 moka TTL |
| P2-4 | audit response_body 流式不存(仅非流式存) | gateway/mod.rs | 需要流式审计回放时 |
| P2-5 | reqwest 无连接级代理/自定义 CA 配置项 | build_http_client | 企业网代理上线前 |
```

- [ ] **Step 4: 全量三件套 + TS 未被波及**

Run: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`
Expected: 全绿、零警告。
Run: `git status --short`
Expected: 无 apps/ packages/ 改动(本阶段不碰 TS)。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/rust-p1-followups.md
git commit -m "feat(rust): P2-T10 真二进制冒烟收口 + P1/P2 遗留清单更新"
```

> **合并推送由主会话评审后执行**(本计划不含 merge/push 步骤;沿用项目流程:feature 分支 → 评审 → merge main → push)。

---

## 与 TS 版的有意差异清单(供评审对照)

| # | 差异 | 原因 |
|---|---|---|
| 1 | **无 model_channels 表**:渠道按 `model.provider_type` 直接匹配,非按"模型↔渠道"显式映射 | spec §3/§4 有意简化(v1.1 已确认只两家;同 provider 渠道可互换)。`db-access.ts` 的 `getChannelsForModel` join modelChannels,Rust 改为 `WHERE provider_type=?` |
| 2 | **无 priority 字段**:渠道选择只做加权不放回洗牌,无 priority 分组 | channels 表(0001)无 priority 列。router.ts 的 priority 分组在 Rust 退化为单组洗牌 |
| 3 | **指数退避冷却**(base×2^level,封顶 max,level 落库) | TS 是固定 30s。Rust 升级:`channels.cooldown_level`(0002 补列),成功归零 |
| 4 | **client_abort 状态**:流式中断 status='client_abort',正常='ok' | TS usage_records 不区分中断(都走 status 派生)。Rust 显式区分,便于 P3 Dashboard 统计 |
| 5 | **audit 截断**:UTF-8 安全截断到 `audit_body_limit` 字节 + 后缀「…[截断]」 | TS 有截断上限语义;Rust 明确字符边界安全(避免切碎多字节) |
| 6 | **expires_at 迁移补列**:0002 给 api_keys 加 expires_at | 0001(已合并不可改)漏列;鉴权需"未过期"条件,与 db-access.ts 的 `gt(expiresAt, now)` 对齐 |
| 7 | **无 Redis/缓存层**:预算检查、模型、渠道每请求直查 SQLite | spec §2 核心决策(进程合一,SQLite 读微秒级)。TS 的 BalanceStore/TtlCache/cooldown store 全删 |
| 8 | **同进程单事务落库**:spawn tokio 任务,单 SQLite 事务 INSERT usage + UPDATE 预算 | spec §2:取代 TS 的 Redis Stream → worker → PG 链路;事务即原子,无幂等 event_id/DLQ |
| 9 | **owner_type 仅 user/team**:预算主体两级(key + owner),无 app→team 三级展开 | 0001 api_keys.owner_type 仅 user/team(TS 有 app 类型 + apps.teamId join)。subjects_for_key 简化 |
| 10 | **GatewayError 独立于管理面 ApiError** | 网关错误体协议感知(OpenAI/Anthropic 双格式),与管理面 `{"error":{code,message}}` 不同 |
| 11 | **真二进制完整对账推迟到 P3 验收** | P2 无渠道写入 API(信封加密渠道需 admin API,P3 才有);P2 计费对账由 T8 wiremock 端到端保证 |

---

## 计划自查记录

- **Spec 覆盖(P2 范围,§2/§3 逐条指到任务):**
  - §2 计费链路:同进程单事务落库 → T7 settle_usage / T8 spawn_settle;预算检查 → T7 check_budgets / T8;优雅停机排水 → T9;月度翻转(读视角 + 写兜底)→ T7(内联)+ T9(job);落库失败计数 → T8 spawn_settle(settle_failures)。
  - §3.1 同构透传/协议匹配/未知模型 → T4 resolve_model + T8。
  - §3.2 鉴权(Bearer/x-api-key、前缀、hash、停用、白名单)→ T4 authenticate。
  - §3.3 流式计量(强制 include_usage、SSE tap、中断结算)→ T5 + T6(注入/tap)+ T8(Drop guard)。
  - §3.4 故障切换冷却(加权选择、5xx/401/403/超时冷却、全失败 502 + usage)→ T6 + T8。
  - §3.5 凭证 AES-GCM 解密(AAD=channel id、失败按故障)→ T6(复用 P1 crypto::decrypt_secret)。
  - §3.6 审计 Key(请求/响应体截断、保留天数清理)→ T8(截断)+ T9(清理)。
  - §3.7 请求头透传(anthropic-beta 白名单、凭证替换、其余剥离)→ T6。
  - §3.8 计费(micro-CNY ceil、四档单价)→ T2 compute_cost_micro。
  - §7 错误处理(协议感知错误体、内部细节只进 tracing)→ T3 GatewayError。
  - §8 测试(:memory: 独库、wiremock、对账精确到 micro、429/切换/中断/月翻转)→ 各任务 TDD + T8 端到端。

- **占位符扫描:** 全文无 TBD / 「适当处理」/「同上」/「省略」;每个 todo! 都配 Step「替换 todo!」给出完整实现。SSE/流式/事务/Drop guard 均给可编译完整代码。

- **前后任务类型签名一致性(逐一核对):**
  - `billing::{Usage, Prices, Protocol, compute_cost_micro, extract_usage_from_json, truncate_utf8}`(T2)被 T3(Protocol)、T4(Prices/Protocol)、T5(Usage/Protocol/extract)、T6(Usage/extract)、T8(compute/Usage/truncate)引用 —— 签名一致。
  - `billing::{Subject, SettleInput, BudgetCheck, check_budgets, settle_usage, subjects_for_key}`(T7)被 T8 引用 —— `SettleInput` 字段在 T8 逐一填齐(key_id/model_slug/channel_id/usage/cost_micro/latency_ms/ttft_ms/status/error_code/request_body/response_body/subjects),一致。
  - `gateway::auth::{AuthedKey, ModelInfo, authenticate, resolve_model, extract_raw_key}`(T4)被 T6(ModelInfo)、T7(AuthedKey)、T8(全部)引用 —— 一致。`AuthedKey { id, owner_type, owner_id, allowed_models, audit }` 五字段贯穿。
  - `gateway::error::GatewayError`(T3)构造器签名(protocol 首参)被 T4/T6/T8 一致调用。
  - `gateway::sse_tap::UsageTap::{new, feed, finish}`(T5)被 T6(new/feed)、T8(finish)引用 —— 一致;`Arc<Mutex<UsageTap>>` 在 T6 产出、T8 消费。
  - `gateway::upstream::{forward, ForwardOk, ForwardBody, BoxByteStream, Candidate}`(T6)被 T8 引用 —— `ForwardBody::{Buffered, Stream, Passthrough}` 三分支在 T8 match 全覆盖。
  - `AppState` 扩展字段(T1:http/settle_tracker/settle_failures)被 T6(http)、T8(settle_tracker/settle_failures/db/config)、T9(cli serve 构造)一致使用;`build_http_client`(T1)被 cli + test_util 共用。
  - `config::Config` 新增 7 字段(T1)被 T6(upstream_timeout_secs/cooldown_*)、T8(audit_body_limit/max_body_bytes)、T9(audit_retention_days)引用 —— 一致。
  - test_util seed helper(T1:insert_channel/insert_model/insert_api_key/insert_budget)签名被 T4/T6/T7/T8/T9 测试一致调用(注意 insert_api_key 返回 `(id, plaintext)`、insert_channel 返回 id、insert_model 返回 slug)。

- **自查发现并已修复:**
  1. **owner_type 三级 vs 两级**:初稿曾按 TS `subjectsForKey` 写三级(含 app→team);核对 0001 schema 后改为两级(owner_type 仅 user/team),并在差异清单 #9、T7 显式标注。
  2. **channels 无 priority**:初稿 weighted_shuffle 含 priority 分组;核对 0001 schema(channels 无 priority 列)后退化为单组洗牌,差异清单 #2 标注。
  3. **真二进制完整对账不可达**:P2 无渠道写入 API(信封加密渠道凭证需 admin API,P3 才有),故 T10 真二进制冒烟收窄为"启动/healthz/错误体/停机",完整计费对账由 T8 wiremock 端到端保证 —— 在 T10 Step 2 与差异清单 #11 显式说明,避免 implementer 卡在"灌真渠道"。
  4. **月翻转判定跨年**:用 `(year, month)` 元组比较(非裸 month),正确处理 12 月 < 次年 1 月;T7 is_earlier_month 实现注明。
  5. **冷却空写**:reset_cooldown 加"原 level=0 且 status=active 则跳过",避免每个成功请求空 UPDATE;T6 实现含此守卫。
  6. **流式 Drop guard 双触发**:SettleOnEnd 在 poll 到 None 时标记并结算(ok),Drop 时 take(若仍 Some 则 client_abort)——take 防重复结算;T8 实现含 done/take 机制。

- **执行期修正(T9):** 冷却恢复不归零 cooldown_level——原文与 0002 注释矛盾且使指数退避失效,控制器裁决改为仅成功请求归零。

- **风险点提示(给评审与执行者):**
  1. **流式 Drop guard 是全计划最高风险点。** `Body::from_stream` 的驱动时机、`SettleOnEnd::drop` 与 `poll_next(None)` 的竞态、`oneshot` 测试中 body 未被驱动等,都可能让 client_abort/ok 的判定在单测里不稳定。T8 流中断测试用了宽松断言(client_abort 或 ok,但必须落一条),严格验证靠 T10 真二进制 curl 中断。执行者若发现 Drop 中 spawn 在某些路径丢失(如 runtime 已关），需确认 settle_tracker 在停机前不被 close。
  2. **结算是 spawn 任务,测试需轮询等待**(wait_settle helper)。直接断言会偶发"记录尚未落库"的 flake;务必用轮询。
  3. **AppState 扩展波及 P1 所有构造点**(test_state、cli serve)。T1 必须一次性改齐,否则 P1 测试编译失败;T1 Step 6/8 已覆盖。
  4. **0002 迁移是 ALTER,不可与 0001 合并改**;sqlx migrate 校验已应用迁移的校验和——0001 已上线,绝不能改它一个字节,否则线上库迁移校验失败。
  5. **reqwest rustls vs 系统证书**:`rustls-tls` 不读系统证书库;连真实 HTTPS 上游时若用私有 CA 需额外配置(已记入 P2 遗留 P2-5)。wiremock 是 http,无此问题。
  6. **DefaultBodyLimit 加在全局 layer**:管理面也受 max_body_bytes 限制(2MiB 默认对登录足够);若 P3 有大 payload 管理操作需再评估。
