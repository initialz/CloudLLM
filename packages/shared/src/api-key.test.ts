import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key.js";

describe("generateApiKey", () => {
  it("生成 sk-cloudllm- 前缀的 Key,并返回哈希与前缀", () => {
    const k = generateApiKey();
    expect(k.plaintext).toMatch(/^sk-cloudllm-[A-Za-z0-9_-]{32}$/);
    expect(k.keyPrefix).toBe(k.plaintext.slice(0, 15));
    expect(k.keyHash).toBe(hashApiKey(k.plaintext));
  });

  it("两次生成互不相同", () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext);
  });
});

describe("hashApiKey", () => {
  it("输出 64 位十六进制 SHA-256,且确定性", () => {
    const h = hashApiKey("sk-cloudllm-test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("sk-cloudllm-test")).toBe(h);
    expect(hashApiKey("sk-cloudllm-other")).not.toBe(h);
  });

  it("固定向量: sk-cloudllm-test 的 SHA-256 已知", () => {
    expect(hashApiKey("sk-cloudllm-test")).toBe(
      "3c5f08c276e14e1f46791c5b08f7f4d41831b792f799f821650d4079ae4e5435"
    );
  });
});
