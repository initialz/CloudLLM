/**
 * 数据库迁移入口：程序化运行 drizzle-orm migrate，无需 drizzle-kit CLI。
 * Docker 中由 migrate 服务执行：node dist/migrate.js
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://byok:byok_dev@localhost:5432/byok";

// __dirname equivalent in ESM
const __dirname = fileURLToPath(new URL(".", import.meta.url));
// migrations 目录相对于 dist/migrate.js 向上一级到 migrations/
const migrationsFolder = resolve(__dirname, "../migrations");

const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 30 });
const db = drizzle(sql);

console.log("开始数据库迁移，migrations 目录:", migrationsFolder);

try {
  await migrate(db, { migrationsFolder });
  console.log("数据库迁移完成");
} catch (err) {
  console.error("迁移失败:", err);
  process.exit(1);
} finally {
  await sql.end();
}
