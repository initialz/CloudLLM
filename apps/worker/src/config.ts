import { hostname } from "node:os";
import { DEFAULT_USAGE_STREAM } from "@cloudllm/shared";

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  usageStream: string;
  group: string;
  consumer: string;
  auditRetentionDays: number;
  jobIntervalMs: number;
  maxDeliveries: number;
  balanceTtlSeconds: number;
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
  };
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`环境变量 ${name} 必须是有效数字,得到: "${raw}"`);
    return v;
  };
  const positive = (name: string, v: number): number => {
    if (v <= 0) throw new Error(`环境变量 ${name} 必须为正数,得到: ${v}`);
    return v;
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    usageStream: env.USAGE_STREAM ?? DEFAULT_USAGE_STREAM,
    group: env.USAGE_GROUP ?? "console-worker",
    consumer: env.WORKER_CONSUMER ?? `${hostname()}-${process.pid}`,
    auditRetentionDays: positive("AUDIT_RETENTION_DAYS", num("AUDIT_RETENTION_DAYS", 30)),
    jobIntervalMs: positive("JOB_INTERVAL_MS", num("JOB_INTERVAL_MS", 3_600_000)),
    maxDeliveries: positive("MAX_DELIVERIES", num("MAX_DELIVERIES", 5)),
    balanceTtlSeconds: positive("BALANCE_TTL_SECONDS", num("BALANCE_TTL_SECONDS", 60)),
  };
}
