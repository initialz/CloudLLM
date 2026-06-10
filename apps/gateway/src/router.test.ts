import { describe, expect, it } from "vitest";
import { selectCandidates } from "./router.js";
import type { CatalogRepo, ChannelChoice, CooldownStore } from "./types.js";

const ch = (id: string, priority: number, weight: number): ChannelChoice => ({
  channelId: id,
  baseUrl: `https://up.example/${id}`,
  credentialEncrypted: "{}",
  upstreamModelId: "real-model",
  priority,
  weight,
});

const catalogOf = (list: ChannelChoice[]): CatalogRepo => ({
  async getModel() {
    return null;
  },
  async getChannelsForModel() {
    return list;
  },
});

const cooldownOf = (cooling: string[]): CooldownStore => ({
  async isCooling(id) {
    return cooling.includes(id);
  },
  async markCooldown() {},
});

describe("selectCandidates", () => {
  it("按 priority 升序分组,组内全员保留", async () => {
    const r = await selectCandidates(
      catalogOf([ch("b", 1, 1), ch("a", 0, 1), ch("c", 1, 1)]),
      cooldownOf([]),
      "m",
      () => 0.5,
    );
    expect(r[0]!.channelId).toBe("a");
    expect(r.map((c) => c.channelId).sort()).toEqual(["a", "b", "c"]);
  });

  it("过滤 cooldown 中的渠道", async () => {
    const r = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 1)]),
      cooldownOf(["a"]),
      "m",
      () => 0.5,
    );
    expect(r.map((c) => c.channelId)).toEqual(["b"]);
  });

  it("权重影响组内排序:rng 偏小时选中第一个累计区间", async () => {
    // weight a=1, b=3;rng=0.1 → 0.1*4=0.4 落在 a 的区间(a 在前)
    const r = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 3)]),
      cooldownOf([]),
      "m",
      () => 0.1,
    );
    expect(r[0]!.channelId).toBe("a");
    // rng=0.9 → 0.9*4=3.6 落在 b 区间
    const r2 = await selectCandidates(
      catalogOf([ch("a", 0, 1), ch("b", 0, 3)]),
      cooldownOf([]),
      "m",
      () => 0.9,
    );
    expect(r2[0]!.channelId).toBe("b");
  });

  it("无可用渠道返回空数组", async () => {
    const r = await selectCandidates(catalogOf([]), cooldownOf([]), "m");
    expect(r).toEqual([]);
  });
});
