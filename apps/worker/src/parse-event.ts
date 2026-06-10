import type { UsageEvent } from "@byok/shared";

const STATUSES = new Set(["ok", "upstream_error", "rejected"]);

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 解析并校验事件 JSON;非法返回 null(调用方负责送死信) */
export function parseUsageEvent(payload: string): UsageEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const u = e.usage as Record<string, unknown> | undefined;
  if (
    typeof e.keyId !== "string" ||
    typeof e.modelSlug !== "string" ||
    !(e.channelId === null || typeof e.channelId === "string") ||
    !u ||
    !isNum(u.inputTokens) || !isNum(u.outputTokens) ||
    !isNum(u.cacheReadTokens) || !isNum(u.cacheWriteTokens) ||
    typeof e.costCny !== "string" ||
    !isNum(e.latencyMs) ||
    !(e.ttftMs === null || isNum(e.ttftMs)) ||
    typeof e.status !== "string" || !STATUSES.has(e.status) ||
    !(e.errorCode === null || typeof e.errorCode === "string") ||
    typeof e.ts !== "string"
  ) {
    return null;
  }
  return raw as UsageEvent;
}
