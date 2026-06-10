import type { Protocol, UsageTotals } from "./types.js";

const zero = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 非流式响应体提取用量。OpenAI 的 prompt_tokens 含缓存命中,拆分计价。 */
export function extractUsageFromJson(protocol: Protocol, body: unknown): UsageTotals {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") return zero();
  const u = usage as Record<string, unknown>;
  if (protocol === "openai") {
    const prompt = num(u.prompt_tokens);
    const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
    const cached = num(details?.cached_tokens);
    return {
      inputTokens: Math.max(prompt - cached, 0),
      outputTokens: num(u.completion_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/** SSE 流用量收集器:把已解码文本喂给 push(),流结束后 totals() 取结果。容忍跨 chunk 断行。 */
export class SseUsageTap {
  private buffer = "";
  private usage: UsageTotals = zero();

  constructor(private protocol: Protocol) {}

  push(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        this.consume(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // 非 JSON 行(或被进一步拆分的行)直接忽略,不影响透传
      }
    }
  }

  totals(): UsageTotals {
    return this.usage;
  }

  private consume(evt: Record<string, unknown>): void {
    if (this.protocol === "openai") {
      if (evt.usage && typeof evt.usage === "object") {
        this.usage = extractUsageFromJson("openai", evt);
      }
      return;
    }
    if (evt.type === "message_start") {
      const msg = (evt.message ?? null) as Record<string, unknown> | null;
      const partial = extractUsageFromJson("anthropic", msg);
      this.usage = { ...partial, outputTokens: this.usage.outputTokens };
    } else if (evt.type === "message_delta") {
      const u = (evt.usage ?? {}) as Record<string, unknown>;
      if (typeof u.output_tokens === "number") {
        this.usage.outputTokens = u.output_tokens;
      }
    }
  }
}
