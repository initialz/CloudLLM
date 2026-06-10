import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { RedisBalanceStore, RedisCooldownStore, RedisEventSink } from "./redis-stores.js";
import type { UsageEvent } from "./types.js";
import type Redis from "ioredis";

const subject = { type: "key" as const, id: "k1" };

describe("RedisBalanceStore", () => {
  it("set/getMany 往返,unlimited 用哨兵存储", async () => {
    const store = new RedisBalanceStore(new RedisMock() as unknown as Redis);
    await store.set(subject, 123n, 60);
    await store.set({ type: "team", id: "t1" }, "unlimited", 60);
    const r = await store.getMany([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }]);
    expect(r).toEqual([123n, "unlimited", null]);
  });

  it("decrBy 只对数值余额扣减,跳过 unlimited 与未缓存", async () => {
    const store = new RedisBalanceStore(new RedisMock() as unknown as Redis);
    await store.set(subject, 100n, 60);
    await store.set({ type: "team", id: "t1" }, "unlimited", 60);
    await store.decrBy([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }], 30n);
    const r = await store.getMany([subject, { type: "team", id: "t1" }, { type: "user", id: "nope" }]);
    expect(r).toEqual([70n, "unlimited", null]);
  });

  it("脏值按未命中(null)返回而不抛错", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisBalanceStore(redis);
    await (redis as unknown as { set(k: string, v: string): Promise<unknown> }).set("bal:key:bad", "abc");
    const r = await store.getMany([{ type: "key", id: "bad" }]);
    expect(r).toEqual([null]);
  });

  it("decrBy 后键带 TTL(防无 TTL 负键)", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = new RedisBalanceStore(redis, 60);
    await store.set(subject, 100n, 60);
    await store.decrBy([subject], 30n);
    const ttl = await (redis as unknown as { ttl(k: string): Promise<number> }).ttl("bal:key:k1");
    expect(ttl).toBeGreaterThan(0);
  });
});

describe("RedisCooldownStore", () => {
  it("markCooldown 后 isCooling 为 true", async () => {
    const store = new RedisCooldownStore(new RedisMock() as unknown as Redis);
    expect(await store.isCooling("c1")).toBe(false);
    await store.markCooldown("c1", 30);
    expect(await store.isCooling("c1")).toBe(true);
  });
});

describe("RedisEventSink", () => {
  it("XADD 写入流,payload 可解析回 UsageEvent", async () => {
    const redis = new RedisMock() as unknown as Redis;
    const sink = new RedisEventSink(redis, "usage_events");
    const event: UsageEvent = {
      keyId: "k1", modelSlug: "anthropic/claude-opus-4-8", channelId: "c1",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costCny: "0.000123", latencyMs: 88, ttftMs: 12,
      status: "ok", errorCode: null, ts: "2026-06-10T00:00:00.000Z",
    };
    await sink.emit(event);
    const entries = await redis.xrange("usage_events", "-", "+");
    expect(entries).toHaveLength(1);
    const fields = entries[0]![1];
    expect(fields[0]).toBe("payload");
    expect(JSON.parse(fields[1]!)).toEqual(event);
  });
});
