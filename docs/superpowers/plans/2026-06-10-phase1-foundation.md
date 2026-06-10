# BYOK 网关 Phase 1:Monorepo 基础 + 共享领域层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 pnpm Monorepo,交付两个共享包——`@byok/shared`(Key 生成/哈希、密码哈希、信封加密、成本计算)和 `@byok/db`(13 张表的 Drizzle schema、迁移、种子脚本)——作为 Gateway 与 Console 的共同地基。

**Architecture:** pnpm workspaces Monorepo;`packages/shared` 为纯函数库(零外部运行时依赖,全 TDD);`packages/db` 用 Drizzle ORM 定义 PostgreSQL schema 并生成 SQL 迁移;本地开发用 docker-compose 起 PG + Redis。spec 见 `docs/superpowers/specs/2026-06-10-byok-llm-gateway-design.md`。

**Tech Stack:** Node ≥22、TypeScript ^5、pnpm workspaces、Vitest ^3、Drizzle ORM(driver: postgres.js)、PostgreSQL 16、Redis 7。

**金额约定:** 所有 CNY 金额在 PG 中用 `numeric(18,6)`,在 TS 计算层用 **micro-CNY 的 BigInt 整数运算**(1 元 = 1_000_000 micro),对外序列化为 6 位小数字符串,避免浮点误差。

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`(根)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `docker-compose.yml`
- Modify: `.gitignore`

- [ ] **Step 1: 写根 package.json**

```json
{
  "name": "byok",
  "private": true,
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 2: 写 pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: 写 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: 写 docker-compose.yml(本地开发依赖)**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: byok
      POSTGRES_PASSWORD: byok_dev
      POSTGRES_DB: byok
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
volumes:
  pgdata:
```

- [ ] **Step 5: 追加 .gitignore 条目**

在现有 `.gitignore` 末尾追加:

```
coverage/
*.tsbuildinfo
```

- [ ] **Step 6: 安装并验证**

Run: `pnpm install`
Expected: 生成 `pnpm-lock.yaml`,无报错。

Run: `docker compose up -d && docker compose ps`
Expected: postgres、redis 两个容器 `running`(若本机无 docker 则跳过此步,在 Task 7 标注)。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json docker-compose.yml .gitignore pnpm-lock.yaml
git commit -m "chore: pnpm monorepo 脚手架与本地开发依赖"
```

---

### Task 2: @byok/shared 包脚手架 + API Key 生成与哈希(TDD)

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/api-key.ts`
- Test: `packages/shared/src/api-key.test.ts`

**规则(来自 spec §4.3):** Key 格式 `sk-wtg-{random}`;库中只存 SHA-256 十六进制哈希;`keyPrefix` 取完整 Key 前 15 个字符(`sk-wtg-` + 随机段前 8 位)用于后台识别;明文仅创建时返回一次。

- [ ] **Step 1: 包脚手架**

`packages/shared/package.json`:

```json
{
  "name": "@byok/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

`packages/shared/src/index.ts`(随任务推进追加导出):

```ts
export * from "./api-key.js";
```

- [ ] **Step 2: 写失败测试**

`packages/shared/src/api-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key.js";

describe("generateApiKey", () => {
  it("生成 sk-wtg- 前缀的 Key,并返回哈希与前缀", () => {
    const k = generateApiKey();
    expect(k.plaintext).toMatch(/^sk-wtg-[A-Za-z0-9_-]{32}$/);
    expect(k.keyPrefix).toBe(k.plaintext.slice(0, 15));
    expect(k.keyHash).toBe(hashApiKey(k.plaintext));
  });

  it("两次生成互不相同", () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext);
  });
});

describe("hashApiKey", () => {
  it("输出 64 位十六进制 SHA-256,且确定性", () => {
    const h = hashApiKey("sk-wtg-test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("sk-wtg-test")).toBe(h);
    expect(hashApiKey("sk-wtg-other")).not.toBe(h);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @byok/shared test`
Expected: FAIL,`Cannot find module './api-key.js'`(或同义报错)。

- [ ] **Step 4: 最小实现**

`packages/shared/src/api-key.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export interface GeneratedApiKey {
  /** 完整明文,仅创建时返回一次 */
  plaintext: string;
  /** SHA-256 hex,入库字段 */
  keyHash: string;
  /** 前 15 字符,后台识别用 */
  keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  // 24 字节 → base64url 32 字符
  const plaintext = `sk-wtg-${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 15),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @byok/shared test`
Expected: PASS(4 个用例)。

- [ ] **Step 6: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): API Key 生成与 SHA-256 哈希"
```

---

### Task 3: 密码哈希(scrypt,TDD)

**Files:**
- Create: `packages/shared/src/password.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/password.test.ts`

**规则:** Console 独立账号体系用。Node 内置 scrypt,零新依赖;存储格式 `scrypt$N$r$p$salt$hash`(salt/hash 为 base64url);校验用时间安全比较。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("哈希后能用正确密码通过校验", async () => {
    const stored = await hashPassword("s3cret!");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret!", stored)).toBe(true);
  });

  it("错误密码校验失败", async () => {
    const stored = await hashPassword("s3cret!");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("同一密码两次哈希结果不同(随机盐)", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });

  it("格式损坏的存储值返回 false 而不抛异常", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @byok/shared test`
Expected: FAIL,找不到 `./password.js`。

- [ ] **Step 3: 最小实现**

`packages/shared/src/password.ts`:

```ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, KEYLEN, { N, r, p })) as Buffer;
  return [
    "scrypt",
    String(N),
    String(r),
    String(p),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64!, "base64url");
    const expected = Buffer.from(hashB64!, "base64url");
    const actual = (await scrypt(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    })) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

`packages/shared/src/index.ts` 追加:

```ts
export * from "./password.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @byok/shared test`
Expected: PASS(累计 8 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): scrypt 密码哈希与校验"
```

---

### Task 4: 渠道凭证信封加密(AES-256-GCM,TDD)

**Files:**
- Create: `packages/shared/src/envelope.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/envelope.test.ts`

**规则(来自 spec §4.3):** 上游渠道凭证必须可逆。信封加密:随机 32B 数据密钥用 AES-256-GCM 加密明文;主密钥(32B,base64,来自 K8s Secret 注入的环境变量)加密数据密钥。产物是单个 JSON 字符串,直接入 `channels.credential_encrypted` 列。主密钥以参数显式传入(不在库内读 env,便于测试与轮换)。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/envelope.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./envelope.js";

const master = randomBytes(32).toString("base64");

describe("envelope encryption", () => {
  it("加密后能用同一主密钥解回原文", () => {
    const ct = encryptSecret("sk-ant-upstream-credential", master);
    expect(decryptSecret(ct, master)).toBe("sk-ant-upstream-credential");
  });

  it("同一明文两次加密产物不同(随机 IV/数据密钥)", () => {
    expect(encryptSecret("x", master)).not.toBe(encryptSecret("x", master));
  });

  it("错误主密钥解密抛错", () => {
    const ct = encryptSecret("x", master);
    const wrong = randomBytes(32).toString("base64");
    expect(() => decryptSecret(ct, wrong)).toThrow();
  });

  it("密文被篡改时解密抛错(GCM 认证)", () => {
    const ct = JSON.parse(encryptSecret("x", master));
    ct.data = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(JSON.stringify(ct), master)).toThrow();
  });

  it("主密钥长度不是 32 字节时拒绝", () => {
    expect(() => encryptSecret("x", "c2hvcnQ=")).toThrow(/32/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @byok/shared test`
Expected: FAIL,找不到 `./envelope.js`。

- [ ] **Step 3: 最小实现**

`packages/shared/src/envelope.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EnvelopeV1 {
  v: 1;
  /** 主密钥加密后的数据密钥 */
  ek: string;
  /** 数据密钥加密用 IV */
  ekiv: string;
  /** 数据密钥加密的 GCM tag */
  ektag: string;
  /** 明文加密用 IV */
  iv: string;
  /** 明文加密的 GCM tag */
  tag: string;
  /** 密文 */
  data: string;
}

function parseMasterKey(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`master key 必须是 32 字节(base64 后传入),实际 ${key.length}`);
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKeyB64: string): string {
  const master = parseMasterKey(masterKeyB64);
  const dataKey = randomBytes(32);

  const iv = randomBytes(12);
  const c1 = createCipheriv("aes-256-gcm", dataKey, iv);
  const data = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);

  const ekiv = randomBytes(12);
  const c2 = createCipheriv("aes-256-gcm", master, ekiv);
  const ek = Buffer.concat([c2.update(dataKey), c2.final()]);

  const env: EnvelopeV1 = {
    v: 1,
    ek: ek.toString("base64"),
    ekiv: ekiv.toString("base64"),
    ektag: c2.getAuthTag().toString("base64"),
    iv: iv.toString("base64"),
    tag: c1.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(env);
}

export function decryptSecret(envelopeJson: string, masterKeyB64: string): string {
  const master = parseMasterKey(masterKeyB64);
  const env = JSON.parse(envelopeJson) as EnvelopeV1;
  if (env.v !== 1) throw new Error(`不支持的信封版本: ${env.v}`);

  const d2 = createDecipheriv("aes-256-gcm", master, Buffer.from(env.ekiv, "base64"));
  d2.setAuthTag(Buffer.from(env.ektag, "base64"));
  const dataKey = Buffer.concat([d2.update(Buffer.from(env.ek, "base64")), d2.final()]);

  const d1 = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(env.iv, "base64"));
  d1.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d1.update(Buffer.from(env.data, "base64")), d1.final()]).toString("utf8");
}
```

`packages/shared/src/index.ts` 追加:

```ts
export * from "./envelope.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @byok/shared test`
Expected: PASS(累计 13 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): 渠道凭证信封加密(AES-256-GCM)"
```

---

### Task 5: 成本计算(micro-CNY BigInt,TDD)

**Files:**
- Create: `packages/shared/src/cost.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/cost.test.ts`

**规则(来自 spec §4.5、§5):** 模型单价按"每百万 token 的 CNY"配置(数据库 numeric 字符串)。计算使用 micro-CNY BigInt:`cost_micro = tokens × price_micro_per_mtok / 1e6`,向上取整(宁多记不少记)。输出 6 位小数字符串,可直接写 `numeric(18,6)`。

- [ ] **Step 1: 写失败测试**

`packages/shared/src/cost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cnyToMicro, computeCostCny, microToCny } from "./cost.js";

describe("cnyToMicro / microToCny", () => {
  it("互为逆运算,支持 6 位小数", () => {
    expect(cnyToMicro("12.345678")).toBe(12_345_678n);
    expect(microToCny(12_345_678n)).toBe("12.345678");
    expect(cnyToMicro("0")).toBe(0n);
    expect(microToCny(0n)).toBe("0.000000");
  });

  it("拒绝超过 6 位小数或非法格式", () => {
    expect(() => cnyToMicro("1.2345678")).toThrow();
    expect(() => cnyToMicro("abc")).toThrow();
  });
});

describe("computeCostCny", () => {
  // 价格:输入 21.0 元/百万 tok,输出 105.0 元/百万 tok,
  // 缓存读 2.1,缓存写 26.25(对应 Claude 系常见比例,仅作测试值)
  const prices = {
    inputPerMTok: "21",
    outputPerMTok: "105",
    cacheReadPerMTok: "2.1",
    cacheWritePerMTok: "26.25",
  };

  it("按四类 token 分别计价求和", () => {
    const cost = computeCostCny(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices,
    );
    // 1000/1e6*21 = 0.021;500/1e6*105 = 0.0525 → 0.0735
    expect(cost).toBe("0.073500");
  });

  it("含缓存 token", () => {
    const cost = computeCostCny(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100000, cacheWriteTokens: 10000 },
      prices,
    );
    // 0.1*2.1 = 0.21;0.01*26.25 = 0.2625 → 0.4725
    expect(cost).toBe("0.472500");
  });

  it("不能整除时向上取整到 micro", () => {
    // 1 token × 1 元/MTok = 1e-6 元 = 1 micro,边界恰好整除;
    // 1 token × 0.5 元/MTok = 0.5 micro → 进位为 1 micro
    const cost = computeCostCny(
      { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputPerMTok: "0.5", outputPerMTok: "0", cacheReadPerMTok: "0", cacheWritePerMTok: "0" },
    );
    expect(cost).toBe("0.000001");
  });

  it("全零返回 0.000000", () => {
    const cost = computeCostCny(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices,
    );
    expect(cost).toBe("0.000000");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @byok/shared test`
Expected: FAIL,找不到 `./cost.js`。

- [ ] **Step 3: 最小实现**

`packages/shared/src/cost.ts`:

```ts
const MICRO = 1_000_000n;

/** "12.345678" → 12345678n(micro-CNY)。最多 6 位小数。 */
export function cnyToMicro(cny: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(cny.trim());
  if (!m) throw new Error(`非法 CNY 金额: ${cny}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return whole * MICRO + frac;
}

/** 12345678n → "12.345678" */
export function microToCny(micro: bigint): string {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 单价:每百万 token 的 CNY(numeric 字符串) */
export interface ModelPrices {
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok: string;
  cacheWritePerMTok: string;
}

/** tokens × price/MTok,micro 级向上取整 */
function lineCostMicro(tokens: number, pricePerMTok: string): bigint {
  if (tokens === 0) return 0n;
  const priceMicro = cnyToMicro(pricePerMTok);
  const numerator = BigInt(tokens) * priceMicro;
  return (numerator + MICRO - 1n) / MICRO; // ceil div
}

export function computeCostCny(usage: TokenUsage, prices: ModelPrices): string {
  const total =
    lineCostMicro(usage.inputTokens, prices.inputPerMTok) +
    lineCostMicro(usage.outputTokens, prices.outputPerMTok) +
    lineCostMicro(usage.cacheReadTokens, prices.cacheReadPerMTok) +
    lineCostMicro(usage.cacheWriteTokens, prices.cacheWritePerMTok);
  return microToCny(total);
}
```

`packages/shared/src/index.ts` 追加:

```ts
export * from "./cost.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @byok/shared test`
Expected: PASS(累计 19 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): micro-CNY BigInt 成本计算"
```

---

### Task 6: @byok/db — Drizzle schema(13 张表)+ 迁移生成

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/vitest.config.ts`
- Test: `packages/db/src/schema.test.ts`

- [ ] **Step 1: 包脚手架**

`packages/db/package.json`:

```json
{
  "name": "@byok/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.2",
    "postgres": "^3.4.7"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.1",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://byok:byok_dev@localhost:5432/byok",
  },
});
```

`packages/db/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 2: 写 schema(spec §5 的 13 张表)**

`packages/db/src/schema.ts`:

```ts
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const cny = (name: string) => numeric(name, { precision: 18, scale: 6 });

// ── 组织 ────────────────────────────────────────────────

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const teams = pgTable("teams", {
  id: id(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const apps = pgTable("apps", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  name: text("name").notNull(),
  env: text("env", { enum: ["prod", "dev"] }).notNull().default("prod"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

// ── Key 与预算 ──────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    ownerType: text("owner_type", { enum: ["user", "team", "app"] }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name"),
    /** null = 不限制 */
    allowedModels: text("allowed_models").array(),
    auditEnabled: boolean("audit_enabled").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "disabled", "revoked"] })
      .notNull()
      .default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_owner_idx").on(t.ownerType, t.ownerId),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    subjectType: text("subject_type", { enum: ["user", "team", "app", "key"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    period: text("period", { enum: ["monthly", "total"] }).notNull(),
    limitAmountCny: cny("limit_amount_cny").notNull(),
    usedAmountCny: cny("used_amount_cny").notNull().default("0"),
    /** monthly 时为当前周期起点 */
    periodStart: timestamp("period_start", { withTimezone: true }),
    /** 0~1,如 0.8 表示 80% 告警 */
    alertThreshold: numeric("alert_threshold", { precision: 5, scale: 4 }),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("budgets_subject_idx").on(t.subjectType, t.subjectId)],
);

// ── 供应商 / 渠道 / 模型 ─────────────────────────────────

export const providers = pgTable("providers", {
  id: id(),
  type: text("type", { enum: ["openai", "anthropic"] }).notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const channels = pgTable("channels", {
  id: id(),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  /** 信封加密 JSON(@byok/shared encryptSecret 产物) */
  credentialEncrypted: text("credential_encrypted").notNull(),
  priority: integer("priority").notNull().default(0),
  weight: integer("weight").notNull().default(1),
  status: text("status", { enum: ["active", "disabled", "cooldown"] })
    .notNull()
    .default("active"),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  createdAt: createdAt(),
});

export const models = pgTable("models", {
  id: id(),
  /** 对外统一目录名,如 anthropic/claude-opus-4-8 */
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  providerType: text("provider_type", { enum: ["openai", "anthropic"] }).notNull(),
  /** 单价:每百万 token 的 CNY */
  priceInputCny: cny("price_input_cny").notNull(),
  priceOutputCny: cny("price_output_cny").notNull(),
  priceCacheReadCny: cny("price_cache_read_cny").notNull().default("0"),
  priceCacheWriteCny: cny("price_cache_write_cny").notNull().default("0"),
  contextLength: integer("context_length"),
  capabilities: text("capabilities").array(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const modelChannels = pgTable(
  "model_channels",
  {
    id: id(),
    modelId: uuid("model_id").notNull().references(() => models.id),
    channelId: uuid("channel_id").notNull().references(() => channels.id),
    /** 该渠道上的真实模型名 */
    upstreamModelId: text("upstream_model_id").notNull(),
    priority: integer("priority").notNull().default(0),
    weight: integer("weight").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("model_channels_pair_idx").on(t.modelId, t.channelId)],
);

// ── 用量 / 流水 / 审计 ──────────────────────────────────

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    keyId: uuid("key_id").notNull().references(() => apiKeys.id),
    modelSlug: text("model_slug").notNull(),
    channelId: uuid("channel_id").references(() => channels.id),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costCny: cny("cost_cny").notNull().default("0"),
    costSrcAmount: numeric("cost_src_amount", { precision: 18, scale: 6 }),
    costSrcCurrency: text("cost_src_currency"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    status: text("status", { enum: ["ok", "upstream_error", "rejected"] }).notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_records_key_time_idx").on(t.keyId, t.createdAt)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    subjectType: text("subject_type", { enum: ["user", "team", "app", "key"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    amountCny: cny("amount_cny").notNull(),
    usageRecordId: uuid("usage_record_id").references(() => usageRecords.id),
    balanceAfterCny: cny("balance_after_cny"),
    createdAt: createdAt(),
  },
  (t) => [index("ledger_subject_time_idx").on(t.subjectType, t.subjectId, t.createdAt)],
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: id(),
    usageRecordId: uuid("usage_record_id")
      .notNull()
      .unique()
      .references(() => usageRecords.id),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("request_logs_expires_idx").on(t.expiresAt)],
);
```

- [ ] **Step 3: 写 client 与入口**

`packages/db/src/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  return drizzle(sql, { schema });
}
```

`packages/db/src/index.ts`:

```ts
export * from "./client.js";
export * from "./schema.js";
```

- [ ] **Step 4: 写 schema 冒烟测试(失败先行)**

`packages/db/src/schema.test.ts`(不连库,验证表定义完整性):

```ts
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

const EXPECTED_TABLES = [
  "users",
  "teams",
  "team_members",
  "apps",
  "api_keys",
  "budgets",
  "providers",
  "channels",
  "models",
  "model_channels",
  "usage_records",
  "ledger_entries",
  "request_logs",
] as const;

describe("schema", () => {
  it("13 张表全部定义", () => {
    const names = Object.values(schema)
      .filter((v) => typeof v === "object" && v !== null && "$inferSelect" in v)
      .map((t) => getTableName(t as never));
    for (const expected of EXPECTED_TABLES) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });
});
```

Run: `pnpm install && pnpm --filter @byok/db test`
Expected: 先 FAIL(schema.ts 未就绪时);Step 2-3 完成后 PASS。
(若按顺序已写完 schema,直接确认 PASS 即可。)

- [ ] **Step 5: 生成迁移并检查 SQL**

Run: `pnpm --filter @byok/db generate`
Expected: `packages/db/migrations/0000_*.sql` 生成,内含 13 个 `CREATE TABLE`。

Run: `grep -c "CREATE TABLE" packages/db/migrations/0000_*.sql`
Expected: `13`

- [ ] **Step 6: typecheck 全仓**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): 13 张表 Drizzle schema 与首个迁移"
```

---

### Task 7: 种子脚本 + 端到端验证(migrate → seed → 查询)

**Files:**
- Create: `packages/db/src/seed.ts`
- Modify: `packages/db/package.json`(加 seed script)
- Create: `.env.example`(根)

**前置:** 本机 docker compose 的 PG 已就绪(Task 1 Step 6)。若执行环境无 docker,此 Task 的运行步骤标注 SKIPPED 并在任务报告中说明,代码照常交付。

- [ ] **Step 1: 写 .env.example**

```
DATABASE_URL=postgres://byok:byok_dev@localhost:5432/byok
REDIS_URL=redis://localhost:6379
# 32 字节 base64。生成:openssl rand -base64 32
MASTER_KEY=
# 初始管理员
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=change-me-now
```

- [ ] **Step 2: 写种子脚本**

`packages/db/src/seed.ts`:

```ts
/**
 * 幂等种子:初始管理员 + openai/anthropic 两个 provider。
 * 运行:pnpm --filter @byok/db seed
 */
import { hashPassword } from "@byok/shared";
import { createDb } from "./client.js";
import { providers, users } from "./schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://byok:byok_dev@localhost:5432/byok";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "change-me-now";

async function main() {
  const db = createDb(DATABASE_URL);

  await db
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "admin",
    })
    .onConflictDoNothing({ target: users.email });

  await db
    .insert(providers)
    .values([
      { type: "openai", displayName: "OpenAI" },
      { type: "anthropic", displayName: "Anthropic" },
    ])
    .onConflictDoNothing({ target: providers.type });

  console.log("seed 完成:admin =", ADMIN_EMAIL);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`packages/db/package.json` 的 scripts 中追加,并把 `@byok/shared` 加入 dependencies:

```json
{
  "scripts": {
    "seed": "node --experimental-strip-types src/seed.ts"
  },
  "dependencies": {
    "@byok/shared": "workspace:*"
  }
}
```

(注:Node 22 的 `--experimental-strip-types` 直接跑 TS;若运行报错,改为先 `pnpm --filter @byok/shared build && pnpm --filter @byok/db build` 后 `node dist/seed.js`。)

- [ ] **Step 3: 跑迁移 + 种子 + 验证**

Run:

```bash
pnpm --filter @byok/db migrate
pnpm --filter @byok/db seed
docker compose exec postgres psql -U byok -d byok -c "select email, role from users; select type from providers;"
```

Expected: users 中有 admin 一行(role=admin),providers 两行(openai、anthropic)。再次运行 seed 不报错、不重复插入(幂等)。

- [ ] **Step 4: 全仓测试收尾**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db .env.example
git commit -m "feat(db): 幂等种子脚本与本地端到端验证"
```

---

## Self-Review 记录

1. **Spec 覆盖**:本计划仅覆盖 spec 的基础层(§4.3 Key 哈希/信封加密、§4.5 CNY 记账、§5 数据模型)。Gateway 热路径(§6.2)、用量回流(§6.3)、Console UI 留给 Phase 2-4 计划——有意为之,见计划开头的分期说明。
2. **占位符扫描**:无 TBD/TODO;每个代码步骤均含完整代码。
3. **类型一致性**:`generateApiKey` 返回字段(keyHash/keyPrefix)与 `api_keys` 表列名对应;`encryptSecret` 产物入 `channels.credential_encrypted`;`computeCostCny` 输出 6 位小数字符串匹配 `numeric(18,6)`;`ModelPrices` 四字段对应 `models` 四个价格列。
