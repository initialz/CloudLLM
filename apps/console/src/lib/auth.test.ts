/**
 * auth.test.ts — login() 角色拒绝逻辑单元测试 (1 用例)
 *
 * 目标:验证 login() 在凭证正确但 role !== "admin" 时返回拒绝文案。
 *
 * 因 login() 调用 next/headers cookies() 与数据库,测试中使用 vi.mock 隔离外部依赖。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// 必须在 import auth.ts 之前 mock,vitest 会提升 vi.mock 调用

// Mock next/headers cookies()
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Mock next/navigation redirect (requireUser/requireAdmin 用到)
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mock @byok/shared verifyPassword
vi.mock("@byok/shared", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

// Mock DB module
vi.mock("./db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// SESSION_SECRET 由 vitest.config.ts 的 env 注入(在模块加载前设置,满足 auth.ts IIFE 校验)

import { login } from "./auth.js";
import { verifyPassword } from "@byok/shared";
import { db } from "./db.js";

const mockVerifyPassword = vi.mocked(verifyPassword);
const mockDb = vi.mocked(db);

describe("auth.login()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("凭证正确但 role=user 时返回「仅管理员可登录控制台」", async () => {
    // 模拟 DB 查询返回一个 role=user 的活跃用户
    const mockUser = {
      id: "test-user-id",
      email: "user@example.com",
      role: "user",
      status: "active",
      passwordHash: "hashed-pw",
    };

    // db.select().from().where().limit() 链式调用 mock
    const mockLimit = vi.fn().mockResolvedValue([mockUser]);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select = vi.fn().mockReturnValue({ from: mockFrom });

    // verifyPassword 返回 true(密码正确)
    mockVerifyPassword.mockResolvedValue(true);

    const result = await login("user@example.com", "correct-password");

    expect(result).toBe("仅管理员可登录控制台");
  });
});
