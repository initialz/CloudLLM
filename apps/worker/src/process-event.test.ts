import { randomUUID } from "node:crypto";
import { createDb, apiKeys, budgets, ledgerEntries, requestLogs, usageRecords, users } from "@byok/db";
import { cnyToMicro, generateApiKey, hashPassword } from "@byok/shared";
import type { UsageEvent } from "@byok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processEvent, type BalanceWrite } from "./process-event.js";

const DB_URL = process.env.DATABASE_URL ?? process.env.DATABASE_URL_TEST ?? "postgres://byok:byok_dev@localhost:5432/byok";

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

describe("processEvent(真 PG)", () => {
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

  it("翻月未重置的 monthly 预算:校正按新周期视图写余额", async () => {
    const bal = new FakeBalance();
    const sid = randomUUID();
    const k = generateApiKey();
    const kr = await db.insert(apiKeys).values({
      ownerType: "user", ownerId: sid, keyHash: k.keyHash, keyPrefix: k.keyPrefix,
    }).returning({ id: apiKeys.id });
    await db.insert(budgets).values({
      subjectType: "key", subjectId: kr[0]!.id, period: "monthly",
      limitAmountCny: "1", usedAmountCny: "1",
      periodStart: new Date("2026-05-01T00:00:00Z"),
    });
    const { event, eventId } = mkEvent(kr[0]!.id, `e-${randomUUID()}`, {
      costCny: "0.000000", status: "rejected",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await processEvent(db, bal.write, event, eventId, { auditRetentionDays: 30, balanceTtlSeconds: 60 });
    const w = bal.writes.find((x) => x.key === `bal:key:${kr[0]!.id}`);
    // 上月 used=1 不应再压住新月:余额应为完整 limit(1 元 = 1000000 micro)
    expect(w!.value).toBe("1000000");
  });
});
