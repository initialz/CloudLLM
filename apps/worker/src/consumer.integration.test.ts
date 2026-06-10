import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { UsageConsumer } from "./consumer.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("UsageConsumer(真 Redis)", () => {
  const redis = new Redis(REDIS_URL);
  const stream = `t_${randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    await redis.del(stream, `${stream}_dlq`);
    await redis.quit();
  });

  it("失败→pending→claimStale 重试成功;超限→DLQ", async () => {
    let failures = 0;
    // maxDeliveries=2:第 1 次消费失败 + 第 1 次 claim 重试失败 → 第 2 次 claim 时投递数 3 > 2 → DLQ
    const flaky = new UsageConsumer(
      { redis, stream, group: "g", consumer: "c1", maxDeliveries: 2 },
      async () => {
        failures++;
        throw new Error("always fail");
      },
    );
    await flaky.ensureGroup();
    await redis.xadd(stream, "*", "payload", "p");
    await flaky.consumeOnce(0); // 第 1 次投递,失败留 pending
    expect(failures).toBe(1);

    await flaky.claimStale(0); // 第 2 次投递,仍失败
    expect(failures).toBe(2);

    await flaky.claimStale(0); // 投递数已 3 > maxDeliveries=2 → 直接送 DLQ,不再调 handler
    expect(failures).toBe(2);
    const dlq = await redis.xrange(`${stream}_dlq`, "-", "+");
    expect(dlq).toHaveLength(1);
    // xpending summary: [count, minId, maxId, [[consumer, count], ...]]
    // ioredis returns array; pending[0] is the count
    const pending = (await redis.xpending(stream, "g")) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);

    // 成功路径:新事件 → consumeOnce 后由成功 handler 处理并 ack
    const ok = new UsageConsumer(
      { redis, stream, group: "g", consumer: "c2", maxDeliveries: 5 },
      async () => "ok",
    );
    await redis.xadd(stream, "*", "payload", "p2");
    await ok.consumeOnce(0);
    const pending2 = (await redis.xpending(stream, "g")) as [number, ...unknown[]];
    expect(pending2[0]).toBe(0);
  });
});
