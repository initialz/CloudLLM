import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./envelope.js";

const master = randomBytes(32).toString("base64");

describe("envelope encryption", () => {
  it("加密后能用同一主密钥解回原文", () => {
    const ct = encryptSecret("sk-ant-upstream-credential", master, "chan-123");
    expect(decryptSecret(ct, master, "chan-123")).toBe("sk-ant-upstream-credential");
  });

  it("同一明文两次加密产物不同(随机 IV/数据密钥)", () => {
    expect(encryptSecret("x", master, "chan-123")).not.toBe(encryptSecret("x", master, "chan-123"));
  });

  it("错误主密钥解密抛错", () => {
    const ct = encryptSecret("x", master, "chan-123");
    const wrong = randomBytes(32).toString("base64");
    expect(() => decryptSecret(ct, wrong, "chan-123")).toThrow();
  });

  it("密文被篡改时解密抛错(GCM 认证)", () => {
    const ct = JSON.parse(encryptSecret("x", master, "chan-123"));
    ct.data = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(JSON.stringify(ct), master, "chan-123")).toThrow();
  });

  it("主密钥长度不是 32 字节时拒绝", () => {
    expect(() => encryptSecret("x", "c2hvcnQ=", "chan-123")).toThrow(/32/);
  });

  it("AAD 上下文不一致时解密抛错(防密文跨记录移植)", () => {
    const ct = encryptSecret("x", master, "chan-A");
    expect(() => decryptSecret(ct, master, "chan-B")).toThrow();
  });

  it("ektag 被篡改时解密抛错", () => {
    const ct = JSON.parse(encryptSecret("x", master, "chan-123"));
    ct.ektag = randomBytes(16).toString("base64");
    expect(() => decryptSecret(JSON.stringify(ct), master, "chan-123")).toThrow();
  });

  it("缺字段的信封给出明确错误", () => {
    const ct = JSON.parse(encryptSecret("x", master, "chan-123"));
    delete ct.ekiv;
    expect(() => decryptSecret(JSON.stringify(ct), master, "chan-123")).toThrow(/ekiv/);
  });

  it("非法 JSON 抛错", () => {
    expect(() => decryptSecret("not-json", master, "chan-123")).toThrow();
  });
});
