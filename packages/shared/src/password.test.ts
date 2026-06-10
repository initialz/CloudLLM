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

  it("空 hash 段的存储值返回 false(防绕过)", async () => {
    const salt = Buffer.from("0123456789abcdef").toString("base64url");
    expect(await verifyPassword("x", `scrypt$65536$8$1$${salt}$`)).toBe(false);
  });

  it("超长密码抛错", async () => {
    await expect(hashPassword("a".repeat(1025))).rejects.toThrow();
  });

  it("旧参数(N=16384)的哈希仍可校验(自描述格式)", async () => {
    const { scrypt } = await import("node:crypto");
    const { promisify } = await import("node:util");
    const scryptP = promisify(scrypt) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
    const salt = Buffer.from("fixed-salt-16byt");
    const hash = await scryptP("pw", salt, 32, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
    expect(await verifyPassword("pw", stored)).toBe(true);
  });
});
