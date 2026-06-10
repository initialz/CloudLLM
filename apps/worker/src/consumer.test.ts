/**
 * consumer.test.ts
 *
 * ioredis-mock@8.13.1 不支持任何 Stream 命令(xgroup/xreadgroup/xpending/xautoclaim/xadd/xack),
 * 因此改为使用 vi.fn() 构造最小 Redis stub 模拟 Stream 接口,不改变实现语义。
 * claimStale(依赖 xautoclaim)已省略专项用例,改由 e2e 真 Redis 验证。
 */

import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { UsageConsumer } from "./consumer.js";

// ─── 最小 Redis stub ────────────────────────────────────────────────────────

/** 构造一个足以测试 UsageConsumer 的 Redis stub */
function makeRedisStub() {
  // pending map: entryId -> count
  const pendingMap: Map<string, number> = new Map();
  const dlqEntries: Array<{ id: string; fields: string[] }> = [];
  let entryCounter = 0;

  // Stream: entries waiting to be consumed
  const streamEntries: Array<{ id: string; fields: string[] }> = [];

  const xgroup = vi.fn(async (..._args: unknown[]) => {
    // Second call: simulate BUSYGROUP
    if (xgroup.mock.calls.length > 1) {
      throw new Error("BUSYGROUP Consumer Group name already exists");
    }
    return "OK";
  });

  const xadd = vi.fn(async (key: string, _id: string, ...fields: string[]) => {
    const id = `${Date.now()}-${entryCounter++}`;
    if (key.endsWith("_dlq")) {
      dlqEntries.push({ id, fields });
    } else {
      streamEntries.push({ id, fields });
    }
    return id;
  });

  const xreadgroup = vi.fn(async (...args: unknown[]) => {
    // args: ["GROUP", group, consumer, "COUNT", count, "STREAMS", stream, ">"]
    if (streamEntries.length === 0) return null;
    const entries = streamEntries.splice(0, streamEntries.length);
    const stream = args[args.indexOf("STREAMS") + 1] as string;
    // Track pending
    for (const e of entries) {
      pendingMap.set(e.id, (pendingMap.get(e.id) ?? 0) + 1);
    }
    return [[stream, entries.map((e) => [e.id, e.fields])]];
  });

  const xack = vi.fn(async (_stream: string, _group: string, entryId: string) => {
    pendingMap.delete(entryId);
    return 1;
  });

  const xpending = vi.fn(async (_stream: string, _group: string) => {
    // Summary form: [count, minId, maxId, consumers]
    return [pendingMap.size, null, null, []];
  });

  const stub = {
    xgroup,
    xadd,
    xreadgroup,
    xack,
    xpending,
    // track for assertions
    _pendingMap: pendingMap,
    _dlqEntries: dlqEntries,
  };

  return stub as unknown as Redis & typeof stub;
}

const cfgOf = (redis: Redis) => ({
  redis,
  stream: "usage_events",
  group: "g",
  consumer: "c1",
  maxDeliveries: 3,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("UsageConsumer", () => {
  it("ensureGroup 幂等(BUSYGROUP 不抛)", async () => {
    const redis = makeRedisStub();
    const c = new UsageConsumer(cfgOf(redis), async () => "ok");
    await c.ensureGroup(); // first call: OK
    await c.ensureGroup(); // second call: BUSYGROUP → should not throw
    // Both calls completed without throwing
  });

  it("消费一批:handler ok → ack", async () => {
    const redis = makeRedisStub();
    const seen: string[] = [];
    const c = new UsageConsumer(cfgOf(redis), async (payload) => {
      seen.push(payload);
      return "ok";
    });
    await c.ensureGroup();
    // Pre-populate stream (xadd to main stream)
    await redis.xadd("usage_events", "*", "payload", "p1");
    await redis.xadd("usage_events", "*", "payload", "p2");
    const n = await c.consumeOnce(0);
    expect(n).toBe(2);
    expect(seen).toEqual(["p1", "p2"]);
    // After ack, pending count should be 0
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(0);
  });

  it("handler 抛错 → 不 ack(留 pending 重试)", async () => {
    const redis = makeRedisStub();
    const c = new UsageConsumer(cfgOf(redis), async () => {
      throw new Error("boom");
    });
    await c.ensureGroup();
    await redis.xadd("usage_events", "*", "payload", "bad");
    await c.consumeOnce(0);
    // xack should NOT have been called for this entry
    expect(redis.xack).not.toHaveBeenCalled();
    // pending map still has the entry (we only remove on ack)
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(1);
  });

  it("handler 返回 dead → 进 DLQ 并 ack", async () => {
    const redis = makeRedisStub();
    const c = new UsageConsumer(cfgOf(redis), async () => "dead");
    await c.ensureGroup();
    await redis.xadd("usage_events", "*", "payload", "poison");
    await c.consumeOnce(0);
    // DLQ should have one entry
    expect(redis._dlqEntries).toHaveLength(1);
    // Entry should have been ack'd (removed from pending)
    const pending = await redis.xpending("usage_events", "g");
    expect((pending as unknown[])[0]).toBe(0);
  });
});
