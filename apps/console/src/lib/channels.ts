import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { channels, type Db } from "@byok/db";
import { encryptSecret } from "@byok/shared";

// MASTER_KEY 启动时校验:必填且 base64 解码后为 32 字节
((): void => {
  const key = process.env.MASTER_KEY;
  if (!key) {
    throw new Error("MASTER_KEY 环境变量未设置");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `MASTER_KEY base64 解码后必须为 32 字节,当前为 ${decoded.length} 字节`,
    );
  }
})();

export interface CreateChannelInput {
  providerId: string;
  name: string;
  baseUrl: string;
  /** 上游明文凭证,仅在本函数内存活 */
  credential: string;
}

/** 创建渠道:应用侧生成 UUID 作为信封加密 AAD(必须先有 id 再加密,见 spec §4.3) */
export async function createChannel(db: Db, masterKey: string, input: CreateChannelInput): Promise<string> {
  if (!/^https?:\/\/.+\/v1$/.test(input.baseUrl.replace(/\/$/, ""))) {
    throw new Error("baseUrl 必须以 /v1 结尾(如 https://api.openai.com/v1)");
  }
  const id = randomUUID();
  await db.insert(channels).values({
    id,
    providerId: input.providerId,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    credentialEncrypted: encryptSecret(input.credential, masterKey, id),
  });
  return id;
}

/** 轮换凭证:复用原行 id 作 AAD */
export async function rotateChannelCredential(db: Db, masterKey: string, channelId: string, credential: string): Promise<void> {
  await db
    .update(channels)
    .set({ credentialEncrypted: encryptSecret(credential, masterKey, channelId) })
    .where(eq(channels.id, channelId));
}
