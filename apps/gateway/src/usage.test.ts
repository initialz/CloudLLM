import { describe, expect, it } from "vitest";
import { SseUsageTap, extractUsageFromJson } from "./usage.js";

describe("extractUsageFromJson", () => {
  it("openai:拆分缓存命中", () => {
    const u = extractUsageFromJson("openai", {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    });
    expect(u).toEqual({ inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it("openai:无缓存明细时 cached=0", () => {
    const u = extractUsageFromJson("openai", { usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("anthropic:四字段直读", () => {
    const u = extractUsageFromJson("anthropic", {
      usage: {
        input_tokens: 7,
        output_tokens: 9,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });
    expect(u).toEqual({ inputTokens: 7, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });

  it("缺失/畸形 usage 返回全零", () => {
    expect(extractUsageFromJson("openai", null)).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(extractUsageFromJson("anthropic", { usage: "bad" })).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });
});

describe("SseUsageTap openai", () => {
  it("从最终 chunk 提取 usage,跨 chunk 断行也能解析", () => {
    const tap = new SseUsageTap("openai");
    tap.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    // 模拟同一行被拆成两个网络包
    tap.push('data: {"usage":{"prompt_tokens":12,"completion_tokens":3,');
    tap.push('"prompt_tokens_details":{"cached_tokens":2}},"choices":[]}\n\ndata: [DONE]\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 });
  });

  it("无 usage 的流返回全零", () => {
    const tap = new SseUsageTap("openai");
    tap.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("SseUsageTap anthropic", () => {
  it("message_start 取 input/cache,message_delta 取累计 output", () => {
    const tap = new SseUsageTap("anthropic");
    tap.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":5,"cache_creation_input_tokens":1,"output_tokens":1}}}\n\n',
    );
    tap.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    tap.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 25, outputTokens: 77, cacheReadTokens: 5, cacheWriteTokens: 1 });
  });

  it("非 JSON 行与心跳行不影响解析", () => {
    const tap = new SseUsageTap("anthropic");
    tap.push(": ping\n\n");
    tap.push("data: not-json\n\n");
    expect(tap.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("SseUsageTap 边界", () => {
  it("CRLF 行尾正常解析", () => {
    const tap = new SseUsageTap("openai");
    tap.push('data: {"usage":{"prompt_tokens":10,"completion_tokens":5},"choices":[]}\r\ndata: [DONE]\r\n');
    expect(tap.totals()).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("anthropic 流中断(无 message_delta)时输出记 0", () => {
    const tap = new SseUsageTap("anthropic");
    tap.push('data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n');
    expect(tap.totals()).toEqual({ inputTokens: 25, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
