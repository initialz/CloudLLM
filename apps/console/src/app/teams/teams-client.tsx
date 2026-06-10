"use client";

import { useState } from "react";
import Link from "next/link";
import { createTeamAction } from "./actions";

interface Team {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}

interface TeamsClientProps {
  teams: Team[];
}

export default function TeamsClient({ teams: initialTeams }: TeamsClientProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const fd = new FormData();
    fd.set("name", createName);
    const result = await createTeamAction(fd);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setCreateName("");
      setShowCreate(false);
      window.location.reload();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">团队管理</h1>
        <button
          onClick={() => { setShowCreate(!showCreate); setCreateError(""); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
        >
          + 新建团队
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 p-4 bg-white border border-gray-200 rounded-lg">
          <h2 className="text-sm font-semibold mb-3">新建团队</h2>
          <form onSubmit={handleCreate} className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs text-gray-600 mb-1">团队名称</label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                placeholder="My Team"
                required
              />
            </div>
            {createError && <p className="text-red-600 text-xs">{createError}</p>}
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
          </form>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">团队名称</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialTeams.map((team) => (
              <tr key={team.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{team.name}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      team.status === "active"
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {team.status === "active" ? "活跃" : "已停用"}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(team.createdAt).toLocaleString("zh-CN")}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/teams/${team.id}`}
                    className="text-blue-600 hover:underline text-xs"
                  >
                    管理
                  </Link>
                </td>
              </tr>
            ))}
            {initialTeams.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                  暂无团队
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
