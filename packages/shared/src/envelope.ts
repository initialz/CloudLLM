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

function parseMasterKey(masterKeyB64: string): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`master key 必须是 32 字节(base64 后传入),实际 ${key.length}`);
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKeyB64: string): string {
  const master = parseMasterKey(masterKeyB64);
  const dataKey = randomBytes(32);

  const iv = randomBytes(12);
  const c1 = createCipheriv("aes-256-gcm", dataKey, iv);
  const data = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);

  const ekiv = randomBytes(12);
  const c2 = createCipheriv("aes-256-gcm", master, ekiv);
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

export function decryptSecret(envelopeJson: string, masterKeyB64: string): string {
  const master = parseMasterKey(masterKeyB64);
  const env = JSON.parse(envelopeJson) as EnvelopeV1;
  if (env.v !== 1) throw new Error(`不支持的信封版本: ${env.v}`);

  const d2 = createDecipheriv("aes-256-gcm", master, Buffer.from(env.ekiv, "base64"));
  d2.setAuthTag(Buffer.from(env.ektag, "base64"));
  const dataKey = Buffer.concat([d2.update(Buffer.from(env.ek, "base64")), d2.final()]);

  const d1 = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(env.iv, "base64"));
  d1.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d1.update(Buffer.from(env.data, "base64")), d1.final()]).toString("utf8");
}
