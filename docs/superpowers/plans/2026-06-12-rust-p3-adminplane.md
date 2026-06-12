# CloudLLM v2 Rust 重写 — P3 管理面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 骨架 + P2 数据面之上交付完整管理面:users / teams / keys / channels / models / budgets / reports / dashboard / audit 的全部 REST API(会话鉴权 + 管理操作审计),admin-ui 全部页面(暗色科技感,中文界面),Key 签发一步带预算并返回明文 + 接入说明 Markdown(buildHandout 移植)。同时认领 P1/P2 遗留:登录限速(#1)、cookie Secure(#2)、healthz trace 噪音(#3)、静态资产 charset(#4)、Guard me 缓存(#6),以及网关 Anthropic 协议 Bearer 回退(handout 兼容)。P3 结束时:真二进制起服务,浏览器内完成「建用户 → 建渠道/模型 → 签 Key 带预算 → 复制接入说明 → 打一发请求 → 报表/审计可见」全闭环。

**Architecture:** 沿用单 crate。管理面 REST 按资源拆文件:`src/admin/{users,teams,keys,channels,models,budgets,reports,dashboard,audit_api,handout}.rs`,`admin/api.rs` 只保留 login/logout/me 与 router 汇总;新增根模块 `src/audit.rs`(管理操作审计 best-effort 落 `audit_events`)。**无 schema 迁移**(audit_events 表 P1 已建,P3 零新列)。UI 侧:AuthContext 上提 me 缓存,`lib/api.ts` 扩全量资源方法,`components/ui.tsx` 共享组件库,react-router 挂满 10 页。

**Tech Stack:** 后端零新依赖(axum 0.7 / sqlx 0.8 runtime API / serde / uuid / time 既有);前端零新 npm 依赖(React 18 + react-router 6 + Tailwind 3 既有,SVG 图表手写)。

**执行约束(用户要求):** 所有写代码的 subagent 一律 `model: "opus"`;沿用 implementer + spec-review + quality-review 三角流程。UI 任务 implementer 加载 frontend-design 技能。

---

## 全局约定(每个任务都必须遵守 —— 违反即返工)

1. **sqlx 一律运行时 API**(`sqlx::query` / `query_as` + `bind`),禁 `query!` 宏。
2. **axum 固定 0.7**;路径参数 `/:id`,通配 `/*path`;extractor 写法同 P1 `AdminUser`。
3. **金额 i64 micro-CNY、时间 i64 epoch 秒**;API 出入金额:**入参收 CNY 字符串**(`"100"`/`"100.50"`,≤6 位小数,`billing::parse_cny_to_micro` 解析),**出参回 `*_micro` 整数**(UI 用 `format.ts` 渲染 ¥)。月初一律 `jobs::month_start_epoch(now)`(T1 提公),禁止任何第二份月初实现。
4. **管理面错误一律 `ApiError`**;响应 `{"error":{"code","message"}}`。新增语义:403 `forbidden`、409 `conflict`、429 `too_many_attempts`(T1/T2 加构造器)。校验失败文案中文、具体(沿用 TS 文案,本计划各任务已写死)。
5. **每个写操作(POST/PATCH/DELETE)成功后写 `audit_events`**:`audit::record(...)` best-effort(失败仅 `tracing::warn`,不影响主响应)。action 字符串用本计划 T1 表格列出的值,不得自造。**detail JSON 绝不含:密码、Key 明文/hash、渠道凭证。**
6. **渠道凭证只写不读**:任何 GET 响应不得出现 `credential` 相关字段;明文仅在 handler 栈帧存活。
7. **每任务 TDD**:先写测试 → 跑红(给预期失败输出)→ 最小实现 → 跑绿 → 收尾三件套 `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`。UI 任务收尾:`cd admin-ui && npm run build`(tsc --noEmit + vite build)。
8. **注释/错误文案/commit 中文**;commit 格式 `feat(rust): P3-TN 描述` / `fix(rust): P3-TN 评审修复——描述`。
9. UI 视觉用既有 token(`bg/panel/line/neon/violet/ink/dim`、`shadow-glow`、`font-mono`),数字与 Key 一律 `font-mono`;新页面不得引入新颜色常量,渐变只用 neon→violet。

## 与 P1/P2 既有签名的硬对齐(已逐一核对源码)

- `AppState { db, config: Arc<Config>, http, settle_tracker, settle_failures: Arc<AtomicU64> }`(lib.rs:25;T2 追加 `login_limiter`)
- `ApiError { status, code, message, detail }`,构造器 `unauthorized/login_failed/not_found/bad_request/internal`(error.rs)
- `AdminUser { id: String, email: String }` extractor,回查 status/role(auth.rs:52)
- `session_cookie(value, max_age_secs) -> Cookie<'static>`(admin/api.rs:40;T1 改签名接 secure)
- `crypto::generate_api_key() -> GeneratedApiKey { plaintext, key_hash, key_prefix }`、`hash_password`、`encrypt_secret(plaintext, &[u8;32], aad) -> Result<Vec<u8>>`、`API_KEY_PREFIX = "sk-cloudllm-"`
- `config::Config` 字段见 config.rs:9(T1 追加 `cookie_secure: bool`,默认 false)、`master_key_bytes() -> [u8;32]`
- `jobs::month_start_epoch(now: i64) -> i64`(现私有,T1 提公;UTC、time crate)
- `gateway::auth::extract_raw_key(protocol, headers)`(T1 改:Anthropic 加 Bearer 回退)
- `billing::Protocol { Openai, Anthropic }`
- `test_util`:`test_state/test_config/json_request/body_json/first_cookie/insert_user/insert_channel/insert_model/insert_api_key/insert_budget`、`TEST_MASTER_KEY`(T1 追加 `admin_session`)
- schema:见 `migrations/0001_init.sql` + `0002_gateway.sql`。注意:`team_members.role` CHECK 仅 `owner/member`(TS 的 admin 角色不存在);`api_keys.status` 仅 `active/disabled`(revoke = disabled);`budgets.subject_type` 仅 `key/user/team`(TS 的 app 不存在);channels 自带 `provider_type/weight`(TS 的 providers/model_channels 两表已并入,**不得照抄 TS 查询**)。
- admin-ui:api 封装见 `admin-ui/src/lib/api.ts`(`request<T>` 抛 `ApiError(status, message)`);token 见 tailwind.config;`vite.config.ts` base `/admin/`、dev proxy `/admin/api → :7100`。

## 与 TS 版的有意分歧(评审依据,不是 bug)

| # | 分歧 | 理由 |
|---|---|---|
| 1 | 创建用户可选 role(admin/user,默认 user) | TS v1.1 固定 admin + 二步降级;一步到位等价且少一次操作。login 仍仅 admin。 |
| 2 | team_members 角色仅 owner/member | 对齐 v2 schema CHECK;TS 的 admin 角色从未在 UI 使用。 |
| 3 | revoke 即 `status='disabled'` | v2 schema 无 revoked 枚举;语义等价(网关 401)。 |
| 4 | 无 team app、无 model_channels | v2 schema 明确砍掉(spec §4)。 |
| 5 | 管理操作写 audit_events | TS 版从未实现(只有请求体审计);spec §3.6 字面要求,P3 补齐。 |
| 6 | 报表 day 维度按日期升序 | 趋势图需要;model/key 维度仍按费用降序(对齐 TS)。 |
| 7 | 网关 Anthropic 协议接受 `Authorization: Bearer` 回退 | handout 教 Claude Code 用 `ANTHROPIC_AUTH_TOKEN`(发 Bearer 头);两版网关原本只认 x-api-key,照搬必 401。宽收一行修平。 |

---

## 文件结构总览

```
src/error.rs                 # T1:+forbidden/conflict;T2:+too_many_attempts
src/audit.rs                 # T1 新建:audit::record best-effort
src/billing.rs               # T1:+parse_cny_to_micro
src/jobs.rs                  # T1:month_start_epoch 提公
src/config.rs                # T1:+cookie_secure
src/lib.rs                   # T1:healthz 摘出 TraceLayer;T2:AppState+login_limiter;声明 pub mod audit
src/admin/assets.rs          # T1:文本类型补 charset
src/gateway/auth.rs          # T1:Anthropic Bearer 回退
src/admin/api.rs             # T1:session_cookie 接 secure;T2:login 限速;router 逐任务 nest
src/admin/limiter.rs         # T2 新建:LoginLimiter
src/admin/users.rs           # T3
src/admin/teams.rs           # T4
src/admin/handout.rs         # T5
src/admin/keys.rs            # T5
src/admin/channels.rs        # T6
src/admin/models.rs          # T6
src/admin/budgets.rs         # T7
src/admin/reports.rs         # T8
src/admin/dashboard.rs       # T8
src/admin/audit_api.rs       # T8
src/admin/mod.rs             # 逐任务补 pub mod
src/test_util.rs             # T1:+admin_session

admin-ui/src/lib/api.ts      # T9 全量扩展
admin-ui/src/lib/format.ts   # T9 新建
admin-ui/src/components/ui.tsx       # T9 新建(组件库)
admin-ui/src/AuthContext.tsx # T9 新建(遗留#6)
admin-ui/src/App.tsx         # T9 全路由
admin-ui/src/components/Layout.tsx   # T9 NAV(+预算)
admin-ui/src/pages/{Users,Teams,TeamDetail}.tsx        # T10
admin-ui/src/pages/{Channels,Models}.tsx               # T10
admin-ui/src/pages/{Keys,Budgets,Reports}.tsx          # T11
admin-ui/src/pages/{Dashboard(重写),Audit}.tsx          # T12
docs/superpowers/plans/rust-p1-followups.md            # T12 划掉认领项
```

---

### Task 1: 基础设施 + 遗留修复(#2 #3 #4 + Bearer 回退 + 公共原语)

**Files:**
- Modify: `src/error.rs`、`src/billing.rs`、`src/jobs.rs`、`src/config.rs`、`src/lib.rs`、`src/admin/api.rs`、`src/admin/assets.rs`、`src/gateway/auth.rs`、`src/test_util.rs`
- Create: `src/audit.rs`

- [ ] **Step 1: 写失败测试(分布在各模块 tests)**

`src/billing.rs` tests 追加:

```rust
    #[test]
    fn parse_cny_to_micro_vectors() {
        assert_eq!(parse_cny_to_micro("100").unwrap(), 100_000_000);
        assert_eq!(parse_cny_to_micro("100.50").unwrap(), 100_500_000);
        assert_eq!(parse_cny_to_micro("0.000001").unwrap(), 1);
        assert_eq!(parse_cny_to_micro("21.000000").unwrap(), 21_000_000);
        assert_eq!(parse_cny_to_micro("0").unwrap(), 0);
        assert!(parse_cny_to_micro("").is_err());
        assert!(parse_cny_to_micro("1.2345678").is_err()); // 7 位小数
        assert!(parse_cny_to_micro("-5").is_err());
        assert!(parse_cny_to_micro("abc").is_err());
        assert!(parse_cny_to_micro("1e3").is_err());
        assert!(parse_cny_to_micro("9300000000000").is_err()); // 溢出 i64 micro
    }
```

`src/audit.rs` tests(新文件,见 Step 3):写入后能查到、detail 序列化、坏 db 不 panic。

`src/gateway/auth.rs` tests 追加:

```rust
    #[test]
    fn anthropic_accepts_bearer_fallback() {
        // Claude Code 配 ANTHROPIC_AUTH_TOKEN 时发 Authorization: Bearer,不发 x-api-key
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer sk-cloudllm-abc".parse().unwrap());
        assert_eq!(
            extract_raw_key(Protocol::Anthropic, &h).as_deref(),
            Some("sk-cloudllm-abc")
        );
        // x-api-key 仍然优先
        h.insert("x-api-key", "sk-cloudllm-xyz".parse().unwrap());
        assert_eq!(
            extract_raw_key(Protocol::Anthropic, &h).as_deref(),
            Some("sk-cloudllm-xyz")
        );
    }
```

`src/config.rs` tests 追加:`cookie_secure` 默认 false、`CLOUDLLM_COOKIE_SECURE=true` 覆盖生效。
`src/admin/api.rs` tests 追加:`cookie_secure=true` 时 login 的 Set-Cookie 含 `Secure`;默认不含。
`src/admin/assets.rs` tests 追加:JS 资产 Content-Type 为 `text/javascript; charset=utf-8`(或 application/javascript 带 charset);HTML 含 charset。

- [ ] **Step 2: 跑红**

`cargo test --locked parse_cny anthropic_accepts cookie_secure charset` → 编译错误(函数/字段不存在)即红。

- [ ] **Step 3: 实现**

`src/error.rs` 追加构造器(同既有风格):

```rust
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self { status: StatusCode::FORBIDDEN, code: "forbidden", message: message.into(), detail: None }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self { status: StatusCode::CONFLICT, code: "conflict", message: message.into(), detail: None }
    }
```

`src/billing.rs` 追加(整数运算,无浮点):

```rust
/// 解析 CNY 字符串为 micro-CNY:接受 "100" / "100.50",最多 6 位小数,非负。
/// 校验「必须为正」由调用方按业务判断(模型价格允许 0,预算限额要 >0)。
pub fn parse_cny_to_micro(s: &str) -> anyhow::Result<i64> {
    let s = s.trim();
    anyhow::ensure!(!s.is_empty(), "金额不能为空");
    anyhow::ensure!(!s.starts_with('-'), "金额不能为负");
    let (int_part, frac_part) = s.split_once('.').unwrap_or((s, ""));
    anyhow::ensure!(frac_part.len() <= 6, "最多 6 位小数");
    anyhow::ensure!(!int_part.is_empty() && int_part.bytes().all(|b| b.is_ascii_digit()), "金额格式无效");
    anyhow::ensure!(frac_part.bytes().all(|b| b.is_ascii_digit()), "金额格式无效");
    let int: i64 = int_part.parse().map_err(|_| anyhow::anyhow!("金额过大"))?;
    let frac: i64 = if frac_part.is_empty() { 0 } else { format!("{frac_part:0<6}").parse()? };
    int.checked_mul(1_000_000).and_then(|v| v.checked_add(frac)).ok_or_else(|| anyhow::anyhow!("金额过大"))
}
```

`src/jobs.rs`:`fn month_start_epoch` → `pub fn month_start_epoch`(注释补一句「预算/报表/Dashboard 共用的月初口径」)。

`src/config.rs`:追加字段 `#[serde(default)] pub cookie_secure: bool`,`apply_overrides` 接 `CLOUDLLM_COOKIE_SECURE`(`"true"/"1"` 为真,其余保默认——与既有 env 解析风格一致),Debug 输出可见(非密钥)。

`src/admin/api.rs`:`session_cookie` 改签名 `fn session_cookie(value: String, max_age_secs: i64, secure: bool)`,builder 链加 `.secure(secure)`;login/logout 调用处传 `state.config.cookie_secure`(logout 无 state——logout 签名加 `State(state)`)。

`src/audit.rs` 新建:

```rust
//! 管理操作审计:best-effort 落 audit_events。
//! 失败仅 warn 不冒泡——审计不阻断管理操作本身(取舍:可用性优先,内部系统)。

use sqlx::SqlitePool;

pub async fn record(
    db: &SqlitePool,
    actor_user_id: Option<&str>,
    action: &str,
    subject: Option<&str>,
    detail: serde_json::Value,
) {
    let r = sqlx::query(
        "INSERT INTO audit_events (id, actor_user_id, action, subject, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(actor_user_id)
    .bind(action)
    .bind(subject)
    .bind(detail.to_string())
    .bind(crate::now_epoch())
    .execute(db)
    .await;
    if let Err(e) = r {
        tracing::warn!(error = %e, action, "审计写入失败");
    }
}
```

`src/lib.rs`:`pub mod audit;`;healthz 消噪(遗留#3)——TraceLayer 只包业务路由,healthz 探活在 trace 外:

```rust
pub fn app(state: AppState) -> Router {
    let max_body = state.config.max_body_bytes;
    let traced = Router::new()
        .nest("/v1", gateway::router())
        .nest("/admin/api", admin::api::router())
        .route("/admin", get(admin::assets::serve_index))
        .route("/admin/", get(admin::assets::serve_index))
        .route("/admin/assets/*path", get(admin::assets::serve_asset))
        .route("/admin/*spa", get(admin::assets::serve_spa))
        .layer(tower_http::trace::TraceLayer::new_for_http());
    // healthz 在 TraceLayer 外:K8s 探针打点不进 trace,DB 故障时 healthz 503 也不再刷 ERROR
    Router::new()
        .route("/healthz", get(healthz))
        .merge(traced)
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}
```

`src/admin/assets.rs`(遗留#4):构造 Content-Type 处,`text/*`、`application/javascript`、`application/json`、`image/svg+xml` 追加 `; charset=utf-8`(mime-guess 给的基础类型上拼接;已带 charset 的不重复拼)。

`src/gateway/auth.rs`:`extract_raw_key` 的 `Protocol::Anthropic` 分支改为:

```rust
        Protocol::Anthropic => {
            // 优先 x-api-key(Anthropic 原生);回退 Authorization: Bearer——
            // Claude Code 配 ANTHROPIC_AUTH_TOKEN 时只发 Bearer 头(handout 教的就是这个配置)
            if let Some(v) = headers.get("x-api-key") {
                return Some(v.to_str().ok()?.to_string());
            }
            let v = headers.get("authorization")?.to_str().ok()?.trim();
            let lower = v.to_ascii_lowercase();
            lower.starts_with("bearer").then(|| v[6..].trim_start().trim().to_string())
        }
```

`src/test_util.rs` 追加(后续所有 admin API 测试共用):

```rust
/// 建管理员 + 登录,返回 (AppState, Cookie 串)。后续 admin API 测试的标准开场。
pub async fn admin_session() -> (AppState, String) {
    let state = test_state().await;
    insert_user(&state.db, "admin@x.com", "Adm1n!pass", "admin", "active").await;
    let resp = crate::app(state.clone())
        .oneshot(json_request(
            "POST",
            "/admin/api/login",
            serde_json::json!({"email": "admin@x.com", "password": "Adm1n!pass"}),
        ))
        .await
        .unwrap();
    let cookie = first_cookie(&resp);
    (state, cookie)
}

/// 带会话 cookie 的 JSON 请求
pub fn authed_request(method: &str, uri: &str, cookie: &str, body: Option<serde_json::Value>) -> Request<Body> {
    let b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json");
    match body {
        Some(v) => b.body(Body::from(v.to_string())).expect("构造请求"),
        None => b.body(Body::empty()).expect("构造请求"),
    }
}
```

(test_util 需要 `use tower::ServiceExt;` 与 oneshot —— dev-dependencies 已有 tower/util。)

**P3 audit action 字符串总表(各任务引用,不得自造):**

| action | subject | detail 字段 |
|---|---|---|
| `auth.login_failed` | email | `{source}` |
| `user.create` | user_id | `{email, role}` |
| `user.update` | user_id | `{status?, role?}` |
| `team.create` | team_id | `{name}` |
| `team.member_add` | team_id | `{user_id, role}` |
| `team.member_role` | team_id | `{user_id, role}` |
| `team.member_remove` | team_id | `{user_id}` |
| `key.create` | key_id | `{name, owner_type, owner_id, budget_micro?}` |
| `key.revoke` | key_id | `{}` |
| `key.update` | key_id | `{audit}` |
| `channel.create` | channel_id | `{name, provider_type, base_url}` |
| `channel.update` | channel_id | `{name?, weight?, status?}` |
| `channel.rotate` | channel_id | `{}`(凭证绝不入) |
| `model.create` | model_id | `{slug, provider_type}` |
| `model.update` | model_id | `{status}` |
| `model.delete` | model_id | `{slug}` |
| `budget.create` | budget_id | `{subject_type, subject_id, period, limit_micro}` |
| `budget.update` | budget_id | `{limit_micro?, alert_threshold?, status?}` |

- [ ] **Step 4: 跑绿 + 三件套**

`cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked` → 全绿(P2 基线 142 测试不得回退)。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(rust): P3-T1 管理面基础设施——audit 落库/parse_cny/月初提公/cookie Secure/healthz 消噪/charset/Anthropic Bearer 回退"
```

---

### Task 2: 登录限速 + 失败登录审计(遗留 #1)

**Files:**
- Create: `src/admin/limiter.rs`
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(login)、`src/error.rs`、`src/lib.rs`(AppState)、`src/cli.rs`(serve 构造)、`src/test_util.rs`(test_state 构造)

**语义(拍板):** 维度 = 邮箱(主防线)+ 来源(`x-forwarded-for` 第一跳,无则 `"direct"`;XFF 可伪造——内网单实例威胁模型下接受,锁定主力是邮箱维度,代码注释写明)。窗口 15 分钟内失败满 5 次 → 锁 15 分钟 → 429 `too_many_attempts`「尝试次数过多,请稍后再试」(不区分维度,防探测)。成功登录清零两个维度。失败(非锁定)写 `auth.login_failed` 审计。内存态(单实例,重启即清,可接受)。

- [ ] **Step 1: 写失败测试**(`src/admin/limiter.rs` 单元 + `src/admin/api.rs` 集成)

```rust
    // limiter.rs 单元测试
    #[test]
    fn locks_after_five_failures_and_recovers() {
        let l = LoginLimiter::default();
        let t0 = 1_000_000;
        for i in 0..5 {
            assert!(l.check("email:a@x.com", t0 + i).is_ok());
            l.record_failure("email:a@x.com", t0 + i);
        }
        assert!(l.check("email:a@x.com", t0 + 10).is_err()); // 锁定
        assert!(l.check("email:a@x.com", t0 + 10 + 900).is_ok()); // 锁过期
    }

    #[test]
    fn success_clears_counter() {
        let l = LoginLimiter::default();
        for i in 0..4 { l.record_failure("email:b@x.com", 1_000 + i); }
        l.clear("email:b@x.com");
        assert!(l.check("email:b@x.com", 1_005).is_ok());
        l.record_failure("email:b@x.com", 1_005);
        assert!(l.check("email:b@x.com", 1_006).is_ok()); // 重新从 1 计
    }

    #[test]
    fn window_expiry_resets_count() {
        let l = LoginLimiter::default();
        for i in 0..4 { l.record_failure("email:c@x.com", 1_000 + i); }
        l.record_failure("email:c@x.com", 1_000 + 901); // 窗口已过,重开窗
        assert!(l.check("email:c@x.com", 1_000 + 902).is_ok());
    }
```

api.rs 集成测试:
- `login_locked_after_five_failures`:同邮箱连错 5 次密码 → 第 6 次(即使密码正确)429,body code `too_many_attempts`;
- `login_failure_writes_audit`:错 1 次后 `SELECT action, subject FROM audit_events WHERE action='auth.login_failed'` 有一行 subject=该邮箱;
- `login_success_not_limited_after_clear`:错 4 次 → 成功一次 → 再错 4 次仍不锁。

- [ ] **Step 2: 跑红** → LoginLimiter 不存在,编译红。

- [ ] **Step 3: 实现**

`src/admin/limiter.rs`:

```rust
//! 登录限速:进程内计数,邮箱 + 来源双维度。单实例内存态即可(重启清零是可接受取舍)。

use std::collections::HashMap;
use std::sync::Mutex;

const WINDOW_SECS: i64 = 900;
const MAX_FAILS: u32 = 5;
const LOCK_SECS: i64 = 900;

#[derive(Default)]
struct Entry {
    count: u32,
    window_start: i64,
    locked_until: i64,
}

#[derive(Default)]
pub struct LoginLimiter {
    map: Mutex<HashMap<String, Entry>>,
}

impl LoginLimiter {
    /// Err(解锁时刻) = 该维度处于锁定中
    pub fn check(&self, key: &str, now: i64) -> Result<(), i64> {
        let map = self.map.lock().expect("limiter 锁");
        match map.get(key) {
            Some(e) if e.locked_until > now => Err(e.locked_until),
            _ => Ok(()),
        }
    }

    pub fn record_failure(&self, key: &str, now: i64) {
        let mut map = self.map.lock().expect("limiter 锁");
        let e = map.entry(key.to_string()).or_default();
        if now - e.window_start > WINDOW_SECS {
            e.count = 0;
            e.window_start = now;
        }
        e.count += 1;
        if e.count >= MAX_FAILS {
            e.locked_until = now + LOCK_SECS;
            e.count = 0; // 锁定后重新计数,避免解锁瞬间再失败立刻又锁
        }
        // 顺手清理:超过 1000 条时丢弃过期项,防长期运行无界增长
        if map.len() > 1000 {
            map.retain(|_, v| v.locked_until > now || now - v.window_start <= WINDOW_SECS);
        }
    }

    pub fn clear(&self, key: &str) {
        self.map.lock().expect("limiter 锁").remove(key);
    }
}
```

`src/error.rs` 追加 `too_many_attempts()`(429,文案「尝试次数过多,请稍后再试」)。

`AppState` 追加 `pub login_limiter: Arc<admin::limiter::LoginLimiter>`;`cli.rs` serve 与 `test_util::test_state` 构造处补 `Arc::new(LoginLimiter::default())`。

`admin/api.rs` login 改造(顺序敏感——限速检查在 DB 查询前;失败记录在 ApiError 返回前):

```rust
async fn login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    jar: CookieJar,
    WithRejection(Json(req), _): WithRejection<Json<LoginReq>, ApiError>,
) -> Result<(CookieJar, Json<MeResp>), ApiError> {
    let now = now_epoch();
    // 来源:XFF 第一跳(可伪造,内网威胁模型下接受;主防线是邮箱维度)
    let source = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "direct".into());
    let email_key = format!("email:{}", req.email);
    let source_key = format!("source:{source}");
    if state.login_limiter.check(&email_key, now).is_err()
        || state.login_limiter.check(&source_key, now).is_err()
    {
        return Err(ApiError::too_many_attempts());
    }
    // …(原有查询/校验逻辑不动)…
    // 每个失败 return Err(ApiError::login_failed()) 之前统一走:
    //   state.login_limiter.record_failure(&email_key, now);
    //   state.login_limiter.record_failure(&source_key, now);
    //   crate::audit::record(&state.db, None, "auth.login_failed", Some(&req.email),
    //       serde_json::json!({"source": source})).await;
    // 成功路径在签发 cookie 前:
    //   state.login_limiter.clear(&email_key);
    //   state.login_limiter.clear(&source_key);
}
```

(实现时把失败收口提成局部 async 闭包/辅助函数,避免三处复制。)

- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T2 登录限速(邮箱+来源双维度)+ 失败登录审计`

---

### Task 3: users 资源 API

**Files:**
- Create: `src/admin/users.rs`
- Modify: `src/admin/mod.rs`(+`pub mod users;`)、`src/admin/api.rs`(router `.merge(super::users::router())`)

**路由契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/users` | — | `{users: [{id,email,role,status,created_at}]}` | 按 created_at 升序 |
| POST | `/admin/api/users` | `{email, password, role?}` | 201 + user 对象 | email 正则 `^[^\s@]+@[^\s@]+\.[^\s@]+$`(trim+lowercase 后),密码 ≥8 位,role ∈ {admin,user} 默认 user;重复邮箱 → 409「该邮箱已注册」 |
| PATCH | `/admin/api/users/:id` | `{status?}` 或 `{role?}` | 200 + user 对象 | status ∈ {active,disabled},role ∈ {admin,user};**不可停用自己**(403「不能停用自己的账号」)、**不可降级自己**(403「不能降级自己的角色」);目标不存在 404;两字段都缺 → 400「没有需要更新的字段」 |

写审计:`user.create` / `user.update`(见 T1 表)。

- [ ] **Step 1: 写失败测试**(本任务是资源 handler 的范本,测试与实现都给全,后续资源任务按同构样式展开)

`src/admin/users.rs` tests:

```rust
#[cfg(test)]
mod tests {
    use crate::test_util::{admin_session, authed_request, body_json};
    use crate::app;
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    #[tokio::test]
    async fn create_and_list_users() {
        let (state, cookie) = admin_session().await;
        let resp = app(state.clone())
            .oneshot(authed_request("POST", "/admin/api/users", &cookie,
                Some(json!({"email": "  Member@X.com ", "password": "memberpw1"}))))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = body_json(resp).await;
        assert_eq!(body["email"], "member@x.com"); // trim + lowercase
        assert_eq!(body["role"], "user");          // 默认 user

        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/users", &cookie, None))
            .await.unwrap();
        let body = body_json(resp).await;
        assert_eq!(body["users"].as_array().unwrap().len(), 2); // admin + member
        // 审计落行
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='user.create'")
            .fetch_one(&state.db).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn create_user_validation() {
        let (state, cookie) = admin_session().await;
        for (body, frag) in [
            (json!({"email": "bad", "password": "longenough"}), "邮箱"),
            (json!({"email": "a@b.com", "password": "short"}), "8"),
            (json!({"email": "a@b.com", "password": "longenough", "role": "root"}), "角色"),
        ] {
            let resp = app(state.clone())
                .oneshot(authed_request("POST", "/admin/api/users", &cookie, Some(body)))
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            let msg = body_json(resp).await["error"]["message"].as_str().unwrap().to_string();
            assert!(msg.contains(frag), "文案应含「{frag}」: {msg}");
        }
    }

    #[tokio::test]
    async fn duplicate_email_conflict() {
        let (state, cookie) = admin_session().await;
        let payload = json!({"email": "dup@x.com", "password": "longenough"});
        app(state.clone()).oneshot(authed_request("POST", "/admin/api/users", &cookie, Some(payload.clone()))).await.unwrap();
        let resp = app(state.clone())
            .oneshot(authed_request("POST", "/admin/api/users", &cookie, Some(payload)))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn cannot_disable_or_demote_self() {
        let (state, cookie) = admin_session().await;
        let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email='admin@x.com'")
            .fetch_one(&state.db).await.unwrap();
        for patch in [json!({"status": "disabled"}), json!({"role": "user"})] {
            let resp = app(state.clone())
                .oneshot(authed_request("PATCH", &format!("/admin/api/users/{id}"), &cookie, Some(patch)))
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn patch_status_and_role() {
        let (state, cookie) = admin_session().await;
        let uid = crate::test_util::insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let resp = app(state.clone())
            .oneshot(authed_request("PATCH", &format!("/admin/api/users/{uid}"), &cookie,
                Some(json!({"status": "disabled"}))))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "disabled");
        // 不存在 → 404;空 patch → 400
        let resp = app(state.clone())
            .oneshot(authed_request("PATCH", "/admin/api/users/nope", &cookie, Some(json!({"status": "disabled"}))))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let resp = app(state.clone())
            .oneshot(authed_request("PATCH", &format!("/admin/api/users/{uid}"), &cookie, Some(json!({}))))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(crate::test_util::json_request("GET", "/admin/api/users", json!({})))
            .await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现 `src/admin/users.rs`**(范本全文;后续资源文件同构)

```rust
//! 用户资源:列表/创建/状态与角色变更。Console 仅 admin 可登录;user 角色用户是记账主体(持 Key 不登录)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list).post(create))
        .route("/users/:id", patch(update))
}

#[derive(Serialize, sqlx::FromRow)]
struct UserRow {
    id: String,
    email: String,
    role: String,
    status: String,
    created_at: i64,
}

async fn list(_user: AdminUser, State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let rows: Vec<UserRow> =
        sqlx::query_as("SELECT id, email, role, status, created_at FROM users ORDER BY created_at")
            .fetch_all(&state.db)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "users": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    email: String,
    password: String,
    #[serde(default)]
    role: Option<String>,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<UserRow>), ApiError> {
    let email = req.email.trim().to_lowercase();
    // 与 TS 版同一正则语义:本地部分@域.后缀,均不含空白/@
    let valid = {
        let parts: Vec<&str> = email.split('@').collect();
        parts.len() == 2
            && !parts[0].is_empty()
            && parts[1].contains('.')
            && !parts[1].starts_with('.')
            && !parts[1].ends_with('.')
            && !email.chars().any(char::is_whitespace)
    };
    if !valid {
        return Err(ApiError::bad_request("请输入有效邮箱地址"));
    }
    if req.password.len() < 8 {
        return Err(ApiError::bad_request("密码至少 8 位"));
    }
    let role = req.role.unwrap_or_else(|| "user".into());
    if !["admin", "user"].contains(&role.as_str()) {
        return Err(ApiError::bad_request("无效角色"));
    }
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if exists.is_some() {
        return Err(ApiError::conflict("该邮箱已注册"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let hash = crate::crypto::hash_password(&req.password).map_err(ApiError::internal)?;
    let created_at = now_epoch();
    sqlx::query("INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
        .bind(&id).bind(&email).bind(&hash).bind(&role).bind(created_at)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    crate::audit::record(&state.db, Some(&user.id), "user.create", Some(&id),
        serde_json::json!({"email": email, "role": role})).await;
    Ok((StatusCode::CREATED, Json(UserRow { id, email, role, status: "active".into(), created_at })))
}

#[derive(Deserialize)]
struct UpdateReq {
    status: Option<String>,
    role: Option<String>,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<UserRow>, ApiError> {
    if req.status.is_none() && req.role.is_none() {
        return Err(ApiError::bad_request("没有需要更新的字段"));
    }
    if let Some(s) = &req.status {
        if !["active", "disabled"].contains(&s.as_str()) {
            return Err(ApiError::bad_request("无效状态"));
        }
        if s == "disabled" && id == user.id {
            return Err(ApiError::forbidden("不能停用自己的账号"));
        }
    }
    if let Some(r) = &req.role {
        if !["admin", "user"].contains(&r.as_str()) {
            return Err(ApiError::bad_request("无效角色"));
        }
        if r == "user" && id == user.id {
            return Err(ApiError::forbidden("不能降级自己的角色"));
        }
    }
    let res = sqlx::query(
        "UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role) WHERE id = ?",
    )
    .bind(&req.status).bind(&req.role).bind(&id)
    .execute(&state.db)
    .await
    .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("用户不存在"));
    }
    crate::audit::record(&state.db, Some(&user.id), "user.update", Some(&id),
        serde_json::json!({"status": req.status, "role": req.role})).await;
    let row: UserRow = sqlx::query_as("SELECT id, email, role, status, created_at FROM users WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(row))
}
```

`admin/api.rs` 的 `router()` 改为:

```rust
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .merge(super::users::router())
        // T4..T8 逐任务在此 .merge(...)
        .fallback(api_not_found)
}
```

- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T3 users 资源 API(创建/列表/状态角色变更 + 自我保护 + 审计)`

---

### Task 4: teams 资源 API(成员管理 + 最后 owner 不变式)

**Files:**
- Create: `src/admin/teams.rs`(结构同 T3 范本)
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(merge)

**路由契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/teams` | — | `{teams: [{id,name,created_at,member_count}]}` | `LEFT JOIN team_members` 计数 |
| POST | `/admin/api/teams` | `{name}` | 201 + team | name trim 后非空;**创建者自动入队为 owner**(单事务两 INSERT——不变式「至少一名 owner」从创建起成立) |
| GET | `/admin/api/teams/:id` | — | `{id,name,created_at,members:[{user_id,email,role}]}` | members owner 在前、email 升序;团队不存在 404 |
| POST | `/admin/api/teams/:id/members` | `{email, role}` | 201 | role ∈ {owner,member}(**schema CHECK 仅此二值,TS 的 admin 不存在**);email 查 users,不存在 → 404「用户不存在」;已是成员 → 409「该用户已是团队成员」 |
| PATCH | `/admin/api/teams/:id/members/:user_id` | `{role}` | 200 | owner→member 且 owner 数 ≤1 → 403「团队至少保留一名 owner」 |
| DELETE | `/admin/api/teams/:id/members/:user_id` | — | 204 | 移除 owner 且 owner 数 ≤1 → 403 同文案;成员不存在 404 |

owner 计数与变更同一事务内做(`BEGIN` → `SELECT COUNT(*) ... role='owner'` → 校验 → UPDATE/DELETE → COMMIT),杜绝并发把最后两个 owner 同时降级的窗口(SQLite 单写者,事务即互斥)。

写审计:`team.create` / `team.member_add` / `team.member_role` / `team.member_remove`。

- [ ] **Step 1: 写失败测试**。必测清单(样式同 T3,逐条独立 `#[tokio::test]`):
  1. `create_team_creator_becomes_owner`:POST 后 GET 详情,members 含 admin 自己 role=owner;audit `team.create` 落行。
  2. `create_team_empty_name_400`。
  3. `list_teams_member_count`:建队加 1 成员 → member_count=2。
  4. `add_member_by_email`:先 `insert_user` 建成员 → POST members → 详情可见;重复加 → 409;不存在邮箱 → 404;role 传 `admin` → 400「无效角色」。
  5. `last_owner_cannot_be_demoted_or_removed`:只有创建者一个 owner 时,PATCH 其 role=member → 403;DELETE → 403;加第二个 owner 后再降级第一个 → 200。
  6. `team_not_found_404`:GET/POST members 对不存在团队 → 404。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现 `src/admin/teams.rs`**。要点(非样板部分):

```rust
// 创建:单事务,团队 + 创建者 owner 一起落
let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
sqlx::query("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
    .bind(&id).bind(&name).bind(created_at)
    .execute(&mut *tx).await.map_err(ApiError::internal)?;
sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')")
    .bind(&id).bind(&user.id)
    .execute(&mut *tx).await.map_err(ApiError::internal)?;
tx.commit().await.map_err(ApiError::internal)?;
```

```rust
// 最后 owner 守护(PATCH 降级与 DELETE 共用;事务内)
async fn guard_last_owner(
    tx: &mut sqlx::SqliteConnection, team_id: &str, target_user_id: &str,
) -> Result<(), ApiError> {
    let cur: Option<(String,)> =
        sqlx::query_as("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(team_id).bind(target_user_id)
            .fetch_optional(&mut *tx).await.map_err(ApiError::internal)?;
    let Some((role,)) = cur else { return Err(ApiError::not_found("成员不存在")) };
    if role == "owner" {
        let (owners,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'owner'")
                .bind(team_id)
                .fetch_one(&mut *tx).await.map_err(ApiError::internal)?;
        if owners <= 1 {
            return Err(ApiError::forbidden("团队至少保留一名 owner"));
        }
    }
    Ok(())
}
```

列表 SQL:

```sql
SELECT t.id, t.name, t.created_at, COUNT(m.user_id) AS member_count
FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
GROUP BY t.id ORDER BY t.created_at
```

详情成员 SQL:

```sql
SELECT m.user_id, u.email, m.role
FROM team_members m JOIN users u ON u.id = m.user_id
WHERE m.team_id = ?
ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email
```

- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T4 teams 资源 API(成员管理 + 最后 owner 事务守护 + 审计)`

---

### Task 5: keys 资源 API + 接入说明(handout 移植)

**Files:**
- Create: `src/admin/handout.rs`、`src/admin/keys.rs`
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(merge)

**handout.rs:** 纯函数,逐段移植 TS `apps/console/src/lib/handout.ts`(模板原文以 TS 文件为准,整体翻译为 `format!` 拼接;**Claude Code 段保持 `ANTHROPIC_AUTH_TOKEN`**——T1 已给网关加 Bearer 回退,该配置可用):

```rust
/// 生成成员接入说明 Markdown。
/// gateway_url 末尾斜杠规整;model_slugs 空 = 不限模型(显示全部两段 SDK 示例)。
/// 规则:ANTHROPIC_BASE_URL 不带 /v1;OpenAI base_url 带 /v1(与 TS buildHandout 逐字对齐)。
pub fn build_handout(gateway_url: &str, plaintext_key: &str, model_slugs: &[String]) -> String
```

段落构成(与 TS 相同):标题+保密提醒 → 基本信息表(网关地址/API Key)→ 可用模型(空 =「全部模型可用(all models available,不受模型白名单限制)」,否则 `- \`slug\`` 列表)→ Claude Code 段(空列表或含 `anthropic/` 前缀 slug 时;含 `/model` 提示,有具体 slug 时给 `# /model {首个 anthropic slug}`)→ OpenAI SDK Python + Node.js 段(空列表或含 `openai/` 前缀 slug 时;示例模型 = 首个 openai slug,否则 `gpt-4o`;附 Cursor 提示行)→ curl 两例(恒显;`/v1/chat/completions` + `/v1/messages`)。

**keys.rs 路由契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/keys` | — | `{keys: [{id,key_prefix,name,owner_type,owner_id,owner_label,allowed_models,audit,expires_at,status,created_at}]}` | owner_label 经 `LEFT JOIN users/teams` 的 `COALESCE(u.email, t.name, k.owner_id)`;allowed_models 反序列化为数组或 null;按 created_at 降序 |
| POST | `/admin/api/keys` | `{name, owner_type, owner_id, allowed_models?, audit?, expires_at?, budget_limit_cny?, budget_period?}` | 201 `{plaintext, handout, key:{…同列表行}}` | name 非空;owner_type ∈ {user,team} 且 owner 必须存在(404「主体不存在」);allowed_models 数组(空数组/缺省 = null 不限),每个 slug 必须存在于 models(400「模型 {slug} 不存在」);expires_at 须 > now(400「过期时间必须是未来时间」);budget_limit_cny 非空时:period ∈ {monthly,total}(缺省 monthly)、`parse_cny_to_micro` 且 >0(400「预算限额必须为正数」);**单事务**:INSERT api_keys + (可选) INSERT budgets(subject_type='key', period_start = monthly ? `month_start_epoch(now)` : now);明文与 handout 仅此响应一次 |
| POST | `/admin/api/keys/:id/revoke` | — | 200 `{status:"disabled"}` | UPDATE status='disabled';不存在 404;幂等(已 disabled 再 revoke 仍 200) |
| PATCH | `/admin/api/keys/:id` | `{audit}` | 200 + key 行 | bool;不存在 404 |

handout 的 gateway_url:`config.gateway_public_url`;`None` 时回退 `http://localhost:{listen 端口}` 且响应加 `"gateway_url_configured": false`(UI 显示「请在配置中设置 gateway_public_url」警告)。

写审计:`key.create`(detail 含 budget_micro,**不含明文/hash**)/ `key.revoke` / `key.update`。

- [ ] **Step 1: 写失败测试**。
  - handout 单元测试(向量对齐 TS `handout.test.ts`):
    1. 空 slugs:含明文 Key、规整后的网关地址(传 `http://gw:8080/` 断言无尾斜杠)、`全部模型`、`/v1/chat/completions`、`/v1/messages`、同时含 Claude Code 与 OpenAI 两段;
    2. 仅 `anthropic/claude-x`:含 `ANTHROPIC_BASE_URL=http://localhost:8080`(**不带 /v1**)、`ANTHROPIC_AUTH_TOKEN`、`/model anthropic/claude-x`;**不含** `from openai import`;
    3. 仅 `openai/gpt-4o`:含 `base_url="http://gw:9000/v1"`(**带 /v1**)与 `baseURL: "http://gw:9000/v1"`;不含 `ANTHROPIC_BASE_URL=`;
    4. 混合:两段都在。
  - keys API 集成测试:
    5. `create_key_returns_plaintext_once_and_handout`:建 user+model 后签发(带 allowed_models + 预算)→ 201,plaintext 以 `sk-cloudllm-` 开头,handout 含 plaintext;列表响应**无** plaintext/key_hash 字段;budgets 表落了一行 subject_type='key', limit 正确, period_start=本月初(断言 `jobs::month_start_epoch(now)`);audit `key.create` 落行且 detail 不含明文。
    6. `create_key_invalid_budget_rolls_back`:budget_limit_cny="abc" → 400 且 api_keys 零行(事务未提交——校验在事务前即可,断言兜底)。
    7. `create_key_unknown_owner_404`、`create_key_unknown_model_400`、`create_key_past_expiry_400`。
    8. `revoked_key_rejected_by_gateway`(端到端闭环):签发 → 用 plaintext 打 `POST /v1/chat/completions`(`json!({"model": slug, "messages": []})`,Bearer 头)→ 非 401(走到后续逻辑即可);revoke 后同请求 → **401**,body `error.code == "invalid_api_key"`(网关协议错误体)。
    9. `toggle_audit_and_list`。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**。签发核心(事务部分):

```rust
let gen = crate::crypto::generate_api_key();
let key_id = uuid::Uuid::new_v4().to_string();
let allowed_json = allowed.as_ref().map(|v| serde_json::to_string(v).expect("序列化白名单"));
let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
sqlx::query(
    "INSERT INTO api_keys (id, key_hash, key_prefix, name, owner_type, owner_id, allowed_models, audit, status, expires_at, created_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
)
.bind(&key_id).bind(&gen.key_hash).bind(&gen.key_prefix).bind(&req.name)
.bind(&req.owner_type).bind(&req.owner_id).bind(&allowed_json)
.bind(req.audit.unwrap_or(false) as i64).bind(req.expires_at).bind(now)
.execute(&mut *tx).await.map_err(ApiError::internal)?;
if let Some(limit_micro) = budget_micro {
    let period_start = if period == "monthly" { crate::jobs::month_start_epoch(now) } else { now };
    sqlx::query(
        "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, used_micro, period_start, alert_threshold, status, created_at) \
         VALUES (?, 'key', ?, ?, ?, 0, ?, NULL, 'active', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string()).bind(&key_id).bind(&period)
    .bind(limit_micro).bind(period_start).bind(now)
    .execute(&mut *tx).await.map_err(ApiError::internal)?;
}
tx.commit().await.map_err(ApiError::internal)?;
let handout = super::handout::build_handout(&gateway_url, &gen.plaintext, allowed.as_deref().unwrap_or(&[]));
```

- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T5 keys 资源 API(单事务签发带预算 + handout 移植 + revoke 网关闭环)`

---

### Task 6: channels + models 资源 API

**Files:**
- Create: `src/admin/channels.rs`、`src/admin/models.rs`
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(merge ×2)

**channels 契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/channels` | — | `{channels:[{id,provider_type,name,base_url,weight,status,cooldown_until,cooldown_level,created_at}]}` | **凭证字段绝不出现**;按 created_at 升序 |
| POST | `/admin/api/channels` | `{provider_type,name,base_url,credential,weight?}` | 201 + 行(无凭证) | provider_type ∈ {openai,anthropic};name 非空;credential 非空(400「凭证不能为空」);base_url:去尾部 `/` 后必须匹配 `^https?://.+/v1$`(400「baseUrl 必须以 /v1 结尾(如 https://api.openai.com/v1)」),存规整值;weight 缺省 1,必须 ≥1;**先生成 UUID 再 `encrypt_secret(credential, &master_key_bytes, &id)`(AAD=行 id)** |
| PATCH | `/admin/api/channels/:id` | `{name?,weight?,status?}` | 200 + 行 | status 仅 {active,disabled}(cooldown 是网关内部态,不许手设);**status→active 时同时 `cooldown_until=NULL, cooldown_level=0`**(管理员手动启用 = 解除冷却惩罚);weight ≥1;空 patch 400 |
| POST | `/admin/api/channels/:id/rotate` | `{credential}` | 204 | 非空;复用原行 id 作 AAD 重加密 |

**models 契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/models` | — | `{models:[{id,slug,provider_type,upstream_model,input_price_micro,output_price_micro,cache_read_price_micro,cache_write_price_micro,status,created_at}]}` | 按 slug 升序 |
| POST | `/admin/api/models` | `{slug,provider_type,upstream_model,input_price_cny,output_price_cny,cache_read_price_cny?,cache_write_price_cny?}` | 201 + 行 | slug 匹配 `^[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+$`(400「slug 格式无效(示例: openai/gpt-4o)」);provider_type ∈ {openai,anthropic};upstream_model 非空;价格走 `parse_cny_to_micro` ≥0(cache 两档缺省 "0");slug 重复 → 409「slug \"{slug}\" 已存在」 |
| PATCH | `/admin/api/models/:id` | `{status}` | 200 + 行 | {active,disabled} |
| DELETE | `/admin/api/models/:id` | — | 204 | 直接删行(usage_records.model_slug 软引用,历史账保留);不存在 404 |

写审计:`channel.create/update/rotate`(rotate 的 detail 为空对象)、`model.create/update/delete`。

- [ ] **Step 1: 写失败测试**。必测清单:
  1. `create_channel_validates_and_encrypts`:201 后直接 `SELECT credential_encrypted` 用 `decrypt_secret(blob, &key, &id)` 还原 == 原文(AAD 正确性);响应 JSON 序列化后字符串**不含**凭证原文与 "credential";
  2. `create_channel_bad_base_url_400`(`https://api.openai.com`、`http://x/v2`、尾斜杠 `https://x/v1/` 应通过且存成无尾斜杠);
  3. `patch_status_active_clears_cooldown`:先手动 `UPDATE channels SET status='cooldown', cooldown_until=now+600, cooldown_level=3` → PATCH active → 三字段归位;
  4. `rotate_reencrypts_with_same_aad`:rotate 后 decrypt(新 blob, AAD=id) == 新凭证;
  5. `create_model_slug_and_prices`:CNY 字符串入参落库为 micro(断言 "21.5" → 21_500_000);slug 重复 409;坏 slug 400;
  6. `delete_model_keeps_usage`:插 usage_records 后删模型 → usage 行还在;
  7. `model_patch_status`。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**(同 T3 范本结构;SQLite 唯一冲突识别:`err.to_string().contains("UNIQUE constraint failed")` → `ApiError::conflict`,提一个模块内辅助 `fn map_unique(e: sqlx::Error, msg: &str) -> ApiError`)
- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T6 channels/models 资源 API(信封加密只写不读 + 启用清冷却 + CNY 字符串入参)`

---

### Task 7: budgets 资源 API

**Files:**
- Create: `src/admin/budgets.rs`
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(merge)

**契约:**

| 方法 | 路径 | 入参 | 出参 | 规则 |
|---|---|---|---|---|
| GET | `/admin/api/budgets` | — | `{budgets:[{id,subject_type,subject_id,subject_label,period,limit_micro,used_micro,period_start,alert_threshold,status,created_at}]}` | subject_label:`CASE subject_type` 三路 LEFT JOIN(user→email、team→name、key→`key_prefix \|\| ' ' \|\| name`),deleted 主体降级回 subject_id |
| GET | `/admin/api/budgets/subjects` | — | `{subjects:[{type,id,label}]}` | 下拉数据源:active users(label=email)+ 全部 teams(label=name)+ active keys(label=`prefix name`) |
| POST | `/admin/api/budgets` | `{subject_type,subject_id,period,limit_cny,alert_threshold?}` | 201 + 行 | subject_type ∈ {key,user,team}(**无 app**);subject 必须存在(404「主体不存在」);period ∈ {monthly,total};limit_cny `parse_cny_to_micro` 且 >0;alert_threshold 空或 0~1(400「告警阈值必须在 0~1 之间(如 0.8)」);period_start:monthly → `month_start_epoch(now)`,total → now;唯一约束冲突 → 409「该主体已存在 {period} 预算,每个主体每 period 只能有一条」 |
| PATCH | `/admin/api/budgets/:id` | `{limit_cny?, alert_threshold?(null=清空), status?}` | 200 + 行 | 部分更新:字段缺省=不动;alert_threshold 显式 null = 置空(serde 需区分 缺省/null:用 `#[serde(default, deserialize_with = "double_option")]` 的 `Option<Option<f64>>` 模式);status ∈ {active,disabled};空 patch 400 |

写审计:`budget.create` / `budget.update`。

- [ ] **Step 1: 写失败测试**。必测:创建落库字段全对(period_start 断言月初)、subject 不存在 404、唯一冲突 409 文案、阈值越界 400、PATCH 三态(只改 limit / 显式清空 threshold / 改 status)、subjects 下拉包含三类、subject_label JOIN 正确 + Key 删除后降级 id。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**。subject_label SQL:

```sql
SELECT b.id, b.subject_type, b.subject_id,
       COALESCE(
         CASE b.subject_type
           WHEN 'user' THEN u.email
           WHEN 'team' THEN t.name
           WHEN 'key'  THEN k.key_prefix || ' ' || k.name
         END,
         b.subject_id
       ) AS subject_label,
       b.period, b.limit_micro, b.used_micro, b.period_start, b.alert_threshold, b.status, b.created_at
FROM budgets b
LEFT JOIN users u ON b.subject_type = 'user' AND u.id = b.subject_id
LEFT JOIN teams t ON b.subject_type = 'team' AND t.id = b.subject_id
LEFT JOIN api_keys k ON b.subject_type = 'key' AND k.id = b.subject_id
ORDER BY b.created_at DESC
```

`Option<Option<f64>>` 反序列化辅助(模块内):

```rust
/// 区分「字段缺失」与「显式 null」:缺失=不更新,null=清空
fn double_option<'de, D>(d: D) -> Result<Option<Option<f64>>, D::Error>
where D: serde::Deserializer<'de> {
    serde::Deserialize::deserialize(d).map(Some)
}
```

- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T7 budgets 资源 API(三类主体 + 唯一约束 409 + 显式清空阈值)`

---

### Task 8: reports + dashboard + audit 查询 API

**Files:**
- Create: `src/admin/reports.rs`、`src/admin/dashboard.rs`、`src/admin/audit_api.rs`
- Modify: `src/admin/mod.rs`、`src/admin/api.rs`(merge ×3)

**reports 契约:** `GET /admin/api/reports?dimension=model|key|day&from=<epoch>&to=<epoch>`
→ `{rows:[{bucket,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro}]}`。
校验:dimension 枚举(400「无效维度」),from/to 必填且 from < to(400「时间窗无效」)。
排序:model/key 按 cost 降序(对齐 TS);**day 按 bucket 升序**(分歧 #6,趋势图需要)。

```sql
-- dimension=model:bucket = model_slug,GROUP BY model_slug
-- dimension=day:  bucket = date(created_at, 'unixepoch'),GROUP BY bucket ORDER BY bucket
-- dimension=key:
SELECT COALESCE(k.key_prefix || ' ' || k.name, u.key_id) AS bucket,
       COUNT(*) AS requests,
       COALESCE(SUM(u.input_tokens), 0)       AS input_tokens,
       COALESCE(SUM(u.output_tokens), 0)      AS output_tokens,
       COALESCE(SUM(u.cache_read_tokens), 0)  AS cache_read_tokens,
       COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
       COALESCE(SUM(u.cost_micro), 0)         AS cost_micro
FROM usage_records u
LEFT JOIN api_keys k ON k.id = u.key_id
WHERE u.created_at >= ? AND u.created_at < ?
GROUP BY bucket
ORDER BY cost_micro DESC
```

**dashboard 契约:** `GET /admin/api/dashboard` →

```json
{
  "month_cost_micro": 0, "month_requests": 0,
  "settle_failures": 0,
  "top_models": [{"slug": "", "cost_micro": 0, "requests": 0}],
  "channels": [{"id": "", "name": "", "provider_type": "", "status": "", "cooldown_until": null, "weight": 1}],
  "daily": [{"date": "2026-06-12", "cost_micro": 0, "requests": 0}]
}
```

- 本月窗口起点 = `jobs::month_start_epoch(now)`;top_models 取本月 cost 前 5;daily 取近 30 天(`created_at >= now - 30*86400`,GROUP BY date 升序);`settle_failures = state.settle_failures.load(Ordering::Relaxed)`(P2 留的 Dashboard 告警口,本任务兑现)。

**audit 契约:**
- `GET /admin/api/audit/requests?key_id=&limit=&offset=` → `{rows:[{id,created_at,model_slug,key_label,cost_micro,status,request_body,response_body}]}`:`usage_records WHERE (request_body IS NOT NULL OR response_body IS NOT NULL)` + 可选 key_id 过滤,LEFT JOIN api_keys 取 key_label,created_at 降序;limit 缺省 50,**上限 100**(超传按 100),offset 缺省 0。
- `GET /admin/api/audit/events?limit=&offset=` → `{rows:[{id,actor_email,action,subject,detail,created_at}]}`:LEFT JOIN users 取 actor_email(系统事件 actor 为 null → actor_email null);同样分页上限。

- [ ] **Step 1: 写失败测试**。必测:
  1. reports 三维度各一发:手插 4 行 usage_records(两模型/两 Key/跨两天,含 cache tokens)断言聚合 sum 与排序;
  2. reports day 升序、model 按 cost 降序;时间窗过滤(窗外行不计);坏 dimension/缺 from → 400;
  3. reports key 维度:删除 Key 后 bucket 降级为 key_id;
  4. dashboard:本月内外各插一行,断言 month_* 只含本月;settle_failures 手动 `fetch_add(3)` 断言回显 3;top_models ≤5;daily 含今天日期字符串;
  5. audit/requests:无体的行不出现;key_id 过滤;limit=200 实际只回 ≤100;
  6. audit/events:T3 建一个用户后该接口能看到 `user.create` 事件与 actor_email。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**(Query 参数用 `#[derive(Deserialize)] struct` + `axum::extract::Query`;`date(created_at,'unixepoch')` 直接 SELECT 为 TEXT)
- [ ] **Step 4: 跑绿 + 三件套**
- [ ] **Step 5: Commit** `feat(rust): P3-T8 reports/dashboard/audit 查询 API(聚合报表 + 落账失败告警透出 + 双审计流)`

---

### Task 9: UI 基建(api client 全量 / 组件库 / AuthContext / 路由)

**Files:**
- Modify: `admin-ui/src/lib/api.ts`、`admin-ui/src/App.tsx`、`admin-ui/src/components/Layout.tsx`、`admin-ui/src/pages/Login.tsx`(接 AuthContext)
- Create: `admin-ui/src/lib/format.ts`、`admin-ui/src/components/ui.tsx`、`admin-ui/src/AuthContext.tsx`、`admin-ui/src/pages/` 下 9 个页面占位文件(导出标题 + 「加载中」骨架,T10–T12 填充)

- [ ] **Step 1: `lib/api.ts` 全量类型与方法**(`request<T>` 封装不动;全部方法签名如下,实现一行一个 `request` 调用,POST/PATCH 带 body):

```typescript
export interface User { id: string; email: string; role: string; status: string; created_at: number }
export interface Team { id: string; name: string; created_at: number; member_count: number }
export interface TeamDetail { id: string; name: string; created_at: number; members: TeamMember[] }
export interface TeamMember { user_id: string; email: string; role: 'owner' | 'member' }
export interface ApiKeyRow {
  id: string; key_prefix: string; name: string; owner_type: 'user' | 'team'; owner_id: string;
  owner_label: string; allowed_models: string[] | null; audit: boolean;
  expires_at: number | null; status: string; created_at: number;
}
export interface CreatedKey { plaintext: string; handout: string; gateway_url_configured?: boolean; key: ApiKeyRow }
export interface Channel {
  id: string; provider_type: 'openai' | 'anthropic'; name: string; base_url: string;
  weight: number; status: string; cooldown_until: number | null; cooldown_level: number; created_at: number;
}
export interface Model {
  id: string; slug: string; provider_type: 'openai' | 'anthropic'; upstream_model: string;
  input_price_micro: number; output_price_micro: number;
  cache_read_price_micro: number; cache_write_price_micro: number; status: string; created_at: number;
}
export interface Budget {
  id: string; subject_type: 'key' | 'user' | 'team'; subject_id: string; subject_label: string;
  period: 'monthly' | 'total'; limit_micro: number; used_micro: number; period_start: number;
  alert_threshold: number | null; status: string; created_at: number;
}
export interface SubjectOption { type: 'key' | 'user' | 'team'; id: string; label: string }
export interface ReportRow {
  bucket: string; requests: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; cost_micro: number;
}
export interface DashboardData {
  month_cost_micro: number; month_requests: number; settle_failures: number;
  top_models: { slug: string; cost_micro: number; requests: number }[];
  channels: Pick<Channel, 'id' | 'name' | 'provider_type' | 'status' | 'cooldown_until' | 'weight'>[];
  daily: { date: string; cost_micro: number; requests: number }[];
}
export interface AuditRequestRow {
  id: string; created_at: number; model_slug: string; key_label: string; cost_micro: number;
  status: string; request_body: string | null; response_body: string | null;
}
export interface AuditEventRow {
  id: string; actor_email: string | null; action: string; subject: string | null;
  detail: string | null; created_at: number;
}

export const api = {
  login, logout, me,                                  // 既有
  users: {
    list: () => request<{ users: User[] }>('/admin/api/users'),
    create: (b: { email: string; password: string; role?: string }) => post<User>('/admin/api/users', b),
    update: (id: string, b: { status?: string; role?: string }) => patch<User>(`/admin/api/users/${id}`, b),
  },
  teams: {
    list/create/detail/addMember/changeMemberRole/removeMember,
  },
  keys: { list/create/revoke/setAudit },
  channels: { list/create/update/rotate },
  models: { list/create/setStatus/remove },
  budgets: { list/subjects/create/update },
  reports: { query: (dimension, from, to) => request<{ rows: ReportRow[] }>(`/admin/api/reports?dimension=${dimension}&from=${from}&to=${to}`) },
  dashboard: () => request<DashboardData>('/admin/api/dashboard'),
  audit: { requests: (p: { key_id?: string; limit?: number; offset?: number }) => …, events: (p) => … },
};
```

(`post`/`patch`/`del` 是 `request` 的三个薄封装:`method` + `JSON.stringify(body)`。上面省略号处的实现都是同构一行,工程师按契约表补齐——T3–T8 的路由契约即是字段真值表。)

- [ ] **Step 2: `lib/format.ts`**

```typescript
/** micro-CNY → "¥1,234.56"(两位小数,千分位);明细场景 fmtMicroExact 保留到 6 位去尾零 */
export function fmtMicro(micro: number): string
export function fmtMicroExact(micro: number): string
/** epoch 秒 → "2026-06-12 14:30"(本地时区) */
export function fmtTime(epoch: number | null): string
/** epoch 秒 → 相对剩余("3 天后"/"已过期"),冷却倒计时用 */
export function fmtUntil(epoch: number | null): string
```

- [ ] **Step 3: `components/ui.tsx` 组件库**(全部用既有 token,签名如下;实现交给 implementer + frontend-design 技能,视觉规范:卡片 `bg-panel border border-line rounded-lg`、主按钮 neon 描边 + hover glow、状态色 active=neon/disabled=dim/cooldown=violet):

```typescript
export function PageHeader(p: { title: string; action?: ReactNode })
export function Card(p: { title?: string; className?: string; children })
export function Button(p: { variant?: 'primary' | 'ghost' | 'danger'; loading?: boolean; ... })
export function Input / Select / Toggle   // 受控,统一 label + 错误文案插槽
export function Table<T>(p: { columns: { key: string; title: string; render?: (row: T) => ReactNode }[]; rows: T[]; empty?: string })
export function Modal(p: { open: boolean; title: string; onClose: () => void; children })
export function Badge(p: { status: string })          // active/disabled/cooldown → 色彩映射
export function CopyButton(p: { text: string; label?: string })  // navigator.clipboard + "已复制"反馈
export function ErrorBar(p: { message: string | null }) // ApiError 文案统一展示
```

- [ ] **Step 4: `AuthContext.tsx`(遗留#6)**:`AuthProvider` 启动时打**一次** `/admin/api/me`,context 持 `{ me, loading, setMe }`;`Guard` 改读 context(不再每次挂载请求);Login 成功后 `setMe` 并跳转;Layout 顶部显示 `me.email`;api 层 401 时(非 login 接口)广播登出 → `setMe(null)`(`window.dispatchEvent` 或在 request 里挂回调,实现自选,保持简单)。

- [ ] **Step 5: `App.tsx` 全路由 + `Layout.tsx` NAV**:

```
/            Dashboard      /users   Users      /teams        Teams
/teams/:id   TeamDetail     /keys    Keys       /channels     Channels
/models      Models         /budgets Budgets    /reports      Reports
/audit       Audit
```

NAV 数组:总览/用户/团队/Key/渠道/模型/**预算**(P1 骨架漏列,补上)/报表/审计,全部 `ready: true`(占位页先渲染标题)。

- [ ] **Step 6: 验证 + Commit**:`cd admin-ui && npm run build` 过;`cargo test --locked` 不回退(assets 嵌入测试)。
  `feat(rust): P3-T9 admin-ui 基建——api 全量类型/组件库/AuthContext(me 缓存)/全路由`

---

### Task 10: UI 页面——用户 / 团队 / 渠道 / 模型

**Files:**
- Create(替换占位): `admin-ui/src/pages/Users.tsx`、`Teams.tsx`、`TeamDetail.tsx`、`Channels.tsx`、`Models.tsx`

**通用页面模式(Users.tsx 为范本,implementer 先写它,其余同构):** 顶部 `PageHeader`(标题 + 新建按钮)→ `ErrorBar` → `Table`;新建/编辑走 `Modal` 表单;每次变更后重拉列表(无乐观更新,内部工具从简);所有 ApiError.message 直接进 ErrorBar(后端文案已中文)。

各页详单(列/表单/交互,字段语义见 T3/T4/T6 契约表):

- **Users**:列 = 邮箱(mono)/角色 Badge/状态 Badge/创建时间/操作(停用|启用、设为管理员|降级)。新建表单:email、password、role(Select,默认 user)。自我操作的 403 文案由 ErrorBar 呈现。
- **Teams**:列 = 名称/成员数/创建时间/操作(进入详情)。新建:name。行点击 → `/teams/:id`。
- **TeamDetail**:面包屑返回;成员表(邮箱/角色 Badge/操作:设为 owner|member、移除);添加成员表单(email + role Select)。「团队至少保留一名 owner」走 ErrorBar。
- **Channels**:列 = 名称/类型 Badge(openai=neon, anthropic=violet)/base_url(mono)/权重/状态(cooldown 时 Badge 旁显示 `fmtUntil(cooldown_until)` 倒计时 + level)/操作(启用|停用、轮换凭证、改权重)。新建表单:provider_type、name、base_url(placeholder `https://api.openai.com/v1`)、credential(`type=password`,提示「提交后不再显示」)、weight。轮换凭证 = 独立 Modal,仅一个 password 输入。**任何地方不渲染凭证。**
- **Models**:列 = slug(mono)/类型/上游模型(mono)/四档价格(`fmtMicroExact`,表头注明 ¥/1M tokens)/状态/操作(启停、删除带 `confirm`)。新建表单:slug(placeholder `openai/gpt-4o`)、provider_type、upstream_model、四档价格(文本框,placeholder "0",说明「单位:元 / 1M tokens」)。

- [ ] **Step 1: 实现 Users.tsx(完整范本)→ Step 2: 其余四页同构展开 → Step 3: `npm run build` 过 → Step 4: 手工/Playwright 点检(T12 统一冒烟,本任务至少 build + dev 自查)→ Step 5: Commit**
  `feat(rust): P3-T10 admin-ui 用户/团队/渠道/模型页`

---

### Task 11: UI 页面——Key 签发向导 / 预算 / 报表

**Files:**
- Create(替换占位): `admin-ui/src/pages/Keys.tsx`、`Budgets.tsx`、`Reports.tsx`

- **Keys**(本任务核心,交互最重):
  - 列表列 = key_prefix(mono)/名称/归属(owner_label + owner_type Badge)/模型白名单(null=「不限」,否则 slug 数量 + title 悬浮全列)/audit Toggle(就地 PATCH)/过期(fmtTime 或「永不」)/状态/操作(吊销带 confirm)。
  - **签发向导 Modal**(单步表单即可,不必分步):name、owner_type(user|team Select,联动拉 `api.users.list`/`api.teams.list` 填 owner 下拉)、allowed_models(active models 多选 checkbox 组;全不选=不限)、audit Toggle、expires_at(`datetime-local`,可空,提交转 epoch)、预算区(limit_cny 文本 + period Select monthly|total;空=不建预算)。
  - **成功页(Modal 第二屏,关闭即丢)**:醒目警示「明文仅显示这一次」;plaintext 大号 mono + CopyButton;handout 滚动区(`<pre>` 原文)+「复制接入说明」CopyButton;`gateway_url_configured === false` 时顶部 violet 警告条「未配置 gateway_public_url,接入说明中的地址是占位值」。
- **Budgets**:列 = 主体(subject_label + type Badge)/周期/限额(fmtMicro)/已用(fmtMicro + 进度条:used/limit,>80% 变 violet、超限变红 `#f87171`——例外:超限红是语义色,允许这一个非 token 色,写入 ui.tsx 常量)/阈值/状态/操作(编辑、启停)。新建:subject(`api.budgets.subjects` 单下拉,label 带类型前缀)、period、limit_cny、alert_threshold(0~1,placeholder 0.8)。编辑 Modal:limit_cny、alert_threshold(留空=不动,点「清空」按钮=显式 null)。
- **Reports**:工具条 = 维度 Tab(模型|Key|按日)+ 时间快捷(今天/近 7 天/近 30 天/本月)+ 自定义 date 区间;汇总卡片行(总费用/总请求/总输入 tokens/总输出 tokens,前端对 rows 求和);表格(bucket/requests/四档 tokens/cost);**按日维度**追加纯 SVG 柱状图(宽度自适应、bar 渐变 neon→violet、hover title 显示日期+金额;手写 `<svg>`,不引图表库)。

- [ ] Steps 同 T10(实现 → build → 自查 → commit)
  `feat(rust): P3-T11 admin-ui Key 签发向导(明文一次性+handout)/预算/报表页`

---

### Task 12: UI 总览 + 审计页 + 全链路冒烟收口

**Files:**
- Modify: `admin-ui/src/pages/Dashboard.tsx`(重写占位)
- Create: `admin-ui/src/pages/Audit.tsx`
- Modify: `docs/superpowers/plans/rust-p1-followups.md`(划掉认领项)

- [ ] **Step 1: Dashboard.tsx**:`api.dashboard()` 单请求;布局 = 顶部三卡(本月费用 fmtMicro 大号 mono / 本月请求数 / 渠道健康 n/m active);`settle_failures > 0` 时页顶红色告警条「有 {n} 笔账单落库失败,请检查磁盘与日志」(P2 留的告警口在 UI 兑现);30 天费用 SVG 面积图(渐变填充 neon→透明);Top5 模型小表;渠道状态小表(Badge + 冷却倒计时)。
- [ ] **Step 2: Audit.tsx**:双 Tab。「请求审计」= key 过滤下拉(api.keys.list)+ 分页(上一页/下一页,offset 步进 limit=50)+ 表格(时间/模型/Key/费用/状态),行展开(`<details>`)显示 request_body/response_body `<pre>`(JSON 尝试 pretty,失败原样);「操作审计」= 表格(时间/操作者/action mono Badge/subject mono/detail `<code>`)+ 同款分页。
- [ ] **Step 3: `npm run build` + 三件套全绿。**
- [ ] **Step 4: 真二进制全链路冒烟**(参照 P2-T10 模式):

```bash
cargo build --locked
TMP=$(mktemp -d)
(cd "$TMP" && /path/to/target/debug/cloudllm init)   # 记下打印的初始管理员密码
(cd "$TMP" && /path/to/target/debug/cloudllm serve &)
```

Playwright(playwright MCP 工具)逐步断言:登录页渲染 → 登录成功进总览(卡片可见)→ 用户页建成员 → 渠道页建渠道(假 base_url `http://127.0.0.1:9/v1` 即可,不打上游)→ 模型页建模型 → Key 页签发(带白名单+预算)→ 成功屏出现 `sk-cloudllm-` 明文与 handout(断言含 `ANTHROPIC_BASE_URL`)→ 预算页可见该 Key 预算行 → curl 用该明文打一发 `/v1/chat/completions`(上游假地址,预期 502 `upstream_failed`,**但** usage_records 落 `status=upstream_error` 一行)→ 报表页按日维度出现该行计数 → 审计页操作流可见 key.create/channel.create 等事件 → 登出回登录页。
最后 `kill -TERM` 验证排水正常退出。

- [ ] **Step 5: 更新 `rust-p1-followups.md`**:#1/#2/#3/#4/#6 标注「P3 已处理(本计划)」;#5(ETag)/#7(probe 资产)与 P2-1..5、P2R-1..7 中本期未动项保留并补一行「P3 未认领,触发条件不变」;新增「P3 自身遗留」表(执行中产生的真实清单,至少包含:登录限速为内存态重启即清、XFF 可伪造取舍、UI 无自动化测试仅 Playwright 冒烟)。
- [ ] **Step 6: Commit** `feat(rust): P3-T12 总览/审计页 + 真二进制全链路冒烟 + 遗留清单更新`

---

## Self-Review 已做检查(写计划时核对过的事实)

1. **Spec §5 覆盖**:5.1 资源路由(T3–T8)、Key 签发单事务+handout(T5)、凭证只写不读+轮换重加密(T6)、报表 SQL 聚合(T8)、5.2 全部页面(T9–T12)、科技感视觉(token 约束 + frontend-design)、接入说明(T5/T11)。会话/防枚举 P1 已有;登录限速 T2 补强。
2. **Schema 一致性**:所有 SQL 列名逐一对照 `0001_init.sql`/`0002_gateway.sql`;无新迁移;`team_members` 无 created_at(别 SELECT 它);`api_keys.name NOT NULL`;`budgets.alert_threshold REAL` 可空。
3. **类型一致性**:`admin_session`/`authed_request`(T1)被 T3–T8 所有测试引用;`parse_cny_to_micro`(T1)被 T5/T6/T7 引用;`month_start_epoch`(T1 提公)被 T5/T7/T8 引用;`ApiError::forbidden/conflict`(T1)被 T3/T4/T6/T7 引用;audit action 表(T1)是 T2–T8 的唯一来源。
4. **已知风险**:axum 0.7 同方法多路由 merge 顺序无冲突(路径互不重叠);`COALESCE` 在 SQLite 对 `||`(NULL 传染)语义已用于 key_label 降级路径,测试 3/8 覆盖。
