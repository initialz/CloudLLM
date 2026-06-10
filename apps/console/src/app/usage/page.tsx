import { Suspense } from "react";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";
import { aggregateUsage, visibleKeyIds } from "../../lib/reports";
import { UsageFilters } from "./usage-client";

/**
 * 用量报表页
 *
 * 注意:本页只读 usage_records(成本恒为正数)。
 * 若未来需展示 ledger_entries 分类账,账目中存在负数条目(退款/调整),
 * 需要在 UI 上区分正负并用红色标注负值。
 */

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface UsagePageProps {
  searchParams: Promise<{ from?: string; to?: string; dim?: string }>;
}

async function UsageTable({
  from,
  to,
  dim,
  userId,
  isAdmin,
}: {
  from: Date;
  to: Date;
  dim: "model" | "key" | "day";
  userId: string;
  isAdmin: boolean;
}) {
  const keyIds = await visibleKeyIds(db, userId, isAdmin);
  const rows = await aggregateUsage(db, { from, to: new Date(to.getTime() + 86400000), keyIds }, dim);

  const dimLabel = dim === "model" ? "模型" : dim === "key" ? "Key ID" : "日期";

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          用量明细 — 按{dimLabel}汇总
        </h2>
        <span className="text-xs text-gray-400">{rows.length} 条</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-400">所选时间范围内暂无数据</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">{dimLabel}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">请求数</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">输入 Token</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">输出 Token</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">成本 (CNY)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.bucket} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 font-mono text-xs max-w-xs truncate">
                    {row.bucket}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.requests.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.inputTokens.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.outputTokens.toLocaleString("zh-CN")}
                  </td>
                  {/* 成本 6 位小数;usage_records 恒正,ledger 如含负数需另行处理 */}
                  <td className="px-4 py-3 text-right text-gray-700 font-mono">
                    {parseFloat(row.costCny).toFixed(6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function UsagePage({ searchParams }: UsagePageProps) {
  const session = await requireUser();
  const params = await searchParams;

  // 默认近 7 天
  const now = new Date();
  const defaultTo = toDateStr(now);
  const defaultFrom = toDateStr(new Date(now.getTime() - 6 * 86400000));

  const fromStr = params.from ?? defaultFrom;
  const toStr = params.to ?? defaultTo;
  const dimParam = params.dim;
  const dim: "model" | "key" | "day" =
    dimParam === "key" || dimParam === "day" ? dimParam : "model";

  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDate = new Date(`${toStr}T00:00:00Z`);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">用量报表</h1>

      <Suspense fallback={null}>
        <UsageFilters dimension={dim} fromDate={fromStr} toDate={toStr} />
      </Suspense>

      <UsageTable
        from={fromDate}
        to={toDate}
        dim={dim}
        userId={session.userId}
        isAdmin={session.role === "admin"}
      />
    </div>
  );
}
