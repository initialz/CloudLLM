import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { apiKeys, requestLogs, usageRecords, type Db } from "@cloudllm/db";

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
  const conds = [gte(usageRecords.createdAt, filter.from), lt(usageRecords.createdAt, filter.to)];
  if (filter.keyIds !== null) {
    if (filter.keyIds.length === 0) return [];
    conds.push(inArray(usageRecords.keyId, filter.keyIds));
  }

  if (dimension === "key") {
    // Key 维度:left join api_keys,显示 keyPrefix + name;Key 已删除时降级为 keyId::text
    const keyBucketExpr = sql<string>`coalesce(
      ${apiKeys.keyPrefix} || ' ' || coalesce(${apiKeys.name}, ''),
      ${usageRecords.keyId}::text
    )`;

    const rows = await db
      .select({
        bucket: keyBucketExpr,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::int`,
        costCny: sql<string>`coalesce(sum(${usageRecords.costCny}), 0)::text`,
      })
      .from(usageRecords)
      .leftJoin(apiKeys, eq(usageRecords.keyId, apiKeys.id))
      .where(and(...conds))
      .groupBy(keyBucketExpr)
      .orderBy(desc(sql`sum(${usageRecords.costCny})`));
    return rows;
  }

  const bucketExpr =
    dimension === "model"
      ? sql<string>`${usageRecords.modelSlug}`
      : sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt}), 'YYYY-MM-DD')`;

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
