const MICRO = 1_000_000n;

/** "12.345678" → 12345678n(micro-CNY)。最多 6 位小数。 */
export function cnyToMicro(cny: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(cny.trim());
  if (!m) throw new Error(`非法 CNY 金额: ${cny}`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return whole * MICRO + frac;
}

/** 12345678n → "12.345678" */
export function microToCny(micro: bigint): string {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 单价:每百万 token 的 CNY(numeric 字符串) */
export interface ModelPrices {
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok: string;
  cacheWritePerMTok: string;
}

/** tokens × price/MTok,micro 级向上取整 */
function lineCostMicro(tokens: number, pricePerMTok: string): bigint {
  if (tokens === 0) return 0n;
  const priceMicro = cnyToMicro(pricePerMTok);
  const numerator = BigInt(tokens) * priceMicro;
  return (numerator + MICRO - 1n) / MICRO; // ceil div
}

export function computeCostCny(usage: TokenUsage, prices: ModelPrices): string {
  const total =
    lineCostMicro(usage.inputTokens, prices.inputPerMTok) +
    lineCostMicro(usage.outputTokens, prices.outputPerMTok) +
    lineCostMicro(usage.cacheReadTokens, prices.cacheReadPerMTok) +
    lineCostMicro(usage.cacheWriteTokens, prices.cacheWritePerMTok);
  return microToCny(total);
}
