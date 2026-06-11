/**
 * 幂等种子:初始管理员 + openai/anthropic 两个 provider。
 * 运行:pnpm --filter @cloudllm/db seed
 */
import { hashPassword } from "@cloudllm/shared";
import { createDb } from "./client.js";
import { providers, users } from "./schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudllm:cloudllm_dev@localhost:5432/cloudllm";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "change-me-now";

async function main() {
  const { db, sql } = createDb(DATABASE_URL, { max: 1 });

  await db
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "admin",
    })
    .onConflictDoNothing({ target: users.email });

  await db
    .insert(providers)
    .values([
      { type: "openai", displayName: "OpenAI" },
      { type: "anthropic", displayName: "Anthropic" },
    ])
    .onConflictDoNothing({ target: providers.type });

  console.log("seed 完成:admin =", ADMIN_EMAIL);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
