import { requireAdmin } from "../lib/auth";
import { db } from "../lib/db";
import { aggregateUsage, visibleKeyIds } from "../lib/reports";

/** 概览页:本月总成本、请求数、Top5 模型 */
export default async function HomePage() {
  // 概览页仅管理员可访问(v1.1)
  const session = await requireAdmin();

  // 本月起始时间(UTC)
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Admin 不限 Key 范围(visibleKeyIds 返回 null=全部)
  const keyIds = await visibleKeyIds(db, session.userId, true);

  // 按模型聚合(用于 Top5 模型)
  const modelRows = await aggregateUsage(
    db,
    { from: monthStart, to: monthEnd, keyIds },
    "model",
  );

  // 汇总本月总成本与请求数
  let totalRequests = 0;
  let totalCostCny = 0;
  for (const r of modelRows) {
    totalRequests += r.requests;
    totalCostCny += parseFloat(r.costCny);
  }

  const top5 = modelRows.slice(0, 5);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">概览</h1>

      {/* 本月汇总卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">本月总成本</p>
          <p className="text-3xl font-bold text-gray-900">
            ¥{totalCostCny.toFixed(6)}
          </p>
          <p className="text-xs text-gray-400 mt-1">CNY</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">本月请求数</p>
          <p className="text-3xl font-bold text-gray-900">
            {totalRequests.toLocaleString("zh-CN")}
          </p>
          <p className="text-xs text-gray-400 mt-1">次</p>
        </div>
      </div>

      {/* Top5 模型 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">本月 Top 5 模型</h2>
        </div>
        {top5.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">本月暂无数据</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">模型</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">请求数</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">输入 Token</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">输出 Token</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">成本 (CNY)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {top5.map((row) => (
                <tr key={row.bucket} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 font-mono text-xs">{row.bucket}</td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.requests.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.inputTokens.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.outputTokens.toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700 font-mono">
                    {parseFloat(row.costCny).toFixed(6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
