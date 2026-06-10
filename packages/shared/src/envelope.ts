import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EnvelopeV1 {
  v: 1;
  /** 主密钥加密后的数据密钥 */
  ek: string;
  /** 数据密钥加密用 IV */
  ekiv: string;
  /** 数据密钥加密的 GCM tag */
  ektag: string;
  /** 明文加密用 IV */
  iv: string;
  /** 明文加密的 GCM tag */
  tag: string;
  /** 密文 */
  data: string;
}

// 主密钥统一用标准 base64(Node 的 "base64" 解码同时接受 base64url,此处以长度校验兜底)
function parseMasterKey(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`master key 必须是 32 字节(base64 后传入),实际 ${key.length}`);
  }
  return key;
}

/**
 * 加密明文,返回信封 JSON 字符串。
 * @param plaintext 待加密的明文
 * @param masterKeyB64 32 字节主密钥的 base64 编码
 * @param aadContext 调用方应传入凭证所属记录的稳定标识(如 channels.id),
 *   防止密文跨记录移植;v1 前缀同时把版本绑进认证。
 */
export function encryptSecret(plaintext: string, masterKeyB64: string, aadContext: string): string {
  const master = parseMasterKey(masterKeyB64);
  const dataKey = randomBytes(32);

  const iv = randomBytes(12);
  const c1 = createCipheriv("aes-256-gcm", dataKey, iv, { authTagLength: 16 });
  const data = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);

  const ekiv = randomBytes(12);
  const c2 = createCipheriv("aes-256-gcm", master, ekiv, { authTagLength: 16 });
  c2.setAAD(Buffer.from(`v1:${aadContext}`, "utf8"));
  const ek = Buffer.concat([c2.update(dataKey), c2.final()]);

  const env: EnvelopeV1 = {
    v: 1,
    ek: ek.toString("base64"),
    ekiv: ekiv.toString("base64"),
    ektag: c2.getAuthTag().toString("base64"),
    iv: iv.toString("base64"),
    tag: c1.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(env);
}

/**
 * 解密信封 JSON 字符串,返回原始明文。
 * @param envelopeJson encryptSecret 返回的信封字符串
 * @param masterKeyB64 32 字节主密钥的 base64 编码
 * @param aadContext 必须与加密时传入的 aadContext 完全一致,否则认证失败抛错。
 *   调用方应传入凭证所属记录的稳定标识(如 channels.id),
 *   防止密文跨记录移植;v1 前缀同时把版本绑进认证。
 */
export function decryptSecret(envelopeJson: string, masterKeyB64: string, aadContext: string): string {
  const master = parseMasterKey(masterKeyB64);
  const env = JSON.parse(envelopeJson) as EnvelopeV1;
  if (env.v !== 1) throw new Error(`不支持的信封版本: ${env.v}`);

  const required = ["ek", "ekiv", "ektag", "iv", "tag", "data"] as const;
  for (const f of required) {
    if (typeof env[f] !== "string") throw new Error(`信封字段 '${f}' 缺失或类型错误`);
  }

  const d2 = createDecipheriv("aes-256-gcm", master, Buffer.from(env.ekiv, "base64"), { authTagLength: 16 });
  d2.setAAD(Buffer.from(`v1:${aadContext}`, "utf8"));
  d2.setAuthTag(Buffer.from(env.ektag, "base64"));
  const dataKey = Buffer.concat([d2.update(Buffer.from(env.ek, "base64")), d2.final()]);

  const d1 = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(env.iv, "base64"), { authTagLength: 16 });
  d1.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d1.update(Buffer.from(env.data, "base64")), d1.final()]).toString("utf8");
}
