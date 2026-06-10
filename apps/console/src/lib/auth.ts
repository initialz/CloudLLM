import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { users } from "@byok/db";
import { verifyPassword } from "@byok/shared";
import { db } from "./db";
import { decodeSession, encodeSession, type SessionData } from "./session";

// SESSION_SECRET 启动时校验:必填且 ≥32 字符
const SESSION_SECRET = ((): string => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET 必须设置且长度 ≥32 字符");
  }
  return s;
})();

const COOKIE_NAME = "byok_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

/**
 * 凭证校验:单独封装便于 SSO 替换
 * 返回用户行或 null
 */
export async function verifyCredentials(email: string, password: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = rows[0];
  if (!user || user.status !== "active") return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return user;
}

/**
 * 登录:验证凭证后写 cookie
 * 失败返回错误字符串(不区分"用户不存在/密码错",防止用户枚举)
 */
export async function login(email: string, password: string): Promise<string | null> {
  const user = await verifyCredentials(email, password);
  if (!user) return "邮箱或密码错误";

  const nowSec = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    userId: user.id,
    role: user.role as "admin" | "user",
    exp: nowSec + SESSION_TTL_SECONDS,
  };
  const value = encodeSession(sessionData, SESSION_SECRET);

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });

  return null; // 成功无错误
}

/** 登出:清除 cookie */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

/**
 * 读取并校验会话,无效则 redirect /login
 * 在 Server Components / Server Actions 中使用
 */
export async function requireUser(): Promise<SessionData> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  const session = decodeSession(raw, SESSION_SECRET);
  if (!session) {
    redirect("/login");
  }
  return session;
}

/**
 * 要求 admin 角色,否则 redirect /
 */
export async function requireAdmin(): Promise<SessionData> {
  const session = await requireUser();
  if (session.role !== "admin") {
    redirect("/");
  }
  return session;
}
