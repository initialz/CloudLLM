import { and, eq } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { apiKeys, type Db } from "@byok/db";
import { generateApiKey } from "@byok/shared";

/**
 * DbOrTx: createApiKey/revokeApiKey 接受的 db 类型。
 * Db (PostgresJsDatabase) 与 db.transaction 回调中的 tx (PgTransaction)
 * 均继承自 PgDatabase,因此扩展为 PgDatabase 可同时兼容两者。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbOrTx = PgDatabase<any, any, any>;

export interface CreateKeyInput {
  ownerType: "user" | "team" | "app";
  ownerId: string;
  name: string;
  /** null = 不限 */
  allowedModels: string[] | null;
  auditEnabled: boolean;
  expiresAt: Date | null;
}

/** 签发 Key:返回明文(仅此一次)与行 id */
export async function createApiKey(db: Db | DbOrTx, input: CreateKeyInput): Promise<{ plaintext: string; id: string }> {
  const k = generateApiKey();
  const rows = await db
    .insert(apiKeys)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      keyHash: k.keyHash,
      keyPrefix: k.keyPrefix,
      name: input.name || null,
      allowedModels: input.allowedModels,
      auditEnabled: input.auditEnabled,
      expiresAt: input.expiresAt,
    })
    .returning({ id: apiKeys.id });
  return { plaintext: k.plaintext, id: rows[0]!.id };
}

/** 撤销:仅状态翻转,不删行(usage_records 软引用历史) */
export async function revokeApiKey(db: Db | DbOrTx, keyId: string, ownerGuard: { ownerType: string; ownerId: string } | null): Promise<boolean> {
  const conds = [eq(apiKeys.id, keyId)];
  if (ownerGuard) {
    conds.push(eq(apiKeys.ownerType, ownerGuard.ownerType as "user" | "team" | "app"));
    conds.push(eq(apiKeys.ownerId, ownerGuard.ownerId));
  }
  const rows = await db
    .update(apiKeys)
    .set({ status: "revoked" })
    .where(and(...conds))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
