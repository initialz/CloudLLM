import type { AuthedKey, BalanceStore, BudgetLoader, BudgetSubject } from "./types.js";

/** 预算上卷路径:Key 自身 → 归属主体 → (app 时)所属团队 */
export function subjectsForKey(key: AuthedKey): BudgetSubject[] {
  const subjects: BudgetSubject[] = [
    { type: "key", id: key.id },
    { type: key.ownerType, id: key.ownerId },
  ];
  if (key.ownerType === "app" && key.teamId) {
    subjects.push({ type: "team", id: key.teamId });
  }
  return subjects;
}

export type BudgetCheck = { ok: true } | { ok: false; exhausted: BudgetSubject };

/** 准实时截断:读缓存余额,未命中回源 PG 并回填;任一层 ≤0 拒绝 */
export async function checkBudgets(
  store: BalanceStore,
  loader: BudgetLoader,
  subjects: BudgetSubject[],
  ttlSeconds: number,
): Promise<BudgetCheck> {
  const cached = await store.getMany(subjects);
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i]!;
    let value = cached[i] ?? null;
    if (value === null) {
      const loaded = await loader.loadRemainingMicro(subject);
      value = loaded === null ? "unlimited" : loaded;
      // 注意:load→set 间有并发 decrBy 被覆盖的窗口,最多 1 个 TTL 内自愈;
      // 规格 §4.4 接受少量超透,PG 台账为事实源,worker 落库时校正
      await store.set(subject, value, ttlSeconds);
    }
    if (value !== "unlimited" && value <= 0n) {
      return { ok: false, exhausted: subject };
    }
  }
  return { ok: true };
}

/** 请求结束后异步扣减(近似值,PG 台账为准) */
export async function settleBudgets(
  store: BalanceStore,
  subjects: BudgetSubject[],
  costMicro: bigint,
): Promise<void> {
  if (costMicro < 0n) {
    throw new Error(`结算金额不能为负: ${costMicro}`);
  }
  if (costMicro > 0n) {
    await store.decrBy(subjects, costMicro);
  }
}
