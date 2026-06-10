import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("TTL 内命中缓存,不再调 loader", async () => {
    let now = 0;
    let calls = 0;
    const cache = new TtlCache<string>(1000, () => now);
    expect(await cache.get("k", async () => { calls++; return "v1"; })).toBe("v1");
    expect(await cache.get("k", async () => { calls++; return "v2"; })).toBe("v1");
    expect(calls).toBe(1);
  });

  it("过期后重新加载", async () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    await cache.get("k", async () => "v1");
    now = 1001;
    expect(await cache.get("k", async () => "v2")).toBe("v2");
  });

  it("getNullable: loader 返回 null 时不缓存,第二次仍调 loader", async () => {
    let calls = 0;
    const cache = new TtlCache<string>(1000);
    const result1 = await cache.getNullable("k", async () => { calls++; return null; });
    const result2 = await cache.getNullable("k", async () => { calls++; return null; });
    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(calls).toBe(2);
  });

  it("getNullable: loader 返回非 null 时缓存,第二次不调 loader", async () => {
    let calls = 0;
    const cache = new TtlCache<string>(1000);
    const result1 = await cache.getNullable("k", async () => { calls++; return "v1"; });
    const result2 = await cache.getNullable("k", async () => { calls++; return "v2"; });
    expect(result1).toBe("v1");
    expect(result2).toBe("v1");
    expect(calls).toBe(1);
  });
});
