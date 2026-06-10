import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("哈希后能用正确密码通过校验", async () => {
    const stored = await hashPassword("s3cret!");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret!", stored)).toBe(true);
  });

  it("错误密码校验失败", async () => {
    const stored = await hashPassword("s3cret!");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("同一密码两次哈希结果不同(随机盐)", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });

  it("格式损坏的存储值返回 false 而不抛异常", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
