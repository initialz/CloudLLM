import { hashApiKey } from "@byok/shared";
import type { AuthedKey, KeyRepo } from "./types.js";

export type AuthResult =
  | { ok: true; key: AuthedKey }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticate(
  repo: KeyRepo,
  rawKey: string | undefined,
  modelSlug: string,
): Promise<AuthResult> {
  if (!rawKey || !rawKey.startsWith("sk-wtg-")) {
    return { ok: false, status: 401, code: "invalid_api_key", message: "缺少或非法的 API Key" };
  }
  const key = await repo.findActiveByHash(hashApiKey(rawKey));
  if (!key) {
    return { ok: false, status: 401, code: "invalid_api_key", message: "API Key 无效或已停用" };
  }
  if (key.allowedModels !== null && !key.allowedModels.includes(modelSlug)) {
    return {
      ok: false,
      status: 403,
      code: "model_not_allowed",
      message: `该 Key 无权使用模型 ${modelSlug}`,
    };
  }
  return { ok: true, key };
}
