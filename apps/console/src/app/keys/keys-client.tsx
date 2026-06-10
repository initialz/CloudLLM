"use client";

import { useState, useTransition } from "react";
import { createKeyAction, revokeKeyAction, toggleAuditAction } from "./actions";

interface ApiKey {
  id: string;
  ownerType: "user" | "team" | "app";
  ownerId: string;
  keyPrefix: string;
  name: string | null;
  allowedModels: string[] | null;
  auditEnabled: boolean;
  expiresAt: Date | null;
  status: "active" | "disabled" | "revoked";
  createdAt: Date;
}

interface KeysClientProps {
  initialKeys: ApiKey[];
  modelSlugs: string[];
  currentUserId: string;
  userList: { id: string; email: string }[];
  teamList: { id: string; name: string }[];
  /** Admin 预筛初始态(来自 URL searchParams) */
  initialFilterOwnerType?: "user" | "team";
  initialFilterOwnerId?: string;
}

export default function KeysClient({
  initialKeys,
  modelSlugs,
  currentUserId,
  userList,
  teamList,
  initialFilterOwnerType,
  initialFilterOwnerId,
}: KeysClientProps) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [showForm, setShowForm] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  // 归属类型选择:v1.1 仅 team(推荐)/user;初始态来自 URL 预筛参数
  const [ownerType, setOwnerType] = useState<"user" | "team">(
    initialFilterOwnerType ?? "team",
  );

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await createKeyAction(formData);
      if (result.error) {
        setFormError(result.error);
        return;
      }
      if (result.plaintext) {
        setPlaintext(result.plaintext);
      }
      setShowForm(false);
      // Refresh list by reloading the page data
      // Since we're in a client component, we reload
      window.location.reload();
    });
  }

  async function handleRevoke(keyId: string) {
    if (!confirm("确认撤销此 Key？此操作不可逆。")) return;
    startTransition(async () => {
      const result = await revokeKeyAction(keyId);
      if (result.error) {
        alert(result.error);
        return;
      }
      setKeys((prev) =>
        prev.map((k) =>
          k.id === keyId ? { ...k, status: "revoked" as const } : k,
        ),
      );
    });
  }

  async function handleToggleAudit(keyId: string, currentEnabled: boolean) {
    startTransition(async () => {
      const result = await toggleAuditAction(keyId, !currentEnabled);
      if (result.error) {
        alert(result.error);
        return;
      }
      setKeys((prev) =>
        prev.map((k) =>
          k.id === keyId ? { ...k, auditEnabled: !currentEnabled } : k,
        ),
      );
    });
  }

  async function handleCopy() {
    if (plaintext) {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const getOwnerOptions = () => {
    if (ownerType === "team") return teamList.map((t) => ({ id: t.id, label: t.name }));
    // ownerType === "user"(管理员自己)
    return userList.map((u) => ({ id: u.id, label: u.email }));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Key 管理</h1>
        <button
          onClick={() => { setShowForm(true); setPlaintext(null); }}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
        >
          + 创建 Key
        </button>
      </div>

      {/* 一次性明文展示 */}
      {plaintext && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm font-semibold text-yellow-800 mb-2">
            Key 已创建!请立即保存——刷新后将无法再次查看。
          </p>
          <div className="flex items-center gap-3">
            <code className="flex-1 text-sm bg-white border border-yellow-300 rounded px-3 py-2 font-mono break-all">
              {plaintext}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-2 bg-yellow-600 text-white text-sm rounded-md hover:bg-yellow-700 whitespace-nowrap"
            >
              {copied ? "已复制!" : "复制"}
            </button>
          </div>
          <button
            onClick={() => setPlaintext(null)}
            className="mt-2 text-xs text-yellow-700 hover:underline"
          >
            关闭
          </button>
        </div>
      )}

      {/* 创建表单 */}
      {showForm && (
        <div className="mb-6 p-6 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">创建新 Key</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                名称 <span className="text-red-500">*</span>
              </label>
              <input
                name="name"
                type="text"
                required
                placeholder="如:张三的 Key"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* 归属主体选择:v1.1 仅 team/user */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  归属类型
                </label>
                <select
                  name="ownerType"
                  value={ownerType}
                  onChange={(e) => setOwnerType(e.target.value as "user" | "team")}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="team">团队(推荐,成员 Key)</option>
                  <option value="user">管理员自己(个人测试用)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  归属实体
                </label>
                <select
                  name="ownerId"
                  defaultValue={initialFilterOwnerId ?? ""}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {getOwnerOptions().map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* allowedModels 多选 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                允许模型{" "}
                <span className="text-gray-400 font-normal">(不选=不限)</span>
              </label>
              {modelSlugs.length > 0 ? (
                <div className="border border-gray-300 rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
                  {modelSlugs.map((slug) => (
                    <label key={slug} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        name="allowedModels"
                        value={slug}
                        className="rounded border-gray-300"
                      />
                      <span>{slug}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">无 active 模型</p>
              )}
            </div>

            {/* 过期时间(可选) */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                过期时间{" "}
                <span className="text-gray-400 font-normal">(可选,UTC)</span>
              </label>
              <input
                name="expiresAt"
                type="datetime-local"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* auditEnabled */}
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  name="auditEnabled"
                  className="rounded border-gray-300"
                />
                开启审计(记录请求/响应内容)
              </label>
            </div>

            {formError && (
              <p className="text-sm text-red-600">{formError}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {isPending ? "创建中..." : "创建"}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError(null); }}
                className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-200"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Key 列表 */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                前缀 / 名称
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                归属
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                状态
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                创建时间
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                过期时间
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Audit
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                  暂无 Key
                </td>
              </tr>
            )}
            {keys.map((key) => (
              <tr key={key.id} className={key.status === "revoked" ? "opacity-50" : ""}>
                <td className="px-4 py-3">
                  <div className="font-mono text-sm text-gray-900">{key.keyPrefix}…</div>
                  <div className="text-xs text-gray-500">{key.name ?? "—"}</div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {key.ownerType}/{key.ownerId.slice(0, 8)}…
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      key.status === "active"
                        ? "bg-green-100 text-green-800"
                        : key.status === "revoked"
                          ? "bg-red-100 text-red-800"
                          : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {key.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {key.createdAt.toLocaleString("zh-CN")}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {key.expiresAt ? key.expiresAt.toLocaleString("zh-CN") : "—"}
                </td>
                <td className="px-4 py-3 text-sm">
                  <button
                    onClick={() => handleToggleAudit(key.id, key.auditEnabled)}
                    disabled={isPending || key.status === "revoked"}
                    className={`text-xs px-2 py-1 rounded ${
                      key.auditEnabled
                        ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    } disabled:opacity-50`}
                  >
                    {key.auditEnabled ? "开" : "关"}
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  {key.status === "active" && (
                    <button
                      onClick={() => handleRevoke(key.id)}
                      disabled={isPending}
                      className="text-sm text-red-600 hover:text-red-900 hover:underline disabled:opacity-50"
                    >
                      撤销
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
