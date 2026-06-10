import type { BudgetSubject, UsageEvent, UsageTotals } from "@byok/shared";

export type { BudgetSubject, UsageEvent, UsageTotals } from "@byok/shared";

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
  /** 该模型的 active 渠道映射(实现方必须过滤非 active 渠道;cooldown 过滤由 router 处理) */
  getChannelsForModel(slug: string): Promise<ChannelChoice[]>;
}

export interface BudgetLoader {
  /** 剩余 micro-CNY;null = 该主体没有预算(无限),对应 BalanceStore 的 "unlimited" 哨兵 */
  loadRemainingMicro(subject: BudgetSubject): Promise<bigint | null>;
}
