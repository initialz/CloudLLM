# BYOK 网关 Phase 4:Console UI + 部署交付 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `apps/console`(Next.js 后台:登录/组织/Key 自助/预算/渠道与模型/报表/审计)与完整部署物(三个 Dockerfile、生产 docker compose、README),完成 v1 全部范围。

**Architecture:** Next.js 15 App Router + Server Actions(无独立 API 层,管理操作直接 server action 落库);drizzle 直连业务库(与 gateway/worker 共享 @byok/db);cookie 会话(HMAC 签名,scrypt 校验密码),AuthProvider 抽象预留 SSO;RBAC 两级:系统 admin / 普通 user(团队内 owner/admin/member 控制团队资源)。UI 用 Tailwind v4,不引组件库(YAGNI)。

**计划粒度说明(有意取舍):** 安全/钱相关的代码(会话、Key 签发、渠道加密、报表 SQL、Dockerfile/compose)给**完整代码**;常规 CRUD 页面给**文件清单 + 行为规格 + 验收断言**(标准 Next.js 模式,实现者按既有代码风格自由发挥,规格审查按行为规格验收)。这是对"No Placeholders"的有界放宽,理由:UI 样板代码逐行预写反而增加 drift 风险。

**Tech Stack:** Next.js ^15、React 19、Tailwind ^4、@byok/db、@byok/shared、Vitest(纯函数部分)。

**前置事项来源:** docs/superpowers/plans/phase4-prerequisites.md(全部纳入,Task 1 与 Task 8/9 落地)。

---

### Task 1: CI 加 PG+Redis services + claimStale 真 Redis 测试 + worker 清理

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `apps/worker/src/consumer.integration.test.ts`
- Modify: `apps/worker/src/process-event.test.ts`、`apps/worker/src/jobs.test.ts`(去 skipIf,改读 env)
- Modify: `apps/worker/package.json`(删 ioredis-mock devDep)
- Modify: `apps/worker/src/config.ts`(数值范围校验)

- [ ] **Step 1: CI services**

`.github/workflows/ci.yml` 的 job 加:

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: byok
          POSTGRES_PASSWORD: byok_dev
          POSTGRES_DB: byok
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U byok" --health-interval 5s
          --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
```

并在 `pnpm test` 步骤前加迁移步骤:

```yaml
      - run: pnpm --filter @byok/db migrate
        env:
          DATABASE_URL: postgres://byok:byok_dev@localhost:5432/byok
      - run: pnpm test
        env:
          DATABASE_URL: postgres://byok:byok_dev@localhost:5432/byok
          REDIS_URL: redis://localhost:6379
```

- [ ] **Step 2: 去 skipIf**

`process-event.test.ts` 与 `jobs.test.ts`:`describe.skipIf(!!process.env.CI)` 改为 `describe`(CI 现在有 PG);DB_URL 常量保持 env 优先。

- [ ] **Step 3: claimStale 真 Redis 集成测试(TDD:本地真 Redis 跑)**

`apps/worker/src/consumer.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { UsageConsumer } from "./consumer.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("UsageConsumer(真 Redis)", () => {
  const redis = new Redis(REDIS_URL);
  afterAll(async () => {
    await redis.quit();
  });

  it("失败→pending→claimStale 重试成功;超限→DLQ", async () => {
    const stream = `t_${randomUUID().slice(0, 8)}`;
    let failures = 0;
    // maxDeliveries=2:第 1 次消费失败 + 第 1 次 claim 重试失败 → 第 2 次 claim 时投递数 3 > 2 → DLQ
    const flaky = new UsageConsumer(
      { redis, stream, group: "g", consumer: "c1", maxDeliveries: 2 },
      async () => {
        failures++;
        throw new Error("always fail");
      },
    );
    await flaky.ensureGroup();
    await redis.xadd(stream, "*", "payload", "p");
    await flaky.consumeOnce(0); // 第 1 次投递,失败留 pending
    expect(failures).toBe(1);

    await flaky.claimStale(0); // 第 2 次投递,仍失败
    expect(failures).toBe(2);

    await flaky.claimStale(0); // 投递数已 3 > maxDeliveries=2 → 直接送 DLQ,不再调 handler
    expect(failures).toBe(2);
    const dlq = await redis.xrange(`${stream}_dlq`, "-", "+");
    expect(dlq).toHaveLength(1);
    const pending = (await redis.xpending(stream, "g")) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);

    // 成功路径:新事件 → claim 后由成功 handler 处理并 ack
    const ok = new UsageConsumer(
      { redis, stream, group: "g", consumer: "c2", maxDeliveries: 5 },
      async () => "ok",
    );
    await redis.xadd(stream, "*", "payload", "p2");
    await ok.consumeOnce(0);
    const pending2 = (await redis.xpending(stream, "g")) as [number, ...unknown[]];
    expect(pending2[0]).toBe(0);

    await redis.del(stream, `${stream}_dlq`);
  });
});
```

(若 xpending 概要返回结构与断言不符,按真实结构适配断言;本测试在本地与 CI 都跑。)

- [ ] **Step 4: worker 清理**

- `apps/worker/package.json` 删除 `ioredis-mock`(consumer.test.ts 已用 stub,不再引用)。
- `config.ts` 的 `num()` 后追加范围校验:

```ts
  const positive = (name: string, v: number): number => {
    if (v <= 0) throw new Error(`环境变量 ${name} 必须为正数,得到: ${v}`);
    return v;
  };
```

对 maxDeliveries/jobIntervalMs/auditRetentionDays/balanceTtlSeconds 套用 `positive("MAX_DELIVERIES", num(...))` 等;config.test.ts 加一例:`MAX_DELIVERIES: "0"` 抛错。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm install && pnpm --filter @byok/worker test`(本地 PG+Redis 全跑,18 用例)`pnpm test && pnpm typecheck`。

```bash
git add .github apps/worker
git commit -m "ci+fix(worker): CI services、claimStale 真 Redis 覆盖、依赖清理与配置校验"
```

(推送后确认 GitHub Actions 全绿——集成测试首次在 CI 真跑。)

---

### Task 2: Console 脚手架 + 会话认证(完整代码)

**Files:**
- Create: `apps/console/package.json`、`next.config.ts`、`tsconfig.json`、`postcss.config.mjs`、`src/app/globals.css`、`vitest.config.ts`
- Create: `apps/console/src/lib/db.ts`(单例 createDb)
- Create: `apps/console/src/lib/session.ts`(HMAC cookie 会话,**完整代码如下**)
- Create: `apps/console/src/lib/auth.ts`(login/logout/requireUser/requireAdmin server 辅助)
- Create: `apps/console/src/app/login/page.tsx` + `src/app/login/actions.ts`
- Create: `apps/console/src/app/layout.tsx`(导航壳:登录态显示菜单)
- Create: `apps/console/src/middleware.ts`(未登录跳 /login)
- Test: `apps/console/src/lib/session.test.ts`

**session.ts(完整代码,核心安全件):**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionData {
  userId: string;
  role: "admin" | "user";
  /** epoch 秒 */
  exp: number;
}

const ALG = "sha256";

function sign(payloadB64: string, secret: string): string {
  return createHmac(ALG, secret).update(payloadB64).digest("base64url");
}

/** 编码为 `payloadB64.sig` 的 cookie 值;exp 由调用方给出 */
export function encodeSession(data: SessionData, secret: string): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 校验签名与有效期;无效返回 null */
export function decodeSession(cookieValue: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): SessionData | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
    if (typeof data.userId !== "string" || (data.role !== "admin" && data.role !== "user") || typeof data.exp !== "number") return null;
    if (data.exp <= nowSec) return null;
    return data;
  } catch {
    return null;
  }
}
```

**session.test.ts(TDD 先行):**

```ts
import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession } from "./session.js";

const secret = "test-secret-32-chars-aaaaaaaaaaaa";

describe("session", () => {
  it("编码后可解回", () => {
    const v = encodeSession({ userId: "u1", role: "admin", exp: 9999999999 }, secret);
    expect(decodeSession(v, secret)).toEqual({ userId: "u1", role: "admin", exp: 9999999999 });
  });
  it("签名被篡改返回 null", () => {
    const v = encodeSession({ userId: "u1", role: "user", exp: 9999999999 }, secret);
    expect(decodeSession(`${v.slice(0, -2)}xx`, secret)).toBeNull();
    expect(decodeSession(v, "another-secret-32-chars-bbbbbbbb")).toBeNull();
  });
  it("过期返回 null;畸形返回 null", () => {
    const v = encodeSession({ userId: "u1", role: "user", exp: 1 }, secret);
    expect(decodeSession(v, secret)).toBeNull();
    expect(decodeSession("garbage", secret)).toBeNull();
    expect(decodeSession(undefined, secret)).toBeNull();
  });
});
```

**auth.ts 行为规格(完整实现由实现者写,签名固定):**
- `login(email, password)`:users 表查 active 用户 → `verifyPassword` → 设 cookie `byok_session`(httpOnly、sameSite=lax、secure=生产、maxAge 7d,值=encodeSession,exp=now+7d);失败返回错误字符串(不区分"用户不存在/密码错")。
- `logout()`:清 cookie。
- `requireUser()`:读 cookie+decodeSession,无效 `redirect("/login")`;返回 SessionData。
- `requireAdmin()`:requireUser 后 role!=="admin" 则 `redirect("/")`。
- SESSION_SECRET 来自 env(必填,≥32 字符,启动校验)。AuthProvider 预留:login 内部凭证校验封装成 `verifyCredentials(email, password)` 单独函数,SSO 未来替换该函数。

**middleware.ts 规格:** 除 `/login`、`/_next`、静态资源外,无有效会话 cookie 一律 redirect /login(middleware 里只做"cookie 存在性"轻检查,真校验在 server 端 requireUser——Edge runtime 无 node:crypto 的约束下这样划分)。

**布局规格:** 左侧导航:概览 / 我的 Key / 用量报表;admin 额外:用户 / 团队 / 预算 / 渠道 / 模型 / 审计。右上显示邮箱 + 退出。

- [ ] Steps: 脚手架 → session TDD(fail→pass)→ auth/login/middleware/layout → `pnpm --filter @byok/console build` 通过 + 手工验证登录(本地 PG 的 admin@example.com)→ Commit `feat(console): 脚手架与会话认证`

---

### Task 3: Key 自助管理(签发是安全关键,完整代码)

**Files:**
- Create: `apps/console/src/app/keys/page.tsx`(列表)+ `src/app/keys/actions.ts`
- Create: `apps/console/src/lib/keys.ts`(纯逻辑,**完整代码**)
- Test: `apps/console/src/lib/keys.test.ts`

**keys.ts(完整代码):**

```ts
import { and, eq } from "drizzle-orm";
import { apiKeys, type Db } from "@byok/db";
import { generateApiKey } from "@byok/shared";

export interface CreateKeyInput {
  ownerType: "user" | "team" | "app";
  ownerId: string;
  name: string;
  /** null = 不限 */
  allowedModels: string[] | null;
  auditEnabled: boolean;
  expiresAt: Date | null;
}

/** 签发 Key:返回明文(仅此一次)与行 id */
export async function createApiKey(db: Db, input: CreateKeyInput): Promise<{ plaintext: string; id: string }> {
  const k = generateApiKey();
  const rows = await db
    .insert(apiKeys)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      keyHash: k.keyHash,
      keyPrefix: k.keyPrefix,
      name: input.name || null,
      allowedModels: input.allowedModels,
      auditEnabled: input.auditEnabled,
      expiresAt: input.expiresAt,
    })
    .returning({ id: apiKeys.id });
  return { plaintext: k.plaintext, id: rows[0]!.id };
}

/** 撤销:仅状态翻转,不删行(usage_records 软引用历史) */
export async function revokeApiKey(db: Db, keyId: string, ownerGuard: { ownerType: string; ownerId: string } | null): Promise<boolean> {
  const conds = [eq(apiKeys.id, keyId)];
  if (ownerGuard) {
    conds.push(eq(apiKeys.ownerType, ownerGuard.ownerType as "user" | "team" | "app"));
    conds.push(eq(apiKeys.ownerId, ownerGuard.ownerId));
  }
  const rows = await db
    .update(apiKeys)
    .set({ status: "revoked" })
    .where(and(...conds))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
```

**keys.test.ts(真 PG 集成,4 用例):** 签发后明文可哈希匹配库内 keyHash、前缀 15 字符;revoke 翻转 status 且 updatedAt 变化($onUpdate 生效的回归验证);带 ownerGuard 时他人 Key revoke 返回 false;allowedModels null 落库为 NULL。

**页面/Action 行为规格:**
- 普通用户:仅见 `ownerType=user, ownerId=自己` 的 Key;可创建(选 allowedModels 多选自 models 表 active slug、可选过期时间)、可撤销自己的。
- admin:可为任意主体(user/team/app 下拉)签发,可撤销任何 Key,可切换 auditEnabled。
- 创建成功后弹出一次性明文展示(刷新即不可再见),复制按钮。
- 列表列:prefix、name、归属、状态、创建时间、过期时间、audit 标志。

- [ ] Steps: keys.ts TDD → action/页面 → build + 手工验证(创建的 Key 用 curl 打一次 gateway 200)→ Commit `feat(console): Key 自助签发与撤销`

---

### Task 4: 组织管理(users/teams/apps,CRUD 规格)

**Files:**
- Create: `apps/console/src/app/admin/users/page.tsx` + actions.ts
- Create: `apps/console/src/app/teams/page.tsx`、`src/app/teams/[id]/page.tsx` + actions.ts

**行为规格:**
- `/admin/users`(requireAdmin):列表(email/role/status/创建时间);创建用户(email+初始密码,hashPassword);停用/启用;改 role。不可停用自己。
- `/teams`:登录用户见自己所属团队;admin 见全部 + 可建团队。
- `/teams/[id]`:成员列表(角色管理:owner/admin/member;仅 team owner/admin 或系统 admin 可改);应用列表(创建 app:name+env;停用);团队内 app 的 Key 入口链接到 /keys 预筛。权限:成员管理操作校验操作者是该团队 owner/admin 或系统 admin(server action 内查 team_members)。
- 全部 server action 内做权限校验(不依赖前端隐藏)。

**验收断言(规格审查依据):** 非 admin 访问 /admin/users 被 redirect;非团队管理员调成员管理 action 返回错误;创建的用户能登录。

- [ ] Steps: 实现 → build → 手工验证三条验收 → Commit `feat(console): 用户/团队/应用组织管理`

---

### Task 5: 预算管理(CRUD 规格 + 校验规则)

**Files:**
- Create: `apps/console/src/app/admin/budgets/page.tsx` + actions.ts

**行为规格:**
- requireAdmin。按主体(类型+选择器:user 邮箱/团队名/应用名/Key prefix)列出现有预算;创建/编辑:period(monthly/total)、limit(正数,≤6 位小数,复用 `cnyToMicro` 校验——非法即拒)、alert_threshold(0~1 可空);停用。
- 同一主体可同时有 monthly+total(唯一索引含 period,创建重复 period 给清晰错误)。
- monthly 创建时 period_start=本月初(`date_trunc('month', now())`)。
- 显示 used_amount 与剩余(limit-used,负数标红=已超透)。

**验收断言:** limit="abc"/负数被拒;重复 (主体,period) 给业务错误而非 500;创建后 gateway 下一请求(余额缓存过期后)生效。

- [ ] Steps: 实现 → build → 验收 → Commit `feat(console): 预算管理`

---

### Task 6: 渠道与模型管理(加密路径完整代码)

**Files:**
- Create: `apps/console/src/lib/channels.ts`(**完整代码**)
- Create: `apps/console/src/app/admin/channels/page.tsx` + actions.ts
- Create: `apps/console/src/app/admin/models/page.tsx` + actions.ts
- Test: `apps/console/src/lib/channels.test.ts`

**channels.ts(完整代码——前置事项 #3 的强制约定落在这里):**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { channels, type Db } from "@byok/db";
import { encryptSecret } from "@byok/shared";

export interface CreateChannelInput {
  providerId: string;
  name: string;
  baseUrl: string;
  /** 上游明文凭证,仅在本函数内存活 */
  credential: string;
}

/** 创建渠道:应用侧生成 UUID 作为信封加密 AAD(必须先有 id 再加密,见 spec §4.3) */
export async function createChannel(db: Db, masterKey: string, input: CreateChannelInput): Promise<string> {
  if (!/^https?:\/\/.+\/v1$/.test(input.baseUrl.replace(/\/$/, ""))) {
    throw new Error("baseUrl 必须以 /v1 结尾(如 https://api.openai.com/v1)");
  }
  const id = randomUUID();
  await db.insert(channels).values({
    id,
    providerId: input.providerId,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    credentialEncrypted: encryptSecret(input.credential, masterKey, id),
  });
  return id;
}

/** 轮换凭证:复用原行 id 作 AAD */
export async function rotateChannelCredential(db: Db, masterKey: string, channelId: string, credential: string): Promise<void> {
  await db
    .update(channels)
    .set({ credentialEncrypted: encryptSecret(credential, masterKey, channelId) })
    .where(eq(channels.id, channelId));
}
```

**channels.test.ts(真 PG,3 用例):** 创建后 `decryptSecret(credentialEncrypted, master, 行id)` 能解回原文(AAD 闭环);baseUrl 不带 /v1 抛错;rotate 后旧密文失效新密文可解。

**页面规格:**
- `/admin/channels`:列表(name/provider/baseUrl/status/cooldown);创建(provider 下拉/凭证输入框 type=password 提交后绝不回显);停用/启用;轮换凭证。**不展示** channels 表的 priority/weight 列(网关未用,见前置 #3)。
- `/admin/models`:模型目录 CRUD(slug 唯一、四项价格用 cnyToMicro 校验、context_length、status);**模型↔渠道映射**子表(model_channels:选渠道、upstream_model_id、priority、weight——这里的才生效)。

**验收断言:** 新建渠道+模型+映射后,gateway(目录缓存 30s 过期后)能路由成功;凭证在任何响应/HTML 中不出现。

- [ ] Steps: channels.ts TDD → 页面 → build → 验收(用 fake-upstream 实测)→ Commit `feat(console): 渠道与模型管理`

---

### Task 7: 用量报表 + 审计查询(SQL 完整代码)

**Files:**
- Create: `apps/console/src/lib/reports.ts`(**完整代码**)
- Create: `apps/console/src/app/page.tsx`(概览)
- Create: `apps/console/src/app/usage/page.tsx`(报表)
- Create: `apps/console/src/app/admin/audit/page.tsx`(审计)
- Test: `apps/console/src/lib/reports.test.ts`

**reports.ts(完整代码):**

```ts
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { apiKeys, requestLogs, usageRecords, type Db } from "@byok/db";

export interface UsageFilter {
  from: Date;
  to: Date;
  /** 限定 Key 集(普通用户=自己的 Key id 列表;admin 可空=全部) */
  keyIds: string[] | null;
}

export interface UsageRow {
  bucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costCny: string;
}

/** 按维度聚合用量;dimension: model_slug | key_id | day */
export async function aggregateUsage(db: Db, filter: UsageFilter, dimension: "model" | "key" | "day"): Promise<UsageRow[]> {
  const bucketExpr =
    dimension === "model"
      ? sql<string>`${usageRecords.modelSlug}`
      : dimension === "key"
        ? sql<string>`${usageRecords.keyId}::text`
        : sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt}), 'YYYY-MM-DD')`;

  const conds = [gte(usageRecords.createdAt, filter.from), lt(usageRecords.createdAt, filter.to)];
  if (filter.keyIds !== null) {
    if (filter.keyIds.length === 0) return [];
    conds.push(inArray(usageRecords.keyId, filter.keyIds));
  }

  const rows = await db
    .select({
      bucket: bucketExpr,
      requests: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::int`,
      costCny: sql<string>`coalesce(sum(${usageRecords.costCny}), 0)::text`,
    })
    .from(usageRecords)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(desc(sql`sum(${usageRecords.costCny})`));
  return rows;
}

/** 当前用户可见的 Key id 列表(admin 返回 null=不限) */
export async function visibleKeyIds(db: Db, userId: string, isAdmin: boolean): Promise<string[] | null> {
  if (isAdmin) return null;
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.ownerType, "user"), eq(apiKeys.ownerId, userId)));
  return rows.map((r) => r.id);
}

/** 审计日志分页查询(admin only;join usage_records 取上下文) */
export async function queryAuditLogs(db: Db, opts: { keyId?: string; limit: number; offset: number }) {
  const conds = opts.keyId ? [eq(usageRecords.keyId, opts.keyId)] : [];
  return db
    .select({
      id: requestLogs.id,
      createdAt: requestLogs.createdAt,
      expiresAt: requestLogs.expiresAt,
      modelSlug: usageRecords.modelSlug,
      keyId: usageRecords.keyId,
      costCny: usageRecords.costCny,
      requestBody: requestLogs.requestBody,
      responseBody: requestLogs.responseBody,
    })
    .from(requestLogs)
    .innerJoin(usageRecords, eq(usageRecords.id, requestLogs.usageRecordId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(requestLogs.createdAt))
    .limit(Math.min(opts.limit, 100))
    .offset(opts.offset);
}
```

**reports.test.ts(真 PG,3 用例):** 造 2 个 Key 各 2 条记录 → 按 model/day 聚合数字正确(成本求和精确到 6 位);keyIds 过滤生效;keyIds=[] 返回空。

**页面规格:**
- `/`(概览):本月总成本、请求数、Top5 模型(aggregateUsage day+model 拼装);普通用户限自己 Key。
- `/usage`:时间范围选择(默认近 7 天)+ 维度切换(模型/Key/天)表格;成本列 CNY 6 位小数。台账符号注意:本页只读 usage_records(恒正);若未来展示 ledger 需容负数(注释提醒)。
- `/admin/audit`:requireAdmin;按 Key 筛选,分页;request/response JSON 折叠展示;顶部显著提示内容敏感+保留期。

- [ ] Steps: reports.ts TDD → 页面 → build → 手工验收(对照 e2e 已落库数据)→ Commit `feat(console): 报表与审计查询`

---

### Task 8: 部署交付(Dockerfile ×3 + 生产 compose + README,完整代码)

**Files:**
- Create: `apps/gateway/Dockerfile`、`apps/worker/Dockerfile`、`apps/console/Dockerfile`
- Create: `deploy/docker-compose.prod.yml`
- Create: `deploy/.env.prod.example`
- Create: `README.md`(部署与使用文档)
- Modify: `apps/console/next.config.ts`(`output: "standalone"`)

**gateway Dockerfile(worker 同构,改 filter 与入口):**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
RUN pnpm install --frozen-lockfile --filter @byok/gateway... \
 && pnpm --filter @byok/shared build \
 && pnpm --filter @byok/db build \
 && pnpm --filter @byok/gateway build \
 && pnpm --filter @byok/gateway --prod deploy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /out .
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

(若 `pnpm deploy` 对 workspace 依赖处理有版本问题,fallback:第二阶段直接 COPY builder 的 node_modules+dist+package.json——实现者选能跑通的,报告说明。worker Dockerfile 同模式,无 EXPOSE,入口 dist/index.js。)

**console Dockerfile:** Next standalone 三段式(builder 同上 + `COPY --from=builder /app/apps/console/.next/standalone ./` + static/public,`CMD ["node", "apps/console/server.js"]`,EXPOSE 3000)。

**deploy/docker-compose.prod.yml:**

```yaml
name: byok
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-byok}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?生产必须显式设置}
      POSTGRES_DB: ${POSTGRES_DB:-byok}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-byok}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  migrate:
    build: { context: .., dockerfile: apps/worker/Dockerfile }
    command: ["npx", "drizzle-kit", "migrate"]
    working_dir: /app/node_modules/@byok/db
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"

  gateway:
    build: { context: .., dockerfile: apps/gateway/Dockerfile }
    restart: unless-stopped
    ports:
      - "${GATEWAY_PORT:-8080}:8080"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
      MASTER_KEY: ${MASTER_KEY:?生产必须设置(openssl rand -base64 32)}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }

  worker:
    build: { context: .., dockerfile: apps/worker/Dockerfile }
    restart: unless-stopped
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }

  console:
    build: { context: .., dockerfile: apps/console/Dockerfile }
    restart: unless-stopped
    ports:
      - "${CONSOLE_PORT:-3000}:3000"
    environment:
      DATABASE_URL: ${DATABASE_URL}
      MASTER_KEY: ${MASTER_KEY}
      SESSION_SECRET: ${SESSION_SECRET:?生产必须设置}
    depends_on:
      postgres: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }

volumes:
  pgdata:
  redisdata:
```

(migrate 服务的 working_dir/command 若与镜像内布局不符,实现者调整为能跑通的等价方式——如专用 migrate 入口脚本;DATABASE_URL 默认 `postgres://byok:${POSTGRES_PASSWORD}@postgres:5432/byok` 写进 .env.prod.example。)

**deploy/.env.prod.example:** POSTGRES_PASSWORD/DATABASE_URL/MASTER_KEY/SESSION_SECRET/GATEWAY_PORT/CONSOLE_PORT/SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD 模板与生成命令注释。

**README.md 章节(中文):** 项目简介与架构图(ASCII)/功能清单/快速开始(本地开发:compose 起 PG+Redis→migrate→seed→三服务 dev)/**生产部署(docker compose)**:准备 .env→`docker compose -f deploy/docker-compose.prod.yml up -d --build`→初始化 seed→登录 Console 配渠道与模型→调用方接入示例(OpenAI SDK base_url、Claude Code ANTHROPIC_BASE_URL、curl 两协议示例)/运维:备份(pgdata)、监控命令(XLEN/XPENDING/DLQ)、密钥轮换、升级流程/目录结构/许可。

**验收:** `docker compose -f deploy/docker-compose.prod.yml up -d --build` 在本机跑通(注意宿主 6379 冲突——prod compose 不映射 redis 到宿主,无冲突;gateway/console 端口可用 .env 改);curl 走容器 gateway 200;Console 容器登录成功。完毕 `down`(保留本地 dev 环境)。

- [ ] Steps: Dockerfiles → compose → README → 真实 up 验收 → down → Commit `feat(deploy): Dockerfile、生产 compose 与 README`

---

### Task 9: 全链路验收 + 收尾

- [ ] 用 prod compose 全栈跑一遍核心旅程:seed → Console 登录 → 建渠道(指向宿主 fake-upstream,`host.docker.internal:9100`)→ 建模型+映射 → 签发 Key(带预算)→ curl 网关 200 → 报表页显示该笔成本 → 审计页(开 audit 后)显示内容 → 预算耗尽 429。每步记录证据。
- [ ] `pnpm test && pnpm typecheck && pnpm build` 全绿;CI 推送绿。
- [ ] Commit(若有修补)+ 准备合并。

---

## Self-Review 记录

1. **前置覆盖**:phase4-prerequisites 1-2(Task 1)、3(Task 6 强制约定+测试)、4(Task 7 注释提醒)、5(时区:保持 UTC 并在 README 运维节说明现状与改法——明确决定不在 v1 改)、6(README runbook)、7(Task 2)、8(Task 8)、9(README 监控节)、次要项(Task 1 清理)。
2. **占位符**:CRUD 页面用行为规格+验收断言代替逐行代码——计划头部已声明这一有界放宽及理由;安全/钱路径全部完整代码。
3. **类型一致性**:createApiKey/createChannel/aggregateUsage 签名与测试一致;Db 类型来自 @byok/db;cnyToMicro 校验复用 shared。
4. **风险**:Next.js 在 monorepo + pnpm 的 standalone 输出与 Docker 细节是最可能踩坑处,Task 8 已给 fallback 授权。
