import { decryptSecret } from "@byok/shared";
import type { ChannelChoice, CooldownStore, Protocol, UsageTotals } from "./types.js";
import { SseUsageTap, extractUsageFromJson } from "./usage.js";

export interface ForwardOk {
  ok: true;
  channel: ChannelChoice;
  status: number;
  headers: Headers;
  /** 回给调用方的 body(流式为 tap 过的流,非流式为原文文本) */
  body: ReadableStream<Uint8Array> | string;
  /** 流结束(或立即)解析到的用量 */
  usagePromise: Promise<UsageTotals>;
  ttftMs: number;
  /** 非流式时的响应 JSON(审计用);流式为 null */
  responseJson: unknown | null;
}

export interface ForwardErr {
  ok: false;
  code: "no_channel" | "upstream_failed";
  lastStatus: number | null;
}

export interface ForwardOptions {
  candidates: ChannelChoice[];
  protocol: Protocol;
  /** 已解析的请求体(model 为对外 slug,转发时替换) */
  requestBody: Record<string, unknown>;
  masterKey: string;
  cooldown: CooldownStore;
  cooldownSeconds: number;
  /** 调用方传来的 anthropic-version 头(仅 anthropic 协议) */
  anthropicVersion?: string;
  /** 调用方 anthropic-beta 头按白名单透传(仅 anthropic 协议) */
  anthropicBeta?: string;
  fetchImpl?: typeof fetch;
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
// 401/403 表示渠道凭证失效(调用方早已通过网关鉴权),按渠道故障处理——冷却+切换,而非把上游的鉴权错误透传给调用方
const isRetryable = (status: number) =>
  status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;

export async function forwardWithFailover(opts: ForwardOptions): Promise<ForwardOk | ForwardErr> {
  const fetchFn = opts.fetchImpl ?? fetch;
  if (opts.candidates.length === 0) {
    return { ok: false, code: "no_channel", lastStatus: null };
  }

  const isStream = opts.requestBody.stream === true;
  let lastStatus: number | null = null;

  for (const channel of opts.candidates) {
    const body: Record<string, unknown> = { ...opts.requestBody, model: channel.upstreamModelId };
    if (opts.protocol === "openai" && isStream) {
      // 计量必需:强制合并 include_usage(客户端自带 stream_options 也不能关掉,否则整条流零计费)
      body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    }

    let credential: string;
    try {
      credential = decryptSecret(channel.credentialEncrypted, opts.masterKey, channel.channelId);
    } catch (err) {
      console.error(`渠道 ${channel.channelId} 凭证解密失败(疑似主密钥轮换/数据损坏)`);
      await opts.cooldown.markCooldown(channel.channelId, opts.cooldownSeconds);
      continue;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.protocol === "openai") {
      headers.authorization = `Bearer ${credential}`;
    } else {
      headers["x-api-key"] = credential;
      headers["anthropic-version"] = opts.anthropicVersion ?? "2023-06-01";
      if (opts.anthropicBeta) headers["anthropic-beta"] = opts.anthropicBeta;
    }
    const base = channel.baseUrl.replace(/\/$/, "");
    const url = opts.protocol === "openai" ? `${base}/chat/completions` : `${base}/messages`;

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      console.error(`渠道 ${channel.channelId} 请求失败: ${(err as Error)?.message}`);
      await opts.cooldown.markCooldown(channel.channelId, opts.cooldownSeconds);
      continue;
    }

    if (isRetryable(res.status)) {
      lastStatus = res.status;
      void res.body?.cancel().catch(() => {});
      await opts.cooldown.markCooldown(channel.channelId, opts.cooldownSeconds);
      continue;
    }
    const ttftMs = Date.now() - startedAt;

    if (!res.ok) {
      // 不可重试的 4xx:原样透传调用方错误,不冷却渠道,不计费
      const text = await res.text();
      return {
        ok: true, channel, status: res.status, headers: res.headers, body: text,
        usagePromise: Promise.resolve(ZERO), ttftMs, responseJson: safeParse(text),
      };
    }

    if (!isStream) {
      const text = await res.text();
      const json = safeParse(text);
      return {
        ok: true, channel, status: res.status, headers: res.headers, body: text,
        usagePromise: Promise.resolve(extractUsageFromJson(opts.protocol, json)),
        ttftMs, responseJson: json,
      };
    }

    // 流式:tee——原样透传字节,同时旁路喂给 usage tap
    const tap = new SseUsageTap(opts.protocol);
    const decoder = new TextDecoder();
    let resolveUsage!: (u: UsageTotals) => void;
    const usagePromise = new Promise<UsageTotals>((resolve) => {
      resolveUsage = resolve;
    });
    // flush=正常收尾;cancel=客户端断开/上游中断——两条路径都要用已解析的部分用量结算,
    // 否则 usagePromise 永不 resolve,该请求零计费且无事件(代理最常见的异常结束方式)
    const settle = () => {
      tap.push(decoder.decode());
      resolveUsage(tap.totals());
    };
    const tapped = res.body!.pipeThrough(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
          tap.push(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush: settle,
        cancel: settle,
      } as any),
    );
    return {
      ok: true, channel, status: res.status, headers: res.headers, body: tapped,
      usagePromise, ttftMs, responseJson: null,
    };
  }

  return { ok: false, code: "upstream_failed", lastStatus };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
