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
});
// 注:RedisEventSink 内部以 MAXLEN ~ 500000 近似裁剪流,防 worker 滞后时无界增长

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`gateway 监听 :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal},优雅停机…`);
    server.close(async () => {
      await redis.quit();
      await sql.end();
      process.exit(0);
    });
  });
}
