"use client";

import { useState } from "react";
import {
  createChannelAction,
  disableChannelAction,
  enableChannelAction,
  rotateCredentialAction,
} from "./actions";
import type { ChannelRow } from "./page";
import type { ProviderOption } from "./page";

interface ChannelsClientProps {
  channels: ChannelRow[];
  providers: ProviderOption[];
}

const statusLabels: Record<string, string> = {
  active: "活跃",
  disabled: "已停用",
  cooldown: "冷却中",
};

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  disabled: "bg-red-100 text-red-700",
  cooldown: "bg-yellow-100 text-yellow-700",
};

export default function ChannelsClient({ channels: initialChannels, providers }: ChannelsClientProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Create form
  const [selectedProviderId, setSelectedProviderId] = useState<string>(providers[0]?.id ?? "");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");

  // Rotate credential state
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateCredential, setRotateCredential] = useState("");
  const [rotateError, setRotateError] = useState("");

  function clearMessages() {
    setActionError("");
    setActionSuccess("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const fd = new FormData();
    fd.set("providerId", selectedProviderId);
    fd.set("name", name);
    fd.set("baseUrl", baseUrl);
    fd.set("credential", credential);
    const result = await createChannelAction(fd);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setShowCreate(false);
      setName("");
      setBaseUrl("");
      setCredential("");
      window.location.reload();
    }
  }

  async function handleToggleStatus(id: string, currentStatus: string) {
    clearMessages();
    const result =
      currentStatus === "active"
        ? await disableChannelAction(id)
        : await enableChannelAction(id);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("状态已更新");
      window.location.reload();
    }
  }

  async function handleRotate(e: React.FormEvent) {
    e.preventDefault();
    if (!rotatingId) return;
    setRotateError("");
    const fd = new FormData();
    fd.set("credential", rotateCredential);
    const result = await rotateCredentialAction(rotatingId, fd);
    if (result.error) {
      setRotateError(result.error);
    } else {
      setRotatingId(null);
      setRotateCredential("");
      window.location.reload();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">渠道管理</h1>
        <button
          onClick={() => { setShowCreate(!showCreate); setCreateError(""); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
        >
          + 新建渠道
        </button>
      </div>

      {actionError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
          {actionSuccess}
        </div>
      )}

      {showCreate && (
        <div className="mb-6 p-4 bg-white border border-gray-200 rounded-lg">
          <h2 className="text-sm font-semibold mb-3">新建渠道</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">供应商</label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => setSelectedProviderId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  required
                >
                  <option value="">请选择供应商...</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">渠道名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="如 OpenAI 主渠道"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Base URL <span className="text-gray-400">(必须以 /v1 结尾)</span>
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="https://api.openai.com/v1"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  凭证 <span className="text-gray-400">(提交后不再展示)</span>
                </label>
                <input
                  type="password"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="sk-..."
                  required
                  autoComplete="new-password"
                />
              </div>
            </div>
            {createError && (
              <p className="text-red-600 text-xs">{createError}</p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
              >
                创建
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setCreateError(""); }}
                className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-200"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rotate credential panel */}
      {rotatingId && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <h2 className="text-sm font-semibold mb-3">轮换凭证</h2>
          <form onSubmit={handleRotate} className="flex gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-600 mb-1">新凭证</label>
              <input
                type="password"
                value={rotateCredential}
                onChange={(e) => setRotateCredential(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm w-80"
                placeholder="sk-..."
                required
                autoComplete="new-password"
              />
            </div>
            {rotateError && <p className="text-red-600 text-xs">{rotateError}</p>}
            <button
              type="submit"
              className="bg-yellow-600 text-white px-4 py-2 rounded text-sm hover:bg-yellow-700"
            >
              确认轮换
            </button>
            <button
              type="button"
              onClick={() => { setRotatingId(null); setRotateCredential(""); setRotateError(""); }}
              className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-200"
            >
              取消
            </button>
          </form>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">名称</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">供应商</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Base URL</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">冷却至</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialChannels.map((ch) => (
              <tr key={ch.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-900 font-medium">{ch.name}</td>
                <td className="px-4 py-3 text-gray-500">{ch.providerDisplayName}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">{ch.baseUrl}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      statusColors[ch.status] ?? "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {statusLabels[ch.status] ?? ch.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {ch.cooldownUntil
                    ? new Date(ch.cooldownUntil).toLocaleString("zh-CN")
                    : "-"}
                </td>
                <td className="px-4 py-3 flex gap-1.5">
                  <button
                    onClick={() => {
                      setRotatingId(ch.id);
                      setRotateCredential("");
                      setRotateError("");
                      clearMessages();
                    }}
                    className="text-xs px-2 py-1 rounded bg-yellow-50 text-yellow-700 hover:bg-yellow-100"
                  >
                    轮换凭证
                  </button>
                  <button
                    onClick={() => handleToggleStatus(ch.id, ch.status)}
                    className={`text-xs px-2 py-1 rounded ${
                      ch.status === "active"
                        ? "bg-red-50 text-red-600 hover:bg-red-100"
                        : "bg-green-50 text-green-600 hover:bg-green-100"
                    }`}
                  >
                    {ch.status === "active" ? "停用" : "启用"}
                  </button>
                </td>
              </tr>
            ))}
            {initialChannels.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  暂无渠道记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
