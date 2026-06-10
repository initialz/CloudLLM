import { describe, expect, it } from "vitest";
import { checkBudgets, settleBudgets, subjectsForKey } from "./budget.js";
import type { AuthedKey, BalanceStore, BudgetLoader, BudgetSubject } from "./types.js";

class FakeStore implements BalanceStore {
  data = new Map<string, bigint | "unlimited">();
  decrCalls: Array<{ subjects: BudgetSubject[]; micro: bigint }> = [];
  private k(s: BudgetSubject) {
    return `${s.type}:${s.id}`;
  }
  async getMany(subjects: BudgetSubject[]) {
    return subjects.map((s) => this.data.get(this.k(s)) ?? null);
  }
  async set(s: BudgetSubject, v: bigint | "unlimited") {
    this.data.set(this.k(s), v);
  }
  async decrBy(subjects: BudgetSubject[], micro: bigint) {
    this.decrCalls.push({ subjects, micro });
    for (const s of subjects) {
      const cur = this.data.get(this.k(s));
      if (typeof cur === "bigint") this.data.set(this.k(s), cur - micro);
    }
  }
}

const loaderOf = (map: Record<string, bigint | null>): BudgetLoader => ({
  async loadRemainingMicro(s) {
    return map[`${s.type}:${s.id}`] ?? null;
  },
});

const appKey: AuthedKey = {
  id: "k1", ownerType: "app", ownerId: "a1", teamId: "t1",
  allowedModels: null, auditEnabled: false,
};

describe("subjectsForKey", () => {
  it("app Key 产生 key/app/team 三层", () => {
    expect(subjectsForKey(appKey)).toEqual([
      { type: "key", id: "k1" },
      { type: "app", id: "a1" },
      { type: "team", id: "t1" },
    ]);
  });

  it("个人 Key 产生 key/user 两层", () => {
    expect(
      subjectsForKey({ ...appKey, ownerType: "user", ownerId: "u1", teamId: null }),
    ).toEqual([
      { type: "key", id: "k1" },
      { type: "user", id: "u1" },
    ]);
  });
});

describe("checkBudgets", () => {
  it("缓存未命中时从 loader 回填并缓存", async () => {
    const store = new FakeStore();
    const subjects = subjectsForKey(appKey);
    const r = await checkBudgets(store, loaderOf({ "key:k1": 100n, "app:a1": null, "team:t1": 50n }), subjects, 60);
    expect(r).toEqual({ ok: true });
    expect(store.data.get("app:a1")).toBe("unlimited");
    expect(store.data.get("team:t1")).toBe(50n);
  });

  it("任一层余额 ≤0 即拒绝并指出主体", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", 100n);
    store.data.set("app:a1", 0n);
    const r = await checkBudgets(store, loaderOf({}), subjectsForKey(appKey), 60);
    expect(r).toEqual({ ok: false, exhausted: { type: "app", id: "a1" } });
  });

  it("负余额(已超透)同样拒绝", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", -5n);
    const r = await checkBudgets(store, loaderOf({}), [{ type: "key", id: "k1" }], 60);
    expect(r.ok).toBe(false);
  });

  it("无预算主体(unlimited)放行", async () => {
    const store = new FakeStore();
    const r = await checkBudgets(store, loaderOf({}), [{ type: "key", id: "k1" }], 60);
    expect(r).toEqual({ ok: true });
  });
});

describe("settleBudgets", () => {
  it("成本为 0 时不扣减", async () => {
    const store = new FakeStore();
    await settleBudgets(store, [{ type: "key", id: "k1" }], 0n);
    expect(store.decrCalls).toHaveLength(0);
  });

  it("正成本对全部层扣减", async () => {
    const store = new FakeStore();
    store.data.set("key:k1", 100n);
    await settleBudgets(store, subjectsForKey(appKey), 30n);
    expect(store.decrCalls).toHaveLength(1);
    expect(store.data.get("key:k1")).toBe(70n);
  });
});
