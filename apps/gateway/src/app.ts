import { Hono } from "hono";
import { cnyToMicro, computeCostCny } from "@byok/shared";
import { authenticate } from "./auth.js";
import { checkBudgets, settleBudgets, subjectsForKey } from "./budget.js";
import { selectCandidates } from "./router.js";
import { TtlCache } from "./ttl-cache.js";
import { forwardWithFailover } from "./upstream.js";
import type {
  AuthedKey, BalanceStore, BudgetLoader, CatalogRepo, ChannelChoice,
  CooldownStore, EventSink, KeyRepo, ModelInfo, Protocol, UsageEvent, UsageTotals,
} from "./types.js";

export interface AppDeps {
  masterKey: string;
  balanceTtlSeconds: number;
  cooldownSeconds: number;
  catalogTtlMs: number;
  keyRepo: KeyRepo;
  catalog: CatalogRepo;
  loader: BudgetLoader;
  balance: BalanceStore;
  cooldown: CooldownStore;
  events: EventSink;
  fetchImpl?: typeof fetch;
}

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const modelCache = new TtlCache<ModelInfo | null>(deps.catalogTtlMs);
  const channelCache = new TtlCache<ChannelChoice[]>(deps.catalogTtlMs);

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.post("/v1/chat/completions", (c) => handle(c.req.raw, "openai"));
  app.post("/v1/messages", (c) => handle(c.req.raw, "anthropic"));

  function errorResponse(protocol: Protocol, status: number, code: string, message: string): Response {
    const body =
      protocol === "openai"
        ? { error: { message, type: "invalid_request_error", code } }
        : { type: "error", error: { type: anthropicErrorType(status), message } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function anthropicErrorType(status: number): string {
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 404) return "not_found_error";
    if (status === 429) return "rate_limit_error";
    if (status >= 500 || status === 502) return "api_error";
    return "invalid_request_error";
  }

  function emitSafe(event: UsageEvent): void {
    void deps.events.emit(event).catch((err) => {
      console.error("用量事件发送失败", err);
    });
  }

  async function handle(req: Request, protocol: Protocol): Promise<Response> {
    const startedAt = Date.now();

    let body: Record<string, unknown> | null = null;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!body || typeof body.model !== "string") {
      return errorResponse(protocol, 400, "invalid_request", "请求体缺少 model 字段");
    }
    const modelSlug = body.model;

    const rawKey =
      protocol === "openai"
        ? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
        : (req.headers.get("x-api-key") ?? undefined);

    const auth = await authenticate(deps.keyRepo, rawKey ?? undefined, modelSlug);
    if (!auth.ok) {
      return errorResponse(protocol, auth.status, auth.code, auth.message);
    }
    const key: AuthedKey = auth.key;

    const model = await modelCache.get(modelSlug, () => deps.catalog.getModel(modelSlug));
    if (!model) {
      return errorResponse(protocol, 404, "model_not_found", `未知模型 ${modelSlug}`);
    }
    if (model.providerType !== protocol) {
      return errorResponse(
        protocol, 400, "protocol_mismatch",
        `模型 ${modelSlug} 须经 ${model.providerType} 协议端点调用(v1 同构透传)`,
      );
    }

    const subjects = subjectsForKey(key);
    const budget = await checkBudgets(deps.balance, deps.loader, subjects, deps.balanceTtlSeconds);
    if (!budget.ok) {
      emitSafe({
        keyId: key.id, modelSlug, channelId: null, usage: ZERO_USAGE, costCny: "0.000000",
        latencyMs: Date.now() - startedAt, ttftMs: null,
        status: "rejected", errorCode: "budget_exhausted", ts: new Date().toISOString(),
      });
      return errorResponse(
        protocol, 429, "budget_exhausted",
        `预算已用尽(${budget.exhausted.type}:${budget.exhausted.id})`,
      );
    }

    const candidates = await channelCache.get(modelSlug, () =>
      Promise.resolve().then(() => deps.catalog.getChannelsForModel(modelSlug)),
    );
    const ordered = await selectCandidates(
      { getModel: deps.catalog.getModel.bind(deps.catalog), getChannelsForModel: async () => candidates },
      deps.cooldown, modelSlug,
    );

    const fwd = await forwardWithFailover({
      candidates: ordered,
      protocol,
      requestBody: body,
      masterKey: deps.masterKey,
      cooldown: deps.cooldown,
      cooldownSeconds: deps.cooldownSeconds,
      anthropicVersion: req.headers.get("anthropic-version") ?? undefined,
      anthropicBeta: req.headers.get("anthropic-beta") ?? undefined,
      fetchImpl: deps.fetchImpl,
    });

    if (!fwd.ok) {
      emitSafe({
        keyId: key.id, modelSlug, channelId: null, usage: ZERO_USAGE, costCny: "0.000000",
        latencyMs: Date.now() - startedAt, ttftMs: null,
        status: "upstream_error", errorCode: fwd.code, ts: new Date().toISOString(),
      });
      return errorResponse(protocol, 502, fwd.code, "上游渠道全部失败,请稍后重试");
    }

    // 计量与结算:流结束后异步执行,不阻塞响应
    void fwd.usagePromise
      .then(async (usage) => {
        const costCny = computeCostCny(usage, model.prices);
        await settleBudgets(deps.balance, subjects, cnyToMicro(costCny));
        emitSafe({
          keyId: key.id, modelSlug, channelId: fwd.channel.channelId, usage, costCny,
          latencyMs: Date.now() - startedAt, ttftMs: fwd.ttftMs,
          status: fwd.status >= 400 ? "upstream_error" : "ok",
          errorCode: fwd.status >= 400 ? `upstream_${fwd.status}` : null,
          ts: new Date().toISOString(),
          audit: key.auditEnabled ? { requestBody: body, responseBody: fwd.responseJson } : undefined,
        });
      })
      .catch((err) => {
        console.error("计量结算失败", err);
      });

    const contentType = fwd.headers.get("content-type") ?? "application/json";
    if (typeof fwd.body === "string") {
      return new Response(fwd.body, { status: fwd.status, headers: { "content-type": contentType } });
    }
    return new Response(fwd.body, {
      status: fwd.status,
      headers: { "content-type": contentType, "cache-control": "no-cache" },
    });
  }

  return app;
}
