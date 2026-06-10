import { describe, expect, it } from "vitest";
import { parseUsageEvent } from "./parse-event.js";

const valid = {
  keyId: "k1", modelSlug: "m", channelId: null,
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costCny: "0.000123", latencyMs: 10, ttftMs: null,
  status: "ok", errorCode: null, ts: "2026-06-10T00:00:00.000Z",
};

describe("parseUsageEvent", () => {
  it("合法事件解析通过", () => {
    expect(parseUsageEvent(JSON.stringify(valid))).toMatchObject({ keyId: "k1", costCny: "0.000123" });
  });

  it("非 JSON / 缺字段 / 类型错 返回 null(进死信而不是炸循环)", () => {
    expect(parseUsageEvent("not-json")).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, keyId: undefined }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, costCny: 123 }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, status: "weird" }))).toBeNull();
    expect(parseUsageEvent(JSON.stringify({ ...valid, usage: { inputTokens: "x" } }))).toBeNull();
  });
});
