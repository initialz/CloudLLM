/**
 * keys.test.ts — 真 PG 集成测试 (4 用例)
 *
 * 运行前提:本地 PG 已起,DATABASE_URL 已设置
 * 默认:postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys } from "@cloudllm/db";
import { createDb, type Db } from "@cloudllm/db";
import { hashApiKey } from "@cloudllm/shared";
import { createApiKey, revokeApiKey } from "./keys.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm";

let db: Db;
let sql: { end: () => Promise<void> };

// 测试用的 ownerId:随机 UUID 避免污染真实数据
const testOwnerId = randomUUID();
const testOwnerId2 = randomUUID();

// 收集创建的 key id 以便测后清理
const createdKeyIds: string[] = [];

beforeAll(async () => {
  const bundle = createDb(DATABASE_URL, { max: 1 });
  db = bundle.db;
  sql = bundle.sql;
});

afterAll(async () => {
  // 清理测试数据
  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id)).catch(() => {});
  }
  await sql.end();
});

describe("keys", () => {
  it("签发后明文可哈希匹配库内 keyHash、前缀 15 字符", async () => {
    const result = await createApiKey(db, {
      ownerType: "user",
      ownerId: testOwnerId,
      name: "test-key-1",
      allowedModels: ["openai/gpt-4o"],
      auditEnabled: false,
      expiresAt: null,
    });

    createdKeyIds.push(result.id);

    // 明文必须存在
    expect(result.plaintext).toBeTruthy();
    // 前缀长度为 15
    expect(result.plaintext.slice(0, 15)).toHaveLength(15);

    // 从 DB 取出 keyHash 验证匹配
    const rows = await db
      .select({ keyHash: apiKeys.keyHash, keyPrefix: apiKeys.keyPrefix })
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(rows).toHaveLength(1);

    const dbHash = rows[0]!.keyHash;
    const computedHash = hashApiKey(result.plaintext);
    expect(dbHash).toBe(computedHash);

    // 前缀也匹配
    expect(rows[0]!.keyPrefix).toBe(result.plaintext.slice(0, 15));
  });

  it("revoke 翻转 status 且 updatedAt 变化", async () => {
    // 先签发一个 key
    const result = await createApiKey(db, {
      ownerType: "user",
      ownerId: testOwnerId,
      name: "test-key-revoke",
      allowedModels: null,
      auditEnabled: false,
      expiresAt: null,
    });
    createdKeyIds.push(result.id);

    // 记录初始的 updatedAt
    const before = await db
      .select({ status: apiKeys.status, updatedAt: apiKeys.updatedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(before[0]!.status).toBe("active");
    const updatedAtBefore = before[0]!.updatedAt;

    // 等待确保时间戳必然不同(insert 的 defaultNow 是 PG 时钟,$onUpdate 是应用时钟,
    // 两个时钟域可能有毫秒级偏差——因此下方只断言"值变化",不断言先后顺序)
    await new Promise((r) => setTimeout(r, 20));

    // 撤销
    const revoked = await revokeApiKey(db, result.id, null);
    expect(revoked).toBe(true);

    // 验证 status 和 updatedAt
    const after = await db
      .select({ status: apiKeys.status, updatedAt: apiKeys.updatedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(after[0]!.status).toBe("revoked");
    // updatedAt 应该发生变化($onUpdate 用应用时钟重写了 PG defaultNow 的初值;
    // 跨时钟域不能比较先后,只断言不相等)
    expect(after[0]!.updatedAt.getTime()).not.toBe(updatedAtBefore.getTime());
  });

  it("ownerGuard 防他人:非 owner 的 revoke 返回 false", async () => {
    // 签发 testOwnerId 的 key
    const result = await createApiKey(db, {
      ownerType: "user",
      ownerId: testOwnerId,
      name: "test-key-guard",
      allowedModels: null,
      auditEnabled: false,
      expiresAt: null,
    });
    createdKeyIds.push(result.id);

    // 用 testOwnerId2 尝试撤销(ownerGuard 指向不同 ownerId)
    const revoked = await revokeApiKey(db, result.id, {
      ownerType: "user",
      ownerId: testOwnerId2,
    });
    expect(revoked).toBe(false);

    // 确认 key 仍然是 active
    const rows = await db
      .select({ status: apiKeys.status })
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(rows[0]!.status).toBe("active");
  });

  it("allowedModels null 落库为 NULL", async () => {
    const result = await createApiKey(db, {
      ownerType: "user",
      ownerId: testOwnerId,
      name: "test-key-null-models",
      allowedModels: null,
      auditEnabled: false,
      expiresAt: null,
    });
    createdKeyIds.push(result.id);

    const rows = await db
      .select({ allowedModels: apiKeys.allowedModels })
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(rows[0]!.allowedModels).toBeNull();
  });
});
