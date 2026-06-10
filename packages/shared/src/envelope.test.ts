import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./envelope.js";

const master = randomBytes(32).toString("base64");

describe("envelope encryption", () => {
  it("加密后能用同一主密钥解回原文", () => {
    const ct = encryptSecret("sk-ant-upstream-credential", master);
    expect(decryptSecret(ct, master)).toBe("sk-ant-upstream-credential");
  });

  it("同一明文两次加密产物不同(随机 IV/数据密钥)", () => {
    expect(encryptSecret("x", master)).not.toBe(encryptSecret("x", master));
  });

  it("错误主密钥解密抛错", () => {
    const ct = encryptSecret("x", master);
    const wrong = randomBytes(32).toString("base64");
    expect(() => decryptSecret(ct, wrong)).toThrow();
  });

  it("密文被篡改时解密抛错(GCM 认证)", () => {
    const ct = JSON.parse(encryptSecret("x", master));
    ct.data = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(JSON.stringify(ct), master)).toThrow();
  });

  it("主密钥长度不是 32 字节时拒绝", () => {
    expect(() => encryptSecret("x", "c2hvcnQ=")).toThrow(/32/);
  });
});
