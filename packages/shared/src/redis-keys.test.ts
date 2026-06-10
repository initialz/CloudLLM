import { describe, expect, it } from "vitest";
import { UNLIMITED_SENTINEL, balKey, cooldownKey } from "./redis-keys.js";

describe("redis-keys", () => {
  it("键格式与 P2 网关既有格式逐字一致", () => {
    expect(balKey({ type: "key", id: "k1" })).toBe("bal:key:k1");
    expect(balKey({ type: "team", id: "t1" })).toBe("bal:team:t1");
    expect(cooldownKey("c1")).toBe("cooldown:c1");
    expect(UNLIMITED_SENTINEL).toBe("u");
  });
});
