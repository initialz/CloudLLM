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
