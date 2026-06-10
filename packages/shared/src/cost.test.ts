import { describe, expect, it } from "vitest";
import { cnyToMicro, computeCostCny, microToCny } from "./cost.js";

describe("cnyToMicro / microToCny", () => {
  it("互为逆运算,支持 6 位小数", () => {
    expect(cnyToMicro("12.345678")).toBe(12_345_678n);
    expect(microToCny(12_345_678n)).toBe("12.345678");
    expect(cnyToMicro("0")).toBe(0n);
    expect(microToCny(0n)).toBe("0.000000");
  });

  it("拒绝超过 6 位小数或非法格式", () => {
    expect(() => cnyToMicro("1.2345678")).toThrow();
    expect(() => cnyToMicro("abc")).toThrow();
  });
});

describe("computeCostCny", () => {
  // 价格:输入 21.0 元/百万 tok,输出 105.0 元/百万 tok,
  // 缓存读 2.1,缓存写 26.25(对应 Claude 系常见比例,仅作测试值)
  const prices = {
    inputPerMTok: "21",
    outputPerMTok: "105",
    cacheReadPerMTok: "2.1",
    cacheWritePerMTok: "26.25",
  };

  it("按四类 token 分别计价求和", () => {
    const cost = computeCostCny(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices,
    );
    // 1000/1e6*21 = 0.021;500/1e6*105 = 0.0525 → 0.0735
    expect(cost).toBe("0.073500");
  });

  it("含缓存 token", () => {
    const cost = computeCostCny(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100000, cacheWriteTokens: 10000 },
      prices,
    );
    // 0.1*2.1 = 0.21;0.01*26.25 = 0.2625 → 0.4725
    expect(cost).toBe("0.472500");
  });

  it("不能整除时向上取整到 micro", () => {
    // 1 token × 0.5 元/MTok = 0.5 micro → 进位为 1 micro
    const cost = computeCostCny(
      { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputPerMTok: "0.5", outputPerMTok: "0", cacheReadPerMTok: "0", cacheWritePerMTok: "0" },
    );
    expect(cost).toBe("0.000001");
  });

  it("全零返回 0.000000", () => {
    const cost = computeCostCny(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      prices,
    );
    expect(cost).toBe("0.000000");
  });
});
