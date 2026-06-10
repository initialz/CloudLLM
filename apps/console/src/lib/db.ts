import { createDb, type Db } from "@byok/db";

// Next.js dev 热重载时模块会被重新执行,用 globalThis 缓存单例防连接泄漏
declare global {
  // eslint-disable-next-line no-var
  var __byokDb: Db | undefined;
}

function getDb(): Db {
  if (globalThis.__byokDb) return globalThis.__byokDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未设置");
  const { db } = createDb(url);
  globalThis.__byokDb = db;
  return db;
}

/** 模块级单例 db */
export const db: Db = getDb();
