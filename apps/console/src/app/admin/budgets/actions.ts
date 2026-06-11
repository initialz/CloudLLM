"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { apiKeys, apps, budgets, teamMembers, teams, users } from "@cloudllm/db";
import { cnyToMicro } from "@cloudllm/shared";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";

export interface BudgetActionResult {
  error?: string;
  success?: boolean;
}

/** 校验 limit 金额: 必须是合法的正 CNY 值(用 cnyToMicro) */
function validateLimit(raw: string): { error?: string; value?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "限额不能为空" };
  try {
    const micro = cnyToMicro(trimmed);
    if (micro <= BigInt(0)) return { error: "限额必须为正数" };
  } catch {
    return { error: "限额格式无效(示例: 100 或 100.50,最多 6 位小数)" };
  }
  return { value: trimmed };
}

/** 校验 alert_threshold: 0~1 可空 */
function validateAlertThreshold(raw: string | null): { error?: string; value?: string | null } {
  if (!raw || raw.trim() === "") return { value: null };
  const num = parseFloat(raw.trim());
  if (isNaN(num) || num < 0 || num > 1) {
    return { error: "告警阈值必须在 0~1 之间(如 0.8)" };
  }
  // Format to 4 decimal places max
  return { value: num.toFixed(4) };
}

/** 创建预算(admin only) */
export async function createBudgetAction(formData: FormData): Promise<BudgetActionResult> {
  await requireAdmin();

  const subjectType = (formData.get("subjectType") as string | null) ?? "";
  const subjectId = (formData.get("subjectId") as string | null) ?? "";
  const period = (formData.get("period") as string | null) ?? "";
  const limitRaw = (formData.get("limit") as string | null) ?? "";
  const alertThresholdRaw = formData.get("alertThreshold") as string | null;

  if (!["user", "team", "app", "key"].includes(subjectType)) {
    return { error: "无效的主体类型" };
  }
  if (!subjectId) {
    return { error: "请选择主体" };
  }
  if (!["monthly", "total"].includes(period)) {
    return { error: "period 必须为 monthly 或 total" };
  }

  const limitResult = validateLimit(limitRaw);
  if (limitResult.error) return { error: limitResult.error };

  const thresholdResult = validateAlertThreshold(alertThresholdRaw);
  if (thresholdResult.error) return { error: thresholdResult.error };

  // For monthly: periodStart = first day of current month (UTC)
  let periodStart: Date | null = null;
  if (period === "monthly") {
    const now = new Date();
    periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  try {
    await db.insert(budgets).values({
      subjectType: subjectType as "user" | "team" | "app" | "key",
      subjectId,
      period: period as "monthly" | "total",
      limitAmountCny: limitResult.value!,
      usedAmountCny: "0",
      periodStart,
      alertThreshold: thresholdResult.value ?? undefined,
      status: "active",
    });
    revalidatePath("/admin/budgets");
    return { success: true };
  } catch (err: unknown) {
    // Unique constraint: (subjectType, subjectId, period)
    // The drizzle/postgres driver wraps constraint errors; check message and cause
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const isUniqueViolation =
      msg.includes("budgets_subject_idx") ||
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      causeMsg.includes("budgets_subject_idx") ||
      causeMsg.includes("unique constraint") ||
      causeMsg.includes("duplicate key");
    if (isUniqueViolation) {
      return { error: `该主体已存在 ${period} 预算,每个主体每 period 只能有一条` };
    }
    console.error("createBudgetAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/** 编辑预算 */
export async function updateBudgetAction(
  budgetId: string,
  formData: FormData,
): Promise<BudgetActionResult> {
  await requireAdmin();

  const patch: {
    limitAmountCny?: string;
    alertThreshold?: string | null;
  } = {};

  // limit:字段缺失=不更新;字段存在=必须合法正数
  const limitRaw = formData.get("limit") as string | null;
  if (limitRaw !== null) {
    const limitResult = validateLimit(limitRaw);
    if (limitResult.error) return { error: limitResult.error };
    patch.limitAmountCny = limitResult.value!;
  }

  // alertThreshold:字段缺失=不更新;显式空串=清空(set null);有值=校验
  if (formData.has("alertThreshold")) {
    const alertThresholdRaw = formData.get("alertThreshold") as string | null;
    if (alertThresholdRaw === null || alertThresholdRaw.trim() === "") {
      // 显式清空
      patch.alertThreshold = null;
    } else {
      const thresholdResult = validateAlertThreshold(alertThresholdRaw);
      if (thresholdResult.error) return { error: thresholdResult.error };
      patch.alertThreshold = thresholdResult.value ?? null;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { error: "没有需要更新的字段" };
  }

  try {
    await db
      .update(budgets)
      .set(patch)
      .where(eq(budgets.id, budgetId));
    revalidatePath("/admin/budgets");
    return { success: true };
  } catch (err) {
    console.error("updateBudgetAction error:", err);
    return { error: "更新失败,请重试" };
  }
}

/** 停用预算 */
export async function disableBudgetAction(budgetId: string): Promise<BudgetActionResult> {
  await requireAdmin();

  try {
    await db
      .update(budgets)
      .set({ status: "disabled" })
      .where(eq(budgets.id, budgetId));
    revalidatePath("/admin/budgets");
    return { success: true };
  } catch (err) {
    console.error("disableBudgetAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 启用预算 */
export async function enableBudgetAction(budgetId: string): Promise<BudgetActionResult> {
  await requireAdmin();

  try {
    await db
      .update(budgets)
      .set({ status: "active" })
      .where(eq(budgets.id, budgetId));
    revalidatePath("/admin/budgets");
    return { success: true };
  } catch (err) {
    console.error("enableBudgetAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 获取可选的主体列表(用于下拉) */
export interface SubjectOption {
  id: string;
  label: string;
  type: "user" | "team" | "app" | "key";
}

export async function getSubjectOptionsAction(): Promise<SubjectOption[]> {
  await requireAdmin();

  const [userRows, teamRows, appRows, keyRows] = await Promise.all([
    db.select({ id: users.id, email: users.email }).from(users).where(eq(users.status, "active")),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.status, "active")),
    db.select({ id: apps.id, name: apps.name }).from(apps).where(eq(apps.status, "active")),
    db
      .select({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix, name: apiKeys.name })
      .from(apiKeys)
      .where(eq(apiKeys.status, "active")),
  ]);

  return [
    ...userRows.map((u) => ({ id: u.id, label: u.email, type: "user" as const })),
    ...teamRows.map((t) => ({ id: t.id, label: t.name, type: "team" as const })),
    ...appRows.map((a) => ({ id: a.id, label: a.name, type: "app" as const })),
    ...keyRows.map((k) => ({
      id: k.id,
      label: `${k.keyPrefix}... ${k.name ? `(${k.name})` : ""}`,
      type: "key" as const,
    })),
  ];
}
