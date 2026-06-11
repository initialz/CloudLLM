import type { Metadata } from "next";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import Link from "next/link";
import "./globals.css";
import { logoutAction } from "./logout-action";
import { decodeSession } from "../lib/session";
import { db } from "../lib/db";
import { users } from "@cloudllm/db";

export const metadata: Metadata = {
  title: "CloudLLM Console",
  description: "CloudLLM 管理后台",
};

/** 从 cookie 读取当前会话(layout 内用,无效不 redirect——由 middleware 处理)
 *  SESSION_SECRET 为空或长度 <32 时直接视为未登录,返回 null,不得用空 secret 调 decodeSession。
 */
async function getCurrentSession() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const cookieStore = await cookies();
  const raw = cookieStore.get("cloudllm_session")?.value;
  return decodeSession(raw, secret);
}

/** 导航链接组件 */
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block px-3 py-2 rounded-md text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900"
    >
      {children}
    </Link>
  );
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getCurrentSession();

  // 未登录时只渲染内容(middleware 会 redirect 到 /login)
  if (!session) {
    return (
      <html lang="zh-CN">
        <body>{children}</body>
      </html>
    );
  }

  // 查询用户邮箱用于顶部显示;查不到时兜底显示 userId
  const userRow = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const displayName = userRow?.email ?? session.userId;

  return (
    <html lang="zh-CN">
      <body className="bg-gray-50 text-gray-900">
        <div className="flex min-h-screen">
          {/* 左侧导航 */}
          <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
            <div className="h-14 flex items-center px-4 border-b border-gray-200">
              <span className="font-bold text-lg text-blue-600">CloudLLM</span>
            </div>

            {/* v1.1: 统一管理员导航——所有入口对管理员可见 */}
            <nav className="flex-1 p-3 space-y-1">
              <NavLink href="/">概览</NavLink>
              <NavLink href="/keys">Key 管理</NavLink>
              <NavLink href="/teams">团队</NavLink>
              <NavLink href="/admin/budgets">预算</NavLink>
              <NavLink href="/admin/channels">渠道</NavLink>
              <NavLink href="/admin/models">模型</NavLink>
              <NavLink href="/usage">用量报表</NavLink>
              <NavLink href="/admin/audit">审计</NavLink>
              <NavLink href="/admin/users">管理员账号</NavLink>
              <NavLink href="/guide">接入说明</NavLink>
            </nav>
          </aside>

          {/* 主内容区 */}
          <div className="flex-1 flex flex-col">
            {/* 顶部栏:右上显示邮箱 + 退出 */}
            <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-end px-6 gap-4">
              <span className="text-sm text-gray-600">{displayName}</span>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="text-sm text-gray-500 hover:text-gray-900 hover:underline"
                >
                  退出
                </button>
              </form>
            </header>

            <main className="flex-1 p-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
