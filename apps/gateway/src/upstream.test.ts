import { randomBytes } from "node:crypto";
import { encryptSecret } from "@cloudllm/shared";
import { describe, expect, it } from "vitest";
import { forwardWithFailover } from "./upstream.js";
import type { ChannelChoice, CooldownStore } from "./types.js";

const master = randomBytes(32).toString("base64");

const chan = (id: string): ChannelChoice => ({
  channelId: id,
  baseUrl: `https://up.example/${id}/v1`,
  credentialEncrypted: encryptSecret(`real-key-${id}`, master, id),
  upstreamModelId: "real-model",
  priority: 0,
  weight: 1,
});

class FakeCooldown implements CooldownStore {
  marked: string[] = [];
  async isCooling() {
    return false;
  }
  async markCooldown(id: string) {
    this.marked.push(id);
  }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("forwardWithFailover", () => {
  it("非流式:注入凭证、替换 model、提取用量", async () => {
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "openai",
      requestBody: { model: "openai/gpt-test", messages: [] },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: new Headers(init!.headers).get("authorization"),
          body: JSON.parse(String(init!.body)),
        });
        return jsonResponse(200, { usage: { prompt_tokens: 10, completion_tokens: 5 } });
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen[0]!.url).toBe("https://up.example/c1/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer real-key-c1");
    expect(seen[0]!.body.model).toBe("real-model");
    expect(await r.usagePromise).toEqual({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("anthropic:x-api-key 与 anthropic-version 头", async () => {
    let headers: Headers | null = null;
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "anthropic",
      requestBody: { model: "anthropic/claude-test", messages: [], max_tokens: 8 },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      anthropicVersion: "2024-01-01",
      fetchImpl: async (url, init) => {
        headers = new Headers(init!.headers);
        expect(String(url)).toBe("https://up.example/c1/v1/messages");
        return jsonResponse(200, { usage: { input_tokens: 3, output_tokens: 4 } });
      },
    });
    expect(r.ok).toBe(true);
    expect(headers!.get("x-api-key")).toBe("real-key-c1");
    expect(headers!.get("anthropic-version")).toBe("2024-01-01");
  });

  it("5xx/网络错误冷却并切换下一渠道;全失败返回 upstream_failed", async () => {
    const cooldown = new FakeCooldown();
    let calls = 0;
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2"), chan("c3")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(500, {});
        if (calls === 2) throw new Error("ECONNREFUSED");
        return jsonResponse(503, {});
      },
    });
    expect(r).toMatchObject({ ok: false, code: "upstream_failed", lastStatus: 503 });
    expect(cooldown.marked).toEqual(["c1", "c2", "c3"]);
  });

  it("失败后第二渠道成功", async () => {
    const cooldown = new FakeCooldown();
    let calls = 0;
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(429, {});
        return jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel.channelId).toBe("c2");
    expect(cooldown.marked).toEqual(["c1"]);
  });

  it("不可重试的 4xx 原样返回给调用方,不冷却", async () => {
    const cooldown = new FakeCooldown();
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2")],
      protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master,
      cooldown,
      cooldownSeconds: 30,
      fetchImpl: async () => jsonResponse(400, { error: { message: "bad request" } }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(400);
    expect(cooldown.marked).toEqual([]);
  });

  it("流式:原样透传字节,旁路解析 usage,注入 include_usage", async () => {
    let sentBody: Record<string, unknown> = {};
    const r = await forwardWithFailover({
      candidates: [chan("c1")],
      protocol: "openai",
      requestBody: { model: "m", messages: [], stream: true },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String(init!.body));
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":6,"completion_tokens":2},"choices":[]}\n\n',
          "data: [DONE]\n\n",
        ]);
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    const text = await new Response(r.body as ReadableStream<Uint8Array>).text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain("[DONE]");
    expect(await r.usagePromise).toEqual({
      inputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  it("空候选返回 no_channel", async () => {
    const r = await forwardWithFailover({
      candidates: [],
      protocol: "openai",
      requestBody: { model: "m" },
      masterKey: master,
      cooldown: new FakeCooldown(),
      cooldownSeconds: 30,
      fetchImpl: async () => jsonResponse(200, {}),
    });
    expect(r).toMatchObject({ ok: false, code: "no_channel" });
  });

  it("客户端中途取消流:usagePromise 仍以已解析的部分用量结算", async () => {
    const r = await forwardWithFailover({
      candidates: [chan("c1")], protocol: "anthropic",
      requestBody: { model: "m", messages: [], stream: true },
      masterKey: master, cooldown: new FakeCooldown(), cooldownSeconds: 30,
      fetchImpl: async () =>
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
          'data: {"type":"content_block_delta"}\n\n',
        ]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    const usage = await r.usagePromise;
    expect(usage.inputTokens).toBe(25);
  });

  it("凭证解密失败:冷却该渠道并切换下一个", async () => {
    const bad: ChannelChoice = { ...chan("cbad"), credentialEncrypted: "not-json" };
    const cooldown = new FakeCooldown();
    const r = await forwardWithFailover({
      candidates: [bad, chan("c2")], protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master, cooldown, cooldownSeconds: 30,
      fetchImpl: async () => jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel.channelId).toBe("c2");
    expect(cooldown.marked).toEqual(["cbad"]);
  });

  it("上游 401 按渠道故障处理:冷却并切换", async () => {
    const cooldown = new FakeCooldown();
    let calls = 0;
    const r = await forwardWithFailover({
      candidates: [chan("c1"), chan("c2")], protocol: "openai",
      requestBody: { model: "m", messages: [] },
      masterKey: master, cooldown, cooldownSeconds: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(401, { error: { message: "invalid api key" } });
        return jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channel.channelId).toBe("c2");
    expect(cooldown.marked).toEqual(["c1"]);
  });

  it("anthropic-beta 头透传", async () => {
    let headers: Headers | null = null;
    await forwardWithFailover({
      candidates: [chan("c1")], protocol: "anthropic",
      requestBody: { model: "m", messages: [], max_tokens: 8 },
      masterKey: master, cooldown: new FakeCooldown(), cooldownSeconds: 30,
      anthropicBeta: "prompt-caching-2024-07-31",
      fetchImpl: async (_u, init) => {
        headers = new Headers(init!.headers);
        return jsonResponse(200, { usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    expect(headers!.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
  });
});
