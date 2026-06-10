import type { Redis } from "ioredis";
import type { BalanceStore, BudgetSubject, CooldownStore, EventSink, UsageEvent } from "./types.js";

const UNLIMITED_SENTINEL = "u";
const balKey = (s: BudgetSubject) => `bal:${s.type}:${s.id}`;

export class RedisBalanceStore implements BalanceStore {
  constructor(private redis: Redis, private defaultTtlSeconds = 60) {}

  async getMany(subjects: BudgetSubject[]): Promise<(bigint | "unlimited" | null)[]> {
    if (subjects.length === 0) return [];
    const values = await this.redis.mget(subjects.map(balKey));
    return values.map((v, i) => {
      if (v === null) return null;
      if (v === UNLIMITED_SENTINEL) return "unlimited" as const;
      try {
        return BigInt(v);
      } catch {
        // 脏值(如被人工改动):按缓存未命中处理,checkBudgets 会回源 PG 重建
        console.error(`余额缓存值损坏 ${balKey(subjects[i]!)}=${v},按未命中处理`);
        return null;
      }
    });
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
        // DECRBY 后补 EXPIRE:防 GET→DECRBY 间键过期导致 DECRBY 重建出"无 TTL 负键"永久锁死主体
        await this.redis.decrby(key, micro.toString() as unknown as number);
        await this.redis.expire(key, this.defaultTtlSeconds);
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
    private maxLen = 500_000,
  ) {}

  async emit(event: UsageEvent): Promise<void> {
    // MAXLEN ~ 近似裁剪:防 worker 滞后时流无界增长打爆 Redis 内存
    await this.redis.xadd(
      this.stream, "MAXLEN", "~", this.maxLen, "*", "payload", JSON.stringify(event),
    );
  }
}
