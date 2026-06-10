const MICRO = 1_000_000n;

/** "12.345678"/"-1.5" → micro-CNY bigint。最多 6 位小数,支持负号(台账冲正读回)。 */
export function cnyToMicro(cny: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(cny.trim());
  if (!m) throw new Error(`非法 CNY 金额: ${cny}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? "").padEnd(6, "0") || "0");
  const abs = whole * MICRO + frac;
  return m[1] ? -abs : abs;
}

/** 12345678n → "12.345678";支持负数(如台账冲正):-1500000n → "-1.500000" */
export function microToCny(micro: bigint): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, "0");
  return `${sign}${whole}.${frac}`;
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

/** tokens × price/MTok,micro 级向上取整(四条线独立进位,合计最多多记 4 micro,宁多记不少记) */
function lineCostMicro(tokens: number, pricePerMTok: string): bigint {
  if (tokens === 0) return 0n;
  const priceMicro = cnyToMicro(pricePerMTok);
  const numerator = BigInt(tokens) * priceMicro;
  return (numerator + MICRO - 1n) / MICRO; // ceil div
}

export function computeCostCny(usage: TokenUsage, prices: ModelPrices): string {
  for (const [k, v] of Object.entries(usage)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`token 数 ${k}=${v} 必须是非负整数`);
    }
  }
  const total =
    lineCostMicro(usage.inputTokens, prices.inputPerMTok) +
    lineCostMicro(usage.outputTokens, prices.outputPerMTok) +
    lineCostMicro(usage.cacheReadTokens, prices.cacheReadPerMTok) +
    lineCostMicro(usage.cacheWriteTokens, prices.cacheWritePerMTok);
  if (total > 999_999_999_999_000_000n) {
    throw new Error(`成本超出 numeric(18,6) 可表示范围: ${total} micro`);
  }
  return microToCny(total);
}
