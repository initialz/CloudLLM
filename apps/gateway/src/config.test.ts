import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validEnv = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  MASTER_KEY: randomBytes(32).toString("base64"),
};

describe("loadConfig", () => {
  it("默认值齐全", () => {
    const c = loadConfig(validEnv);
    expect(c.port).toBe(8080);
    expect(c.balanceTtlSeconds).toBe(60);
    expect(c.cooldownSeconds).toBe(30);
    expect(c.catalogTtlMs).toBe(30000);
    expect(c.usageStream).toBe("usage_events");
  });

  it("环境变量覆盖默认值", () => {
    const c = loadConfig({ ...validEnv, PORT: "9090", COOLDOWN_SECONDS: "5" });
    expect(c.port).toBe(9090);
    expect(c.cooldownSeconds).toBe(5);
  });

  it("缺少必填项抛错并点名变量", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("MASTER_KEY 非 32 字节拒绝", () => {
    expect(() => loadConfig({ ...validEnv, MASTER_KEY: "c2hvcnQ=" })).toThrow(/32/);
  });
});
