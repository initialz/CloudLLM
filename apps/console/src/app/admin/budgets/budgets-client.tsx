"use client";

import { useState } from "react";
import {
  createBudgetAction,
  updateBudgetAction,
  disableBudgetAction,
  enableBudgetAction,
} from "./actions";
import type { BudgetRow } from "./page";
import type { SubjectOption } from "./actions";

interface BudgetsClientProps {
  budgets: BudgetRow[];
  subjectOptions: SubjectOption[];
}

const periodLabels: Record<string, string> = {
  monthly: "按月",
  total: "总计",
};

const subjectTypeLabels: Record<string, string> = {
  user: "用户",
  team: "团队",
  app: "应用",
  key: "Key",
};

export default function BudgetsClient({ budgets: initialBudgets, subjectOptions }: BudgetsClientProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Create form state
  const [selectedType, setSelectedType] = useState<string>("user");
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>("");
  const [period, setPeriod] = useState<string>("monthly");
  const [limit, setLimit] = useState<string>("");
  const [alertThreshold, setAlertThreshold] = useState<string>("");

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLimit, setEditLimit] = useState("");
  const [editAlertThreshold, setEditAlertThreshold] = useState("");
  const [editError, setEditError] = useState("");

  function clearMessages() {
    setActionError("");
    setActionSuccess("");
  }

  const filteredOptions = subjectOptions.filter((o) => o.type === selectedType);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const fd = new FormData();
    fd.set("subjectType", selectedType);
    fd.set("subjectId", selectedSubjectId);
    fd.set("period", period);
    fd.set("limit", limit);
    fd.set("alertThreshold", alertThreshold);
    const result = await createBudgetAction(fd);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setShowCreate(false);
      setLimit("");
      setAlertThreshold("");
      setSelectedSubjectId("");
      window.location.reload();
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setEditError("");
    const fd = new FormData();
    fd.set("limit", editLimit);
    fd.set("alertThreshold", editAlertThreshold);
    const result = await updateBudgetAction(editingId, fd);
    if (result.error) {
      setEditError(result.error);
    } else {
      setEditingId(null);
      window.location.reload();
    }
  }

  async function handleToggleStatus(id: string, currentStatus: string) {
    clearMessages();
    const result =
      currentStatus === "active"
        ? await disableBudgetAction(id)
        : await enableBudgetAction(id);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("状态已更新");
      window.location.reload();
    }
  }

  function startEdit(b: BudgetRow) {
    setEditingId(b.id);
    setEditLimit(b.limitAmountCny);
    setEditAlertThreshold(b.alertThreshold ?? "");
    setEditError("");
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">预算管理</h1>
        <button
          onClick={() => { setShowCreate(!showCreate); setCreateError(""); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
        >
          + 新建预算
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
          <h2 className="text-sm font-semibold mb-3">新建预算</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">主体类型</label>
                <select
                  value={selectedType}
                  onChange={(e) => { setSelectedType(e.target.value); setSelectedSubjectId(""); }}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                >
                  <option value="user">用户</option>
                  <option value="team">团队</option>
                  <option value="app">应用</option>
                  <option value="key">Key</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">主体</label>
                <select
                  value={selectedSubjectId}
                  onChange={(e) => setSelectedSubjectId(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  required
                >
                  <option value="">请选择...</option>
                  {filteredOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">周期</label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                >
                  <option value="monthly">按月</option>
                  <option value="total">总计</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">限额 (CNY)</label>
                <input
                  type="text"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="如 100 或 100.50"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  告警阈值 (0~1, 可空)
                </label>
                <input
                  type="text"
                  value={alertThreshold}
                  onChange={(e) => setAlertThreshold(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="如 0.8"
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

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">主体</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">类型</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">周期</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">限额 (CNY)</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">已用 (CNY)</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">剩余 (CNY)</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">阈值</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialBudgets.map((b) => {
              const remainNum = parseFloat(b.remainCny);
              const isOverspent = remainNum < 0;

              if (editingId === b.id) {
                return (
                  <tr key={b.id} className="bg-yellow-50">
                    <td className="px-4 py-3" colSpan={9}>
                      <form onSubmit={handleEdit} className="flex gap-3 items-end flex-wrap">
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">限额 (CNY)</label>
                          <input
                            type="text"
                            value={editLimit}
                            onChange={(e) => setEditLimit(e.target.value)}
                            className="border border-gray-300 rounded px-3 py-2 text-sm"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">告警阈值</label>
                          <input
                            type="text"
                            value={editAlertThreshold}
                            onChange={(e) => setEditAlertThreshold(e.target.value)}
                            className="border border-gray-300 rounded px-3 py-2 text-sm"
                            placeholder="如 0.8"
                          />
                        </div>
                        {editError && <p className="text-red-600 text-xs">{editError}</p>}
                        <button
                          type="submit"
                          className="bg-blue-600 text-white px-3 py-2 rounded text-sm hover:bg-blue-700"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="bg-gray-100 text-gray-700 px-3 py-2 rounded text-sm"
                        >
                          取消
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">{b.subjectLabel}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {subjectTypeLabels[b.subjectType] ?? b.subjectType}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                      {periodLabels[b.period] ?? b.period}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-900">{b.limitAmountCny}</td>
                  <td className="px-4 py-3 text-gray-700">{b.usedAmountCny}</td>
                  <td className="px-4 py-3">
                    <span className={isOverspent ? "text-red-600 font-medium" : "text-green-700"}>
                      {b.remainCny}
                    </span>
                    {isOverspent && (
                      <span className="ml-1 text-xs text-red-500">超额</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {b.alertThreshold ? `${(parseFloat(b.alertThreshold) * 100).toFixed(0)}%` : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        b.status === "active"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {b.status === "active" ? "活跃" : "已停用"}
                    </span>
                  </td>
                  <td className="px-4 py-3 flex gap-1.5">
                    <button
                      onClick={() => startEdit(b)}
                      className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleToggleStatus(b.id, b.status)}
                      className={`text-xs px-2 py-1 rounded ${
                        b.status === "active"
                          ? "bg-red-50 text-red-600 hover:bg-red-100"
                          : "bg-green-50 text-green-600 hover:bg-green-100"
                      }`}
                    >
                      {b.status === "active" ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {initialBudgets.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  暂无预算记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
