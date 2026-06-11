import { createHash, randomBytes } from "node:crypto";

export interface GeneratedApiKey {
  /** 完整明文,仅创建时返回一次 */
  plaintext: string;
  /** SHA-256 hex,入库字段 */
  keyHash: string;
  /** 前 15 字符,后台识别用 */
  keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  // 24 字节 → base64url 32 字符
  const plaintext = `sk-cloudllm-${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, 15),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
