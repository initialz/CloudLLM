import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

const validEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };

describe("loadWorkerConfig", () => {
  it("默认值齐全", () => {
    const c = loadWorkerConfig(validEnv);
    expect(c.usageStream).toBe("usage_events");
    expect(c.group).toBe("console-worker");
    expect(c.auditRetentionDays).toBe(30);
    expect(c.jobIntervalMs).toBe(3_600_000);
    expect(c.maxDeliveries).toBe(5);
    expect(c.balanceTtlSeconds).toBe(60);
    expect(c.consumer).toMatch(/.+/);
  });

  it("缺必填项抛错点名;非数字抛错点名", () => {
    expect(() => loadWorkerConfig({ REDIS_URL: "redis://x" })).toThrow(/DATABASE_URL/);
    expect(() => loadWorkerConfig({ ...validEnv, MAX_DELIVERIES: "abc" })).toThrow(/MAX_DELIVERIES/);
  });
});
