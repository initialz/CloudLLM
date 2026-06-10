# 公司内部 BYOK / LLM 网关系统 — 设计文档

- 日期：2026-06-10
- 状态：设计已确认，待转实施计划
- 作者：Console 团队（brainstorming 产出）

## 1. 背景与目标

公司内部多个团队、应用和员工都在直接对接各家 LLM 供应商（OpenAI、Anthropic、国内厂商）。这带来三个问题：每处各自持有供应商凭证、成本分散无法统计管控、权限和额度无法集中分配。

本系统提供一个**统一的内部 LLM 网关**：内部所有调用方只连公司平台、不再直连供应商。公司在后台完成成本计算、用量统计、预算管控、权限分配、模型配置。前端按通用方式（参考 OpenRouter）设置模型使用方式即可。

### 核心目标

1. **统一接入**：调用方改一个 `base_url` + 一把内部 Key 即可使用，无需感知上游。
2. **集中管控**：按个人 / 团队 / 应用三级分配预算与权限，超限准实时截断。
3. **成本可见**：每次调用计量 token、计算成本、折算 CNY，按任意维度出报表。
4. **可审计**：可选记录请求内容用于审计与排障，带开关与保留期。
5. **少依赖、简洁**：纯 TypeScript 技术栈，运行期依赖仅 PostgreSQL + Redis。

## 2. 范围

### v1 纳入

- 对外协议端点：**OpenAI 兼容**（`/v1/chat/completions` 等）+ **Claude 原生**（`/v1/messages`）。
- 上游供应商：**OpenAI、Anthropic** 两家（同构透传，见 §4.1）。
- 三级组织模型：个人 / 团队 / 应用，预算逐级上卷。
- 预算硬限制 + 准实时截断。
- 多渠道路由 + 故障转移（同一模型可配多渠道，按优先级/权重路由，失败自动切换）。
- 用量计量、CNY 成本折算、按维度报表。
- 审计日志（可选记录 prompt/completion，按 Key/团队级开关 + TTL 清理）。
- 后台认证：独立账号（邮箱+密码），认证层抽象为接口，预留 SSO 扩展。
- 员工自助门户：申请 Key、查看用量；管理员审批与配置。

### v1 不做（明确推迟）

- **跨协议转换**（如用 OpenAI 协议调 Anthropic 上游）——v1 走同构透传，转换矩阵的非对角格子留空，按需再加。
- 国内厂商适配器（DeepSeek / 通义 / 豆包 / Kimi / 智谱）——架构预留，增量加适配器即可。
- 云平台托管模型（Bedrock / Vertex / Azure）——鉴权方式不同，推迟。
- SSO / SCIM 实际对接——仅预留接口。
- 充值/付款（EPay/Stripe 等）——内部成本分摊用记账即可，不做支付。
- 限流（RPM/TPM）——v1 仅做预算硬限，限流推迟。

## 3. 总体架构

控制面 / 数据面分离，两个独立部署单元，共享同一套业务库。

```
        调用方（Claude Code / OpenAI SDK / 业务应用）
           │ OpenAI 协议  或  Claude /v1/messages
           ▼
   ┌────────────────────────────┐    ┌──────────────────────┐
   │ Gateway（数据面，Hono/TS）    │    │ Console（控制面，Next.js）│
   │ ① 鉴权 ② 注入凭证           │    │ 三级组织 / 预算策略      │
   │ ③ 透传 ④ 计量+发用量事件    │    │ 自助门户 / 审批          │
   │ 副本 ×N，无状态             │    │ CNY 报表 / 审计查询      │
   │ 适配器：openai, anthropic    │    │ 渠道凭证 / 模型目录管理   │
   └───┬──────────────┬────────┘    └──────┬───────────────┘
       │ 转发          │ 用量事件             │ 直接读写
       ▼              ▼ (Redis Stream)      │
   上游供应商      ┌──────────┐  ┌──────────────────┐
   OpenAI         │ Redis     │  │ PostgreSQL        │
   Anthropic      │ 余额缓存   │  │ 组织/Key/预算/用量 │
                  │ 限额计数   │  │ /渠道/模型/审计    │
                  │ 用量队列   │  └──────────────────┘
                  └──────────┘
```

### 职责划分

| 能力 | 归属 |
|---|---|
| 协议端点（OpenAI 兼容 + `/v1/messages`） | Gateway |
| Key 鉴权、归属/白名单校验 | Gateway |
| 预算准实时截断（读 Redis 余额缓存） | Gateway |
| 渠道路由 / 故障转移 / 重试 | Gateway |
| 凭证注入、请求透传、流式回传 | Gateway |
| token 计量、成本计算、发用量事件 | Gateway |
| 三级组织模型、预算策略 | Console |
| 员工自助申请 Key / 审批 / 生命周期 | Console |
| 用量事件消费落库、报表（CNY 折算） | Console（worker + UI） |
| 审计内容日志（开关 + TTL 清理） | Console（worker + job） |
| 渠道凭证 / 模型目录管理 | Console |

**单一事实源**：业务库（PostgreSQL）是唯一事实源。Gateway 启动时加载配置（Key/渠道/模型/白名单）并支持热刷新；用量经 Redis Stream 异步回流由 Console worker 落库。两个服务都是自研、共享同一套库，因此无需外部引擎对账。

## 4. 关键设计决策

### 4.1 同构透传（v1 不写协议转换）

v1 的两个对外协议与两家上游一一对应：

```
OpenAI 协议请求   ──► OpenAI 上游     （格式一致，近乎原样转发）
Claude 协议请求   ──► Anthropic 上游  （格式一致，近乎原样转发）
```

因此 v1 数据面**不需要协议转换代码**。最难的部分（OpenAI ↔ Anthropic 格式互转、流式逐 chunk 重组）推迟到跨协议需求真实出现时再实现，届时只是"加一个转换器"，不影响已上线部分。

数据面 v1 只做四件事：**鉴权 → 注入凭证 → 透传（含流式 pipe）→ 计量**。

### 4.2 自研数据面而非引入 LiteLLM

调研对比了 LiteLLM（MIT）、new-api（AGPL）、Bifrost 等。结论：

- LiteLLM 开源版能覆盖数据面 + 基础 budget/team，但引入 Python 进程依赖与对账复杂度。
- new-api AGPL 传染、模型管控粒度不匹配。
- 用户诉求是**少依赖**。在 v1 范围被收窄到"两协议 + 两同构上游"后，自研数据面的工作量被压到很小（无协议转换），换来纯 TS 技术栈、依赖仅 PG+Redis、无外部引擎对账。

因此选择**自研最小数据面**。架构按"适配器 + 透传"组织，未来若数据面演变失控，仍可替换实现而不动控制面。

### 4.3 Key 只存哈希，渠道凭证用信封加密

方向不同：
- 调用方 Key：Gateway 只需**验证**，存 SHA-256 哈希比对即可；明文仅创建时展示一次，前 15 字符（`sk-wtg-` + 随机段前 8 位）明文留作后台识别。
- 上游渠道凭证：Gateway 需**还原明文**去调供应商，必须可逆 → 信封加密（数据密钥加密凭证、主密钥加密数据密钥，主密钥放 K8s Secret）。

### 4.4 预算上卷与准实时截断

每把 Key 归属一个主体（个人/团队/应用）；应用归属团队。一次消耗逐级计入：**Key 自身 → 归属主体 → 所在团队**。预算可设在任意层级，请求需通过路径上所有层级的余额检查才放行。

截断为**硬限制、准实时**：Gateway 在请求路径上读 Redis 缓存的各层剩余余额做快速判断，任一层 ≤ 0 即拒绝（OpenAI 端点返回 429，Claude 端点返回对应错误）。计费在请求后异步结算，允许少量超透（一般数分钟内收敛）。这是 OpenRouter / 多数平台的做法，避免同步扣减带来的延迟。

### 4.5 统一以 CNY 记账

业务库统一以 **CNY（精确到 0.000001 元）** 记账。海外厂商单价按系统配置的汇率折算录入，避免多币种混算。同时保留供应商原币种成本字段便于对账。

## 5. 数据模型（PostgreSQL）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | email, password_hash, role(admin/user), status | 认证层抽象为 AuthProvider 接口，预留 SSO |
| `teams` | name, status | 团队 |
| `team_members` | team_id, user_id, role(owner/admin/member) | 成员与角色 |
| `apps` | team_id, name, env(prod/dev), status | 生产应用主体，归属团队 |
| `api_keys` | owner_type(user/team/app)+owner_id, key_hash, prefix, allowed_models[], audit_enabled, expires_at, status | Key 只存哈希；audit_enabled 控制是否记录内容 |
| `budgets` | subject_type+subject_id, period(monthly/total), limit_amount_cny, used_amount_cny, period_start, alert_threshold | 月度自动重置或一次性总额 |
| `providers` | type(openai/anthropic), display_name | 供应商定义 |
| `channels` | provider_id, base_url, credential_encrypted, priority, weight, status(active/disabled/cooldown), cooldown_until | 渠道=供应商凭证实例，故障转移最小单元 |
| `models` | slug(`anthropic/claude-opus-4-8`), display_name, price_input/output/cache_read/cache_write（每百万 token，CNY）, context_length, capabilities[], status | 对外统一模型目录 |
| `model_channels` | model_id, channel_id, upstream_model_id, priority, weight | 模型↔渠道多对多映射 |
| `usage_records` | key_id, model_slug, channel_id, tokens(input/output/cache_read/cache_write), cost_cny, cost_src_currency, latency_ms, ttft_ms, status, error_code, created_at | 每请求一条，报表事实表 |
| `ledger_entries` | subject_type+subject_id, amount_cny, usage_record_id, balance_after_cny, created_at | 预算扣减流水账，可对账 |
| `request_logs` | usage_record_id, request_body(JSONB), response_body(JSONB), expires_at | 审计内容单独表，按开关写入，TTL 清理 |

**Redis 职责**：各层预算剩余余额热缓存（截断用）、渠道健康/冷却计时、用量事件缓冲队列（Redis Stream）。

## 6. 关键数据流

### 6.1 Key 签发（Console）

1. 员工/管理员在 Console 发起申请，选择归属主体与 `allowed_models`、过期时间。
2.（按策略）走审批流。
3. 生成 `sk-wtg-{random}`，存 `key_hash` + `prefix`，**明文仅展示一次**。
4. 写库即生效；Gateway 通过热刷新或首次命中加载该 Key。

### 6.2 请求热路径（Gateway）

```
收到请求（OpenAI 或 Claude 协议）
  → 解析 Key（sk-wtg-…），哈希比对，查归属/白名单/过期/状态
  → 读 Redis：Key / 归属主体 / 团队 三层剩余余额，任一 ≤0 → 拒绝
  → 选路：model_slug → model_channels 按 priority/weight 选渠道
            （跳过 cooldown 中的渠道）
  → 注入：解密渠道凭证，换 base_url
  → 转发：请求体近乎原样发往上游；流式响应 pipe 回调用方
  → 故障转移：上游错误/超时 → 标记渠道 cooldown → 尝试下一渠道
  → 计量：读响应/流末包 usage → 算 cost_cny
  → 扣减：Redis 三层余额递减
  → 发事件：用量事件写入 Redis Stream（含审计内容，若 audit_enabled）
```

### 6.3 用量回流（Console worker）

```
Redis Stream（用量事件）
  → Console worker 消费
  → 写 usage_records + ledger_entries
  → 更新 budgets.used_amount_cny（PG 为准，Redis 为热缓存）
  → 若 audit_enabled：写 request_logs（带 expires_at）
  → ack
```

**可靠性**：事件先入 Redis Stream 再消费，Console 重启/抖动不丢；消费失败可重试（消费组 + pending）。计费宁可延迟不可丢。

### 6.4 超限截断

Gateway 在热路径上读 Redis 缓存余额做准实时判断；扣减在请求后异步。Redis 余额由 worker 落库时校正，月度预算到期由定时任务重置 `period_start` 与计数。允许少量超透。

### 6.5 审计日志生命周期

`audit_enabled` 按 Key（可由团队策略下推）控制是否记录内容。`request_logs.expires_at` 由保留期策略写入；定时清理 job 按 `expires_at` 删除过期记录。

## 7. 技术栈

- **Gateway**：Node.js + Hono（轻量、流式友好）。无状态，水平扩展。
- **Console**：Next.js（App Router），含后台 UI + 用量消费 worker + 定时 job。
- **存储**：PostgreSQL（业务库）、Redis（缓存/计数/队列）。
- **语言**：全栈 TypeScript，Monorepo 管理，共享类型与数据访问层。
- **部署**：公司 K8s。

## 8. 部署拓扑（K8s）

```
              内网 Ingress
       ┌──────────┴──────────┐
 api.llm.公司.com        console.llm.公司.com
       ▼                     ▼
 Deployment: gateway    Deployment: console
 副本 ×3~N（随流量）     副本 ×2（含 worker）
 持有上游凭证            后台 UI + 消费 + job
       │  用量事件             │ 读写
       ▼                      ▼
   Redis                  PostgreSQL
```

- 两服务独立 Deployment：独立扩缩容、发布隔离（Console 发版不中断流式请求）、故障隔离、安全边界（Gateway 不暴露公网多余面，凭证集中）。
- 共享 PG/Redis 但逻辑边界清晰：Gateway 主要读配置 + 写 Redis 事件，Console 读写业务库 + 消费事件。

## 9. 安全

- Key 哈希存储；渠道凭证信封加密，主密钥置 K8s Secret。
- Gateway 网络策略：入站仅 Ingress，出站仅上游供应商。
- 审计内容默认关闭，按需开启，带 TTL；涉及隐私需脱敏策略（后续细化）。
- 后台 RBAC：admin / 团队 owner-admin-member 分级。

## 10. 后续演进（非 v1）

- 跨协议转换器（OpenAI ↔ Anthropic）。
- 增量接入国内厂商与云托管模型适配器。
- 限流（RPM/TPM）。
- SSO/SCIM 实际对接。
- 内部定价/加价倍率（按部门分摊）。

## 11. 待澄清 / 风险

- 审计内容脱敏策略的具体规则（v1 先做开关+TTL，脱敏规则后续细化）。
- 月度预算重置的时区与对齐（默认公司时区，月初 00:00）。
- 团队下是否需再分"部门"层级（当前不做，三级足够）。
