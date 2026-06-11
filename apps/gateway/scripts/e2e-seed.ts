/**
 * e2e 造数:provider 渠道(指向本地假上游)、两个模型、一把 Key、一份小额预算。
 * 运行:pnpm --filter @cloudllm/gateway e2e-seed
 * 输出:可直接用于 curl 的明文 Key。
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, apiKeys, budgets, channels, modelChannels, models, providers, users } from "@cloudllm/db";
import { encryptSecret, generateApiKey } from "@cloudllm/shared";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm";
const MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) throw new Error("需要 MASTER_KEY 环境变量(32 字节 base64)");

async function main() {
  const { db, sql } = createDb(DATABASE_URL, { max: 1 });

  const allProviders = await db.select().from(providers);
  const openaiP = allProviders.find((p) => p.type === "openai");
  const anthropicP = allProviders.find((p) => p.type === "anthropic");
  if (!openaiP || !anthropicP) throw new Error("providers 未找到(请先运行 seed)");

  // 渠道:应用侧生成 UUID,使 AAD=行 id 的约定成立
  const mkChannel = async (providerId: string, name: string): Promise<string> => {
    const id = randomUUID();
    await db.insert(channels).values({
      id,
      providerId,
      name,
      baseUrl: "http://localhost:9100/v1",
      credentialEncrypted: encryptSecret("fake-upstream-credential", MASTER_KEY!, id),
    }).onConflictDoNothing();
    return id;
  };
  const openaiChan = await mkChannel(openaiP.id, "e2e-openai");
  const anthropicChan = await mkChannel(anthropicP.id, "e2e-anthropic");

  const mkModel = async (
    slug: string,
    providerType: "openai" | "anthropic",
    channelId: string,
  ): Promise<void> => {
    const existing = await db.select().from(models).where(eq(models.slug, slug));
    let modelId = existing[0]?.id;
    if (!modelId) {
      modelId = randomUUID();
      await db.insert(models).values({
        id: modelId,
        slug,
        displayName: slug,
        providerType,
        priceInputCny: "21",
        priceOutputCny: "105",
        priceCacheReadCny: "2.1",
        priceCacheWriteCny: "26.25",
      });
    }
    await db.insert(modelChannels).values({
      modelId,
      channelId,
      upstreamModelId: "fake-real-model",
    }).onConflictDoNothing();
  };
  await mkModel("openai/gpt-e2e", "openai", openaiChan);
  await mkModel("anthropic/claude-e2e", "anthropic", anthropicChan);

  // Key 归属 admin 用户;预算 0.05 元——两三次调用后必触发 429
  const adminRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  const adminId = adminRows[0]?.id;
  if (!adminId) throw new Error("未找到 admin 用户");

  const key = generateApiKey();
  const keyRow = await db.insert(apiKeys).values({
    ownerType: "user",
    ownerId: adminId,
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
    name: "e2e",
  }).returning({ id: apiKeys.id });

  const keyId = keyRow[0]?.id;
  if (!keyId) throw new Error("Key 插入失败");

  await db.insert(budgets).values({
    subjectType: "key",
    subjectId: keyId,
    period: "total",
    limitAmountCny: "0.05",
  }).onConflictDoNothing();

  console.log("e2e Key:", key.plaintext);
  console.log("Key ID:", keyId);
  console.log("OpenAI Channel ID:", openaiChan);
  console.log("Anthropic Channel ID:", anthropicChan);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
