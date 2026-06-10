/** Gateway 与 Worker 共用的 Redis 键约定 */
export type BudgetSubjectType = "user" | "team" | "app" | "key";

export interface BudgetSubject {
  type: BudgetSubjectType;
  id: string;
}

/** 余额热缓存键;值=剩余 micro-CNY 整数字符串,或 UNLIMITED_SENTINEL */
export const balKey = (s: BudgetSubject): string => `bal:${s.type}:${s.id}`;

/** 无预算(不限)哨兵值 */
export const UNLIMITED_SENTINEL = "u";

/** 渠道冷却键(存在即冷却,EX 控制时长) */
export const cooldownKey = (channelId: string): string => `cooldown:${channelId}`;

export const DEFAULT_USAGE_STREAM = "usage_events";
