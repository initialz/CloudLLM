"use client";

import Link from "next/link";

interface TeamDetailClientProps {
  team: { id: string; name: string; status: string };
  teamId: string;
}

/**
 * 团队详情(v1.1)
 * - 移除成员管理区块(team_members 不再使用)
 * - 展示:团队信息 + 该团队 Key 列表链接 + 预算入口
 */
export default function TeamDetailClient({
  team,
  teamId,
}: TeamDetailClientProps) {
  return (
    <div className="space-y-6">
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

      {/* 团队信息 */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">团队信息</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">团队 ID</dt>
            <dd className="font-mono text-gray-900 mt-0.5">{teamId}</dd>
          </div>
          <div>
            <dt className="text-gray-500">名称</dt>
            <dd className="text-gray-900 mt-0.5">{team.name}</dd>
          </div>
          <div>
            <dt className="text-gray-500">状态</dt>
            <dd className="text-gray-900 mt-0.5">
              {team.status === "active" ? "活跃" : "已停用"}
            </dd>
          </div>
        </dl>
      </section>

      {/* Key 列表快捷入口 */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">该团队的 Key</h2>
        <p className="text-sm text-gray-500 mb-3">
          查看或管理归属于此团队的所有 API Key。
        </p>
        <Link
          href={`/keys?ownerType=team&ownerId=${teamId}`}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700"
        >
          查看 Key 列表
        </Link>
      </section>

      {/* 预算入口 */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">团队预算</h2>
        <p className="text-sm text-gray-500 mb-3">
          在预算页面管理此团队的额度设置。
        </p>
        <Link
          href={`/admin/budgets?subjectType=team&subjectId=${teamId}`}
          className="inline-flex items-center px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-200"
        >
          查看团队预算
        </Link>
      </section>
    </div>
  );
}
