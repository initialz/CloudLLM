export interface GatewayConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** 32 字节 base64,信封加密主密钥 */
  masterKey: string;
  balanceTtlSeconds: number;
  cooldownSeconds: number;
  catalogTtlMs: number;
  usageStream: string;
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`缺少环境变量 ${name}`);
    return v;
  };
  const masterKey = required("MASTER_KEY");
  if (Buffer.from(masterKey, "base64").length !== 32) {
    throw new Error("MASTER_KEY 必须是 32 字节的 base64");
  }
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    masterKey,
    balanceTtlSeconds: Number(env.BALANCE_TTL_SECONDS ?? 60),
    cooldownSeconds: Number(env.COOLDOWN_SECONDS ?? 30),
    catalogTtlMs: Number(env.CATALOG_TTL_MS ?? 30000),
    usageStream: env.USAGE_STREAM ?? "usage_events",
  };
}
