/**
 * reports.test.ts — 真 PG 集成测试 (3 用例)
 *
 * 运行前提:本地 PG 已起,DATABASE_URL 已设置
 * 默认:postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys, usageRecords } from "@cloudllm/db";
import { createDb, type Db } from "@cloudllm/db";
import { eq, inArray } from "drizzle-orm";
import { aggregateUsage, visibleKeyIds } from "./reports.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm";

let db: Db;
let sql: { end: () => Promise<void> };

// 测试用 owner IDs
const testUserId = randomUUID();
const testUserId2 = randomUUID();

// 收集创建的资源以便测后清理
const createdKeyIds: string[] = [];
const createdUsageIds: string[] = [];

// 测试数据:两个 Key,各两条用量记录
let key1Id: string;
let key2Id: string;

beforeAll(async () => {
  const bundle = createDb(DATABASE_URL, { max: 1 });
  db = bundle.db;
  sql = bundle.sql;

  // 创建两个 API key(ownerType=user)
  const key1Rows = await db
    .insert(apiKeys)
    .values({
      ownerType: "user",
      ownerId: testUserId,
      keyHash: `test-hash-rpt-1-${randomUUID()}`,
      keyPrefix: "bk_test_rpt1__",
      name: "report-test-key-1",
      allowedModels: null,
      auditEnabled: false,
      expiresAt: null,
    })
    .returning({ id: apiKeys.id });
  key1Id = key1Rows[0]!.id;
  createdKeyIds.push(key1Id);

  const key2Rows = await db
    .insert(apiKeys)
    .values({
      ownerType: "user",
      ownerId: testUserId2,
      keyHash: `test-hash-rpt-2-${randomUUID()}`,
      keyPrefix: "bk_test_rpt2__",
      name: "report-test-key-2",
      allowedModels: null,
      auditEnabled: false,
      expiresAt: null,
    })
    .returning({ id: apiKeys.id });
  key2Id = key2Rows[0]!.id;
  createdKeyIds.push(key2Id);

  // 创建 4 条用量记录 (2 per key)
  // key1: 2 records with model "openai/gpt-4o", cost 0.001000 each
  // key2: 2 records with model "anthropic/claude-3-5-sonnet", cost 0.002000 each
  const usageRows = await db
    .insert(usageRecords)
    .values([
      {
        keyId: key1Id,
        modelSlug: "openai/gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
        costCny: "0.001000",
        status: "ok",
      },
      {
        keyId: key1Id,
        modelSlug: "openai/gpt-4o",
        inputTokens: 200,
        outputTokens: 100,
        costCny: "0.001000",
        status: "ok",
      },
      {
        keyId: key2Id,
        modelSlug: "anthropic/claude-3-5-sonnet",
        inputTokens: 300,
        outputTokens: 150,
        costCny: "0.002000",
        status: "ok",
      },
      {
        keyId: key2Id,
        modelSlug: "anthropic/claude-3-5-sonnet",
        inputTokens: 400,
        outputTokens: 200,
        costCny: "0.002000",
        status: "ok",
      },
    ])
    .returning({ id: usageRecords.id });
  for (const r of usageRows) {
    createdUsageIds.push(r.id);
  }
});

afterAll(async () => {
  // 清理测试数据(顺序:先删 usage,再删 key)
  if (createdUsageIds.length > 0) {
    await db
      .delete(usageRecords)
      .where(inArray(usageRecords.id, createdUsageIds))
      .catch(() => {});
  }
  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id)).catch(() => {});
  }
  await sql.end();
});

describe("reports", () => {
  it("按 model 聚合:两个 model 的请求数与成本精确", async () => {
    // 使用足够宽的时间范围覆盖测试数据
    const from = new Date(Date.now() - 60 * 60 * 1000); // 1 小时前
    const to = new Date(Date.now() + 60 * 60 * 1000); // 1 小时后

    const rows = await aggregateUsage(
      db,
      { from, to, keyIds: [key1Id, key2Id] },
      "model",
    );

    // 找 gpt-4o
    const gptRow = rows.find((r) => r.bucket === "openai/gpt-4o");
    expect(gptRow).toBeDefined();
    expect(gptRow!.requests).toBe(2);
    expect(gptRow!.inputTokens).toBe(300); // 100 + 200
    expect(gptRow!.outputTokens).toBe(150); // 50 + 100
    // cost: 0.001000 + 0.001000 = 0.002000
    expect(parseFloat(gptRow!.costCny)).toBeCloseTo(0.002, 6);

    // 找 claude
    const claudeRow = rows.find((r) =>
      r.bucket.includes("claude"),
    );
    expect(claudeRow).toBeDefined();
    expect(claudeRow!.requests).toBe(2);
    expect(claudeRow!.inputTokens).toBe(700); // 300 + 400
    expect(claudeRow!.outputTokens).toBe(350); // 150 + 200
    // cost: 0.002000 + 0.002000 = 0.004000
    expect(parseFloat(claudeRow!.costCny)).toBeCloseTo(0.004, 6);
  });

  it("keyIds 过滤生效:只查 key1 时不含 key2 数据", async () => {
    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);

    const rows = await aggregateUsage(
      db,
      { from, to, keyIds: [key1Id] },
      "model",
    );

    // 只有 gpt-4o 的数据
    const models = rows.map((r) => r.bucket);
    expect(models).toContain("openai/gpt-4o");
    // claude 数据属于 key2,不应出现
    const claudeRow = rows.find((r) => r.bucket.includes("claude"));
    expect(claudeRow).toBeUndefined();

    // gpt-4o 聚合:2 条
    const gptRow = rows.find((r) => r.bucket === "openai/gpt-4o");
    expect(gptRow!.requests).toBe(2);
  });

  it("keyIds=[] 返回空数组", async () => {
    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);

    const rows = await aggregateUsage(
      db,
      { from, to, keyIds: [] },
      "model",
    );
    expect(rows).toEqual([]);
  });

  it("按 key 聚合:bucket 含 keyPrefix 与名称", async () => {
    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);

    const rows = await aggregateUsage(
      db,
      { from, to, keyIds: [key1Id, key2Id] },
      "key",
    );

    // key1: keyPrefix="bk_test_rpt1__", name="report-test-key-1"
    const key1Row = rows.find((r) => r.bucket.includes("bk_test_rpt1__"));
    expect(key1Row).toBeDefined();
    expect(key1Row!.bucket).toContain("report-test-key-1");
    expect(key1Row!.requests).toBe(2);

    // key2: keyPrefix="bk_test_rpt2__", name="report-test-key-2"
    const key2Row = rows.find((r) => r.bucket.includes("bk_test_rpt2__"));
    expect(key2Row).toBeDefined();
    expect(key2Row!.bucket).toContain("report-test-key-2");
    expect(key2Row!.requests).toBe(2);
  });

  it("按 day 聚合:bucket 为 YYYY-MM-DD 且计数正确", async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const rows = await aggregateUsage(
      db,
      { from: dayAgo, to: tomorrow, keyIds: [key1Id, key2Id] },
      "day",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const total = rows.reduce((s, r) => s + r.requests, 0);
    expect(total).toBe(4); // 造数共 4 条记录
  });
});
