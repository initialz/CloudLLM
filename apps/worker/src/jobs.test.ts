import { randomUUID } from "node:crypto";
import { createDb, budgets, requestLogs, usageRecords } from "@byok/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupExpiredAuditLogs, resetRolledOverMonthlyBudgets } from "./jobs.js";

const DB_URL = process.env.DATABASE_URL_TEST ?? "postgres://byok:byok_dev@localhost:5432/byok";

describe("jobs(真 PG)", () => {
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
