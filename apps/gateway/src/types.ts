export type Protocol = "openai" | "anthropic";

export interface AuthedKey {
  id: string;
  ownerType: "user" | "team" | "app";
  ownerId: string;
  /** owner 为 app 时为其所属团队 id,否则 null */
  teamId: string | null;
  /** null = 不限模型 */
  allowedModels: string[] | null;
  auditEnabled: boolean;
}

export interface BudgetSubject {
  type: "user" | "team" | "app" | "key";
  id: string;
}

export interface ModelInfo {
  slug: string;
  providerType: Protocol;
  prices: {
    inputPerMTok: string;
    outputPerMTok: string;
    cacheReadPerMTok: string;
    cacheWritePerMTok: string;
  };
}

export interface ChannelChoice {
  channelId: string;
  baseUrl: string;
  credentialEncrypted: string;
  upstreamModelId: string;
  priority: number;
  weight: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageEvent {
  keyId: string;
  modelSlug: string;
  channelId: string | null;
  usage: UsageTotals;
  costCny: string;
  latencyMs: number;
  ttftMs: number | null;
  status: "ok" | "upstream_error" | "rejected";
  errorCode: string | null;
  /** ISO 时间戳 */
  ts: string;
  /** 仅 auditEnabled 的 Key 携带 */
  audit?: { requestBody: unknown; responseBody: unknown };
}

// ── 端口(实现见 redis-stores.ts / db-access.ts,单测用 fake)──

export interface BalanceStore {
  /** 与 subjects 一一对应;null=未缓存,"unlimited"=无预算 */
  getMany(subjects: BudgetSubject[]): Promise<(bigint | "unlimited" | null)[]>;
  set(subject: BudgetSubject, value: bigint | "unlimited", ttlSeconds: number): Promise<void>;
  decrBy(subjects: BudgetSubject[], micro: bigint): Promise<void>;
}

export interface CooldownStore {
  isCooling(channelId: string): Promise<boolean>;
  markCooldown(channelId: string, seconds: number): Promise<void>;
}

export interface EventSink {
  emit(event: UsageEvent): Promise<void>;
}

export interface KeyRepo {
  /** 只返回 active 且未过期的 Key,否则 null */
  findActiveByHash(keyHash: string): Promise<AuthedKey | null>;
}

export interface CatalogRepo {
  getModel(slug: string): Promise<ModelInfo | null>;
  /** 该模型的 active 渠道映射(不含 cooldown 过滤,由 router 处理) */
  getChannelsForModel(slug: string): Promise<ChannelChoice[]>;
}

export interface BudgetLoader {
  /** 剩余 micro-CNY;null = 该主体没有预算(不限) */
  loadRemainingMicro(subject: BudgetSubject): Promise<bigint | null>;
}
