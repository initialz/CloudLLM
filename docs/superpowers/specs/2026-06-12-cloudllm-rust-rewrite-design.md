# CloudLLM v2 — Rust 一体化重写设计

日期:2026-06-12
状态:已与用户确认
取代:TS 版(apps/gateway + apps/worker + apps/console + packages/*),合并后 TS 代码从主干删除(git 历史保留)

## 0. 背景与决策

TS 版 v1.1 功能完整但架构偏重:pnpm monorepo 五个包、三个 Node 服务、依赖 PG 16 + Redis 7,部署需要三个 Deployment。用户判断:技术方案过于复杂、技术栈一般、界面平淡。

参考 `cloudcode`(本机 `workspaces/petez/cloudcode_dev/cloudcode`)的 hub 形态重写:**一个 Rust 二进制 + 一个 SQLite 文件,admin-ui 以 React SPA 形式经 rust-embed 内嵌**。

已确认的决策(用户拍板):

| 决策点 | 结论 |
|---|---|
| 存储/部署形态 | SQLite 单文件(WAL),零外部依赖,单实例 |
| 功能范围 | 与 TS 版 v1.1 全功能对等 |
| 仓库布局 | 同仓替换:Rust 进根目录,TS 版删除(历史可查) |
| 旧数据 | 不迁移,全新开始(上线时重建管理员、重发 Key) |
| admin-ui 路线 | React 18 + Vite + Tailwind,构建产物 rust-embed 内嵌 |
| 实施方式 | Opus 模型 + subagents(implementer + 双 review) |

明确不做(本版):多实例水平扩展、PG/Redis 兼容层、旧数据迁移脚本、协议转换(仍同构透传)、审批流。

## 1. 总体架构

```
./cloudllm serve --config cloudllm.toml
          │
  ┌───────┴──────────────────────────────────┐
  │  axum(单端口,默认 7100)                   │
  │   POST /v1/chat/completions ─┐            │
  │   POST /v1/messages ─────────┤ 网关透传    │
  │   GET  /healthz              │            │
  │   /admin/api/*  ── 管理 REST API(会话鉴权) │
  │   /admin/*      ── rust-embed React SPA   │
  │  tokio 后台任务:月度预算翻转、渠道冷却恢复、  │
  │                audit 体积清理              │
  └────────────────┬──────────────────────────┘
                   ▼
             cloudllm.db(SQLite,WAL,busy_timeout)
```

- **单端口**同时服务网关与管理面。生产上若需隔离,由 ingress 对 `/admin` 路径做来源限制;不在应用内做双端口(YAGNI)。
- **CLI**(clap):`cloudllm --init`(生成 cloudllm.toml + 建库 + 创建管理员并打印初始密码)、`cloudllm serve`、`cloudllm admin reset-password <email>`。
- **配置**(TOML):`listen`、`db_path`、`master_key`(32 字节 base64,渠道信封加密用)、`session_secret`(≥32 字符)、`gateway_public_url`(接入说明生成用)、上游超时参数。环境变量可覆盖同名配置(容器场景)。配置缺失/非法 → 启动即失败,不做运行期惰性校验(单进程启动路径,无 next build 那类构建期求值问题)。

## 2. 计费链路(与 TS 版的最大差异)

TS 版:网关 → Redis Stream(XADD)→ worker 消费组 → PG 落库 → DLQ/XAUTOCLAIM/幂等 event_id。该机制存在的唯一理由是跨进程传递;进程合一后整体删除。

Rust 版:**请求内同进程直接落库**。

- 响应(含流式)结束时,请求任务 spawn 一个 tokio 任务,在**单个 SQLite 事务**内完成:插入 `usage_records` + 对命中的预算行(key → 成员 → 团队,最多三行)累加 `used_amount_micro`。
- 事务即原子性,无需幂等 event_id、无需 DLQ。落库失败(磁盘满等)→ `tracing::error` + 进程内计数器,Dashboard 显示告警条。
- **预算检查**:请求前对三级预算各做一条索引 SELECT(主键/唯一索引命中,WAL 下读不阻塞)。超限 → 429,响应体格式对齐所在协议(OpenAI/Anthropic 错误格式)。不再有 Redis 热缓存,也不需要内存缓存(内部规模几十 QPS,SQLite 读是微秒级;若未来压测证明需要,再加 moka TTL 缓存——有压力数据才做)。
- **优雅停机**:axum graceful shutdown → 停止接收新请求 → 等待在途请求与落库任务排水(上限 30s)→ 关闭 SQLite 池。
- **月度翻转**:tokio interval 任务(对齐 TS 版 jobs.ts 语义):月度预算 `period_start` 跨月时重置 `used_amount_micro` 并更新 `period_start`;翻转与累加同走 budgets 行级事务,避免自锁(TS 版踩过的坑)。

## 3. 网关语义(逐条对等 TS 版)

以下语义是 TS 版历经多轮 review 锤炼的结果,Rust 版逐条保留:

1. **同构透传**:OpenAI 协议(`/v1/chat/completions`)只路由到 `provider.type=openai` 渠道;`/v1/messages` 只路由到 `anthropic` 渠道。模型 slug → models 表 → provider 匹配;协议与渠道不匹配 → 400;未知模型 → 404(且不污染任何缓存)。
2. **鉴权**:`Authorization: Bearer sk-cloudllm-…`(OpenAI 协议)/ `x-api-key`(Anthropic 协议)。SHA-256 哈希查 `api_keys`(indexed)。Key 停用/用户停用 → 401;模型白名单外 → 403 `model_not_allowed`。
3. **流式计量**:上游请求强制合并 `stream_options: {"include_usage": true}`(OpenAI 流式);SSE tap 解析末尾 usage 事件;客户端中断时仍以已读到的 usage 结算(无 usage 则按已传输内容估算输入侧,与 TS 版 SseUsageTap 语义一致)。
4. **故障切换与冷却**:同 provider 多渠道按权重选择;5xx/网络错误/超时 → 冷却该渠道(指数退避,落 `channels.cooldown_until`)并切换下一渠道;401/403(上游凭证失效)同样冷却切换;全部失败 → 502 `upstream_failed`,并照常落一条 `status=upstream_error` 的 usage 记录(零 token、零费用)。
5. **凭证**:渠道凭证 AES-256-GCM 信封解密(AAD = channel 行 UUID),仅在转发瞬间存活于内存。解密失败按渠道故障处理(冷却切换),不向客户端泄露细节。
6. **审计 Key**:`api_keys.audit=true` 的 Key,usage 记录附带请求/响应体(截断上限可配),`audit_events` 记录管理操作;audit 数据由后台任务按保留天数清理。
7. **请求头透传**:`anthropic-beta` 等白名单头原样透传;`Authorization`/`x-api-key` 替换为渠道凭证;其余敏感头剥离。
8. **计费**:micro-CNY(1 CNY = 1,000,000 micro)整数运算,逐行向上取整(ceil),与 TS 版 `computeCostCny` 同口径;价格来自 `models` 表(输入/输出/缓存读/缓存写四档单价)。

## 4. 数据模型(SQLite)

9 张表,金额一律 INTEGER(i64,micro-CNY;上限 ~9.2e18 micro ≈ 9.2 万亿 CNY),时间一律 INTEGER(unix epoch 秒):

- `users` — id(uuid text)、email(unique)、password_hash(argon2id)、role(admin/user)、status、created_at。仅 admin 可登录控制台(对齐 v1.1)。
- `teams` — id、name、created_at。
- `team_members` — team_id、user_id、role(owner/member),复合主键;保留「最后 owner 不可移除」约束(应用层)。
- `api_keys` — id、key_hash(sha256 hex, unique)、key_prefix(前 15 字符)、name、owner_type(user/team)、owner_id、allowed_models(JSON 数组或 NULL=全部)、audit(bool)、status、created_at。明文仅签发瞬间返回一次。
- `channels` — id(uuid,同时是信封 AAD)、provider_type(openai/anthropic)、name、base_url(必须以 /v1 结尾,应用层校验)、credential_encrypted(blob)、weight、status(active/disabled/cooldown)、cooldown_until。TS 版独立的 providers 表并入 channels 的 provider_type 字段(简化:v1.1 已确认只支持两家)。
- `models` — id、slug(unique,客户端可见)、provider_type、upstream_model(转发时替换的真实模型名)、四档单价(micro-CNY per 1M tokens,INTEGER)、status。
- `budgets` — id、subject_type(key/user/team)、subject_id、period(monthly/total)、limit_micro、used_micro、period_start、alert_threshold、status;(subject_type, subject_id, period) 唯一。
- `usage_records` — id、key_id、model_slug、channel_id、input/output/cache_read/cache_write tokens、cost_micro、latency_ms、ttft_ms、status(ok/rejected/upstream_error/client_abort)、error_code、request_body/response_body(仅 audit key,截断)、created_at。索引:(key_id, created_at)、(created_at)。
- `audit_events` — id、actor_user_id、action、subject、detail(JSON)、created_at。

迁移:`sqlx::migrate!` 内嵌 SQL 迁移文件,启动时自动执行(单进程无并发迁移问题)。

## 5. 管理面(REST API + 内嵌 SPA)

### 5.1 API(`/admin/api/*`)

- 会话:email + password 登录(argon2 校验),HMAC 签名 cookie(`cloudllm_session`,7 天),middleware 校验 + 每请求回查用户 status/role(停用/降级即时生效,对齐 TS 版 requireUser 语义)。登录失败统一报「邮箱或密码错误」(防枚举)。
- 资源路由:users / teams / keys / channels / models / budgets / reports / audit 的 CRUD 与查询。Key 签发 = 单事务(建 key + 建预算),响应一次性返回明文 + 接入说明 Markdown(buildHandout 语义移植:网关地址、各平台配置示例、`sk-cloudllm-` 前缀)。
- 渠道凭证:只写不读(提交后 UI 不再展示);轮换 = 重新信封加密。
- 报表:按 key/成员/团队/模型聚合用量与费用,时间窗参数;SQL 聚合直出(SQLite 聚合对内部数据量足够)。

### 5.2 admin-ui(React SPA)

- 栈:React 18 + Vite + Tailwind + react-router;构建产物 `admin-ui/dist` 经 rust-embed(`debug-embed`)打进二进制;`/admin/assets/*` 长缓存哈希资源,其余 `/admin/*` 回退 index.html(SPA 深链接,照搬 cloudcode assets.rs 模式)。
- 页面:登录、Dashboard(费用/用量趋势图、各团队消耗、渠道健康)、用户、团队(含成员管理)、Key(签发向导 + 接入说明一键复制)、渠道、模型价格、报表、审计。
- 视觉:**暗色优先「科技感」**——深底(near-black)+ 霓虹强调色(青/紫渐变)、数字与 Key 等宽字体、卡片细描边 + 微光、SVG 实时图表;中文界面。实现阶段用 frontend-design 技能打磨,明确避开「默认 Tailwind 灰白后台」的平淡感。
- 开发体验:`npm run dev` 起 Vite dev server,proxy `/admin/api` 到本地 cloudllm 进程;生产构建无 Node 运行时依赖。

## 6. 技术栈与代码布局

依赖对齐 cloudcode 已验证的组合:`axum 0.7 / tokio / sqlx(sqlite, runtime-tokio) / tower-http / rust-embed / argon2 / aes-gcm / sha2 / hmac / clap / tracing / reqwest(stream, rustls) / serde / uuid / chrono / rand`。

单 crate(lib + bin),仓库根:

```
Cargo.toml
src/
  main.rs            # clap:init / serve / admin 子命令
  lib.rs
  config.rs          # TOML + env 覆盖,启动即校验
  db.rs              # SqlitePool(WAL、busy_timeout、外键开)+ migrate
  crypto.rs          # AES-256-GCM 信封(AAD 必填)、argon2、HMAC 会话、sha256 key hash
  auth.rs            # API key 鉴权(数据面)+ 会话鉴权(管理面)
  gateway/
    mod.rs           # /v1 路由、协议判定、预算检查、429/404/400 语义
    upstream.rs      # 渠道选择、forward_with_failover、冷却
    sse_tap.rs       # 流式转发 + usage 提取 + 中断结算
  billing.rs         # 费用计算(micro-CNY ceil)、usage 落库事务、预算累加
  jobs.rs            # 月度翻转、冷却恢复、audit 清理(tokio interval)
  admin/
    mod.rs
    api.rs           # REST 路由与 handler
    assets.rs        # rust-embed SPA 服务
    handout.rs       # 接入说明 Markdown 生成
  audit.rs
migrations/          # sqlx 迁移 SQL
admin-ui/            # React SPA(独立 npm 工程,构建期产物被 embed)
deploy/              # Dockerfile、K8s 单 Deployment + PVC、README
```

预计规模:Rust ~10k 行 + UI ~5k 行(参照 cloudcode hub 11.3k + 5.5k)。

## 7. 错误处理原则

- 客户端可见错误体严格对齐所在协议(OpenAI `{"error":{...}}` / Anthropic `{"type":"error",...}`),错误码沿用 TS 版词汇(`invalid_api_key` / `model_not_allowed` / `budget_exceeded` / `upstream_failed` …)。
- 上游/内部细节(渠道名、解密失败原因)只进 tracing 与 audit,不出网关。
- 落库失败不影响已完成的响应,但必须可观测(错误日志 + Dashboard 告警计数)。
- 所有 panic 路径视为 bug;handler 层用 Result 贯穿,`unwrap` 仅允许在启动期。

## 8. 测试策略

- **单元/集成(Rust)**:sqlx `sqlite::memory:` 每用例独库;wiremock 模拟上游(流式 SSE、5xx、401、慢响应、无 usage 中断)。覆盖语义对齐 TS 版全部既有用例(132+)的关键面:计费对账精确到 micro、429 截断、故障切换冷却、流中断结算、月度翻转不自锁、最后 owner 不可移除、停用用户会话即失效、信封 AAD 不匹配拒解密。
- **admin-ui**:lib 层(api client、格式化)vitest;页面级以手工 + Playwright 冒烟为主(沿用现状,UI 自动化仍是已知 backlog)。
- **验收**:docker 构建单镜像,干净环境起容器跑 e2e 脚本(真实 OpenAI/Anthropic mock 或低额真实渠道),对账一致后才算交付——延续 verification-before-completion 纪律。

## 9. 交付物

- 多阶段 Dockerfile:`node:22 构建 admin-ui` → `rust:1-slim 构建(SQLX_OFFLINE=true,查询元数据随仓库提交)` → 运行层 `debian-slim/distroless`,单镜像。
- `docker-compose.dev.yml` 缩成单服务(或直接 `cargo run`,compose 仅为统一入口保留)。
- K8s:单 Deployment + PVC(挂 `/data/cloudllm.db`)+ Service + Ingress;replicas 固定 1(SQLite 单写者),文档明确说明。
- README 重写:安装(curl 脚本可选)、`--init` 初始化、配置说明、备份(拷 .db 文件)、从 TS 版迁移说明(= 重建管理员 + 重发 Key)。
- CI:cargo fmt --check / clippy -D warnings / cargo test + admin-ui tsc/vitest/build。

## 10. 实施阶段划分(供 writing-plans 细化)

1. **P1 骨架**:Cargo 工程、config/--init、db+迁移、crypto、admin 登录会话、SPA 嵌入壳、CI。
2. **P2 数据面**:鉴权、路由、透传、SSE tap、故障切换冷却、预算检查、计费落库、后台任务。
3. **P3 管理面**:全部 REST API + admin-ui 全页面(科技感视觉)+ 接入说明。
4. **P4 替换交付**:删 TS 版、Dockerfile/K8s/README、e2e 验收、合并 main。

实施约束(用户要求):写代码使用 **Opus 模型 + subagents**,沿用本项目 implementer + spec-review + quality-review 的每任务三角流程。
