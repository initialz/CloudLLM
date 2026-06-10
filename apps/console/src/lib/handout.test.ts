/**
 * handout.test.ts — 纯函数单元测试 (3 用例)
 *
 * 覆盖:
 *   1. Key/URL/模型 slug 正确嵌入;空模型数组 → "全部模型可用"说明
 *   2. anthropic/* 模型 → Claude Code 配置段(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / /model)
 *   3. openai/* 模型 → OpenAI SDK 段(Python+JS);两类都有时两段都出
 */
import { describe, expect, it } from "vitest";
import { buildHandout } from "./handout.js";

describe("buildHandout", () => {
  it("Key/URL 正确嵌入;空模型数组 → 全部模型可用说明", () => {
    const out = buildHandout({
      gatewayUrl: "http://gateway.example.com:8080/",
      plaintextKey: "sk-wtg-abc123",
      modelSlugs: [],
    });

    // Key 嵌入
    expect(out).toContain("sk-wtg-abc123");
    // URL 嵌入(末尾斜杠已规整)
    expect(out).toContain("http://gateway.example.com:8080");
    // 空模型 → 说明全部可用
    expect(out).toMatch(/全部模型|all models available/i);
    // 通用 curl 示例两例
    expect(out).toContain("/v1/chat/completions");
    expect(out).toContain("/v1/messages");
  });

  it("anthropic/* 模型 → 包含 Claude Code 配置段;无 openai/* 则无 OpenAI SDK 段", () => {
    const out = buildHandout({
      gatewayUrl: "http://localhost:8080",
      plaintextKey: "sk-wtg-testkey",
      modelSlugs: ["anthropic/claude-3-5-sonnet", "anthropic/claude-3-haiku"],
    });

    // Claude Code 段存在
    expect(out).toContain("ANTHROPIC_BASE_URL");
    expect(out).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(out).toContain("sk-wtg-testkey");
    // BASE_URL 不带 /v1
    expect(out).toContain("ANTHROPIC_BASE_URL=http://localhost:8080");
    expect(out).not.toContain("ANTHROPIC_BASE_URL=http://localhost:8080/v1");
    // /model 选择提示
    expect(out).toContain("/model");

    // 无 openai/* → 不含 OpenAI SDK Python/JS 示例
    expect(out).not.toContain("from openai import");
    expect(out).not.toContain("import OpenAI");
  });

  it("openai/* 模型 → OpenAI SDK 段(Python+JS);anthropic/* + openai/* 两段都出", () => {
    const out = buildHandout({
      gatewayUrl: "http://my-gateway:9000",
      plaintextKey: "sk-wtg-mixed",
      modelSlugs: ["openai/gpt-4o", "anthropic/claude-opus-4"],
    });

    // OpenAI SDK 段(Python)
    expect(out).toContain("from openai import");
    expect(out).toContain('base_url="http://my-gateway:9000/v1"');
    expect(out).toContain('"sk-wtg-mixed"');

    // OpenAI SDK 段(JS/TS)
    expect(out).toContain("import OpenAI");
    expect(out).toContain("baseURL: \"http://my-gateway:9000/v1\"");

    // Claude Code 段也出现(有 anthropic/*)
    expect(out).toContain("ANTHROPIC_BASE_URL");
    expect(out).toContain("ANTHROPIC_AUTH_TOKEN");
  });
});
