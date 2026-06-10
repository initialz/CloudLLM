/** 网关→worker 的用量事件契约。经 Redis Stream 传输:XADD <stream> * payload <JSON.stringify(UsageEvent)> */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type UsageEventStatus = "ok" | "upstream_error" | "rejected";

export interface UsageEvent {
  keyId: string;
  modelSlug: string;
  channelId: string | null;
  usage: UsageTotals;
  /** 6 位小数 CNY 字符串(computeCostCny 输出) */
  costCny: string;
  latencyMs: number;
  /** 到上游响应头的耗时(毫秒,严格说是 TTFB 而非首 token) */
  ttftMs: number | null;
  status: UsageEventStatus;
  errorCode: string | null;
  /** ISO 时间戳 */
  ts: string;
  /** 仅 auditEnabled 的 Key 携带 */
  audit?: { requestBody: unknown; responseBody: unknown };
}
