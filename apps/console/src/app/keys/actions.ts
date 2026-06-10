"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { apiKeys, budgets, models } from "@byok/db";
import { cnyToMicro } from "@byok/shared";
import { requireAdmin } from "../../lib/auth";
import { db } from "../../lib/db";
import { createApiKey, revokeApiKey } from "../../lib/keys";

export interface CreateKeyResult {
  error?: string;
  plaintext?: string;
  keyId?: string;
}

export interface RevokeKeyResult {
  error?: string;
  success?: boolean;
}

/**
 * 创建 Key server action
 * 仅 admin 可调用;可为任意主体签发
 */
export async function createKeyAction(formData: FormData): Promise<CreateKeyResult> {
  const session = await requireAdmin();

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const allowedModelsRaw = formData.getAll("allowedModels") as string[];
  const allowedModels = allowedModelsRaw.length > 0 ? allowedModelsRaw : null;
  const expiresAtRaw = formData.get("expiresAt") as string | null;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const auditEnabled = formData.get("auditEnabled") === "on";

  // Admin 可为任意主体签发
  const ownerTypeRaw = formData.get("ownerType") as string | null;
  const ownerIdRaw = formData.get("ownerId") as string | null;

  let ownerType: "user" | "team" | "app";
  let ownerId: string;

  if (!ownerTypeRaw || !["user", "team", "app"].includes(ownerTypeRaw)) {
    ownerType = "user";
    ownerId = session.userId;
  } else {
    ownerType = ownerTypeRaw as "user" | "team" | "app";
    ownerId = ownerIdRaw || session.userId;
  }

  if (!name) {
    return { error: "名称不能为空" };
  }

  if (expiresAt && (isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
    return { error: "过期时间必须是未来的有效时间" };
  }

  // ── 预算参数解析 ──────────────────────────────────────────────────────────
  const budgetLimitRaw = (formData.get("budgetLimit") as string | null)?.trim() ?? "";
  const budgetPeriod = (formData.get("budgetPeriod") as string | null) ?? "monthly";
  const hasBudget = budgetLimitRaw !== "" && budgetLimitRaw !== "0";

  if (hasBudget) {
    if (!["monthly", "total"].includes(budgetPeriod)) {
      return { error: "预算周期必须为 monthly 或 total" };
    }
    try {
      const micro = cnyToMicro(budgetLimitRaw);
      if (micro <= BigInt(0)) return { error: "预算限额必须为正数" };
    } catch {
      return { error: "预算金额格式无效(示例: 100 或 100.50,最多 6 位小数)" };
    }
  }

  try {
    // 优先用 db.transaction 把 createApiKey insert 与 budgets insert 包在一起
    // 若 budget insert 失败,事务自动回滚,Key 不会残留
    const result = await db.transaction(async (tx) => {
      const keyResult = await createApiKey(tx, {
        ownerType,
        ownerId,
        name,
        allowedModels,
        auditEnabled,
        expiresAt,
      });

      if (hasBudget) {
        // monthly: periodStart = 本月初(UTC)
        let periodStart: Date | null = null;
        if (budgetPeriod === "monthly") {
          const now = new Date();
          periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        }

        await tx.insert(budgets).values({
          subjectType: "key",
          subjectId: keyResult.id,
          period: budgetPeriod as "monthly" | "total",
          limitAmountCny: budgetLimitRaw,
          usedAmountCny: "0",
          periodStart,
          status: "active",
        });
      }

      return keyResult;
    });

    revalidatePath("/keys");
    return { plaintext: result.plaintext, keyId: result.id };
  } catch (err) {
    console.error("createKeyAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/**
 * 撤销 Key server action
 * 仅 admin 可调用;可撤销任何 Key(ownerGuard 传 null)
 */
export async function revokeKeyAction(keyId: string): Promise<RevokeKeyResult> {
  await requireAdmin();

  const ownerGuard = null;

  try {
    const ok = await revokeApiKey(db, keyId, ownerGuard);
    if (!ok) {
      return { error: "撤销失败:Key 不存在或无权操作" };
    }
    revalidatePath("/keys");
    return { success: true };
  } catch (err) {
    console.error("revokeKeyAction error:", err);
    return { error: "撤销失败,请重试" };
  }
}

/**
 * Admin 切换 auditEnabled
 */
export async function toggleAuditAction(keyId: string, enabled: boolean): Promise<{ error?: string }> {
  await requireAdmin();

  try {
    await db
      .update(apiKeys)
      .set({ auditEnabled: enabled })
      .where(eq(apiKeys.id, keyId));
    revalidatePath("/keys");
    return {};
  } catch (err) {
    console.error("toggleAuditAction error:", err);
    return { error: "操作失败" };
  }
}

/**
 * 获取可用的 active 模型 slug 列表(创建表单用)
 */
export async function getActiveModelSlugs(): Promise<string[]> {
  await requireAdmin();
  const rows = await db
    .select({ slug: models.slug })
    .from(models)
    .where(eq(models.status, "active"));
  return rows.map((r) => r.slug);
}

/**
 * 获取 Key 列表(仅 admin);返回全部 Key
 */
export async function listKeysAction() {
  await requireAdmin();

  const selectColumns = {
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    name: apiKeys.name,
    ownerType: apiKeys.ownerType,
    ownerId: apiKeys.ownerId,
    allowedModels: apiKeys.allowedModels,
    auditEnabled: apiKeys.auditEnabled,
    expiresAt: apiKeys.expiresAt,
    status: apiKeys.status,
    createdAt: apiKeys.createdAt,
  };

  return db.select(selectColumns).from(apiKeys).orderBy(apiKeys.createdAt);
}
