import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbBundle = ReturnType<typeof createDb>;
export type Db = DbBundle["db"];

/** 返回 db(查询)与 sql(连接句柄,优雅停机时 await sql.end()) */
export function createDb(databaseUrl: string, options?: { max?: number }) {
  const sql = postgres(databaseUrl, {
    max: options?.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
