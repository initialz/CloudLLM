import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const COOKIE_NAME = "byok_session";

/**
 * 中间件:未登录用户重定向至 /login
 *
 * Edge runtime 无法使用 node:crypto,这里只做 cookie 存在性轻检查。
 * 真正的签名校验与有效期校验在 server 端 requireUser() 中进行。
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 白名单:登录页、Next.js 内部路由、静态资源
  // 注:console 无 /api 路由,全部走 server actions,不豁免 /api
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // cookie 存在性检查
  const session = request.cookies.get(COOKIE_NAME);
  if (!session?.value) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
