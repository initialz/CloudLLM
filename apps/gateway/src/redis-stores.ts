import type { Redis } from "ioredis";
import type { BalanceStore, BudgetSubject, CooldownStore, EventSink, UsageEvent } from "./types.js";

const UNLIMITED_SENTINEL = "u";
const balKey = (s: BudgetSubject) => `bal:${s.type}:${s.id}`;

export class RedisBalanceStore implements BalanceStore {
  constructor(private redis: Redis) {}

  async getMany(subjects: BudgetSubject[]): Promise<(bigint | "unlimited" | null)[]> {
    if (subjects.length === 0) return [];
    const values = await this.redis.mget(subjects.map(balKey));
    return values.map((v: string | null) =>
      v === null ? null : v === UNLIMITED_SENTINEL ? ("unlimited" as const) : BigInt(v),
    );
  }

  async set(subject: BudgetSubject, value: bigint | "unlimited", ttlSeconds: number): Promise<void> {
    await this.redis.set(
      balKey(subject),
      value === "unlimited" ? UNLIMITED_SENTINEL : value.toString(),
      "EX",
      ttlSeconds,
    );
  }

  async decrBy(subjects: BudgetSubject[], micro: bigint): Promise<void> {
    // 读后减,接受微小竞态:余额是热缓存,PG 台账才是事实源,Phase 3 worker 落库时校正
    for (const subject of subjects) {
      const key = balKey(subject);
      const current = await this.redis.get(key);
      if (current !== null && current !== UNLIMITED_SENTINEL) {
        // 以字符串传 DECRBY,避免大额 bigint 经 Number 损失精度
        await this.redis.decrby(key, micro.toString());
      }
    }
  }
}

export class RedisCooldownStore implements CooldownStore {
  constructor(private redis: Redis) {}

  async isCooling(channelId: string): Promise<boolean> {
    return (await this.redis.exists(`cooldown:${channelId}`)) === 1;
  }

  async markCooldown(channelId: string, seconds: number): Promise<void> {
    await this.redis.set(`cooldown:${channelId}`, "1", "EX", seconds);
  }
}

export class RedisEventSink implements EventSink {
  constructor(
    private redis: Redis,
    private stream: string,
  ) {}

  async emit(event: UsageEvent): Promise<void> {
    await this.redis.xadd(this.stream, "*", "payload", JSON.stringify(event));
  }
}
