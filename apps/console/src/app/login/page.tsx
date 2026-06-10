// 已知限制:此页面使用 useActionState + useRouter,依赖客户端 JS。
// 禁用 JS 的浏览器将无法完成登录流程。v1 接受此限制;未来可考虑添加 <noscript> 提示。
"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

/** 登录页面:表单 + Server Action + 错误提示 */
export default function LoginPage() {
  const router = useRouter();
  const [state, action, pending] = useActionState(loginAction, initialState);

  // 登录成功后客户端跳转(避免 redirect() 在 server action 中的 RSC 流问题)
  useEffect(() => {
    if (state.success) {
      router.push("/");
      router.refresh();
    }
  }, [state.success, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4 text-center">
          BYOK Console
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          团队成员无需登录,使用管理员发放的 API Key 即可
        </p>

        {state.error && (
          <div
            role="alert"
            className="mb-4 rounded bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
          >
            {state.error}
          </div>
        )}

        <form action={action} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              邮箱
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="admin@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              密码
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
