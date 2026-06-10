import { generateApiKey } from "@byok/shared";
import { describe, expect, it } from "vitest";
import { authenticate } from "./auth.js";
import type { AuthedKey, KeyRepo } from "./types.js";

const KEY: AuthedKey = {
  id: "key-1",
  ownerType: "app",
  ownerId: "app-1",
  teamId: "team-1",
  allowedModels: ["anthropic/claude-opus-4-8"],
  auditEnabled: false,
};

function repoWith(hash: string | null): KeyRepo {
  return {
    async findActiveByHash(h) {
      return hash !== null && h === hash ? KEY : null;
    },
  };
}

describe("authenticate", () => {
  it("合法 Key + 白名单内模型通过", async () => {
    const k = generateApiKey();
    const r = await authenticate(repoWith(k.keyHash), k.plaintext, "anthropic/claude-opus-4-8");
    expect(r).toEqual({ ok: true, key: KEY });
  });

  it("缺失或非 sk-wtg- 前缀返回 401", async () => {
    expect((await authenticate(repoWith(null), undefined, "m")).ok).toBe(false);
    const r = await authenticate(repoWith(null), "sk-other-xxx", "m");
    expect(r).toMatchObject({ ok: false, status: 401, code: "invalid_api_key" });
  });

  it("查不到(无效/停用/过期)返回 401", async () => {
    const r = await authenticate(repoWith(null), "sk-wtg-notexist", "m");
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("白名单外模型返回 403 model_not_allowed", async () => {
    const k = generateApiKey();
    const r = await authenticate(repoWith(k.keyHash), k.plaintext, "openai/gpt-x");
    expect(r).toMatchObject({ ok: false, status: 403, code: "model_not_allowed" });
  });
});
