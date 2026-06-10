import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key.js";

describe("generateApiKey", () => {
  it("生成 sk-wtg- 前缀的 Key,并返回哈希与前缀", () => {
    const k = generateApiKey();
    expect(k.plaintext).toMatch(/^sk-wtg-[A-Za-z0-9_-]{32}$/);
    expect(k.keyPrefix).toBe(k.plaintext.slice(0, 15));
    expect(k.keyHash).toBe(hashApiKey(k.plaintext));
  });

  it("两次生成互不相同", () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext);
  });
});

describe("hashApiKey", () => {
  it("输出 64 位十六进制 SHA-256,且确定性", () => {
    const h = hashApiKey("sk-wtg-test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("sk-wtg-test")).toBe(h);
    expect(hashApiKey("sk-wtg-other")).not.toBe(h);
  });

  it("固定向量: sk-wtg-test 的 SHA-256 已知", () => {
    expect(hashApiKey("sk-wtg-test")).toBe(
      "150c18a3007b665f85ad33eb5ad6ee8177cae2d17622258fe25d0d109abdaca1"
    );
  });
});
