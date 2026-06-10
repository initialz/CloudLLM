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
      // 与 gateway DrizzleBudgetLoader 同口径——翻月未重置的 monthly 按新周期视图,防零成本事件把过期余额自续写回
      const rows = await db
        .select({
          remaining: sql<string>`(${budgets.limitAmountCny} - CASE
            WHEN ${budgets.period} = 'monthly'
             AND ${budgets.periodStart} IS NOT NULL
             AND date_trunc('month', ${budgets.periodStart}) < date_trunc('month', now())
            THEN 0
            ELSE ${budgets.usedAmountCny}
          END)::text`,
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
