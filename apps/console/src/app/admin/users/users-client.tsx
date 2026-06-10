"use client";

import { useState } from "react";
import {
  createUserAction,
  toggleUserStatusAction,
  changeUserRoleAction,
} from "./actions";

interface User {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: Date;
}

interface UsersClientProps {
  users: User[];
  currentUserId: string;
}

export default function UsersClient({ users: initialUsers, currentUserId }: UsersClientProps) {
  const [users, setUsers] = useState(initialUsers);
  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [actionError, setActionError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setCreateSuccess("");
    const fd = new FormData();
    fd.set("email", createEmail);
    fd.set("password", createPassword);
    const result = await createUserAction(fd);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setCreateSuccess("用户创建成功");
      setCreateEmail("");
      setCreatePassword("");
      setShowCreate(false);
      // Refresh by reloading (server will revalidate)
      window.location.reload();
    }
  }

  async function handleToggleStatus(userId: string, currentStatus: string) {
    setActionError("");
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    const result = await toggleUserStatusAction(userId, newStatus as "active" | "disabled");
    if (result.error) {
      setActionError(result.error);
    } else {
      window.location.reload();
    }
  }

  async function handleChangeRole(userId: string, currentRole: string) {
    setActionError("");
    const newRole = currentRole === "admin" ? "user" : "admin";
    const result = await changeUserRoleAction(userId, newRole as "admin" | "user");
    if (result.error) {
      setActionError(result.error);
    } else {
      window.location.reload();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">用户管理</h1>
        <button
          onClick={() => { setShowCreate(!showCreate); setCreateError(""); setCreateSuccess(""); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
        >
          + 新建用户
        </button>
      </div>

      {createSuccess && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
          {createSuccess}
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
          {actionError}
        </div>
      )}

      {showCreate && (
        <div className="mb-6 p-4 bg-white border border-gray-200 rounded-lg">
          <h2 className="text-sm font-semibold mb-3">新建用户</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">邮箱</label>
              <input
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                placeholder="user@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">初始密码</label>
              <input
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                placeholder="至少 8 位"
                required
              />
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
              <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-900">
                  {user.email}
                  {user.id === currentUserId && (
                    <span className="ml-2 text-xs text-blue-500">(我)</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      user.role === "admin"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {user.role === "admin" ? "管理员" : "用户"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      user.status === "active"
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {user.status === "active" ? "活跃" : "已停用"}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(user.createdAt).toLocaleString("zh-CN")}
                </td>
                <td className="px-4 py-3 flex gap-2">
                  <button
                    onClick={() => handleToggleStatus(user.id, user.status)}
                    disabled={user.id === currentUserId && user.status === "active"}
                    className={`text-xs px-2 py-1 rounded ${
                      user.id === currentUserId && user.status === "active"
                        ? "bg-gray-50 text-gray-400 cursor-not-allowed"
                        : user.status === "active"
                        ? "bg-red-50 text-red-600 hover:bg-red-100"
                        : "bg-green-50 text-green-600 hover:bg-green-100"
                    }`}
                    title={
                      user.id === currentUserId ? "不能停用自己" : ""
                    }
                  >
                    {user.status === "active" ? "停用" : "启用"}
                  </button>
                  <button
                    onClick={() => handleChangeRole(user.id, user.role)}
                    disabled={user.id === currentUserId && user.role === "admin"}
                    className={`text-xs px-2 py-1 rounded ${
                      user.id === currentUserId && user.role === "admin"
                        ? "bg-gray-50 text-gray-400 cursor-not-allowed"
                        : "bg-blue-50 text-blue-600 hover:bg-blue-100"
                    }`}
                    title={
                      user.id === currentUserId ? "不能降级自己" : ""
                    }
                  >
                    {user.role === "admin" ? "降为用户" : "升为管理员"}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  暂无用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
