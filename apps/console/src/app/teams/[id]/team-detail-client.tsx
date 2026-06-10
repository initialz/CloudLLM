"use client";

import { useState } from "react";
import Link from "next/link";
import {
  addTeamMemberAction,
  changeTeamMemberRoleAction,
  removeTeamMemberAction,
  createTeamAppAction,
  disableTeamAppAction,
} from "../actions";

interface Member {
  userId: string;
  role: string;
  createdAt: Date;
  email: string;
}

interface App {
  id: string;
  name: string;
  env: string;
  status: string;
  createdAt: Date;
}

interface TeamDetailClientProps {
  team: { id: string; name: string; status: string };
  members: Member[];
  apps: App[];
  teamId: string;
  canManage: boolean;
  currentUserId: string;
}

export default function TeamDetailClient({
  team,
  members: initialMembers,
  apps: initialApps,
  teamId,
  canManage,
  currentUserId,
}: TeamDetailClientProps) {
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState("member");

  // Add app form
  const [showAddApp, setShowAddApp] = useState(false);
  const [appName, setAppName] = useState("");
  const [appEnv, setAppEnv] = useState("prod");

  function clearMessages() {
    setActionError("");
    setActionSuccess("");
  }

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    clearMessages();
    const fd = new FormData();
    fd.set("email", addEmail);
    fd.set("role", addRole);
    const result = await addTeamMemberAction(teamId, fd);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("成员已添加/更新");
      setAddEmail("");
      setShowAddMember(false);
      window.location.reload();
    }
  }

  async function handleChangeRole(userId: string, currentRole: string) {
    clearMessages();
    const roles: ("owner" | "admin" | "member")[] = ["owner", "admin", "member"];
    const idx = roles.indexOf(currentRole as "owner" | "admin" | "member");
    const newRole = roles[(idx + 1) % roles.length]!;
    const result = await changeTeamMemberRoleAction(teamId, userId, newRole);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess(`角色已改为 ${newRole}`);
      window.location.reload();
    }
  }

  async function handleRemoveMember(userId: string) {
    clearMessages();
    if (!confirm("确认移除该成员?")) return;
    const result = await removeTeamMemberAction(teamId, userId);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("成员已移除");
      window.location.reload();
    }
  }

  async function handleCreateApp(e: React.FormEvent) {
    e.preventDefault();
    clearMessages();
    const fd = new FormData();
    fd.set("name", appName);
    fd.set("env", appEnv);
    const result = await createTeamAppAction(teamId, fd);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("应用已创建");
      setAppName("");
      setShowAddApp(false);
      window.location.reload();
    }
  }

  async function handleDisableApp(appId: string) {
    clearMessages();
    if (!confirm("确认停用该应用?")) return;
    const result = await disableTeamAppAction(teamId, appId);
    if (result.error) {
      setActionError(result.error);
    } else {
      setActionSuccess("应用已停用");
      window.location.reload();
    }
  }

  const roleLabels: Record<string, string> = {
    owner: "拥有者",
    admin: "管理员",
    member: "成员",
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/teams" className="text-sm text-gray-500 hover:text-gray-700">
          ← 团队列表
        </Link>
        <h1 className="text-xl font-bold">{team.name}</h1>
        <span
          className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
            team.status === "active"
              ? "bg-green-100 text-green-700"
              : "bg-red-100 text-red-700"
          }`}
        >
          {team.status === "active" ? "活跃" : "已停用"}
        </span>
      </div>

      {actionError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="p-3 bg-green-50 border border-green-200 rounded text-green-800 text-sm">
          {actionSuccess}
        </div>
      )}

      {/* Members section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">成员</h2>
          {canManage && (
            <button
              onClick={() => { setShowAddMember(!showAddMember); clearMessages(); }}
              className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700"
            >
              + 添加成员
            </button>
          )}
        </div>

        {showAddMember && (
          <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg">
            <form onSubmit={handleAddMember} className="flex gap-3 items-end flex-wrap">
              <div>
                <label className="block text-xs text-gray-600 mb-1">邮箱</label>
                <input
                  type="email"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  className="border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">角色</label>
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value)}
                  className="border border-gray-300 rounded px-3 py-2 text-sm"
                >
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                  <option value="owner">拥有者</option>
                </select>
              </div>
              <button
                type="submit"
                className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
              >
                添加
              </button>
              <button
                type="button"
                onClick={() => setShowAddMember(false)}
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">邮箱</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">加入时间</th>
                {canManage && (
                  <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {initialMembers.map((m) => (
                <tr key={m.userId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">
                    {m.email}
                    {m.userId === currentUserId && (
                      <span className="ml-2 text-xs text-blue-500">(我)</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                      {roleLabels[m.role] ?? m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(m.createdAt).toLocaleString("zh-CN")}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 flex gap-2">
                      <button
                        onClick={() => handleChangeRole(m.userId, m.role)}
                        className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100"
                      >
                        改角色
                      </button>
                      <button
                        onClick={() => handleRemoveMember(m.userId)}
                        className="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100"
                      >
                        移除
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {initialMembers.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 4 : 3} className="px-4 py-8 text-center text-gray-400">
                    暂无成员
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Apps section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">应用</h2>
          {canManage && (
            <button
              onClick={() => { setShowAddApp(!showAddApp); clearMessages(); }}
              className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700"
            >
              + 新建应用
            </button>
          )}
        </div>

        {showAddApp && (
          <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg">
            <form onSubmit={handleCreateApp} className="flex gap-3 items-end flex-wrap">
              <div>
                <label className="block text-xs text-gray-600 mb-1">应用名称</label>
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  className="border border-gray-300 rounded px-3 py-2 text-sm"
                  placeholder="My App"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">环境</label>
                <select
                  value={appEnv}
                  onChange={(e) => setAppEnv(e.target.value)}
                  className="border border-gray-300 rounded px-3 py-2 text-sm"
                >
                  <option value="prod">生产</option>
                  <option value="dev">开发</option>
                </select>
              </div>
              <button
                type="submit"
                className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
              >
                创建
              </button>
              <button
                type="button"
                onClick={() => setShowAddApp(false)}
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">环境</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">状态</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">创建时间</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {initialApps.map((app) => (
                <tr key={app.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{app.name}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                      {app.env === "prod" ? "生产" : "开发"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        app.status === "active"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {app.status === "active" ? "活跃" : "已停用"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(app.createdAt).toLocaleString("zh-CN")}
                  </td>
                  <td className="px-4 py-3 flex gap-2">
                    <Link
                      href={`/keys?ownerType=app&ownerId=${app.id}`}
                      className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100"
                    >
                      Key 管理
                    </Link>
                    {canManage && app.status === "active" && (
                      <button
                        onClick={() => handleDisableApp(app.id)}
                        className="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100"
                      >
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {initialApps.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    暂无应用
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
