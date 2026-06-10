import { Redis } from "ioredis";
import { createDb } from "@byok/db";
import { loadWorkerConfig } from "./config.js";
import { UsageConsumer } from "./consumer.js";
import { cleanupExpiredAuditLogs, resetRolledOverMonthlyBudgets } from "./jobs.js";
import { parseUsageEvent } from "./parse-event.js";
import { processEvent } from "./process-event.js";

const config = loadWorkerConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 5 });
const redis = new Redis(config.redisUrl);

const consumer = new UsageConsumer(
  {
    redis,
    stream: config.usageStream,
    group: config.group,
    consumer: config.consumer,
    maxDeliveries: config.maxDeliveries,
  },
  async (payload, entryId) => {
    const event = parseUsageEvent(payload);
    if (!event) return "dead"; // 畸形事件:死信,不无限重试
    await processEvent(
      db,
      (key, value, ttl) => redis.set(key, value, "EX", ttl).then(() => undefined),
      event,
      entryId,
      { auditRetentionDays: config.auditRetentionDays, balanceTtlSeconds: config.balanceTtlSeconds },
    );
    return "ok";
  },
);

let running = true;

async function main(): Promise<void> {
  await consumer.ensureGroup();
  console.log(`worker 启动:stream=${config.usageStream} group=${config.group} consumer=${config.consumer}`);

  const runJobs = async () => {
    try {
      const resets = await resetRolledOverMonthlyBudgets(db);
      const cleaned = await cleanupExpiredAuditLogs(db);
      if (resets || cleaned) console.log(`jobs:月度重置 ${resets} 条,审计清理 ${cleaned} 条`);
    } catch (err) {
      console.error("定时任务失败", err);
    }
  };
  await runJobs();
  const jobTimer = setInterval(runJobs, config.jobIntervalMs);

  // 启动先认领历史滞留,之后每轮顺带认领
  while (running) {
    try {
      await consumer.claimStale(60_000);
      await consumer.consumeOnce(5_000);
    } catch (err) {
      console.error("消费循环异常,3s 后重试", err);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  clearInterval(jobTimer);
  await redis.quit();
  await sql.end();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal},处理完当前批次后退出…`);
    running = false;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
