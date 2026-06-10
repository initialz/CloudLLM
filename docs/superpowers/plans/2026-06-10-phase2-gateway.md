# BYOK 网关 Phase 2:Gateway 数据面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `apps/gateway`(Hono 数据面):鉴权 → Redis 三层余额截断 → 渠道路由/冷却/故障转移 → 凭证解密注入 → 同构透传(OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`,含流式)→ 计量 → Redis Stream 发用量事件。

**Architecture:** 端口-适配器:核心逻辑(auth/budget/router/usage/upstream)依赖 `types.ts` 中的接口(KeyRepo/CatalogRepo/BudgetLoader/BalanceStore/CooldownStore/EventSink),单测全部用内存 fake 或 ioredis-mock;Drizzle/ioredis 实现放 `db-access.ts`/`redis-stores.ts`;`app.ts` 编排热路径;`index.ts` 负责真实装配与优雅停机。上游 fetch 可注入(`fetchImpl`),故障转移单测不需要真网络。

**Tech Stack:** Hono ^4 + @hono/node-server ^1、ioredis ^5(测试 ioredis-mock ^8)、@byok/shared、@byok/db、Vitest ^3。

**关键约定:**
- 余额缓存 Redis key:`bal:{subjectType}:{subjectId}`,值为剩余 micro-CNY 整数字符串;`"u"` 表示该主体无预算(不限)。TTL 默认 60s。
- 渠道冷却 key:`cooldown:{channelId}`,TTL 默认 30s。
- 用量事件:`XADD usage_events * payload <JSON>`(UsageEvent 结构见 Task 2)。
- 扣减是"读后减"的近似操作,接受微小竞态——PG 台账才是事实源,Phase 3 worker 落库时校正 Redis。
- 同构透传:`models.provider_type` 必须与请求协议一致,不一致返回 400(v1 不做跨协议转换)。
- OpenAI 流式请求注入 `stream_options.include_usage: true`(计量必需,对调用方透明)。

---

### Task 1: 前置修复(P1 评审遗留,见 docs/superpowers/plans/phase2-prerequisites.md)

**Files:**
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/schema.ts`(api_keys.updatedAt)
- Modify: `packages/db/src/seed.ts`
- Modify: `packages/shared/src/cost.ts`
- Test: `packages/shared/src/cost.test.ts`(追加)

- [ ] **Step 1: cnyToMicro 负数支持——先写失败测试**

在 `packages/shared/src/cost.test.ts` 追加:

```ts
describe("cnyToMicro 负数(读回台账冲正)", () => {
  it("解析负数金额", () => {
    expect(cnyToMicro("-1.5")).toBe(-1_500_000n);
    expect(cnyToMicro("-0.000001")).toBe(-1n);
  });

  it("与 microToCny 互为逆运算(负数)", () => {
    expect(microToCny(cnyToMicro("-12.345678"))).toBe("-12.345678");
  });

  it("仍拒绝非法格式", () => {
    expect(() => cnyToMicro("--1")).toThrow();
    expect(() => cnyToMicro("-")).toThrow();
  });
});
```

Run: `pnpm --filter @byok/shared test` → 新增 3 个用例 FAIL。

- [ ] **Step 2: 实现负数解析**

`packages/shared/src/cost.ts` 中 `cnyToMicro` 替换为:

```ts
/** "12.345678"/"-1.5" → micro-CNY bigint。最多 6 位小数,支持负号(台账冲正读回)。 */
export function cnyToMicro(cny: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(cny.trim());
  if (!m) throw new Error(`非法 CNY 金额: ${cny}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? "").padEnd(6, "0") || "0");
  const abs = whole * MICRO + frac;
  return m[1] ? -abs : abs;
}
```

Run: `pnpm --filter @byok/shared test` → 33 个用例全 PASS。

- [ ] **Step 3: createDb 暴露 sql 句柄与池参数**

`packages/db/src/client.ts` 整体替换为:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbBundle = ReturnType<typeof createDb>;
export type Db = DbBundle["db"];

/** 返回 db(查询)与 sql(连接句柄,优雅停机时 await sql.end()) */
export function createDb(databaseUrl: string, options?: { max?: number }) {
  const sql = postgres(databaseUrl, {
    max: options?.max ?? 10,
    idle_timeout: 30,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
```

- [ ] **Step 4: seed.ts 适配新签名并优雅退出**

`packages/db/src/seed.ts` 中 `const db = createDb(DATABASE_URL);` 改为:

```ts
const { db, sql } = createDb(DATABASE_URL, { max: 1 });
```

`main()` 末尾的 `console.log(...); process.exit(0);` 改为:

```ts
  console.log("seed 完成:admin =", ADMIN_EMAIL);
  await sql.end();
```

(catch 分支保留 `process.exit(1)`。)

- [ ] **Step 5: api_keys.updatedAt 加 $onUpdate**

`packages/db/src/schema.ts` 中 api_keys 的 updatedAt 列改为:

```ts
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
```

- [ ] **Step 6: 验证无迁移漂移 + 全仓回归**

Run: `cd packages/db && npx drizzle-kit generate && cd ../..`
Expected: `No schema changes, nothing to migrate`($onUpdate 是应用侧行为,不产生 SQL)。

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS(shared 33 + db 1)。

Run(真实 PG,验证 seed 仍幂等且正常退出):
```bash
docker compose up -d postgres && pnpm --filter @byok/db seed && pnpm --filter @byok/db seed
```
Expected: 两次都输出 `seed 完成`,进程自然退出(不再依赖 process.exit)。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src packages/db/src
git commit -m "feat: P2 前置——createDb 暴露 sql、updatedAt \$onUpdate、cnyToMicro 负数"
```

---

### Task 2: gateway 脚手架 + types.ts + config(TDD)

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/vitest.config.ts`
- Create: `apps/gateway/src/types.ts`
- Create: `apps/gateway/src/config.ts`
- Modify: `.env.example`(追加 gateway 变量)
- Test: `apps/gateway/src/config.test.ts`

- [ ] **Step 1: 包脚手架**

`apps/gateway/package.json`:

```json
{
  "name": "@byok/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@byok/db": "workspace:*",
    "@byok/shared": "workspace:*",
    "@hono/node-server": "^1.14.0",
    "hono": "^4.7.0",
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

`apps/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/gateway/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 2: 写 types.ts(全部口径与接口,后续任务共用)**

`apps/gateway/src/types.ts`:

```ts
export type Protocol = "openai" | "anthropic";

export interface AuthedKey {
  id: string;
  ownerType: "user" | "team" | "app";
  ownerId: string;
  /** owner 为 app 时为其所属团队 id,否则 null */
  teamId: string | null;
  /** null = 不限模型 */
  allowedModels: string[] | null;
  auditEnabled: boolean;
}

export interface BudgetSubject {
  type: "user" | "team" | "app" | "key";
  id: string;
}

export interface ModelInfo {
  slug: string;
  providerType: Protocol;
  prices: {
    inputPerMTok: string;
    outputPerMTok: string;
    cacheReadPerMTok: string;
    cacheWritePerMTok: string;
  };
}

export interface ChannelChoice {
  channelId: string;
  baseUrl: string;
  credentialEncrypted: string;
  upstreamModelId: string;
  priority: number;
  weight: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageEvent {
  keyId: string;
  modelSlug: string;
  channelId: string | null;
  usage: UsageTotals;
  costCny: string;
  latencyMs: number;
  ttftMs: number | null;
  status: "ok" | "upstream_error" | "rejected";
  errorCode: string | null;
  /** ISO 时间戳 */
  ts: string;
  /** 仅 auditEnabled 的 Key 携带 */
  audit?: { requestBody: unknown; responseBody: unknown };
}

// ── 端口(实现见 redis-stores.ts / db-access.ts,单测用 fake)──

export interface BalanceStore {
  /** 与 subjects 一一对应;null=未缓存,"unlimited"=无预算 */
  getMany(subjects: BudgetSubject[]): Promise<(bigint | "unlimited" | null)[]>;
  set(subject: BudgetSubject, value: bigint | "unlimited", ttlSeconds: number): Promise<void>;
  decrBy(subjects: BudgetSubject[], micro: bigint): Promise<void>;
}

export interface CooldownStore {
  isCooling(channelId: string): Promise<boolean>;
  markCooldown(channelId: string, seconds: number): Promise<void>;
}

export interface EventSink {
  emit(event: UsageEvent): Promise<void>;
}

export interface KeyRepo {
  /** 只返回 active 且未过期的 Key,否则 null */
  findActiveByHash(keyHash: string): Promise<AuthedKey | null>;
}

export interface CatalogRepo {
  getModel(slug: string): Promise<ModelInfo | null>;
  /** 该模型的 active 渠道映射(不含 cooldown 过滤,由 router 处理) */
  getChannelsForModel(slug: string): Promise<ChannelChoice[]>;
}

export interface BudgetLoader {
  /** 剩余 micro-CNY;null = 该主体没有预算(不限) */
  loadRemainingMicro(subject: BudgetSubject): Promise<bigint | null>;
}
```

- [ ] **Step 3: config 失败测试**

`apps/gateway/src/config.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  MASTER_KEY: randomBytes(32).toString("base64"),
};

describe("loadConfig", () => {
  it("默认值齐全", () => {
    const c = loadConfig(validEnv);
    expect(c.port).toBe(8080);
    expect(c.balanceTtlSeconds).toBe(60);
    expect(c.cooldownSeconds).toBe(30);
    expect(c.catalogTtlMs).toBe(30000);
    expect(c.usageStream).toBe("usage_events");
  });

  it("环境变量覆盖默认值", () => {
    const c = loadConfig({ ...validEnv, PORT: "9090", COOLDOWN_SECONDS: "5" });
    expect(c.port).toBe(9090);
    expect(c.cooldownSeconds).toBe(5);
  });

  it("缺少必填项抛错并点名变量", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("MASTER_KEY 非 32 字节拒绝", () => {
    expect(() => loadConfig({ ...validEnv, MASTER_KEY: "c2hvcnQ=" })).toThrow(/32/);
  });
});
```

Run: `pnpm install && pnpm --filter @byok/gateway test` → FAIL(找不到 ./config.js)。

- [ ] **Step 4: 实现 config**

`apps/gateway/src/config.ts`:

```ts
export interface GatewayConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** 32 字节 base64,信封加密主密钥 */
  masterKey: string;
  balanceTtlSeconds: number;
  cooldownSeconds: number;
  catalogTtlMs: number;
  usageStream: string;
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
  };
  const masterKey = required("MASTER_KEY");
  if (Buffer.from(masterKey, "base64").length !== 32) {
    throw new Error("MASTER_KEY 必须是 32 字节的 base64");
  }
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    masterKey,
    balanceTtlSeconds: Number(env.BALANCE_TTL_SECONDS ?? 60),
    cooldownSeconds: Number(env.COOLDOWN_SECONDS ?? 30),
    catalogTtlMs: Number(env.CATALOG_TTL_MS ?? 30000),
    usageStream: env.USAGE_STREAM ?? "usage_events",
  };
}
```

`.env.example` 末尾追加:

```
# Gateway
PORT=8080
BALANCE_TTL_SECONDS=60
COOLDOWN_SECONDS=30
CATALOG_TTL_MS=30000
USAGE_STREAM=usage_events
```

- [ ] **Step 5: 跑通**

Run: `pnpm --filter @byok/gateway test && pnpm --filter @byok/gateway typecheck`
Expected: 4 个用例 PASS,typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add apps/gateway .env.example pnpm-lock.yaml
git commit -m "feat(gateway): 脚手架、领域类型与配置加载"
```

---

### Task 3: TtlCache + 鉴权 auth(TDD)

**Files:**
- Create: `apps/gateway/src/ttl-cache.ts`
- Create: `apps/gateway/src/auth.ts`
- Test: `apps/gateway/src/ttl-cache.test.ts`
- Test: `apps/gateway/src/auth.test.ts`

- [ ] **Step 1: TtlCache 失败测试**

`apps/gateway/src/ttl-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("TTL 内命中缓存,不再调 loader", async () => {
    let now = 0;
    let calls = 0;
    const cache = new TtlCache<string>(1000, () => now);
    expect(await cache.get("k", async () => { calls++; return "v1"; })).toBe("v1");
    expect(await cache.get("k", async () => { calls++; return "v2"; })).toBe("v1");
    expect(calls).toBe(1);
  });

  it("过期后重新加载", async () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    await cache.get("k", async () => "v1");
    now = 1001;
    expect(await cache.get("k", async () => "v2")).toBe("v2");
  });
});
```

Run: `pnpm --filter @byok/gateway test` → 新文件 FAIL。

- [ ] **Step 2: 实现 TtlCache**

`apps/gateway/src/ttl-cache.ts`:

```ts
interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** 进程内 TTL 缓存,用于模型目录/渠道列表的热路径读 */
export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const value = await loader();
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}
```

- [ ] **Step 3: auth 失败测试**

`apps/gateway/src/auth.test.ts`:

```ts
import { generateApiKey } from "@byok/shared";
import { describe, expect, it } from "vitest";
import { authenticate } from "./auth.js";
import type { AuthedKey, KeyRepo } from "./types.js";

const KEY: AuthedKey = {
  id: "key-1",
  ownerType: "app",
  ownerId: "app-1",
  teamId: "team-1",
  allowedModels: ["anthropic/claude-opus-4-8"],
  auditEnabled: false,
};

function repoWith(hash: string | null): KeyRepo {
  return {
    async findActiveByHash(h) {
      return hash !== null && h === hash ? KEY : null;
    },
  };
}

describe("authenticate", () => {
  it("合法 Key + 白名单内模型通过", async () => {
    const k = generateApiKey();
    const r = await authenticate(repoWith(k.keyHash), k.plaintext, "anthropic/claude-opus-4-8");
    expect(r).toEqual({ ok: true, key: KEY });
  });

  it("缺失或非 sk-wtg- 前缀返回 401", async () => {
    expect((await authenticate(repoWith(null), undefined, "m")).ok).toBe(false);
    const r = await authenticate(repoWith(null), "sk-other-xxx", "m");
    expect(r).toMatchObject({ ok: false, status: 401, code: "invalid_api_key" });
  });

  it("查不到(无效/停用/过期)返回 401", async () => {
    const r = await authenticate(repoWith(null), "sk-wtg-notexist", "m");
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("白名单外模型返回 403 model_not_allowed", async () => {
    const k = generateApiKey();
    const r = await authenticate(repoWith(k.keyHash), k.plaintext, "openai/gpt-x");
    expect(r).toMatchObject({ ok: false, status: 403, code: "model_not_allowed" });
  });
});
```

Run: `pnpm --filter @byok/gateway test` → auth 文件 FAIL。

- [ ] **Step 4: 实现 auth**

`apps/gateway/src/auth.ts`:

```ts
import { hashApiKey } from "@byok/shared";
import type { AuthedKey, KeyRepo } from "./types.js";

export type AuthResult =
  | { ok: true; key: AuthedKey }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticate(
  repo: KeyRepo,
  rawKey: string | undefined,
  modelSlug: string,
): Promise<AuthResult> {
  if (!rawKey || !rawKey.startsWith("sk-wtg-")) {
    return { ok: false, status: 401, code: "invalid_api_key", message: "缺少或非法的 API Key" };
  }
  const key = await repo.findActiveByHash(hashApiKey(rawKey));
  if (!key) {
    return { ok: false, status: 401, code: "invalid_api_key", message: "API Key 无效或已停用" };
  }
  if (key.allowedModels !== null && !key.allowedModels.includes(modelSlug)) {
    return {
      ok: false,
      status: 403,
      code: "model_not_allowed",
      message: `该 Key 无权使用模型 ${modelSlug}`,
    };
  }
  return { ok: true, key };
}
```

- [ ] **Step 5: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(6 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): TtlCache 与 API Key 鉴权"
```

---

### Task 4: 预算三层截断 budget(TDD)

**Files:**
- Create: `apps/gateway/src/budget.ts`
- Test: `apps/gateway/src/budget.test.ts`

- [ ] **Step 1: 失败测试**

`apps/gateway/src/budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkBudgets, settleBudgets, subjectsForKey } from "./budget.js";
import type { AuthedKey, BalanceStore, BudgetLoader, BudgetSubject } from "./types.js";

class FakeStore implements BalanceStore {
  data = new Map<string, bigint | "unlimited">();
  decrCalls: Array<{ subjects: BudgetSubject[]; micro: bigint }> = [];
  private k(s: BudgetSubject) {
    return `${s.type}:${s.id}`;
  }
  async getMany(subjects: BudgetSubject[]) {
    return subjects.map((s) => this.data.get(this.k(s)) ?? null);
  }
  async set(s: BudgetSubject, v: bigint | "unlimited") {
    this.data.set(this.k(s), v);
  }
  async decrBy(subjects: BudgetSubject[], micro: bigint) {
    this.decrCalls.push({ subjects, micro });
    for (const s of subjects) {
      const cur = this.data.get(this.k(s));
      if (typeof cur === "bigint") this.data.set(this.k(s), cur - micro);
    }
  }
}

const loaderOf = (map: Record<string, bigint | null>): BudgetLoader => ({
  async loadRemainingMicro(s) {
    return map[`${s.type}:${s.id}`] ?? null;
  },
});

const appKey: AuthedKey = {
  id: "k1", ownerType: "app", ownerId: "a1", teamId: "t1",
  allowedModels: null, auditEnabled: false,
};

describe("subjectsForKey", () => {
  it("app Key 产生 key/app/team 三层", () => {
    expect(subjectsForKey(appKey)).toEqual([
      { type: "key", id: "k1" },
      { type: "app", id: "a1" },
      { type: "team", id: "t1" },
    ]);
  });

  it("个人 Key 产生 key/user 两层", () => {
    expect(
      subjectsForKey({ ...appKey, ownerType: "user", ownerId: "u1", teamId: null }),
    ).toEqual([
      { type: "key", id: "k1" },
      { type: "user", id: "u1" },
    ]);
  });
});

describe("checkBudgets", () => {
  it("缓存未命中时从 loader 回填并缓存", async () => {
    const store = new FakeStore();
    const subjects = subjectsForKey(appKey);
    const r = await checkBudgets(store, loaderOf({ "key:k1": 100n, "app:a1": null, "team:t1": 50n }), subjects, 60);
    expect(r).toEqual({ ok: true });
    expect(store.data.get("app:a1")).toBe("unlimited");
    expect(store.data.get("team:t1")).toBe(50n);
  });

  it("任一层余额 ≤0 即拒绝并指出主体", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", 100n);
    store.data.set("app:a1", 0n);
    const r = await checkBudgets(store, loaderOf({}), subjectsForKey(appKey), 60);
    expect(r).toEqual({ ok: false, exhausted: { type: "app", id: "a1" } });
  });

  it("负余额(已超透)同样拒绝", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", -5n);
    const r = await checkBudgets(store, loaderOf({}), [{ type: "key", id: "k1" }], 60);
    expect(r.ok).toBe(false);
  });

  it("无预算主体(unlimited)放行", async () => {
    const store = new FakeStore();
    const r = await checkBudgets(store, loaderOf({}), [{ type: "key", id: "k1" }], 60);
    expect(r).toEqual({ ok: true });
  });
});

describe("settleBudgets", () => {
  it("成本为 0 时不扣减", async () => {
    const store = new FakeStore();
    await settleBudgets(store, [{ type: "key", id: "k1" }], 0n);
    expect(store.decrCalls).toHaveLength(0);
  });

  it("正成本对全部层扣减", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", 100n);
    await settleBudgets(store, subjectsForKey(appKey), 30n);
    expect(store.decrCalls).toHaveLength(1);
    expect(store.data.get("key:k1")).toBe(70n);
  });
});
```

Run: `pnpm --filter @byok/gateway test` → budget 文件 FAIL。

- [ ] **Step 2: 实现 budget**

`apps/gateway/src/budget.ts`:

```ts
import type { AuthedKey, BalanceStore, BudgetLoader, BudgetSubject } from "./types.js";

/** 预算上卷路径:Key 自身 → 归属主体 → (app 时)所属团队 */
export function subjectsForKey(key: AuthedKey): BudgetSubject[] {
  const subjects: BudgetSubject[] = [
    { type: "key", id: key.id },
    { type: key.ownerType, id: key.ownerId },
  ];
  if (key.ownerType === "app" && key.teamId) {
    subjects.push({ type: "team", id: key.teamId });
  }
  return subjects;
}

export type BudgetCheck = { ok: true } | { ok: false; exhausted: BudgetSubject };

/** 准实时截断:读缓存余额,未命中回源 PG 并回填;任一层 ≤0 拒绝 */
export async function checkBudgets(
  store: BalanceStore,
  loader: BudgetLoader,
  subjects: BudgetSubject[],
  ttlSeconds: number,
): Promise<BudgetCheck> {
  const cached = await store.getMany(subjects);
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i]!;
    let value = cached[i] ?? null;
    if (value === null) {
      const loaded = await loader.loadRemainingMicro(subject);
      value = loaded === null ? "unlimited" : loaded;
      await store.set(subject, value, ttlSeconds);
    }
    if (value !== "unlimited" && value <= 0n) {
      return { ok: false, exhausted: subject };
    }
  }
  return { ok: true };
}

/** 请求结束后异步扣减(近似值,PG 台账为准) */
export async function settleBudgets(
  store: BalanceStore,
  subjects: BudgetSubject[],
  costMicro: bigint,
): Promise<void> {
  if (costMicro > 0n) {
    await store.decrBy(subjects, costMicro);
  }
}
```

- [ ] **Step 3: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(14 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): 三层预算检查与异步扣减"
```

---

### Task 5: 用量解析 usage(TDD,两协议 × 非流式/SSE)

**Files:**
- Create: `apps/gateway/src/usage.ts`
- Test: `apps/gateway/src/usage.test.ts`

**口径:** OpenAI 的 `prompt_tokens` 含缓存命中,需拆分:`input = prompt_tokens - cached_tokens`,`cacheRead = cached_tokens`;OpenAI 无 cacheWrite。Anthropic 的 `input_tokens` 不含缓存,`cache_read_input_tokens`/`cache_creation_input_tokens` 分别对应 cacheRead/cacheWrite。SSE:OpenAI 用量在最终 chunk 的 `usage` 字段(需 include_usage);Anthropic 在 `message_start`(input/cache)与 `message_delta`(累计 output)。

- [ ] **Step 1: 失败测试**

`apps/gateway/src/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SseUsageTap, extractUsageFromJson } from "./usage.js";

describe("extractUsageFromJson", () => {
  it("openai:拆分缓存命中", () => {
    const u = extractUsageFromJson("openai", {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    });
    expect(u).toEqual({ inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it("openai:无缓存明细时 cached=0", () => {
    const u = extractUsageFromJson("openai", { usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("anthropic:四字段直读", () => {
    const u = extractUsageFromJson("anthropic", {
      usage: {
        input_tokens: 7,
        output_tokens: 9,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });
    expect(u).toEqual({ inputTokens: 7, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });

  it("缺失/畸形 usage 返回全零", () => {
    expect(extractUsageFromJson("openai", null)).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(extractUsageFromJson("anthropic", { usage: "bad" })).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });
});

describe("SseUsageTap openai", () => {
  it("从最终 chunk 提取 usage,跨 chunk 断行也能解析", () => {
    const tap = new SseUsageTap("openai");
    tap.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    // 模拟同一行被拆成两个网络包
    tap.push('data: {"usage":{"prompt_tokens":12,"completion_tokens":3,');
    tap.push('"prompt_tokens_details":{"cached_tokens":2}},"choices":[]}\n\ndata: [DONE]\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 });
  });

  it("无 usage 的流返回全零", () => {
    const tap = new SseUsageTap("openai");
    tap.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("SseUsageTap anthropic", () => {
  it("message_start 取 input/cache,message_delta 取累计 output", () => {
    const tap = new SseUsageTap("anthropic");
    tap.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":5,"cache_creation_input_tokens":1,"output_tokens":1}}}\n\n',
    );
    tap.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    tap.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 25, outputTokens: 77, cacheReadTokens: 5, cacheWriteTokens: 1 });
  });

  it("非 JSON 行与心跳行不影响解析", () => {
    const tap = new SseUsageTap("anthropic");
    tap.push(": ping\n\n");
    tap.push("data: not-json\n\n");
    expect(tap.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
```

Run: `pnpm --filter @byok/gateway test` → usage 文件 FAIL。

- [ ] **Step 2: 实现 usage**

`apps/gateway/src/usage.ts`:

```ts
import type { Protocol, UsageTotals } from "./types.js";

const zero = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 非流式响应体提取用量。OpenAI 的 prompt_tokens 含缓存命中,拆分计价。 */
export function extractUsageFromJson(protocol: Protocol, body: unknown): UsageTotals {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") return zero();
  const u = usage as Record<string, unknown>;
  if (protocol === "openai") {
    const prompt = num(u.prompt_tokens);
    const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
    const cached = num(details?.cached_tokens);
    return {
      inputTokens: Math.max(prompt - cached, 0),
      outputTokens: num(u.completion_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/** SSE 流用量收集器:把已解码文本喂给 push(),流结束后 totals() 取结果。容忍跨 chunk 断行。 */
export class SseUsageTap {
  private buffer = "";
  private usage: UsageTotals = zero();

  constructor(private protocol: Protocol) {}

  push(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        this.consume(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // 非 JSON 行(或被进一步拆分的行)直接忽略,不影响透传
      }
    }
  }

  totals(): UsageTotals {
    return this.usage;
  }

  private consume(evt: Record<string, unknown>): void {
    if (this.protocol === "openai") {
      if (evt.usage && typeof evt.usage === "object") {
        this.usage = extractUsageFromJson("openai", evt);
      }
      return;
    }
    if (evt.type === "message_start") {
      const msg = (evt.message ?? null) as Record<string, unknown> | null;
      const partial = extractUsageFromJson("anthropic", msg);
      this.usage = { ...partial, outputTokens: this.usage.outputTokens };
    } else if (evt.type === "message_delta") {
      const u = (evt.usage ?? {}) as Record<string, unknown>;
      if (typeof u.output_tokens === "number") {
        this.usage.outputTokens = u.output_tokens;
      }
    }
  }
}
```

- [ ] **Step 3: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(22 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): 两协议用量解析(非流式 + SSE tap)"
```

---

### Task 6: 渠道路由 router(TDD,注入 RNG)

**Files:**
- Create: `apps/gateway/src/router.ts`
- Test: `apps/gateway/src/router.test.ts`

- [ ] **Step 1: 失败测试**

`apps/gateway/src/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectCandidates } from "./router.js";
import type { CatalogRepo, ChannelChoice, CooldownStore } from "./types.js";

const ch = (id: string, priority: number, weight: number): ChannelChoice => ({
  channelId: id,
  baseUrl: `https://up.example/${id}`,
  credentialEncrypted: "{}",
  upstreamModelId: "real-model",
  priority,
  weight,
});

const catalogOf = (list: ChannelChoice[]): CatalogRepo => ({
  async getModel() {
    return null;
  },
  async getChannelsForModel() {
    return list;
  },
});

const cooldownOf = (cooling: string[]): CooldownStore => ({
  async isCooling(id) {
    return cooling.includes(id);
  },
  async markCooldown() {},
});

describe("selectCandidates", () => {
  it("按 priority 升序分组,组内全员保留", async () => {
    const r = await selectCandidates(
      catalogOf([ch("b", 1, 1), ch("a", 0, 1), ch("c", 1, 1)]),
      cooldownOf([]),
      "m",
      () => 0.5,
    );
    expect(r[0]!.channelId).toBe("a");
    expect(r.map((c) => c.channelId).sort()).toEqual(["a", "b", "c"]);
  });

  it("过滤 cooldown 中的渠道", async () => {
    const r = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 1)]),
      cooldownOf(["a"]),
      "m",
      () => 0.5,
    );
    expect(r.map((c) => c.channelId)).toEqual(["b"]);
  });

  it("权重影响组内排序:rng 偏小时选中第一个累计区间", async () => {
    // weight a=1, b=3;rng=0.1 → 0.1*4=0.4 落在 a 的区间(a 在前)
    const r = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 3)]),
      cooldownOf([]),
      "m",
      () => 0.1,
    );
    expect(r[0]!.channelId).toBe("a");
    // rng=0.9 → 0.9*4=3.6 落在 b 区间
    const r2 = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 3)]),
      cooldownOf([]),
      "m",
      () => 0.9,
    );
    expect(r2[0]!.channelId).toBe("b");
  });

  it("无可用渠道返回空数组", async () => {
    const r = await selectCandidates(catalogOf([]), cooldownOf([]), "m");
    expect(r).toEqual([]);
  });
});
```

Run: `pnpm --filter @byok/gateway test` → router 文件 FAIL。

- [ ] **Step 2: 实现 router**

`apps/gateway/src/router.ts`:

```ts
import type { CatalogRepo, ChannelChoice, CooldownStore } from "./types.js";

/**
 * 返回有序候选渠道列表(供故障转移逐个尝试):
 * priority 升序分组;组内按 weight 加权随机排列;跳过 cooldown 中的渠道。
 */
export async function selectCandidates(
  catalog: CatalogRepo,
  cooldown: CooldownStore,
  modelSlug: string,
  rng: () => number = Math.random,
): Promise<ChannelChoice[]> {
  const all = await catalog.getChannelsForModel(modelSlug);
  const usable: ChannelChoice[] = [];
  for (const channel of all) {
    if (!(await cooldown.isCooling(channel.channelId))) usable.push(channel);
  }
  const groups = new Map<number, ChannelChoice[]>();
  for (const channel of usable) {
    const group = groups.get(channel.priority) ?? [];
    group.push(channel);
    groups.set(channel.priority, group);
  }
  const ordered: ChannelChoice[] = [];
  for (const priority of [...groups.keys()].sort((a, b) => a - b)) {
    ordered.push(...weightedShuffle(groups.get(priority)!, rng));
  }
  return ordered;
}

/** 加权不放回抽样:每轮按 weight 占比抽一个 */
function weightedShuffle(items: ChannelChoice[], rng: () => number): ChannelChoice[] {
  const pool = [...items];
  const result: ChannelChoice[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + Math.max(c.weight, 1), 0);
    let pick = rng() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      pick -= Math.max(pool[i]!.weight, 1);
      if (pick < 0) {
        idx = i;
        break;
      }
    }
    result.push(pool.splice(idx, 1)[0]!);
  }
  return result;
}
```

- [ ] **Step 3: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(26 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): 渠道路由——优先级分组与加权排列"
```

---

### Task 7: Redis 适配器 redis-stores(ioredis-mock 单测)

**Files:**
- Create: `apps/gateway/src/redis-stores.ts`
- Test: `apps/gateway/src/redis-stores.test.ts`

- [ ] **Step 1: 失败测试**

`apps/gateway/src/redis-stores.test.ts`:

```ts
import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { RedisBalanceStore, RedisCooldownStore, RedisEventSink } from "./redis-stores.js";
import type { UsageEvent } from "./types.js";

const subject = { type: "key" as const, id: "k1" };

describe("RedisBalanceStore", () => {
  it("set/getMany 往返,unlimited 用哨兵存储", async () => {
    const store = new RedisBalanceStore(new RedisMock());
    await store.set(subject, 123n, 60);
    await store.set({ type: "team", id: "t1" }, "unlimited", 60);
    const r = await store.getMany([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }]);
    expect(r).toEqual([123n, "unlimited", null]);
  });

  it("decrBy 只对数值余额扣减,跳过 unlimited 与未缓存", async () => {
    const store = new RedisBalanceStore(new RedisMock());
    await store.set(subject, 100n, 60);
    await store.set({ type: "team", id: "t1" }, "unlimited", 60);
    await store.decrBy([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }], 30n);
    const r = await store.getMany([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }]);
    expect(r).toEqual([70n, "unlimited", null]);
  });
});

describe("RedisCooldownStore", () => {
  it("markCooldown 后 isCooling 为 true", async () => {
    const store = new RedisCooldownStore(new RedisMock());
    expect(await store.isCooling("c1")).toBe(false);
    await store.markCooldown("c1", 30);
    expect(await store.isCooling("c1")).toBe(true);
  });
});

describe("RedisEventSink", () => {
  it("XADD 写入流,payload 可解析回 UsageEvent", async () => {
    const redis = new RedisMock();
    const sink = new RedisEventSink(redis, "usage_events");
    const event: UsageEvent = {
      keyId: "k1", modelSlug: "anthropic/claude-opus-4-8", channelId: "c1",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costCny: "0.000123", latencyMs: 88, ttftMs: 12,
      status: "ok", errorCode: null, ts: "2026-06-10T00:00:00.000Z",
    };
    await sink.emit(event);
    const entries = await redis.xrange("usage_events", "-", "+");
    expect(entries).toHaveLength(1);
    const fields = entries[0]![1];
    expect(fields[0]).toBe("payload");
    expect(JSON.parse(fields[1]!)).toEqual(event);
  });
});
```

Run: `pnpm --filter @byok/gateway test` → redis-stores 文件 FAIL。

- [ ] **Step 2: 实现 redis-stores**

`apps/gateway/src/redis-stores.ts`:

```ts
import type Redis from "ioredis";
import type { BalanceStore, BudgetSubject, CooldownStore, EventSink, UsageEvent } from "./types.js";

const UNLIMITED_SENTINEL = "u";
const balKey = (s: BudgetSubject) => `bal:${s.type}:${s.id}`;

export class RedisBalanceStore implements BalanceStore {
  constructor(private redis: Redis) {}

  async getMany(subjects: BudgetSubject[]): Promise<(bigint | "unlimited" | null)[]> {
    if (subjects.length === 0) return [];
    const values = await this.redis.mget(subjects.map(balKey));
    return values.map((v) =>
      v === null ? null : v === UNLIMITED_SENTINEL ? ("unlimited" as const) : BigInt(v),
    );
  }

  async set(subject: BudgetSubject, value: bigint | "unlimited", ttlSeconds: number): Promise<void> {
    await this.redis.set(
      balKey(subject),
      value === "unlimited" ? UNLIMITED_SENTINEL : value.toString(),
      "EX",
      ttlSeconds,
    );
  }

  async decrBy(subjects: BudgetSubject[], micro: bigint): Promise<void> {
    // 读后减,接受微小竞态:余额是热缓存,PG 台账才是事实源,Phase 3 worker 落库时校正
    for (const subject of subjects) {
      const key = balKey(subject);
      const current = await this.redis.get(key);
      if (current !== null && current !== UNLIMITED_SENTINEL) {
        // 以字符串传 DECRBY,避免大额 bigint 经 Number 损失精度
        await this.redis.call("decrby", key, micro.toString());
      }
    }
  }
}

export class RedisCooldownStore implements CooldownStore {
  constructor(private redis: Redis) {}

  async isCooling(channelId: string): Promise<boolean> {
    return (await this.redis.exists(`cooldown:${channelId}`)) === 1;
  }

  async markCooldown(channelId: string, seconds: number): Promise<void> {
    await this.redis.set(`cooldown:${channelId}`, "1", "EX", seconds);
  }
}

export class RedisEventSink implements EventSink {
  constructor(
    private redis: Redis,
    private stream: string,
  ) {}

  async emit(event: UsageEvent): Promise<void> {
    await this.redis.xadd(this.stream, "*", "payload", JSON.stringify(event));
  }
}
```

(注:`ioredis-mock` 的类型与 ioredis 兼容;若 TS 报构造类型不匹配,在测试里 `new RedisMock() as unknown as Redis`。)

- [ ] **Step 3: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(30 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): Redis 余额/冷却/事件流适配器"
```

---

### Task 8: 上游转发与故障转移 upstream(TDD,注入 fetchImpl)

**Files:**
- Create: `apps/gateway/src/upstream.ts`
- Test: `apps/gateway/src/upstream.test.ts`

- [ ] **Step 1: 失败测试**

`apps/gateway/src/upstream.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@byok/shared";
import { describe, expect, it } from "vitest";
import { forwardWithFailover } from "./upstream.js";
import type { ChannelChoice, CooldownStore } from "./types.js";

const master = randomBytes(32).toString("base64");

const chan = (id: string): ChannelChoice => ({
  channelId: id,
  baseUrl: `https://up.example/${id}/v1`,
  credentialEncrypted: encryptSecret(`real-key-${id}`, master, id),
  upstreamModelId: "real-model",
  priority: 0,
  weight: 1,
});

class FakeCooldown implements CooldownStore {
  marked: string[] = [];
  async isCooling() {
    return false;
  }
  async markCooldown(id: string) {
    this.marked.push(id);
  }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("forwardWithFailover", () => {
  it("非流式:注入凭证、替换 model、提取用量", async () => {
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "openai",
      requestBody: { model: "openai/gpt-test", messages: [] },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: new Headers(init!.headers).get("authorization"),
          body: JSON.parse(String(init!.body)),
        });
        return jsonResponse(200, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen[0]!.url).toBe("https://up.example/c1/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer real-key-c1");
    expect(seen[0]!.body.model).toBe("real-model");
    expect(await r.usagePromise).toEqual({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("anthropic:x-api-key 与 anthropic-version 头", async () => {
    let headers: Headers | null = null;
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "anthropic",
      requestBody: { model: "anthropic/claude-test", messages: [], max_tokens: 8 },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      anthropicVersion: "2024-01-01",
      fetchImpl: async (url, init) => {
        headers = new Headers(init!.headers);
        expect(String(url)).toBe("https://up.example/c1/v1/messages");
        return jsonResponse(200, { usage: { input_tokens: 3, output_tokens: 4 } });
      },
    });
    expect(r.ok).toBe(true);
    expect(headers!.get("x-api-key")).toBe("real-key-c1");
    expect(headers!.get("anthropic-version")).toBe("2024-01-01");
  });

  it("5xx/网络错误冷却并切换下一渠道;全失败返回 upstream_failed", async () => {
    const cooldown = new FakeCooldown();
    let calls = 0;
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2"), chan("c3")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(500, {});
        if (calls === 2) throw new Error("ECONNREFUSED");
        return jsonResponse(503, {});
      },
    });
    expect(r).toMatchObject({ ok: false, code: "upstream_failed", lastStatus: 503 });
    expect(cooldown.marked).toEqual(["c1", "c2", "c3"]);
  });

  it("失败后第二渠道成功", async () => {
    const cooldown = new FakeCooldown();
    let calls = 0;
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(429, {});
        return jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel.channelId).toBe("c2");
    expect(cooldown.marked).toEqual(["c1"]);
  });

  it("不可重试的 4xx 原样返回给调用方,不冷却", async () => {
    const cooldown = new FakeCooldown();
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => jsonResponse(400, { error: { message: "bad request" } }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(400);
    expect(cooldown.marked).toEqual([]);
  });

  it("流式:原样透传字节,旁路解析 usage,注入 include_usage", async () => {
    let sentBody: Record<string, unknown> = {};
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "openai",
      requestBody: { model: "m", messages: [], stream: true },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String(init!.body));
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":6,"completion_tokens":2},"choices":[]}\n\n',
          "data: [DONE]\n\n",
        ]);
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    const text = await new Response(r.body as ReadableStream<Uint8Array>).text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain("[DONE]");
    expect(await r.usagePromise).toEqual({
      inputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("空候选返回 no_channel", async () => {
    const r = await forwardWithFailover({
      candidates: [],
      protocol: "openai",
      requestBody: { model: "m" },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async () => jsonResponse(200, {}),
    });
    expect(r).toMatchObject({ ok: false, code: "no_channel" });
  });
});
```

Run: `pnpm --filter @byok/gateway test` → upstream 文件 FAIL。

- [ ] **Step 2: 实现 upstream**

`apps/gateway/src/upstream.ts`:

```ts
import { decryptSecret } from "@byok/shared";
import type { ChannelChoice, CooldownStore, Protocol, UsageTotals } from "./types.js";
import { SseUsageTap, extractUsageFromJson } from "./usage.js";

export interface ForwardOk {
  ok: true;
  channel: ChannelChoice;
  status: number;
  headers: Headers;
  /** 回给调用方的 body(流式为 tap 过的流,非流式为原文文本) */
  body: ReadableStream<Uint8Array> | string;
  /** 流结束(或立即)解析到的用量 */
  usagePromise: Promise<UsageTotals>;
  ttftMs: number;
  /** 非流式时的响应 JSON(审计用);流式为 null */
  responseJson: unknown | null;
}

export interface ForwardErr {
  ok: false;
  code: "no_channel" | "upstream_failed";
  lastStatus: number | null;
}

export interface ForwardOptions {
  candidates: ChannelChoice[];
  protocol: Protocol;
  /** 已解析的请求体(model 为对外 slug,转发时替换) */
  requestBody: Record<string, unknown>;
  masterKey: string;
  cooldown: CooldownStore;
  cooldownSeconds: number;
  /** 调用方传来的 anthropic-version 头(仅 anthropic 协议) */
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const isRetryable = (status: number) => status === 408 || status === 429 || status >= 500;

export async function forwardWithFailover(opts: ForwardOptions): Promise<ForwardOk | ForwardErr> {
  const fetchFn = opts.fetchImpl ?? fetch;
  if (opts.candidates.length === 0) {
    return { ok: false, code: "no_channel", lastStatus: null };
  }

  const isStream = opts.requestBody.stream === true;
  let lastStatus: number | null = null;

  for (const channel of opts.candidates) {
    const body: Record<string, unknown> = { ...opts.requestBody, model: channel.upstreamModelId };
    if (opts.protocol === "openai" && isStream) {
      // 计量必需:强制合并 include_usage(客户端自带 stream_options 也不能关掉,否则整条流零计费)
      body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    }

    const credential = decryptSecret(channel.credentialEncrypted, opts.masterKey, channel.channelId);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.protocol === "openai") {
      headers.authorization = `Bearer ${credential}`;
    } else {
      headers["x-api-key"] = credential;
      headers["anthropic-version"] = opts.anthropicVersion ?? "2023-06-01";
    }
    const base = channel.baseUrl.replace(/\/$/, "");
    const url = opts.protocol === "openai" ? `${base}/chat/completions` : `${base}/messages`;

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      await opts.cooldown.markCooldown(channel.channelId, opts.cooldownSeconds);
      continue;
    }

    if (isRetryable(res.status)) {
      lastStatus = res.status;
      await opts.cooldown.markCooldown(channel.channelId, opts.cooldownSeconds);
      continue;
    }
    const ttftMs = Date.now() - startedAt;

    if (!res.ok) {
      // 不可重试的 4xx:原样透传调用方错误,不冷却渠道,不计费
      const text = await res.text();
      return {
        ok: true, channel, status: res.status, headers: res.headers, body: text,
        usagePromise: Promise.resolve(ZERO), ttftMs, responseJson: safeParse(text),
      };
    }

    if (!isStream) {
      const text = await res.text();
      const json = safeParse(text);
      return {
        ok: true, channel, status: res.status, headers: res.headers, body: text,
        usagePromise: Promise.resolve(extractUsageFromJson(opts.protocol, json)),
        ttftMs, responseJson: json,
      };
    }

    // 流式:tee——原样透传字节,同时旁路喂给 usage tap
    const tap = new SseUsageTap(opts.protocol);
    const decoder = new TextDecoder();
    let resolveUsage!: (u: UsageTotals) => void;
    const usagePromise = new Promise<UsageTotals>((resolve) => {
      resolveUsage = resolve;
    });
    const tapped = res.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          tap.push(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          tap.push(decoder.decode());
          resolveUsage(tap.totals());
        },
      }),
    );
    return {
      ok: true, channel, status: res.status, headers: res.headers, body: tapped,
      usagePromise, ttftMs, responseJson: null,
    };
  }

  return { ok: false, code: "upstream_failed", lastStatus };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test`(37 用例 PASS)

```bash
git add apps/gateway/src
git commit -m "feat(gateway): 上游转发——凭证注入、流式 tee、故障转移"
```

---

### Task 9: 热路径编排 app + Drizzle 仓储 db-access + 启动 index

**Files:**
- Create: `apps/gateway/src/app.ts`
- Create: `apps/gateway/src/db-access.ts`
- Create: `apps/gateway/src/index.ts`
- Test: `apps/gateway/src/app.test.ts`

(db-access 无单测——其正确性由 Task 10 真实依赖 e2e 覆盖;app 用全 fake 测编排。)

- [ ] **Step 1: app 失败测试**

`apps/gateway/src/app.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { encryptSecret, generateApiKey } from "@byok/shared";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import type {
  AuthedKey, BalanceStore, BudgetLoader, BudgetSubject, CatalogRepo,
  ChannelChoice, CooldownStore, EventSink, KeyRepo, ModelInfo, UsageEvent,
} from "./types.js";

const master = randomBytes(32).toString("base64");
const apiKey = generateApiKey();

const MODEL: ModelInfo = {
  slug: "openai/gpt-test",
  providerType: "openai",
  prices: { inputPerMTok: "21", outputPerMTok: "105", cacheReadPerMTok: "2.1", cacheWritePerMTok: "0" },
};

const CLAUDE: ModelInfo = {
  slug: "anthropic/claude-test",
  providerType: "anthropic",
  prices: { inputPerMTok: "30", outputPerMTok: "150", cacheReadPerMTok: "3", cacheWritePerMTok: "37.5" },
};

const KEY: AuthedKey = {
  id: "key-1", ownerType: "user", ownerId: "u1", teamId: null,
  allowedModels: null, auditEnabled: false,
};

function makeDeps(overrides: Partial<AppDeps> = {}): { deps: AppDeps; events: UsageEvent[] } {
  const events: UsageEvent[] = [];
  const channel: ChannelChoice = {
    channelId: "c1", baseUrl: "https://up.example/v1",
    credentialEncrypted: encryptSecret("upstream-key", master, "c1"),
    upstreamModelId: "real-model", priority: 0, weight: 1,
  };
  const deps: AppDeps = {
    masterKey: master,
    balanceTtlSeconds: 60,
    cooldownSeconds: 30,
    catalogTtlMs: 0,
    keyRepo: {
      async findActiveByHash(h) {
        return h === apiKey.keyHash ? KEY : null;
      },
    } satisfies KeyRepo,
    catalog: {
      async getModel(slug) {
        if (slug === MODEL.slug) return MODEL;
        if (slug === CLAUDE.slug) return CLAUDE;
        return null;
      },
      async getChannelsForModel() {
        return [channel];
      },
    } satisfies CatalogRepo,
    loader: { async loadRemainingMicro() { return null; } } satisfies BudgetLoader,
    balance: {
      store: new Map<string, bigint | "unlimited">(),
      async getMany(subjects: BudgetSubject[]) {
        return subjects.map((s) => this.store.get(`${s.type}:${s.id}`) ?? null);
      },
      async set(s: BudgetSubject, v: bigint | "unlimited") {
        this.store.set(`${s.type}:${s.id}`, v);
      },
      async decrBy(subjects: BudgetSubject[], micro: bigint) {
        for (const s of subjects) {
          const cur = this.store.get(`${s.type}:${s.id}`);
          if (typeof cur === "bigint") this.store.set(`${s.type}:${s.id}`, cur - micro);
        }
      },
    } as BalanceStore & { store: Map<string, bigint | "unlimited"> },
    cooldown: {
      async isCooling() { return false; },
      async markCooldown() {},
    } satisfies CooldownStore,
    events: {
      async emit(e) { events.push(e); },
    } satisfies EventSink,
    fetchImpl: async () =>
      new Response(JSON.stringify({ id: "resp-1", usage: { prompt_tokens: 1000, completion_tokens: 500 } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ...overrides,
  };
  return { deps, events };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("POST /v1/chat/completions", () => {
  it("全链路成功:200 + 事件入流 + 余额扣减", async () => {
    const { deps, events } = makeDeps();
    const balance = deps.balance as BalanceStore & { store: Map<string, bigint | "unlimited"> };
    balance.store.set("key:key-1", 10_000_000n);
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }).id).toBe("resp-1");
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      keyId: "key-1", modelSlug: "openai/gpt-test", channelId: "c1", status: "ok",
      usage: { inputTokens: 1000, outputTokens: 500 },
      costCny: "0.073500",
    });
    // 0.0735 元 = 73500 micro
    expect(balance.store.get("key:key-1")).toBe(10_000_000n - 73_500n);
  });

  it("无 Key 返回 401(OpenAI 错误格式)", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("余额耗尽返回 429 并发 rejected 事件", async () => {
    const { deps, events } = makeDeps();
    (deps.balance as BalanceStore & { store: Map<string, bigint | "unlimited"> }).store.set("key:key-1", 0n);
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(429);
    await flush();
    expect(events[0]).toMatchObject({ status: "rejected", errorCode: "budget_exhausted", costCny: "0.000000" });
  });

  it("未知模型 404;协议不匹配 400", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const mk = (model: string) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [] }),
      });
    expect((await mk("nope/none")).status).toBe(404);
    expect((await mk("anthropic/claude-test")).status).toBe(400);
  });

  it("上游全失败返回 502 并发 upstream_error 事件", async () => {
    const { deps, events } = makeDeps({
      fetchImpl: async () => new Response("{}", { status: 500 }),
    });
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(502);
    await flush();
    expect(events[0]).toMatchObject({ status: "upstream_error", errorCode: "upstream_failed" });
  });
});

describe("POST /v1/messages", () => {
  it("anthropic 链路:x-api-key 鉴权 + anthropic 错误格式", async () => {
    const { deps } = makeDeps({
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "msg-1", usage: { input_tokens: 5, output_tokens: 7 } }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
    });
    const app = createApp(deps);
    const ok = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey.plaintext, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [], max_tokens: 8 }),
    });
    expect(ok.status).toBe(200);

    const unauth = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [], max_tokens: 8 }),
    });
    expect(unauth.status).toBe(401);
    const body = await unauth.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  it("audit Key 的事件携带请求/响应体", async () => {
    const auditKey: AuthedKey = { ...KEY, auditEnabled: true };
    const { deps, events } = makeDeps({
      keyRepo: { async findActiveByHash(h) { return h === apiKey.keyHash ? auditKey : null; } },
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "msg-2", usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
    });
    const app = createApp(deps);
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey.plaintext, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    });
    await flush();
    expect(events[0]!.audit).toBeDefined();
    expect((events[0]!.audit!.responseBody as { id: string }).id).toBe("msg-2");
  });
});

describe("GET /healthz", () => {
  it("返回 ok", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });
});
```

Run: `pnpm --filter @byok/gateway test` → app 文件 FAIL。

- [ ] **Step 2: 实现 app**

`apps/gateway/src/app.ts`:

```ts
import { Hono } from "hono";
import { cnyToMicro, computeCostCny } from "@byok/shared";
import { authenticate } from "./auth.js";
import { checkBudgets, settleBudgets, subjectsForKey } from "./budget.js";
import { selectCandidates } from "./router.js";
import { TtlCache } from "./ttl-cache.js";
import { forwardWithFailover } from "./upstream.js";
import type {
  AuthedKey, BalanceStore, BudgetLoader, CatalogRepo, ChannelChoice,
  CooldownStore, EventSink, KeyRepo, ModelInfo, Protocol, UsageEvent, UsageTotals,
} from "./types.js";

export interface AppDeps {
  masterKey: string;
  balanceTtlSeconds: number;
  cooldownSeconds: number;
  catalogTtlMs: number;
  keyRepo: KeyRepo;
  catalog: CatalogRepo;
  loader: BudgetLoader;
  balance: BalanceStore;
  cooldown: CooldownStore;
  events: EventSink;
  fetchImpl?: typeof fetch;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const modelCache = new TtlCache<ModelInfo | null>(deps.catalogTtlMs);
  const channelCache = new TtlCache<ChannelChoice[]>(deps.catalogTtlMs);

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.post("/v1/chat/completions", (c) => handle(c.req.raw, "openai"));
  app.post("/v1/messages", (c) => handle(c.req.raw, "anthropic"));

  function errorResponse(protocol: Protocol, status: number, code: string, message: string): Response {
    const body =
      protocol === "openai"
        ? { error: { message, type: "invalid_request_error", code } }
        : { type: "error", error: { type: anthropicErrorType(status), message } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function anthropicErrorType(status: number): string {
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 404) return "not_found_error";
    if (status === 429) return "rate_limit_error";
    if (status >= 500 || status === 502) return "api_error";
    return "invalid_request_error";
  }

  function emitSafe(event: UsageEvent): void {
    void deps.events.emit(event).catch((err) => {
      console.error("用量事件发送失败", err);
    });
  }

  async function handle(req: Request, protocol: Protocol): Promise<Response> {
    const startedAt = Date.now();

    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!body || typeof body.model !== "string") {
      return errorResponse(protocol, 400, "invalid_request", "请求体缺少 model 字段");
    }
    const modelSlug = body.model;

    const rawKey =
      protocol === "openai"
        ? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        : (req.headers.get("x-api-key") ?? undefined);

    const auth = await authenticate(deps.keyRepo, rawKey ?? undefined, modelSlug);
    if (!auth.ok) {
      return errorResponse(protocol, auth.status, auth.code, auth.message);
    }
    const key: AuthedKey = auth.key;

    const model = await modelCache.get(modelSlug, () => deps.catalog.getModel(modelSlug));
    if (!model) {
      return errorResponse(protocol, 404, "model_not_found", `未知模型 ${modelSlug}`);
    }
    if (model.providerType !== protocol) {
      return errorResponse(
        protocol, 400, "protocol_mismatch",
        `模型 ${modelSlug} 须经 ${model.providerType} 协议端点调用(v1 同构透传)`,
      );
    }

    const subjects = subjectsForKey(key);
    const budget = await checkBudgets(deps.balance, deps.loader, subjects, deps.balanceTtlSeconds);
    if (!budget.ok) {
      emitSafe({
        keyId: key.id, modelSlug, channelId: null, usage: ZERO_USAGE, costCny: "0.000000",
        latencyMs: Date.now() - startedAt, ttftMs: null,
        status: "rejected", errorCode: "budget_exhausted", ts: new Date().toISOString(),
      });
      return errorResponse(
        protocol, 429, "budget_exhausted",
        `预算已用尽(${budget.exhausted.type}:${budget.exhausted.id})`,
      );
    }

    const candidates = await channelCache.get(modelSlug, () =>
      Promise.resolve().then(() => deps.catalog.getChannelsForModel(modelSlug)),
    );
    const ordered = await selectCandidates(
      { getModel: deps.catalog.getModel.bind(deps.catalog), getChannelsForModel: async () => candidates },
      deps.cooldown, modelSlug,
    );

    const fwd = await forwardWithFailover({
      candidates: ordered,
      protocol,
      requestBody: body,
      masterKey: deps.masterKey,
      cooldown: deps.cooldown,
      cooldownSeconds: deps.cooldownSeconds,
      anthropicVersion: req.headers.get("anthropic-version") ?? undefined,
      fetchImpl: deps.fetchImpl,
    });

    if (!fwd.ok) {
      emitSafe({
        keyId: key.id, modelSlug, channelId: null, usage: ZERO_USAGE, costCny: "0.000000",
        latencyMs: Date.now() - startedAt, ttftMs: null,
        status: "upstream_error", errorCode: fwd.code, ts: new Date().toISOString(),
      });
      return errorResponse(protocol, 502, fwd.code, "上游渠道全部失败,请稍后重试");
    }

    // 计量与结算:流结束后异步执行,不阻塞响应
    void fwd.usagePromise
      .then(async (usage) => {
        const costCny = computeCostCny(usage, model.prices);
        await settleBudgets(deps.balance, subjects, cnyToMicro(costCny));
        emitSafe({
          keyId: key.id, modelSlug, channelId: fwd.channel.channelId, usage, costCny,
          latencyMs: Date.now() - startedAt, ttftMs: fwd.ttftMs,
          status: fwd.status >= 400 ? "upstream_error" : "ok",
          errorCode: fwd.status >= 400 ? `upstream_${fwd.status}` : null,
          ts: new Date().toISOString(),
          audit: key.auditEnabled ? { requestBody: body, responseBody: fwd.responseJson } : undefined,
        });
      })
      .catch((err) => {
        console.error("计量结算失败", err);
      });

    const contentType = fwd.headers.get("content-type") ?? "application/json";
    if (typeof fwd.body === "string") {
      return new Response(fwd.body, { status: fwd.status, headers: { "content-type": contentType } });
    }
    return new Response(fwd.body, {
      status: fwd.status,
      headers: { "content-type": contentType, "cache-control": "no-cache" },
    });
  }

  return app;
}
```

- [ ] **Step 3: 实现 db-access(无单测,e2e 覆盖)**

`apps/gateway/src/db-access.ts`:

```ts
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { apiKeys, apps, budgets, channels, modelChannels, models, type Db } from "@byok/db";
import { cnyToMicro } from "@byok/shared";
import type {
  AuthedKey, BudgetLoader, BudgetSubject, CatalogRepo, ChannelChoice, KeyRepo, ModelInfo,
} from "./types.js";

export class DrizzleKeyRepo implements KeyRepo {
  constructor(private db: Db) {}

  async findActiveByHash(keyHash: string): Promise<AuthedKey | null> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        ownerType: apiKeys.ownerType,
        ownerId: apiKeys.ownerId,
        allowedModels: apiKeys.allowedModels,
        auditEnabled: apiKeys.auditEnabled,
        teamId: apps.teamId,
      })
      .from(apiKeys)
      .leftJoin(apps, and(eq(apiKeys.ownerType, "app"), eq(apps.id, apiKeys.ownerId)))
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          eq(apiKeys.status, "active"),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      teamId: row.teamId ?? null,
      allowedModels: row.allowedModels,
      auditEnabled: row.auditEnabled,
    };
  }
}

export class DrizzleCatalogRepo implements CatalogRepo {
  constructor(private db: Db) {}

  async getModel(slug: string): Promise<ModelInfo | null> {
    const rows = await this.db
      .select()
      .from(models)
      .where(and(eq(models.slug, slug), eq(models.status, "active")))
      .limit(1);
    const m = rows[0];
    if (!m) return null;
    return {
      slug: m.slug,
      providerType: m.providerType,
      prices: {
        inputPerMTok: m.priceInputCny,
        outputPerMTok: m.priceOutputCny,
        cacheReadPerMTok: m.priceCacheReadCny,
        cacheWritePerMTok: m.priceCacheWriteCny,
      },
    };
  }

  async getChannelsForModel(slug: string): Promise<ChannelChoice[]> {
    return this.db
      .select({
        channelId: channels.id,
        baseUrl: channels.baseUrl,
        credentialEncrypted: channels.credentialEncrypted,
        upstreamModelId: modelChannels.upstreamModelId,
        priority: modelChannels.priority,
        weight: modelChannels.weight,
      })
      .from(modelChannels)
      .innerJoin(models, eq(models.id, modelChannels.modelId))
      .innerJoin(channels, eq(channels.id, modelChannels.channelId))
      .where(and(eq(models.slug, slug), eq(channels.status, "active")));
  }
}

export class DrizzleBudgetLoader implements BudgetLoader {
  constructor(private db: Db) {}

  async loadRemainingMicro(subject: BudgetSubject): Promise<bigint | null> {
    const rows = await this.db
      .select({
        remaining: sql<string>`(${budgets.limitAmountCny} - ${budgets.usedAmountCny})::text`,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.subjectType, subject.type),
          eq(budgets.subjectId, subject.id),
          eq(budgets.status, "active"),
        ),
      );
    if (rows.length === 0) return null;
    // 同一主体可同时有 monthly 与 total 预算:取剩余最小者(任一耗尽即截断)
    let min: bigint | null = null;
    for (const row of rows) {
      const value = cnyToMicro(row.remaining);
      if (min === null || value < min) min = value;
    }
    return min;
  }
}
```

- [ ] **Step 4: 实现 index 启动装配**

`apps/gateway/src/index.ts`:

```ts
import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createDb } from "@byok/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DrizzleBudgetLoader, DrizzleCatalogRepo, DrizzleKeyRepo } from "./db-access.js";
import { RedisBalanceStore, RedisCooldownStore, RedisEventSink } from "./redis-stores.js";

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);

const app = createApp({
  masterKey: config.masterKey,
  balanceTtlSeconds: config.balanceTtlSeconds,
  cooldownSeconds: config.cooldownSeconds,
  catalogTtlMs: config.catalogTtlMs,
  keyRepo: new DrizzleKeyRepo(db),
  catalog: new DrizzleCatalogRepo(db),
  loader: new DrizzleBudgetLoader(db),
  balance: new RedisBalanceStore(redis, config.balanceTtlSeconds),
  cooldown: new RedisCooldownStore(redis),
  events: new RedisEventSink(redis, config.usageStream),
});
// 注:RedisEventSink 内部以 MAXLEN ~ 500000 近似裁剪流,防 worker 滞后时无界增长

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`gateway 监听 :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal},优雅停机…`);
    server.close(async () => {
      await redis.quit();
      await sql.end();
      process.exit(0);
    });
  });
}
```

- [ ] **Step 5: 跑通 + Commit**

Run: `pnpm --filter @byok/gateway test && pnpm typecheck && pnpm build`
Expected: app 9 个用例 + 既有用例全 PASS(46 用例),全仓 typecheck/build 干净。

```bash
git add apps/gateway/src
git commit -m "feat(gateway): 热路径编排、Drizzle 仓储与启动装配"
```

---

### Task 10: 真实依赖端到端验证(PG + Redis + 假上游)

**Files:**
- Create: `apps/gateway/scripts/e2e-seed.ts`(造数:渠道/模型/Key/预算)
- Create: `apps/gateway/scripts/fake-upstream.mjs`(本地假 OpenAI/Anthropic 上游)
- Create: `apps/gateway/scripts/e2e.md`(操作手册,含验收清单)

- [ ] **Step 1: 写假上游**

`apps/gateway/scripts/fake-upstream.mjs`:

```js
// 假上游:9100 端口,/v1/chat/completions(OpenAI)与 /v1/messages(Anthropic),支持流式
import { createServer } from "node:http";

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const isOpenAI = req.url.includes("chat/completions");
    if (body.stream && isOpenAI) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"流式OK"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":20,"completion_tokens":4},"choices":[]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        isOpenAI
          ? { id: "fake-openai", model: body.model, usage: { prompt_tokens: 100, completion_tokens: 50 } }
          : { id: "fake-anthropic", model: body.model, usage: { input_tokens: 80, output_tokens: 40 } },
      ),
    );
  });
});

server.listen(9100, () => console.log("fake upstream on :9100"));
```

- [ ] **Step 2: 写造数脚本**

`apps/gateway/scripts/e2e-seed.ts`:

```ts
/**
 * e2e 造数:provider 渠道(指向本地假上游)、两个模型、一把 Key、一份小额预算。
 * 运行:MASTER_KEY=$(grep MASTER_KEY .env | cut -d= -f2) pnpm --filter @byok/gateway e2e-seed
 * 输出:可直接用于 curl 的明文 Key。
 */
import { randomUUID } from "node:crypto";
import { createDb, apiKeys, budgets, channels, modelChannels, models, providers } from "@byok/db";
import { encryptSecret, generateApiKey } from "@byok/shared";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://byok:byok_dev@localhost:5432/byok";
const MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) throw new Error("需要 MASTER_KEY 环境变量(32 字节 base64)");

async function main() {
  const { db, sql } = createDb(DATABASE_URL, { max: 1 });

  const allProviders = await db.select().from(providers);
  const openaiP = allProviders.find((p) => p.type === "openai")!;
  const anthropicP = allProviders.find((p) => p.type === "anthropic")!;

  // 渠道:应用侧生成 UUID,使 AAD=行 id 的约定成立
  const mkChannel = async (providerId: string, name: string) => {
    const id = randomUUID();
    await db.insert(channels).values({
      id, providerId, name,
      baseUrl: "http://localhost:9100/v1",
      credentialEncrypted: encryptSecret("fake-upstream-credential", MASTER_KEY!, id),
    }).onConflictDoNothing();
    return id;
  };
  const openaiChan = await mkChannel(openaiP.id, "e2e-openai");
  const anthropicChan = await mkChannel(anthropicP.id, "e2e-anthropic");

  const mkModel = async (slug: string, providerType: "openai" | "anthropic", channelId: string) => {
    const existing = await db.select().from(models).where(eq(models.slug, slug));
    let modelId = existing[0]?.id;
    if (!modelId) {
      modelId = randomUUID();
      await db.insert(models).values({
        id: modelId, slug, displayName: slug, providerType,
        priceInputCny: "21", priceOutputCny: "105",
        priceCacheReadCny: "2.1", priceCacheWriteCny: "26.25",
      });
    }
    await db.insert(modelChannels).values({
      modelId, channelId, upstreamModelId: "fake-real-model",
    }).onConflictDoNothing();
  };
  await mkModel("openai/gpt-e2e", "openai", openaiChan);
  await mkModel("anthropic/claude-e2e", "anthropic", anthropicChan);

  // Key 归属 admin 用户;预算 0.05 元——两三次调用后必触发 429
  const adminRows = await db.execute(/* sql */ `select id from users where role = 'admin' limit 1`);
  const adminId = (adminRows as unknown as Array<{ id: string }>)[0]!.id;
  const key = generateApiKey();
  const keyRow = await db.insert(apiKeys).values({
    ownerType: "user", ownerId: adminId,
    keyHash: key.keyHash, keyPrefix: key.keyPrefix, name: "e2e",
  }).returning({ id: apiKeys.id });
  await db.insert(budgets).values({
    subjectType: "key", subjectId: keyRow[0]!.id,
    period: "total", limitAmountCny: "0.05",
  }).onConflictDoNothing();

  console.log("e2e Key:", key.plaintext);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`apps/gateway/package.json` scripts 追加:

```json
    "e2e-seed": "pnpm --filter @byok/shared build && pnpm --filter @byok/db build && tsc -p tsconfig.json && node dist/../dist 2>/dev/null; node dist/scripts/e2e-seed.js"
```

(注:若 scripts 不在 tsconfig include 内,改为把 `scripts` 加进 include 再 build,或直接 `node --experimental-strip-types scripts/e2e-seed.ts` ——执行者用最简单能跑通的方式,并在报告中说明。)

- [ ] **Step 3: 写操作手册 + 执行验收**

`apps/gateway/scripts/e2e.md`:

```markdown
# Gateway e2e 验收(真实 PG + Redis + 假上游)

前置:docker compose up -d postgres;本机 6379 已有 Redis(或 docker compose up -d redis);
.env 中 MASTER_KEY 已生成(openssl rand -base64 32)。

1. 迁移+种子:pnpm --filter @byok/db migrate && pnpm --filter @byok/db seed
2. 假上游:node apps/gateway/scripts/fake-upstream.mjs &
3. 造数:得到 sk-wtg-… 明文 Key(见 e2e-seed 脚本头部注释)
4. 起网关:(读 .env)PORT=8080 pnpm --filter @byok/gateway start &

验收清单(逐项打勾):
- [ ] OpenAI 非流式:curl -s localhost:8080/v1/chat/completions -H "Authorization: Bearer $KEY" \
      -H 'content-type: application/json' -d '{"model":"openai/gpt-e2e","messages":[]}' → fake-openai
- [ ] Anthropic 非流式:curl -s localhost:8080/v1/messages -H "x-api-key: $KEY" \
      -H 'content-type: application/json' -d '{"model":"anthropic/claude-e2e","messages":[],"max_tokens":8}' → fake-anthropic
- [ ] OpenAI 流式:同 1 加 "stream":true → 收到 SSE 与 [DONE]
- [ ] 事件:redis-cli XRANGE usage_events - + → 每次调用一条,costCny 正确
      (非流式 openai:100×21/1e6 + 50×105/1e6 = 0.007350)
- [ ] 余额:redis-cli GET bal:key:<keyId> → 随调用递减
- [ ] 截断:连续调用至超 0.05 元预算 → 429 budget_exhausted(注意余额 TTL 60s 内生效)
- [ ] 错误 Key → 401;白名单外模型(给 Key 设 allowed_models 后)→ 403
- [ ] 停掉假上游再调用 → 502,且 redis-cli EXISTS cooldown:<channelId> = 1
```

执行手册全部步骤,逐项确认;无法满足的项记录原因。

- [ ] **Step 4: 全仓收尾 + Commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS。

```bash
git add apps/gateway/scripts apps/gateway/package.json
git commit -m "feat(gateway): e2e 造数脚本、假上游与验收手册"
```

---

## Self-Review 记录

1. **Spec 覆盖(§6.2 热路径)**:鉴权(Task 3)→ 三层余额截断(Task 4)→ 选路/冷却(Task 6)→ 解密注入/透传/故障转移(Task 8)→ 计量(Task 5)→ 扣减+发事件(Task 9)。§6.4 的"月度重置定时任务"与"worker 校正"属 Phase 3,不在本计划。
2. **占位符扫描**:无 TBD;Task 10 e2e-seed 的运行方式留了"最简单能跑通"的执行者裁量,已显式说明并要求报告——非占位符。
3. **类型一致性**:`AppDeps` 字段与 Task 2 types.ts 接口一一对应;`ForwardOk.ttftMs` 为 number(app.test 中事件断言用 fwd.ttftMs 透传);`UsageEvent.costCny` 始终 6 位小数字符串(computeCostCny 输出);`ChannelChoice` 在 router/upstream/db-access 三处字段一致。
4. **已知取舍**:余额扣减读后减有竞态(注释+约定声明);catalogTtlMs=0 时 TtlCache 每次过期(测试用);channelCache 与 selectCandidates 的临时 CatalogRepo 包装略别扭,但避免了在 router 内引缓存——Phase 3 若引入配置热刷新再重构。
