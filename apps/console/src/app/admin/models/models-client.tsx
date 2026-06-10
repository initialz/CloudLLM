"use client";

import { useState } from "react";
import {
  createModelAction,
  toggleModelStatusAction,
  deleteModelAction,
  createModelChannelAction,
  deleteModelChannelAction,
} from "./actions";
import type { ModelRow, ChannelOption } from "./page";

interface ModelsClientProps {
  models: ModelRow[];
  channelOptions: ChannelOption[];
}

export default function ModelsClient({ models: initialModels, channelOptions }: ModelsClientProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Create model form
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [providerType, setProviderType] = useState<string>("openai");
  const [priceInput, setPriceInput] = useState("");
  const [priceOutput, setPriceOutput] = useState("");
  const [priceCacheRead, setPriceCacheRead] = useState("0");
  const [priceCacheWrite, setPriceCacheWrite] = useState("0");
  const [contextLength, setContextLength] = useState("");

  // Expanded model for mapping management
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);

  // Add mapping form
  const [addMappingModelId, setAddMappingModelId] = useState<string | null>(null);
  const [mappingChannelId, setMappingChannelId] = useState("");
  const [mappingUpstreamModelId, setMappingUpstreamModelId] = useState("");
  const [mappingPriority, setMappingPriority] = useState("0");
  const [mappingWeight, setMappingWeight] = useState("1");
  const [mappingError, setMappingError] = useState("");

  function clearMessages() {
    setActionError("");
    setActionSuccess("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("displayName", displayName);
    fd.set("providerType", providerType);
    fd.set("priceInput", priceInput);
    fd.set("priceOutput", priceOutput);
    fd.set("priceCacheRead", priceCacheRead);
    fd.set("priceCacheWrite", priceCacheWrite);
    fd.set("contextLength", contextLength);
    const result = await createModelAction(fd);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setShowCreate(false);
      setSlug("");
      setDisplayName("");
      setPriceInput("");
      setPriceOutput("");
      setPriceCacheRead("0");
      setPriceCacheWrite("0");
      setContextLength("");
      window.location.reload();
    }
  }

  async function handleToggleStatus(id: string, currentStatus: string) {
    clearMessages();
    const result = await toggleModelStatusAction(id, currentStatus);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("状态已更新");
      window.location.reload();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("确认删除该模型及其所有渠道映射?")) return;
    clearMessages();
    const result = await deleteModelAction(id);
    if (result.error) {
      setActionError(result.error);
    } else {
      window.location.reload();
    }
  }

  async function handleAddMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!addMappingModelId) return;
    setMappingError("");
    const fd = new FormData();
    fd.set("channelId", mappingChannelId);
    fd.set("upstreamModelId", mappingUpstreamModelId);
    fd.set("priority", mappingPriority);
    fd.set("weight", mappingWeight);
    const result = await createModelChannelAction(addMappingModelId, fd);
    if (result.error) {
      setMappingError(result.error);
    } else {
      setAddMappingModelId(null);
      setMappingChannelId("");
      setMappingUpstreamModelId("");
      setMappingPriority("0");
      setMappingWeight("1");
      window.location.reload();
    }
  }

  async function handleDeleteMapping(modelId: string, channelId: string) {
    if (!confirm("确认删除该渠道映射?")) return;
    clearMessages();
    const result = await deleteModelChannelAction(modelId, channelId);
    if (result.error) {
      setActionError(result.error);
    } else {
      window.location.reload();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">模型管理</h1>
        <button
          onClick={() => { setShowCreate(!showCreate); setCreateError(""); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
        >
          + 新建模型
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
          <h2 className="text-sm font-semibold mb-3">新建模型</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Slug <span className="text-gray-400">(唯一,如 openai/gpt-4o)</span></label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="openai/gpt-4o"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">显示名</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="GPT-4o"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">供应商类型</label>
                <select
                  value={providerType}
                  onChange={(e) => setProviderType(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">输入价格 (CNY/百万 token)</label>
                <input
                  type="text"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="21"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">输出价格 (CNY/百万 token)</label>
                <input
                  type="text"
                  value={priceOutput}
                  onChange={(e) => setPriceOutput(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="105"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">缓存读价格 (CNY/百万 token)</label>
                <input
                  type="text"
                  value={priceCacheRead}
                  onChange={(e) => setPriceCacheRead(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">缓存写价格 (CNY/百万 token)</label>
                <input
                  type="text"
                  value={priceCacheWrite}
                  onChange={(e) => setPriceCacheWrite(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Context Length <span className="text-gray-400">(可空)</span></label>
                <input
                  type="text"
                  value={contextLength}
                  onChange={(e) => setContextLength(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="128000"
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

      <div className="space-y-4">
        {initialModels.map((m) => (
          <div key={m.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {/* Model header row */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-medium text-gray-900">{m.slug}</span>
                <span className="text-gray-400 text-xs">{m.displayName}</span>
                <span className="text-gray-400 text-xs bg-gray-100 px-2 py-0.5 rounded">{m.providerType}</span>
                <span
                  className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                    m.status === "active"
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {m.status === "active" ? "活跃" : "已停用"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  输入 {m.priceInputCny} / 输出 {m.priceOutputCny} CNY/MTok
                  {m.contextLength ? ` | ctx ${m.contextLength.toLocaleString()}` : ""}
                </span>
                <button
                  onClick={() => setExpandedModelId(expandedModelId === m.id ? null : m.id)}
                  className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100"
                >
                  {expandedModelId === m.id ? "收起" : "渠道映射"}
                </button>
                <button
                  onClick={() => handleToggleStatus(m.id, m.status)}
                  className={`text-xs px-2 py-1 rounded ${
                    m.status === "active"
                      ? "bg-red-50 text-red-600 hover:bg-red-100"
                      : "bg-green-50 text-green-600 hover:bg-green-100"
                  }`}
                >
                  {m.status === "active" ? "停用" : "启用"}
                </button>
                <button
                  onClick={() => handleDelete(m.id)}
                  className="text-xs px-2 py-1 rounded bg-gray-50 text-gray-500 hover:bg-gray-100"
                >
                  删除
                </button>
              </div>
            </div>

            {/* Expanded model_channels section */}
            {expandedModelId === m.id && (
              <div className="px-4 py-3 bg-gray-50">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-gray-600">渠道映射</span>
                  <button
                    onClick={() => {
                      setAddMappingModelId(addMappingModelId === m.id ? null : m.id);
                      setMappingChannelId(
                        channelOptions.find((c) => c.providerType === m.providerType)?.id ?? "",
                      );
                      setMappingUpstreamModelId("");
                      setMappingPriority("0");
                      setMappingWeight("1");
                      setMappingError("");
                    }}
                    className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    + 添加映射
                  </button>
                </div>

                {addMappingModelId === m.id && (
                  <form onSubmit={handleAddMapping} className="mb-3 p-3 bg-white border border-blue-100 rounded space-y-2">
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">渠道</label>
                        <select
                          value={mappingChannelId}
                          onChange={(e) => setMappingChannelId(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                          required
                        >
                          <option value="">选择渠道...</option>
                          {channelOptions
                            .filter((c) => c.providerType === m.providerType)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">上游模型 ID</label>
                        <input
                          type="text"
                          value={mappingUpstreamModelId}
                          onChange={(e) => setMappingUpstreamModelId(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                          placeholder="gpt-4o"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Priority</label>
                        <input
                          type="number"
                          value={mappingPriority}
                          onChange={(e) => setMappingPriority(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Weight</label>
                        <input
                          type="number"
                          value={mappingWeight}
                          onChange={(e) => setMappingWeight(e.target.value)}
                          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                          min="1"
                        />
                      </div>
                    </div>
                    {mappingError && <p className="text-red-600 text-xs">{mappingError}</p>}
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="bg-blue-600 text-white px-3 py-1.5 rounded text-xs hover:bg-blue-700"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddMappingModelId(null)}
                        className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded text-xs"
                      >
                        取消
                      </button>
                    </div>
                  </form>
                )}

                {m.mappings.length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">暂无渠道映射</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left py-1 pr-4">渠道</th>
                        <th className="text-left py-1 pr-4">上游模型 ID</th>
                        <th className="text-left py-1 pr-4">Priority</th>
                        <th className="text-left py-1 pr-4">Weight</th>
                        <th className="text-left py-1">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.mappings.map((mc) => (
                        <tr key={mc.channelId} className="border-t border-gray-100">
                          <td className="py-1.5 pr-4 text-gray-700">{mc.channelName}</td>
                          <td className="py-1.5 pr-4 font-mono text-gray-600">{mc.upstreamModelId}</td>
                          <td className="py-1.5 pr-4 text-gray-600">{mc.priority}</td>
                          <td className="py-1.5 pr-4 text-gray-600">{mc.weight}</td>
                          <td className="py-1.5">
                            <button
                              onClick={() => handleDeleteMapping(m.id, mc.channelId)}
                              className="text-red-500 hover:text-red-700"
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ))}

        {initialModels.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-8 text-center text-gray-400">
            暂无模型记录
          </div>
        )}
      </div>
    </div>
  );
}
