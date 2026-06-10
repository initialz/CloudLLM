"use client";

import { useState } from "react";

interface AuditLog {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  modelSlug: string;
  keyId: string;
  costCny: string | null;
  requestBody: unknown;
  responseBody: unknown;
}

interface AuditClientProps {
  logs: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  filterKeyId: string;
  keyOptions: { id: string; prefix: string; name: string | null }[];
}

function JsonCollapse({ label, data }: { label: string; data: unknown }) {
  const [open, setOpen] = useState(false);
  if (data == null) return <span className="text-gray-400 text-xs">—</span>;
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-blue-600 hover:underline text-xs"
      >
        {open ? "折叠" : `展开 ${label}`}
      </button>
      {open && (
        <pre className="mt-1 text-xs bg-gray-50 border border-gray-200 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AuditClient({
  logs,
  total,
  page,
  pageSize,
  filterKeyId,
  keyOptions,
}: AuditClientProps) {
  const totalPages = Math.ceil(total / pageSize);

  function buildUrl(p: number, kid?: string) {
    const params = new URLSearchParams();
    params.set("page", String(p));
    const k = kid !== undefined ? kid : filterKeyId;
    if (k) params.set("keyId", k);
    return `/admin/audit?${params.toString()}`;
  }

  return (
    <div>
      {/* 顶部敏感提示 */}
      <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
        <strong>注意:</strong>
        审计日志包含完整的请求与响应内容,属于敏感数据。请勿在未授权人员面前展示。
        日志按 <code>expires_at</code> 定期清除,保留期以系统配置为准。
      </div>

      {/* Key 筛选 */}
      <form method="get" action="/admin/audit" className="flex items-center gap-3 mb-6 bg-white border border-gray-200 rounded-lg px-4 py-3">
        <label className="text-xs text-gray-500">按 Key 筛选</label>
        <select
          name="keyId"
          defaultValue={filterKeyId}
          className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 max-w-sm"
          onChange={(e) => {
            // Submit form on change
            (e.target.form as HTMLFormElement).submit();
          }}
        >
          <option value="">全部 Key</option>
          {keyOptions.map((k) => (
            <option key={k.id} value={k.id}>
              {k.prefix}... {k.name ? `(${k.name})` : ""}
            </option>
          ))}
        </select>
        <input type="hidden" name="page" value="1" />
        <button
          type="submit"
          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          筛选
        </button>
      </form>

      {/* 日志表格 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">审计日志</span>
          <span className="text-xs text-gray-400">共 {total} 条</span>
        </div>

        {logs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">暂无审计日志</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">时间</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">模型</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Key</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">成本 (CNY)</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">过期时间</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">请求体</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">响应体</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 align-top">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">
                      {log.modelSlug}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {log.keyId.slice(0, 8)}...
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-700">
                      {log.costCny ? parseFloat(log.costCny).toFixed(6) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                      {new Date(log.expiresAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td className="px-4 py-3">
                      <JsonCollapse label="请求" data={log.requestBody} />
                    </td>
                    <td className="px-4 py-3">
                      <JsonCollapse label="响应" data={log.responseBody} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          {page > 1 && (
            <a
              href={buildUrl(page - 1)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
            >
              上一页
            </a>
          )}
          <span className="text-sm text-gray-500">
            第 {page} / {totalPages} 页
          </span>
          {page < totalPages && (
            <a
              href={buildUrl(page + 1)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
            >
              下一页
            </a>
          )}
        </div>
      )}
    </div>
  );
}
