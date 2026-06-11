import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { channels, type Db } from "@cloudllm/db";
import { encryptSecret } from "@cloudllm/shared";

// 注:MASTER_KEY 的校验在 app/admin/channels/actions.ts 的 getMasterKey() 中惰性进行
// (请求时校验)。本模块不在导入时读取 MASTER_KEY——否则 `next build` 静态分析
// 导入本模块即失败(构建环境无此密钥)。createChannel/rotateChannelCredential
// 通过参数接收 masterKey,本身不读环境变量。

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
