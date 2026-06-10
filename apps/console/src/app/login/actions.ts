"use server";

import { login } from "../../lib/auth";

export interface LoginState {
  error?: string;
  success?: boolean;
}

/** Server Action:处理登录表单提交 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = formData.get("email")?.toString() ?? "";
  const password = formData.get("password")?.toString() ?? "";

  if (!email || !password) {
    return { error: "请填写邮箱和密码" };
  }

  const error = await login(email, password);
  if (error) {
    return { error };
  }

  // 登录成功 - 返回 success 状态,让客户端通过 useEffect + router.push 导航
  return { success: true };
}
