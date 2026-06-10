/**
 * channels.test.ts — 真 PG 集成测试 (3 用例)
 *
 * 运行前提:本地 PG 已起,DATABASE_URL 已设置
 * 默认:postgres://byok:byok_dev@localhost:5432/byok
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channels, providers } from "@byok/db";
import { createDb, type Db } from "@byok/db";
import { decryptSecret } from "@byok/shared";
import { createChannel, rotateChannelCredential } from "./channels.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://byok:byok_dev@localhost:5432/byok";

// 测试用主密钥:32 字节,base64 编码
const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes base64

let db: Db;
let sql: { end: () => Promise<void> };

// 测试用 provider id (会在 beforeAll 创建)
let testProviderId: string;

// 收集创建的资源以便测后清理
const createdChannelIds: string[] = [];
let testProviderCreated = false;

beforeAll(async () => {
  const bundle = createDb(DATABASE_URL, { max: 1 });
  db = bundle.db;
  sql = bundle.sql;

  // 确保有一个测试用 provider
  // 先查 openai provider,若无则插入
  const existing = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.type, "openai"))
    .limit(1);

  if (existing.length > 0) {
    testProviderId = existing[0]!.id;
  } else {
    testProviderId = randomUUID();
    await db.insert(providers).values({
      id: testProviderId,
      type: "openai",
      displayName: "OpenAI (test)",
    });
    testProviderCreated = true;
  }
});

afterAll(async () => {
  // 清理测试渠道
  for (const id of createdChannelIds) {
    await db.delete(channels).where(eq(channels.id, id)).catch(() => {});
  }
  // 若是我们创建的 provider 则删除
  if (testProviderCreated) {
    await db.delete(providers).where(eq(providers.id, testProviderId)).catch(() => {});
  }
  await sql.end();
});

describe("channels", () => {
  it("AAD 闭环:创建后 decryptSecret(credentialEncrypted, master, 行id) 能解回原文", async () => {
    const credential = "sk-test-credential-aad-roundtrip";
    const channelId = await createChannel(db, MASTER_KEY, {
      providerId: testProviderId,
      name: "test-channel-aad",
      baseUrl: "https://api.openai.com/v1",
      credential,
    });
    createdChannelIds.push(channelId);

    // 从 DB 取出加密后的凭证
    const rows = await db
      .select({ credentialEncrypted: channels.credentialEncrypted })
      .from(channels)
      .where(eq(channels.id, channelId));

    expect(rows).toHaveLength(1);
    const encrypted = rows[0]!.credentialEncrypted;

    // 用相同的 masterKey 和行 id 作 AAD 解密,应得到原文
    const decrypted = decryptSecret(encrypted, MASTER_KEY, channelId);
    expect(decrypted).toBe(credential);
  });

  it("baseUrl 不带 /v1 抛错", async () => {
    await expect(
      createChannel(db, MASTER_KEY, {
        providerId: testProviderId,
        name: "test-channel-bad-url",
        baseUrl: "https://api.openai.com",
        credential: "sk-whatever",
      }),
    ).rejects.toThrow("baseUrl 必须以 /v1 结尾");

    // 也测试带尾斜杠但无 /v1 的情况
    await expect(
      createChannel(db, MASTER_KEY, {
        providerId: testProviderId,
        name: "test-channel-bad-url-2",
        baseUrl: "https://api.openai.com/",
        credential: "sk-whatever",
      }),
    ).rejects.toThrow("baseUrl 必须以 /v1 结尾");
  });

  it("rotate 后:旧密文(原 AAD)不匹配新密文,新密文可解回新凭证", async () => {
    const oldCredential = "sk-old-credential";
    const newCredential = "sk-new-credential-after-rotate";

    const channelId = await createChannel(db, MASTER_KEY, {
      providerId: testProviderId,
      name: "test-channel-rotate",
      baseUrl: "https://api.openai.com/v1",
      credential: oldCredential,
    });
    createdChannelIds.push(channelId);

    // 记录旧密文
    const before = await db
      .select({ credentialEncrypted: channels.credentialEncrypted })
      .from(channels)
      .where(eq(channels.id, channelId));
    const oldEncrypted = before[0]!.credentialEncrypted;

    // 执行轮换
    await rotateChannelCredential(db, MASTER_KEY, channelId, newCredential);

    // 取出新密文
    const after = await db
      .select({ credentialEncrypted: channels.credentialEncrypted })
      .from(channels)
      .where(eq(channels.id, channelId));
    const newEncrypted = after[0]!.credentialEncrypted;

    // 新密文与旧密文不同
    expect(newEncrypted).not.toBe(oldEncrypted);

    // 新密文可解回新凭证
    const decrypted = decryptSecret(newEncrypted, MASTER_KEY, channelId);
    expect(decrypted).toBe(newCredential);

    // 旧密文 JSON 已被 DB 替换——旧密文解不出新凭证
    // (旧密文用原 AAD 解出的是旧凭证,不是新凭证,所以"旧密文失效"体现在内容上)
    const decryptedOld = decryptSecret(oldEncrypted, MASTER_KEY, channelId);
    expect(decryptedOld).toBe(oldCredential); // 旧密文仍可解出旧凭证
    expect(decryptedOld).not.toBe(newCredential); // 但不等于新凭证,故旧密文"失效"
  });
});
