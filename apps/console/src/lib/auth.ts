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
 *
 * 已知限制(timing 侧信道):用户不存在时直接返回 null,跳过 scrypt 运算,
 * 导致响应时间比密码错误时短,可被用于用户枚举。v1 接受此风险;
 * 未来修复方案:用户不存在时执行 dummy hash 以保持时间一致性。
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
 * v1.1:仅管理员可登录控制台,非 admin 角色直接拒绝
 */
export async function login(email: string, password: string): Promise<string | null> {
  const user = await verifyCredentials(email, password);
  if (!user) return "邮箱或密码错误";

  // 仅管理员可登录控制台
  if (user.role !== "admin") {
    return "仅管理员可登录控制台";
  }

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
 *
 * 无状态 cookie 的撤销补偿:decodeSession 成功后回查 users 表(by id),
 * status !== "active" 则清 cookie 并 redirect("/login")。
 * console 流量小,每请求一次 PK 查询可接受。
 */
export async function requireUser(): Promise<SessionData> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  const session = decodeSession(raw, SESSION_SECRET);
  if (!session) {
    redirect("/login");
  }

  // 回查用户状态与角色:停用用户会话立即失效;role 以 DB 为准(降级即时生效)
  const rows = await db
    .select({ status: users.status, role: users.role })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (rows.length === 0 || rows[0]!.status !== "active") {
    // 尝试清 cookie(仅 Server Action / Route Handler 可写 cookie,
    // Server Component 中会抛出异常;此处吞掉异常,直接 redirect 即可——
    // 下次请求 DB 查询仍会失效,逻辑不受影响)
    try {
      cookieStore.delete(COOKIE_NAME);
    } catch {
      // Server Component 上下文中忽略此错误
    }
    redirect("/login");
  }

  // 若 DB 中 role 与 cookie 中 role 不一致,以 DB 为准覆盖——
  // 保证管理员降级(admin→user)无需重新登录即时生效
  const dbRole = rows[0]!.role as "admin" | "user";
  if (dbRole !== session.role) {
    session.role = dbRole;
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
