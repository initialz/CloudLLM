import { createDb, type Db } from "@cloudllm/db";

// Next.js dev 热重载时模块会被重新执行,用 globalThis 缓存单例防连接泄漏
declare global {
  // eslint-disable-next-line no-var
  var __cloudllmDb: Db | undefined;
}

function getDb(): Db {
  if (globalThis.__cloudllmDb) return globalThis.__cloudllmDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未设置");
  const { db } = createDb(url);
  globalThis.__cloudllmDb = db;
  return db;
}

/**
 * 惰性单例 db:用 Proxy 把初始化推迟到首次属性访问(运行时请求),
 * 而非模块导入时。这样 `next build` 的 "Collecting page data" 阶段
 * 导入本模块时不会读 DATABASE_URL、不会建连接——构建环境无需也不应有该密钥。
 * 所有 `db.select(...)` 等调用点无需改动。
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
