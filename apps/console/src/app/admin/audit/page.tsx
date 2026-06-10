import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { queryAuditLogs } from "../../../lib/reports";
import { apiKeys, requestLogs, usageRecords } from "@byok/db";
import { and, count, eq } from "drizzle-orm";
import AuditClient from "./audit-client";

const PAGE_SIZE = 20;

interface AuditPageProps {
  searchParams: Promise<{ page?: string; keyId?: string }>;
}

export default async function AdminAuditPage({ searchParams }: AuditPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const filterKeyId = params.keyId ?? "";

  const offset = (page - 1) * PAGE_SIZE;

  // 查询日志
  const logs = await queryAuditLogs(db, {
    keyId: filterKeyId || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  // 查询总数(用于分页)
  const countConds = filterKeyId
    ? [eq(usageRecords.keyId, filterKeyId)]
    : [];

  const totalResult = await db
    .select({ total: count() })
    .from(requestLogs)
    .innerJoin(usageRecords, eq(usageRecords.id, requestLogs.usageRecordId))
    .where(countConds.length ? and(...countConds) : undefined);
  const total = totalResult[0]?.total ?? 0;

  // Key 下拉选项:取所有有 audit 日志的 Key
  const keyOptions = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.keyPrefix,
      name: apiKeys.name,
    })
    .from(apiKeys)
    .orderBy(apiKeys.keyPrefix);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">审计日志</h1>
      <AuditClient
        logs={logs}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        filterKeyId={filterKeyId}
        keyOptions={keyOptions.map((k) => ({
          id: k.id,
          prefix: k.prefix,
          name: k.name ?? null,
        }))}
      />
    </div>
  );
}
