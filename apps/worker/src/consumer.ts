import type { Redis } from "ioredis";

export type HandleResult = "ok" | "dead";
/** 处理一条事件;抛错=留 pending 重试;"dead"=送死信并 ack */
export type EventHandler = (payload: string, entryId: string) => Promise<HandleResult>;

export interface ConsumerConfig {
  redis: Redis;
  stream: string;
  group: string;
  consumer: string;
  maxDeliveries: number;
}

type StreamEntry = [id: string, fields: string[]];
type XReadGroupResult = Array<[stream: string, entries: StreamEntry[]]> | null;

export class UsageConsumer {
  constructor(
    private cfg: ConsumerConfig,
    private handler: EventHandler,
  ) {}

  /** 幂等创建消费组(MKSTREAM 容忍流不存在) */
  async ensureGroup(): Promise<void> {
    try {
      await this.cfg.redis.xgroup("CREATE", this.cfg.stream, this.cfg.group, "$", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
  }

  /** 读一批新事件并处理;返回处理条数。blockMs=0 时不阻塞(测试用)。 */
  async consumeOnce(blockMs: number): Promise<number> {
    const args: string[] = [
      "GROUP", this.cfg.group, this.cfg.consumer,
      "COUNT", "32",
      ...(blockMs > 0 ? ["BLOCK", String(blockMs)] : []),
      "STREAMS", this.cfg.stream, ">",
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (this.cfg.redis.xreadgroup as (...a: string[]) => Promise<unknown>)(...args)) as XReadGroupResult;
    if (!res) return 0;
    let handled = 0;
    for (const [, entries] of res) {
      for (const [entryId, fields] of entries) {
        await this.handleEntry(entryId, fields);
        handled++;
      }
    }
    return handled;
  }

  /** 认领滞留 pending(其他消费者崩溃遗留/本进程上轮失败),超过投递上限送死信 */
  async claimStale(minIdleMs: number): Promise<void> {
    const res = (await this.cfg.redis.xautoclaim(
      this.cfg.stream, this.cfg.group, this.cfg.consumer, minIdleMs, "0-0", "COUNT", 32,
    )) as [string, StreamEntry[], ...unknown[]];
    const entries = res[1] ?? [];
    for (const [entryId, fields] of entries) {
      const info = (await this.cfg.redis.xpending(
        this.cfg.stream, this.cfg.group, entryId, entryId, 1,
      )) as Array<[string, string, number, number]>;
      const deliveries = info[0]?.[3] ?? 1;
      if (deliveries > this.cfg.maxDeliveries) {
        await this.toDlq(entryId, fields, `投递 ${deliveries} 次仍失败`);
        continue;
      }
      await this.handleEntry(entryId, fields);
    }
  }

  private async handleEntry(entryId: string, fields: string[]): Promise<void> {
    const idx = fields.indexOf("payload");
    const payload = idx >= 0 ? fields[idx + 1] : undefined;
    if (payload === undefined) {
      await this.toDlq(entryId, fields, "缺 payload 字段");
      return;
    }
    try {
      const result = await this.handler(payload, entryId);
      if (result === "dead") {
        await this.toDlq(entryId, fields, "handler 判定不可处理");
        return;
      }
      await this.cfg.redis.xack(this.cfg.stream, this.cfg.group, entryId);
    } catch (err) {
      // 不 ack:留 pending,由 claimStale 重试;超限后送死信
      console.error(`事件 ${entryId} 处理失败(将重试): ${(err as Error).message}`);
    }
  }

  private async toDlq(entryId: string, fields: string[], reason: string): Promise<void> {
    console.error(`事件 ${entryId} 送死信: ${reason}`);
    await this.cfg.redis.xadd(`${this.cfg.stream}_dlq`, "*", ...fields, "origin_id", entryId, "reason", reason);
    await this.cfg.redis.xack(this.cfg.stream, this.cfg.group, entryId);
  }
}
