import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionData {
  userId: string;
  role: "admin" | "user";
  /** epoch 秒 */
  exp: number;
}

const ALG = "sha256";

function sign(payloadB64: string, secret: string): string {
  return createHmac(ALG, secret).update(payloadB64).digest("base64url");
}

/** 编码为 `payloadB64.sig` 的 cookie 值;exp 由调用方给出 */
export function encodeSession(data: SessionData, secret: string): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 校验签名与有效期;无效返回 null */
export function decodeSession(
  cookieValue: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): SessionData | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
    if (
      typeof data.userId !== "string" ||
      (data.role !== "admin" && data.role !== "user") ||
      typeof data.exp !== "number"
    )
      return null;
    if (data.exp <= nowSec) return null;
    return data;
  } catch {
    return null;
  }
}
