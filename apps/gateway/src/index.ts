import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createDb } from "@byok/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DrizzleBudgetLoader, DrizzleCatalogRepo, DrizzleKeyRepo } from "./db-access.js";
import { RedisBalanceStore, RedisCooldownStore, RedisEventSink } from "./redis-stores.js";

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);

// C1: 停机排水 — 收集所有在途结算 promise
const pendingSettlements = new Set<Promise<void>>();

const app = createApp({
  masterKey: config.masterKey,
  balanceTtlSeconds: config.balanceTtlSeconds,
  cooldownSeconds: config.cooldownSeconds,
  catalogTtlMs: config.catalogTtlMs,
  keyRepo: new DrizzleKeyRepo(db),
  catalog: new DrizzleCatalogRepo(db),
  loader: new DrizzleBudgetLoader(db),
  balance: new RedisBalanceStore(redis, config.balanceTtlSeconds),
  cooldown: new RedisCooldownStore(redis),
  events: new RedisEventSink(redis, config.usageStream),
  pendingSettlements,
});
// 注:RedisEventSink 内部以 MAXLEN ~ 500000 近似裁剪流,防 worker 滞后时无界增长

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`gateway 监听 :${info.port}`);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return; // m5: 防双信号重复 close
    closing = true;
    console.log(`收到 ${signal},优雅停机…`);
    // 硬超时 25s(< K8s 默认 30s 宽限期):防挂死的长流阻塞 close 导致 SIGKILL 丢全部在途结算
    const deadline = setTimeout(() => {
      console.error("停机排水超时,强制退出");
      process.exit(1);
    }, 25_000);
    server.close(async () => {
      await Promise.allSettled([...pendingSettlements]);
      clearTimeout(deadline);
      await redis.quit();
      await sql.end();
      process.exit(0);
    });
  });
}
