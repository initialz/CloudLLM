import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { logoutAction } from "./logout-action";
import { decodeSession } from "../lib/session";

export const metadata: Metadata = {
  title: "BYOK Console",
  description: "BYOK 管理后台",
};

/** 从 cookie 读取当前会话(layout 内用,无效不 redirect——由 middleware 处理) */
async function getCurrentSession() {
  const secret = process.env.SESSION_SECRET ?? "";
  const cookieStore = await cookies();
  const raw = cookieStore.get("byok_session")?.value;
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

  return (
    <html lang="zh-CN">
      <body className="bg-gray-50 text-gray-900">
        <div className="flex min-h-screen">
          {/* 左侧导航 */}
          <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
            <div className="h-14 flex items-center px-4 border-b border-gray-200">
              <span className="font-bold text-lg text-blue-600">BYOK</span>
            </div>

            <nav className="flex-1 p-3 space-y-1">
              {/* 所有用户可见 */}
              <NavLink href="/">概览</NavLink>
              <NavLink href="/keys">我的 Key</NavLink>
              <NavLink href="/usage">用量报表</NavLink>

              {/* 仅 admin 可见 */}
              {session.role === "admin" && (
                <>
                  <div className="pt-3 pb-1">
                    <p className="px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      管理
                    </p>
                  </div>
                  <NavLink href="/admin/users">用户</NavLink>
                  <NavLink href="/teams">团队</NavLink>
                  <NavLink href="/admin/budgets">预算</NavLink>
                  <NavLink href="/admin/channels">渠道</NavLink>
                  <NavLink href="/admin/models">模型</NavLink>
                  <NavLink href="/admin/audit">审计</NavLink>
                </>
              )}
            </nav>
          </aside>

          {/* 主内容区 */}
          <div className="flex-1 flex flex-col">
            {/* 顶部栏:右上显示邮箱 + 退出 */}
            <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-end px-6 gap-4">
              <span className="text-sm text-gray-600">{session.userId}</span>
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
