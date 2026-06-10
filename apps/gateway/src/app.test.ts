import { randomBytes } from "node:crypto";
import { encryptSecret, generateApiKey } from "@byok/shared";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import type {
  AuthedKey, BalanceStore, BudgetLoader, BudgetSubject, CatalogRepo,
  ChannelChoice, CooldownStore, EventSink, KeyRepo, ModelInfo, UsageEvent,
} from "./types.js";

const master = randomBytes(32).toString("base64");
const apiKey = generateApiKey();

const MODEL: ModelInfo = {
  slug: "openai/gpt-test",
  providerType: "openai",
  prices: { inputPerMTok: "21", outputPerMTok: "105", cacheReadPerMTok: "2.1", cacheWritePerMTok: "0" },
};

const CLAUDE: ModelInfo = {
  slug: "anthropic/claude-test",
  providerType: "anthropic",
  prices: { inputPerMTok: "30", outputPerMTok: "150", cacheReadPerMTok: "3", cacheWritePerMTok: "37.5" },
};

const KEY: AuthedKey = {
  id: "key-1", ownerType: "user", ownerId: "u1", teamId: null,
  allowedModels: null, auditEnabled: false,
};

function makeDeps(overrides: Partial<AppDeps> = {}): { deps: AppDeps; events: UsageEvent[] } {
  const events: UsageEvent[] = [];
  const channel: ChannelChoice = {
    channelId: "c1", baseUrl: "https://up.example/v1",
    credentialEncrypted: encryptSecret("upstream-key", master, "c1"),
    upstreamModelId: "real-model", priority: 0, weight: 1,
  };
  const deps: AppDeps = {
    masterKey: master,
    balanceTtlSeconds: 60,
    cooldownSeconds: 30,
    catalogTtlMs: 0,
    keyRepo: {
      async findActiveByHash(h) {
        return h === apiKey.keyHash ? KEY : null;
      },
    } satisfies KeyRepo,
    catalog: {
      async getModel(slug) {
        if (slug === MODEL.slug) return MODEL;
        if (slug === CLAUDE.slug) return CLAUDE;
        return null;
      },
      async getChannelsForModel() {
        return [channel];
      },
    } satisfies CatalogRepo,
    loader: { async loadRemainingMicro() { return null; } } satisfies BudgetLoader,
    balance: {
      store: new Map<string, bigint | "unlimited">(),
      async getMany(subjects: BudgetSubject[]) {
        return subjects.map((s) => this.store.get(`${s.type}:${s.id}`) ?? null);
      },
      async set(s: BudgetSubject, v: bigint | "unlimited") {
        this.store.set(`${s.type}:${s.id}`, v);
      },
      async decrBy(subjects: BudgetSubject[], micro: bigint) {
        for (const s of subjects) {
          const cur = this.store.get(`${s.type}:${s.id}`);
          if (typeof cur === "bigint") this.store.set(`${s.type}:${s.id}`, cur - micro);
        }
      },
    } as BalanceStore & { store: Map<string, bigint | "unlimited"> },
    cooldown: {
      async isCooling() { return false; },
      async markCooldown() {},
    } satisfies CooldownStore,
    events: {
      async emit(e) { events.push(e); },
    } satisfies EventSink,
    fetchImpl: async () =>
      new Response(JSON.stringify({ id: "resp-1", usage: { prompt_tokens: 1000, completion_tokens: 500 } }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ...overrides,
  };
  return { deps, events };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("POST /v1/chat/completions", () => {
  it("全链路成功:200 + 事件入流 + 余额扣减", async () => {
    const { deps, events } = makeDeps();
    const balance = deps.balance as BalanceStore & { store: Map<string, bigint | "unlimited"> };
    balance.store.set("key:key-1", 10_000_000n);
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }).id).toBe("resp-1");
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      keyId: "key-1", modelSlug: "openai/gpt-test", channelId: "c1", status: "ok",
      usage: { inputTokens: 1000, outputTokens: 500 },
      costCny: "0.073500",
    });
    // 0.0735 元 = 73500 micro
    expect(balance.store.get("key:key-1")).toBe(10_000_000n - 73_500n);
  });

  it("无 Key 返回 401(OpenAI 错误格式)", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("余额耗尽返回 429 并发 rejected 事件", async () => {
    const { deps, events } = makeDeps();
    (deps.balance as BalanceStore & { store: Map<string, bigint | "unlimited"> }).store.set("key:key-1", 0n);
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(429);
    await flush();
    expect(events[0]).toMatchObject({ status: "rejected", errorCode: "budget_exhausted", costCny: "0.000000" });
  });

  it("未知模型 404;协议不匹配 400", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const mk = (model: string) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [] }),
      });
    expect((await mk("nope/none")).status).toBe(404);
    expect((await mk("anthropic/claude-test")).status).toBe(400);
  });

  it("上游全失败返回 502 并发 upstream_error 事件", async () => {
    const { deps, events } = makeDeps({
      fetchImpl: async () => new Response("{}", { status: 500 }),
    });
    const app = createApp(deps);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });
    expect(res.status).toBe(502);
    await flush();
    expect(events[0]).toMatchObject({ status: "upstream_error", errorCode: "upstream_failed" });
  });
});

describe("POST /v1/messages", () => {
  it("anthropic 链路:x-api-key 鉴权 + anthropic 错误格式", async () => {
    const { deps } = makeDeps({
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "msg-1", usage: { input_tokens: 5, output_tokens: 7 } }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
    });
    const app = createApp(deps);
    const ok = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey.plaintext, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [], max_tokens: 8 }),
    });
    expect(ok.status).toBe(200);

    const unauth = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [], max_tokens: 8 }),
    });
    expect(unauth.status).toBe(401);
    const body = await unauth.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  it("audit Key 的事件携带请求/响应体", async () => {
    const auditKey: AuthedKey = { ...KEY, auditEnabled: true };
    const { deps, events } = makeDeps({
      keyRepo: { async findActiveByHash(h) { return h === apiKey.keyHash ? auditKey : null; } },
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "msg-2", usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
    });
    const app = createApp(deps);
    await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey.plaintext, "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-test", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    });
    await flush();
    expect(events[0]!.audit).toBeDefined();
    expect((events[0]!.audit!.responseBody as { id: string }).id).toBe("msg-2");
  });
});

describe("GET /healthz", () => {
  it("返回 ok", async () => {
    const { deps } = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });
});
