/**
 * Phase 4 生产验收造数脚本
 * 与 e2e-seed.ts 等价,但:
 *   - 使用 ESM (无需 tsc),可直接用 node 运行
 *   - baseUrl 默认指向 host.docker.internal:9100(容器内访问宿主假上游)
 *   - 通过 UPSTREAM_BASE_URL 环境变量覆盖
 * 使用:
 *   DATABASE_URL=... MASTER_KEY=... node apps/gateway/scripts/e2e-seed-prod.mjs
 */
import { randomUUID, createHash } from "node:crypto";
import postgres from "../../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js";

// 动态 import @byok/db and @byok/shared from the built dist
const { createDb, apiKeys, budgets, channels, modelChannels, models, providers, users } = await import("../../packages/db/dist/index.js");
const { encryptSecret, generateApiKey } = await import("../../packages/shared/dist/index.js");
import { eq } from "../../node_modules/.pnpm/drizzle-orm@0.44.7_postgres@3.4.9/node_modules/drizzle-orm/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("需要 DATABASE_URL");
const MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) throw new Error("需要 MASTER_KEY");
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL ?? "http://host.docker.internal:9100/v1";

const { db, sql } = createDb(DATABASE_URL, { max: 1 });

const allProviders = await db.select().from(providers);
const openaiP = allProviders.find((p) => p.type === "openai");
const anthropicP = allProviders.find((p) => p.type === "anthropic");
if (!openaiP || !anthropicP) throw new Error("providers 未找到(请先运行 seed)");

const mkChannel = async (providerId, name) => {
  const id = randomUUID();
  await db.insert(channels).values({
    id,
    providerId,
    name,
    baseUrl: UPSTREAM_BASE_URL,
    credentialEncrypted: encryptSecret("fake-upstream-credential", MASTER_KEY, id),
  }).onConflictDoNothing();
  return id;
};

const openaiChan = await mkChannel(openaiP.id, "p4-e2e-openai");
const anthropicChan = await mkChannel(anthropicP.id, "p4-e2e-anthropic");

const mkModel = async (slug, providerType, channelId) => {
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

await mkModel("openai/gpt-p4e2e", "openai", openaiChan);
await mkModel("anthropic/claude-p4e2e", "anthropic", anthropicChan);

const adminRows = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
const adminId = adminRows[0]?.id;
if (!adminId) throw new Error("未找到 admin 用户");

const key = generateApiKey();
const keyRow = await db.insert(apiKeys).values({
  ownerType: "user",
  ownerId: adminId,
  keyHash: key.keyHash,
  keyPrefix: key.keyPrefix,
  name: "p4-e2e",
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
