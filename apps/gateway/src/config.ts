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
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      throw new Error(`环境变量 ${name} 必须是有效数字,得到: "${raw}"`);
    }
    return v;
  };
  const masterKey = required("MASTER_KEY");
  if (Buffer.from(masterKey, "base64").length !== 32) {
    throw new Error("MASTER_KEY 必须是 32 字节的 base64");
  }
  return {
    port: num("PORT", 8080),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    masterKey,
    balanceTtlSeconds: num("BALANCE_TTL_SECONDS", 60),
    cooldownSeconds: num("COOLDOWN_SECONDS", 30),
    catalogTtlMs: num("CATALOG_TTL_MS", 30000),
    usageStream: env.USAGE_STREAM ?? "usage_events",
  };
}
