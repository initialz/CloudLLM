# BYOK 网关 Phase 3:Worker(用量落库 + 定时任务)+ CI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `apps/worker`(独立 Node 服务):消费 `usage_events` → 事务落库(usage_records/ledger_entries/request_logs)→ 更新预算 → 校正 Redis 余额;月度预算重置与审计 TTL 清理两个定时 job;外加契约提取到 @byok/shared 与 GitHub Actions CI。完成后预算执行变为持久(闭合 P2 的非持久缺口)。

**Architecture:** 纯函数核心(事件解析/处理逻辑)+ 薄 I/O 边缘(XREADGROUP 循环、drizzle 事务、ioredis)。at-least-once 投递,幂等靠 usage_records.event_id 唯一键去重;失败事件留 pending 由 XAUTOCLAIM 重试,超过投递上限进死信流。前置事项清单:docs/superpowers/plans/phase3-prerequisites.md。

**Tech Stack:** Node ≥22、ioredis ^5(mock ^8 测试)、@byok/db(drizzle 事务)、@byok/shared、Vitest ^3、GitHub Actions。

**关键约定:**
- 消费组 `console-worker`,消费者名 = hostname+pid;`XGROUP CREATE ... $ MKSTREAM` 启动时幂等创建。
- 幂等:`usage_records.event_id` = Redis Stream entry ID,unique,`onConflictDoNothing` 返回空 → 重复事件直接 ack。
- 台账符号:消费记**正数**(amount_cny = costCny);未来冲正记负数。
- 预算更新:消费时 `used_amount_cny += cost`;monthly 预算若 period 已翻月,先重置(used=cost 本身,period_start=本月初)。
- Redis 校正:PG 事务提交后,对每个主体 `SET bal:{type}:{id} = (limit-used) micro EX ttl`;无预算主体 SET "u"。
- 死信:同一 entry 投递次数 > 5 → XADD 到 `{stream}_dlq` 并 ack,告警靠 DLQ 长度监控。
- rejected/upstream_error 事件同样落 usage_records(成本可能为 0),保证可观测。

---

### Task 1: 契约提取到 @byok/shared + gateway 改造引用

**Files:**
- Create: `packages/shared/src/events.ts`
- Create: `packages/shared/src/redis-keys.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/gateway/src/types.ts`(改为 re-export)
- Modify: `apps/gateway/src/redis-stores.ts`(用共享常量)
- Test: `packages/shared/src/redis-keys.test.ts`

- [ ] **Step 1: 写共享契约**

`packages/shared/src/events.ts`:

```ts
/** 网关→worker 的用量事件契约。经 Redis Stream 传输:XADD <stream> * payload <JSON.stringify(UsageEvent)> */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type UsageEventStatus = "ok" | "upstream_error" | "rejected";

export interface UsageEvent {
  keyId: string;
  modelSlug: string;
  channelId: string | null;
  usage: UsageTotals;
  /** 6 位小数 CNY 字符串(computeCostCny 输出) */
  costCny: string;
  latencyMs: number;
  /** 到上游响应头的耗时(毫秒,严格说是 TTFB 而非首 token) */
  ttftMs: number | null;
  status: UsageEventStatus;
  errorCode: string | null;
  /** ISO 时间戳 */
  ts: string;
  /** 仅 auditEnabled 的 Key 携带 */
  audit?: { requestBody: unknown; responseBody: unknown };
}
```

`packages/shared/src/redis-keys.ts`:

```ts
/** Gateway 与 Worker 共用的 Redis 键约定 */
export type BudgetSubjectType = "user" | "team" | "app" | "key";

export interface BudgetSubject {
  type: BudgetSubjectType;
  id: string;
}

/** 余额热缓存键;值=剩余 micro-CNY 整数字符串,或 UNLIMITED_SENTINEL */
export const balKey = (s: BudgetSubject): string => `bal:${s.type}:${s.id}`;

/** 无预算(不限)哨兵值 */
export const UNLIMITED_SENTINEL = "u";

/** 渠道冷却键(存在即冷却,EX 控制时长) */
export const cooldownKey = (channelId: string): string => `cooldown:${channelId}`;

export const DEFAULT_USAGE_STREAM = "usage_events";
```

`packages/shared/src/index.ts` 追加:

```ts
export * from "./events.js";
export * from "./redis-keys.js";
```

- [ ] **Step 2: 共享键约定测试(TDD:先跑失败)**

`packages/shared/src/redis-keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UNLIMITED_SENTINEL, balKey, cooldownKey } from "./redis-keys.js";

describe("redis-keys", () => {
  it("键格式与 P2 网关既有格式逐字一致", () => {
    expect(balKey({ type: "key", id: "k1" })).toBe("bal:key:k1");
    expect(balKey({ type: "team", id: "t1" })).toBe("bal:team:t1");
    expect(cooldownKey("c1")).toBe("cooldown:c1");
    expect(UNLIMITED_SENTINEL).toBe("u");
  });
});
```

- [ ] **Step 3: gateway 改造为引用共享契约**

`apps/gateway/src/types.ts`:删除本地的 `UsageTotals`/`UsageEvent`/`BudgetSubject` 定义,改为:

```ts
export type { BudgetSubject, UsageEvent, UsageTotals } from "@byok/shared";
```

(其余 gateway 专属类型 AuthedKey/ModelInfo/ChannelChoice/端口接口保持不动;接口里引用这些类型处 import 来源不变——types.ts 内部需 `import type { ... } from "@byok/shared"` 供接口签名使用。)

`apps/gateway/src/redis-stores.ts`:删除本地 `UNLIMITED_SENTINEL` 与 `balKey`、cooldown 键模板字符串,改为 `import { UNLIMITED_SENTINEL, balKey, cooldownKey } from "@byok/shared";`,`cooldown:${channelId}` 两处换成 `cooldownKey(channelId)`。

- [ ] **Step 4: 全量回归**

Run: `pnpm --filter @byok/shared build && pnpm test && pnpm typecheck`
Expected: shared 36、gateway 63、db 1 全 PASS(契约迁移不改变行为)。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src apps/gateway/src
git commit -m "refactor: UsageEvent 与 Redis 键约定提取到 @byok/shared"
```

---

### Task 2: CI 流水线(GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
      - name: drizzle drift check
        run: |
          cd packages/db
          npx drizzle-kit generate
          git diff --exit-code migrations
```

- [ ] **Step 2: 本地等效验证 + Commit**

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test && (cd packages/db && npx drizzle-kit generate && git diff --exit-code migrations)`
Expected: 全部通过、drift check 无差异。

```bash
git add .github
git commit -m "ci: GitHub Actions——build/typecheck/test/迁移漂移检查"
```

(推送后在 GitHub Actions 页面确认绿勾——执行者若无权限查看,在报告注明由控制者验证。)

---

### Task 3: usage_records 加 event_id 幂等列(迁移 0001)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0001_*.sql`(drizzle 生成)

- [ ] **Step 1: schema 加列**

`usageRecords` 表中 `keyId` 上方加:

```ts
    /** Redis Stream entry ID,worker 幂等去重用(at-least-once 投递) */
    eventId: text("event_id").unique(),
```

- [ ] **Step 2: 生成迁移并验证**

Run: `pnpm --filter @byok/db generate`
Expected: 新文件 `packages/db/migrations/0001_*.sql`,内含 `ALTER TABLE "usage_records" ADD COLUMN "event_id" text` 与 unique 约束。

Run: `pnpm --filter @byok/db migrate && pnpm test && pnpm typecheck`
Expected: 迁移应用成功(本地 PG),全测试通过。

- [ ] **Step 3: Commit**

```bash
git add packages/db
git commit -m "feat(db): usage_records.event_id 幂等列(迁移 0001)"
```

---

### Task 4: apps/worker 脚手架 + config + 事件解析(TDD)

**Files:**
- Create: `apps/worker/package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/parse-event.ts`
- Test: `apps/worker/src/config.test.ts`、`apps/worker/src/parse-event.test.ts`
- Modify: `.env.example`(追加 worker 变量)

- [ ] **Step 1: 脚手架**

`apps/worker/package.json`:

```json
{
  "name": "@byok/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@byok/db": "workspace:*",
    "@byok/shared": "workspace:*",
    "drizzle-orm": "^0.44.2",
    "ioredis": "^5.6.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "ioredis-mock": "^8.9.0",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

`tsconfig.json`/`vitest.config.ts` 与 gateway 同构(extends base、outDir dist、exclude tests / include src/**/*.test.ts)。

`.env.example` 追加:

```
# Worker
USAGE_GROUP=console-worker
AUDIT_RETENTION_DAYS=30
JOB_INTERVAL_MS=3600000
MAX_DELIVERIES=5
```

- [ ] **Step 2: config 失败测试 → 实现**

`apps/worker/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

const validEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };

describe("loadWorkerConfig", () => {
  it("默认值齐全", () => {
    const c = loadWorkerConfig(validEnv);
    expect(c.usageStream).toBe("usage_events");
    expect(c.group).toBe("console-worker");
    expect(c.auditRetentionDays).toBe(30);
    expect(c.jobIntervalMs).toBe(3_600_000);
    expect(c.maxDeliveries).toBe(5);
    expect(c.balanceTtlSeconds).toBe(60);
    expect(c.consumer).toMatch(/.+/);
  });

  it("缺必填项抛错点名;非数字抛错点名", () => {
    expect(() => loadWorkerConfig({ REDIS_URL: "redis://x" })).toThrow(/DATABASE_URL/);
    expect(() => loadWorkerConfig({ ...validEnv, MAX_DELIVERIES: "abc" })).toThrow(/MAX_DELIVERIES/);
  });
});
```

`apps/worker/src/config.ts`:

```ts
import { hostname } from "node:os";
import { DEFAULT_USAGE_STREAM } from "@byok/shared";

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  usageStream: string;
  group: string;
  consumer: string;
  auditRetentionDays: number;
  jobIntervalMs: number;
  maxDeliveries: number;
  balanceTtlSeconds: number;
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
  };
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`环境变量 ${name} 必须是有效数字,得到: "${raw}"`);
    return v;
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    usageStream: env.USAGE_STREAM ?? DEFAULT_USAGE_STREAM,
    group: env.USAGE_GROUP ?? "console-worker",
    consumer: env.WORKER_CONSUMER ?? `${hostname()}-${process.pid}`,
    auditRetentionDays: num("AUDIT_RETENTION_DAYS", 30),
    jobIntervalMs: num("JOB_INTERVAL_MS", 3_600_000),
    maxDeliveries: num("MAX_DELIVERIES", 5),
    balanceTtlSeconds: num("BALANCE_TTL_SECONDS", 60),
  };
}
```

- [ ] **Step 3: parse-event 失败测试 → 实现**

`apps/worker/src/parse-event.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseUsageEvent } from "./parse-event.js";

const valid = {
  keyId: "k1", modelSlug: "m", channelId: null,
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costCny: "0.000123", latencyMs: 10, ttftMs: null,
  status: "ok", errorCode: null, ts: "2026-06-10T00:00:00.000Z",
};

describe("parseUsageEvent", () => {
  it("合法事件解析通过", () => {
    expect(parseUsageEvent(JSON.stringify(valid))).toMatchObject({ keyId: "k1", costCny: "0.000123" });
  });

  it("非 JSON / 缺字段 / 类型错 返回 null(进死信而不是炸循环)", () => {
    expect(parseUsageEvent("not-json")).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, keyId: undefined }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, costCny: 123 }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, status: "weird" }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, usage: { inputTokens: "x" } }))).toBeNull();
  });
});
```

`apps/worker/src/parse-event.ts`:

```ts
import type { UsageEvent } from "@byok/shared";

const STATUSES = new Set(["ok", "upstream_error", "rejected"]);

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 解析并校验事件 JSON;非法返回 null(调用方负责送死信) */
export function parseUsageEvent(payload: string): UsageEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const u = e.usage as Record<string, unknown> | undefined;
  if (
    typeof e.keyId !== "string" ||
    typeof e.modelSlug !== "string" ||
    !(e.channelId === null || typeof e.channelId === "string") ||
    !u ||
    !isNum(u.inputTokens) || !isNum(u.outputTokens) ||
    !isNum(u.cacheReadTokens) || !isNum(u.cacheWriteTokens) ||
    typeof e.costCny !== "string" ||
    !isNum(e.latencyMs) ||
    !(e.ttftMs === null || isNum(e.ttftMs)) ||
    typeof e.status !== "string" || !STATUSES.has(e.status) ||
    !(e.errorCode === null || typeof e.errorCode === "string") ||
    typeof e.ts !== "string"
  ) {
    return null;
  }
  return raw as UsageEvent;
}
```

- [ ] **Step 4: 回归 + Commit**

Run: `pnpm install && pnpm --filter @byok/worker test && pnpm typecheck`
Expected: worker 9 用例 PASS。

```bash
git add apps/worker .env.example pnpm-lock.yaml
git commit -m "feat(worker): 脚手架、配置与事件解析"
```

---

### Task 5: 核心落库 process-event(TDD,真 PG 集成测试)

**Files:**
- Create: `apps/worker/src/process-event.ts`
- Test: `apps/worker/src/process-event.test.ts`(标记 integration:连本地 PG,docker compose 的 postgres 必须在跑;CI 暂跳过 → `describe.skipIf(!process.env.DATABASE_URL_TEST)`)

**语义:**
1. 以 `eventId`(stream entry ID)`onConflictDoNothing` 插 `usage_records`;无返回行 → duplicate,直接返回。
2. 查 `api_keys`(left join apps 拿 teamId)推导主体链(与 gateway subjectsForKey 同口径:key → owner → app 时 team)。Key 不存在(被删)→ 记录仍落(主体链为空,只有 usage_records),返回 ok。
3. `costMicro > 0` 时:逐主体插 `ledger_entries`(amount=costCny 正数);对**有预算行**的主体更新 `used_amount_cny += cost`;monthly 且 period_start 翻月的预算先重置(used=本次 cost,period_start=本月初)。
4. `event.audit` 存在时插 `request_logs`(expires_at = now + retentionDays)。
5. 以上 1-4 在**一个 drizzle 事务**内;提交后(非事务内)对每个主体校正 Redis:有预算 → `SET balKey (limit-used)micro EX ttl`;无预算 → `SET balKey "u" EX ttl`。
6. 返回 `"ok" | "duplicate"`。

- [ ] **Step 1: 失败测试(integration)**

`apps/worker/src/process-event.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createDb, apiKeys, budgets, ledgerEntries, requestLogs, usageRecords, users } from "@byok/db";
import { cnyToMicro, generateApiKey, hashPassword } from "@byok/shared";
import type { UsageEvent } from "@byok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processEvent, type BalanceWrite } from "./process-event.js";

const DB_URL = process.env.DATABASE_URL_TEST ?? "postgres://byok:byok_dev@localhost:5432/byok";

class FakeBalance {
  writes: Array<{ key: string; value: string; ttl: number }> = [];
  write: BalanceWrite = async (key, value, ttl) => {
    this.writes.push({ key, value, ttl });
  };
}

const mkEvent = (keyId: string, eventId: string, over: Partial<UsageEvent> = {}): { event: UsageEvent; eventId: string } => ({
  eventId,
  event: {
    keyId, modelSlug: "anthropic/claude-e2e", channelId: null,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costCny: "0.007350", latencyMs: 10, ttftMs: 5, status: "ok", errorCode: null,
    ts: new Date().toISOString(),
    ...over,
  },
});

describe.skipIf(!!process.env.CI)("processEvent(真 PG)", () => {
  const { db, sql } = createDb(DB_URL, { max: 2 });
  let keyId: string;
  let userId: string;

  beforeAll(async () => {
    const u = await db.insert(users).values({
      email: `w-${randomUUID()}@test.local`,
      passwordHash: await hashPassword("x"),
    }).returning({ id: users.id });
    userId = u[0]!.id;
    const k = generateApiKey();
    const kr = await db.insert(apiKeys).values({
      ownerType: "user", ownerId: userId, keyHash: k.keyHash, keyPrefix: k.keyPrefix,
    }).returning({ id: apiKeys.id });
    keyId = kr[0]!.id;
    await db.insert(budgets).values({
      subjectType: "key", subjectId: keyId, period: "total", limitAmountCny: "1",
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("落库 + 台账 + 预算累加 + Redis 校正", async () => {
    const bal = new FakeBalance();
    const { event, eventId } = mkEvent(keyId, `e-${randomUUID()}`);
    const r = await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    expect(r).toBe("ok");

    const rec = await db.select().from(usageRecords).where(eq(usageRecords.eventId, eventId));
    expect(rec).toHaveLength(1);
    expect(rec[0]!.costCny).toBe("0.007350");

    const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.usageRecordId, rec[0]!.id));
    expect(ledger.length).toBeGreaterThanOrEqual(2); // key + user 两层

    const b = await db.select().from(budgets).where(eq(budgets.subjectId, keyId));
    expect(cnyToMicro(b[0]!.usedAmountCny) >= 7350n).toBe(true);

    const keyWrite = bal.writes.find((w) => w.key === `bal:key:${keyId}`);
    expect(keyWrite).toBeDefined();
    // limit 1 元 - used ≥ 0.00735 → 剩余 ≤ 992650 micro
    expect(BigInt(keyWrite!.value) <= 992_650n).toBe(true);
    const userWrite = bal.writes.find((w) => w.key === `bal:user:${userId}`);
    expect(userWrite!.value).toBe("u"); // user 层无预算
  });

  it("同一 eventId 重复投递 → duplicate,不重复记账", async () => {
    const bal = new FakeBalance();
    const { event, eventId } = mkEvent(keyId, `e-${randomUUID()}`);
    await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    const before = await db.select().from(budgets).where(eq(budgets.subjectId, keyId));
    const r2 = await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    expect(r2).toBe("duplicate");
    const after = await db.select().from(budgets).where(eq(budgets.subjectId, keyId));
    expect(after[0]!.usedAmountCny).toBe(before[0]!.usedAmountCny);
  });

  it("audit 事件写 request_logs(带过期时间)", async () => {
    const bal = new FakeBalance();
    const { event, eventId } = mkEvent(keyId, `e-${randomUUID()}`, {
      audit: { requestBody: { hi: 1 }, responseBody: { ok: true } },
    });
    await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    const rec = await db.select().from(usageRecords).where(eq(usageRecords.eventId, eventId));
    const logs = await db.select().from(requestLogs).where(eq(requestLogs.usageRecordId, rec[0]!.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("Key 已被删除:仍落 usage_records,无台账", async () => {
    const bal = new FakeBalance();
    const ghost = randomUUID();
    const { event, eventId } = mkEvent(ghost, `e-${randomUUID()}`);
    const r = await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    expect(r).toBe("ok");
    const rec = await db.select().from(usageRecords).where(eq(usageRecords.eventId, eventId));
    expect(rec).toHaveLength(1);
  });

  it("零成本事件(rejected)不产生台账/预算变更", async () => {
    const bal = new FakeBalance();
    const { event, eventId } = mkEvent(keyId, `e-${randomUUID()}`, {
      costCny: "0.000000", status: "rejected", errorCode: "budget_exhausted",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const before = await db.select().from(budgets).where(eq(budgets.subjectId, keyId));
    await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    const after = await db.select().from(budgets).where(eq(budgets.subjectId, keyId));
    expect(after[0]!.usedAmountCny).toBe(before[0]!.usedAmountCny);
  });
});
```

注意:`usage_records.key_id` 是 NOT NULL + FK——Key 已删场景下 FK 必然失败!**为支持"Key 已删仍落账"**,本任务还需把 `usageRecords.keyId` 的 FK 放宽:schema 中去掉 `.references(() => apiKeys.id)` 保留 NOT NULL(成为软引用,与 owner_id 同理),并生成迁移 0002(DROP CONSTRAINT)。这是有意的取舍:计费事实不能因主体删除而丢;写进 schema 注释。

- [ ] **Step 2: 实现 process-event(含 schema FK 放宽 + 迁移 0002)**

`packages/db/src/schema.ts`:`usageRecords.keyId` 改为:

```ts
    /** 软引用 api_keys.id(无 FK:Key 删除后计费事实仍须可落库) */
    keyId: uuid("key_id").notNull(),
```

Run: `pnpm --filter @byok/db generate && pnpm --filter @byok/db migrate`

`apps/worker/src/process-event.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import {
  apiKeys, apps, budgets, ledgerEntries, requestLogs, usageRecords, type Db,
} from "@byok/db";
import {
  type BudgetSubject, type UsageEvent, UNLIMITED_SENTINEL, balKey, cnyToMicro,
} from "@byok/shared";

/** PG 提交后校正余额缓存的写函数(由调用方绑定 Redis) */
export type BalanceWrite = (key: string, value: string, ttlSeconds: number) => Promise<void>;

export interface ProcessOptions {
  auditRetentionDays: number;
  balanceTtlSeconds: number;
}

export async function processEvent(
  db: Db,
  writeBalance: BalanceWrite,
  event: UsageEvent,
  eventId: string,
  opts: ProcessOptions,
): Promise<"ok" | "duplicate"> {
  const costMicro = cnyToMicro(event.costCny);

  // 主体链推导(与 gateway subjectsForKey 同口径);Key 可能已删 → 空链
  const keyRows = await db
    .select({
      ownerType: apiKeys.ownerType,
      ownerId: apiKeys.ownerId,
      teamId: apps.teamId,
    })
    .from(apiKeys)
    .leftJoin(apps, and(eq(apiKeys.ownerType, "app"), eq(apps.id, apiKeys.ownerId)))
    .where(eq(apiKeys.id, event.keyId))
    .limit(1);

  const subjects: BudgetSubject[] = [];
  const key = keyRows[0];
  if (key) {
    subjects.push({ type: "key", id: event.keyId });
    subjects.push({ type: key.ownerType, id: key.ownerId });
    if (key.ownerType === "app" && key.teamId) {
      subjects.push({ type: "team", id: key.teamId });
    }
  }

  const inserted = await db.transaction(async (tx) => {
    const rec = await tx
      .insert(usageRecords)
      .values({
        eventId,
        keyId: event.keyId,
        modelSlug: event.modelSlug,
        channelId: event.channelId,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        costCny: event.costCny,
        latencyMs: event.latencyMs,
        ttftMs: event.ttftMs,
        status: event.status,
        errorCode: event.errorCode,
        createdAt: new Date(event.ts),
      })
      .onConflictDoNothing({ target: usageRecords.eventId })
      .returning({ id: usageRecords.id });

    const row = rec[0];
    if (!row) return null; // 重复投递

    if (costMicro > 0n) {
      for (const subject of subjects) {
        await tx.insert(ledgerEntries).values({
          subjectType: subject.type,
          subjectId: subject.id,
          amountCny: event.costCny,
          usageRecordId: row.id,
        });
        // monthly 翻月先重置,再累加;total 直接累加
        await tx
          .update(budgets)
          .set({
            usedAmountCny: sql`CASE
              WHEN ${budgets.period} = 'monthly'
               AND ${budgets.periodStart} IS NOT NULL
               AND date_trunc('month', ${budgets.periodStart}) < date_trunc('month', now())
              THEN ${event.costCny}::numeric
              ELSE ${budgets.usedAmountCny} + ${event.costCny}::numeric
            END`,
            periodStart: sql`CASE
              WHEN ${budgets.period} = 'monthly'
               AND (${budgets.periodStart} IS NULL
                    OR date_trunc('month', ${budgets.periodStart}) < date_trunc('month', now()))
              THEN date_trunc('month', now())
              ELSE ${budgets.periodStart}
            END`,
          })
          .where(and(eq(budgets.subjectType, subject.type), eq(budgets.subjectId, subject.id)));
      }
    }

    if (event.audit) {
      await tx.insert(requestLogs).values({
        usageRecordId: row.id,
        requestBody: event.audit.requestBody,
        responseBody: event.audit.responseBody,
        expiresAt: new Date(Date.now() + opts.auditRetentionDays * 86_400_000),
      });
    }
    return row.id;
  });

  if (inserted === null) return "duplicate";

  // PG 已提交,校正余额缓存(失败不影响账——下一事件或 TTL 过期会再校正)
  for (const subject of subjects) {
    try {
      const rows = await db
        .select({
          remaining: sql<string>`(${budgets.limitAmountCny} - ${budgets.usedAmountCny})::text`,
        })
        .from(budgets)
        .where(and(
          eq(budgets.subjectType, subject.type),
          eq(budgets.subjectId, subject.id),
          eq(budgets.status, "active"),
        ));
      if (rows.length === 0) {
        await writeBalance(balKey(subject), UNLIMITED_SENTINEL, opts.balanceTtlSeconds);
      } else {
        let min: bigint | null = null;
        for (const r of rows) {
          const v = cnyToMicro(r.remaining);
          if (min === null || v < min) min = v;
        }
        await writeBalance(balKey(subject), String(min), opts.balanceTtlSeconds);
      }
    } catch (err) {
      console.error(`余额校正失败 ${balKey(subject)}: ${(err as Error).message}`);
    }
  }
  return "ok";
}
```

- [ ] **Step 3: 跑通(需本地 PG)+ Commit**

Run: `docker compose up -d postgres && pnpm --filter @byok/db migrate && pnpm --filter @byok/worker test`
Expected: 5 个 integration 用例 PASS(本地);CI 上 skipIf 跳过。
Run: `pnpm test && pnpm typecheck`(全仓回归)。

```bash
git add apps/worker/src packages/db
git commit -m "feat(worker): 事件落库核心——幂等/台账/预算/审计/余额校正(迁移 0002)"
```

---

### Task 6: 消费循环 consumer + 定时 jobs(TDD)

**Files:**
- Create: `apps/worker/src/consumer.ts`
- Create: `apps/worker/src/jobs.ts`
- Create: `apps/worker/src/index.ts`
- Test: `apps/worker/src/consumer.test.ts`(ioredis-mock)
- Test: `apps/worker/src/jobs.test.ts`(真 PG,同 Task 5 skipIf)

- [ ] **Step 1: consumer 失败测试 → 实现**

`apps/worker/src/consumer.test.ts`:

```ts
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { UsageConsumer } from "./consumer.js";

const cfgOf = (redis: Redis) => ({
  redis,
  stream: "usage_events",
  group: "g",
  consumer: "c1",
  maxDeliveries: 3,
});

describe("UsageConsumer", () => {
  it("ensureGroup 幂等(BUSYGROUP 不抛)", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const c = new UsageConsumer(cfgOf(redis), async () => "ok");
    await c.ensureGroup();
    await c.ensureGroup();
  });

  it("消费一批:handler ok → ack", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const seen: string[] = [];
    const c = new UsageConsumer(cfgOf(redis), async (payload) => {
      seen.push(payload);
      return "ok";
    });
    await c.ensureGroup();
    await redis.xadd("usage_events", "*", "payload", "p1");
    await redis.xadd("usage_events", "*", "payload", "p2");
    const n = await c.consumeOnce(0);
    expect(n).toBe(2);
    expect(seen).toEqual(["p1", "p2"]);
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(0); // 无 pending
  });

  it("handler 抛错 → 不 ack(留 pending 重试)", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const c = new UsageConsumer(cfgOf(redis), async () => {
      throw new Error("boom");
    });
    await c.ensureGroup();
    await redis.xadd("usage_events", "*", "payload", "bad");
    await c.consumeOnce(0);
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(1);
  });

  it("handler 返回 dead → 进 DLQ 并 ack", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const c = new UsageConsumer(cfgOf(redis), async () => "dead");
    await c.ensureGroup();
    await redis.xadd("usage_events", "*", "payload", "poison");
    await c.consumeOnce(0);
    const dlq = await redis.xrange("usage_events_dlq", "-", "+");
    expect(dlq).toHaveLength(1);
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(0);
  });
});
```

`apps/worker/src/consumer.ts`:

```ts
import type Redis from "ioredis";

export type HandleResult = "ok" | "dead";
/** 处理一条事件;抛错=留 pending 重试;"dead"=送死信并 ack */
export type EventHandler = (payload: string, entryId: string) => Promise<HandleResult>;

export interface ConsumerConfig {
  redis: Redis;
  stream: string;
  group: string;
  consumer: string;
  maxDeliveries: number;
}

type StreamEntry = [id: string, fields: string[]];
type XReadGroupResult = Array<[stream: string, entries: StreamEntry[]]> | null;

export class UsageConsumer {
  constructor(
    private cfg: ConsumerConfig,
    private handler: EventHandler,
  ) {}

  /** 幂等创建消费组(MKSTREAM 容忍流不存在) */
  async ensureGroup(): Promise<void> {
    try {
      await this.cfg.redis.xgroup("CREATE", this.cfg.stream, this.cfg.group, "$", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
  }

  /** 读一批新事件并处理;返回处理条数。blockMs=0 时不阻塞(测试用)。 */
  async consumeOnce(blockMs: number): Promise<number> {
    const args = [
      "GROUP", this.cfg.group, this.cfg.consumer,
      "COUNT", "32",
      ...(blockMs > 0 ? ["BLOCK", String(blockMs)] : []),
      "STREAMS", this.cfg.stream, ">",
    ];
    const res = (await this.cfg.redis.xreadgroup(...(args as [string, ...string[]]))) as XReadGroupResult;
    if (!res) return 0;
    let handled = 0;
    for (const [, entries] of res) {
      for (const [entryId, fields] of entries) {
        await this.handleEntry(entryId, fields);
        handled++;
      }
    }
    return handled;
  }

  /** 认领滞留 pending(其他消费者崩溃遗留/本进程上轮失败),超过投递上限送死信 */
  async claimStale(minIdleMs: number): Promise<void> {
    const res = (await this.cfg.redis.xautoclaim(
      this.cfg.stream, this.cfg.group, this.cfg.consumer, minIdleMs, "0-0", "COUNT", 32,
    )) as [string, StreamEntry[], ...unknown[]];
    const entries = res[1] ?? [];
    for (const [entryId, fields] of entries) {
      const info = (await this.cfg.redis.xpending(
        this.cfg.stream, this.cfg.group, entryId, entryId, 1,
      )) as Array<[string, string, number, number]>;
      const deliveries = info[0]?.[3] ?? 1;
      if (deliveries > this.cfg.maxDeliveries) {
        await this.toDlq(entryId, fields, `投递 ${deliveries} 次仍失败`);
        continue;
      }
      await this.handleEntry(entryId, fields);
    }
  }

  private async handleEntry(entryId: string, fields: string[]): Promise<void> {
    const idx = fields.indexOf("payload");
    const payload = idx >= 0 ? fields[idx + 1] : undefined;
    if (payload === undefined) {
      await this.toDlq(entryId, fields, "缺 payload 字段");
      return;
    }
    try {
      const result = await this.handler(payload, entryId);
      if (result === "dead") {
        await this.toDlq(entryId, fields, "handler 判定不可处理");
        return;
      }
      await this.cfg.redis.xack(this.cfg.stream, this.cfg.group, entryId);
    } catch (err) {
      // 不 ack:留 pending,由 claimStale 重试;超限后送死信
      console.error(`事件 ${entryId} 处理失败(将重试): ${(err as Error).message}`);
    }
  }

  private async toDlq(entryId: string, fields: string[], reason: string): Promise<void> {
    console.error(`事件 ${entryId} 送死信: ${reason}`);
    await this.cfg.redis.xadd(`${this.cfg.stream}_dlq`, "*", ...fields, "origin_id", entryId, "reason", reason);
    await this.cfg.redis.xack(this.cfg.stream, this.cfg.group, entryId);
  }
}
```

(注:ioredis-mock 若不支持 xautoclaim,claimStale 的用例可省略——以 consumeOnce/ack/DLQ 三条为准;claimStale 由 Task 7 e2e 真 Redis 验证。)

- [ ] **Step 2: jobs 失败测试 → 实现**

`apps/worker/src/jobs.test.ts`(真 PG,`describe.skipIf(!!process.env.CI)`):

```ts
import { randomUUID } from "node:crypto";
import { createDb, budgets, requestLogs, usageRecords } from "@byok/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupExpiredAuditLogs, resetRolledOverMonthlyBudgets } from "./jobs.js";

const DB_URL = process.env.DATABASE_URL_TEST ?? "postgres://byok:byok_dev@localhost:5432/byok";

describe.skipIf(!!process.env.CI)("jobs(真 PG)", () => {
  const { db, sql } = createDb(DB_URL, { max: 2 });
  afterAll(async () => {
    await sql.end();
  });

  it("月度预算翻月重置", async () => {
    const sid = randomUUID();
    await db.insert(budgets).values({
      subjectType: "user", subjectId: sid, period: "monthly",
      limitAmountCny: "100", usedAmountCny: "88",
      periodStart: new Date("2026-05-01T00:00:00Z"),
    });
    const n = await resetRolledOverMonthlyBudgets(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await db.select().from(budgets).where(eq(budgets.subjectId, sid));
    expect(after[0]!.usedAmountCny).toBe("0.000000");
    expect(after[0]!.periodStart!.getTime()).toBeGreaterThan(new Date("2026-05-31").getTime());
  });

  it("过期审计日志清理(不动未过期)", async () => {
    const rec = await db.insert(usageRecords).values({
      keyId: randomUUID(), modelSlug: "m", status: "ok", eventId: `e-${randomUUID()}`,
    }).returning({ id: usageRecords.id });
    await db.insert(requestLogs).values({
      usageRecordId: rec[0]!.id, requestBody: {}, responseBody: {},
      expiresAt: new Date(Date.now() - 1000),
    });
    const n = await cleanupExpiredAuditLogs(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(requestLogs).where(eq(requestLogs.usageRecordId, rec[0]!.id));
    expect(left).toHaveLength(0);
  });
});
```

`apps/worker/src/jobs.ts`:

```ts
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { budgets, requestLogs, type Db } from "@byok/db";

/** 月度预算翻月重置(公司时区按 PG now() 所在时区;返回重置条数) */
export async function resetRolledOverMonthlyBudgets(db: Db): Promise<number> {
  const r = await db
    .update(budgets)
    .set({
      usedAmountCny: "0.000000",
      periodStart: sql`date_trunc('month', now())`,
    })
    .where(and(
      eq(budgets.period, "monthly"),
      isNotNull(budgets.periodStart),
      sql`date_trunc('month', ${budgets.periodStart}) < date_trunc('month', now())`,
    ))
    .returning({ id: budgets.id });
  return r.length;
}

/** 删除过期审计日志(返回删除条数) */
export async function cleanupExpiredAuditLogs(db: Db): Promise<number> {
  const r = await db
    .delete(requestLogs)
    .where(lt(requestLogs.expiresAt, sql`now()`))
    .returning({ id: requestLogs.id });
  return r.length;
}
```

- [ ] **Step 3: index 启动装配**

`apps/worker/src/index.ts`:

```ts
import { Redis } from "ioredis";
import { createDb } from "@byok/db";
import { loadWorkerConfig } from "./config.js";
import { UsageConsumer } from "./consumer.js";
import { cleanupExpiredAuditLogs, resetRolledOverMonthlyBudgets } from "./jobs.js";
import { parseUsageEvent } from "./parse-event.js";
import { processEvent } from "./process-event.js";

const config = loadWorkerConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 5 });
const redis = new Redis(config.redisUrl);

const consumer = new UsageConsumer(
  {
    redis,
    stream: config.usageStream,
    group: config.group,
    consumer: config.consumer,
    maxDeliveries: config.maxDeliveries,
  },
  async (payload, entryId) => {
    const event = parseUsageEvent(payload);
    if (!event) return "dead"; // 畸形事件:死信,不无限重试
    await processEvent(
      db,
      (key, value, ttl) => redis.set(key, value, "EX", ttl).then(() => undefined),
      event,
      entryId,
      { auditRetentionDays: config.auditRetentionDays, balanceTtlSeconds: config.balanceTtlSeconds },
    );
    return "ok";
  },
);

let running = true;

async function main(): Promise<void> {
  await consumer.ensureGroup();
  console.log(`worker 启动:stream=${config.usageStream} group=${config.group} consumer=${config.consumer}`);

  const runJobs = async () => {
    try {
      const resets = await resetRolledOverMonthlyBudgets(db);
      const cleaned = await cleanupExpiredAuditLogs(db);
      if (resets || cleaned) console.log(`jobs:月度重置 ${resets} 条,审计清理 ${cleaned} 条`);
    } catch (err) {
      console.error("定时任务失败", err);
    }
  };
  await runJobs();
  const jobTimer = setInterval(runJobs, config.jobIntervalMs);

  // 启动先认领历史滞留,之后每轮顺带认领
  while (running) {
    try {
      await consumer.claimStale(60_000);
      await consumer.consumeOnce(5_000);
    } catch (err) {
      console.error("消费循环异常,3s 后重试", err);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  clearInterval(jobTimer);
  await redis.quit();
  await sql.end();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal},处理完当前批次后退出…`);
    running = false;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: 回归 + Commit**

Run: `pnpm --filter @byok/worker test && pnpm test && pnpm typecheck && pnpm build`

```bash
git add apps/worker/src
git commit -m "feat(worker): 消费循环(重试/死信)、月度重置与审计清理 job、启动装配"
```

---

### Task 7: 真实联调 e2e(gateway + worker)+ 全仓收尾

**Files:**
- Modify: `apps/gateway/scripts/e2e.md`(追加 worker 验收节)

- [ ] **Step 1: 联调执行**

环境:PG(docker compose)+ 本机 Redis + fake-upstream + gateway + worker 同时跑。复用 P2 的 e2e-seed Key(或重新造数)。验收:

1. 发 2 次非流式调用(1 次开 audit 的 Key 若有,或临时 `UPDATE api_keys SET audit_enabled=true`)。
2. **worker 落库**:`psql` 查 `usage_records`(event_id 非空、cost 正确)、`ledger_entries`(每主体一条)、`budgets.used_amount_cny` 增加。
3. **幂等**:`redis-cli XADD` 手工重发同 payload(不同 entry id 会造新账——改为直接观察 XPENDING=0 即可;幂等已有集成测试覆盖,e2e 验证 ack 即可)。
4. **余额校正闭环**:`redis-cli GET bal:key:<id>` 应等于 `(limit-used)` micro(worker SET 的值,而非 gateway DECRBY 的近似值)。
5. **审计**:`request_logs` 有行、expires_at = now+30d。
6. **持久性**(P2 缺口闭合的证明):`redis-cli DEL bal:key:<id>` 模拟 TTL 过期 → 再调用 → gateway 从 PG 重建的余额已含历史消费(预算用尽则 429 仍然 429)。
7. **DLQ**:`redis-cli XADD usage_events '*' payload not-json` → worker 日志显示送死信,`XRANGE usage_events_dlq - +` 有条目。

把以上各项命令与预期写进 `apps/gateway/scripts/e2e.md` 的"Phase 3 worker 验收"一节。

- [ ] **Step 2: 全仓收尾 + Commit**

Run: `pnpm test && pnpm typecheck && pnpm build`

```bash
git add apps/gateway/scripts/e2e.md
git commit -m "test: e2e 手册补 worker 验收节(联调通过)"
```

---

## Self-Review 记录

1. **前置清单覆盖**:8 项中 1(消费)/2(契约)/3(落库链)/4(月度重置)/5(审计)/8(CI)在本计划;6(监控)以 DLQ+XLEN 命令写入 e2e 手册(正式监控接公司体系,出范围);7(渠道 UI 约定)归 Phase 4。
2. **占位符**:无 TBD。Task 7 是执行型验收,命令逐条列出。
3. **类型一致性**:BalanceWrite/ProcessOptions/HandleResult 等签名在测试与实现间一致;subjects 推导与 gateway subjectsForKey 同口径(注释声明);事件契约引用 @byok/shared 单一来源。
4. **已知取舍**:integration 测试在 CI skipIf 跳过(CI 无 PG 服务,后续可加 services 配置);Key 删除场景放宽 usage_records.key_id FK(软引用,注释说明);claimStale 依赖 xautoclaim(Redis ≥6.2,组里 redis:7 满足)。
