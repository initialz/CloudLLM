"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { channels, modelChannels, models, providers } from "@cloudllm/db";
import { cnyToMicro } from "@cloudllm/shared";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";

export interface ModelActionResult {
  error?: string;
  success?: boolean;
}

/** 校验 CNY 价格:必须是非负合法值 */
function validatePrice(raw: string, fieldName: string): { error?: string; value?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: `${fieldName} 不能为空` };
  try {
    const micro = cnyToMicro(trimmed);
    if (micro < BigInt(0)) return { error: `${fieldName} 不能为负数` };
  } catch {
    return { error: `${fieldName} 格式无效(示例: 21 或 21.000000,最多 6 位小数)` };
  }
  return { value: trimmed };
}

/** 创建模型 */
export async function createModelAction(formData: FormData): Promise<ModelActionResult> {
  await requireAdmin();

  const slug = (formData.get("slug") as string | null)?.trim() ?? "";
  const displayName = (formData.get("displayName") as string | null)?.trim() ?? "";
  const providerType = (formData.get("providerType") as string | null) ?? "";
  const priceInputRaw = (formData.get("priceInput") as string | null) ?? "";
  const priceOutputRaw = (formData.get("priceOutput") as string | null) ?? "";
  const priceCacheReadRaw = (formData.get("priceCacheRead") as string | null) ?? "0";
  const priceCacheWriteRaw = (formData.get("priceCacheWrite") as string | null) ?? "0";
  const contextLengthRaw = (formData.get("contextLength") as string | null)?.trim() ?? "";

  if (!slug) return { error: "slug 不能为空" };
  if (!/^[a-z0-9_.\-]+\/[a-z0-9_.\-]+$/i.test(slug))
    return { error: "slug 格式无效(示例: openai/gpt-4o)" };
  if (!displayName) return { error: "显示名不能为空" };
  if (!["openai", "anthropic"].includes(providerType)) return { error: "供应商类型无效" };

  const priceInput = validatePrice(priceInputRaw, "输入价格");
  if (priceInput.error) return { error: priceInput.error };
  const priceOutput = validatePrice(priceOutputRaw, "输出价格");
  if (priceOutput.error) return { error: priceOutput.error };
  const priceCacheRead = validatePrice(priceCacheReadRaw, "缓存读价格");
  if (priceCacheRead.error) return { error: priceCacheRead.error };
  const priceCacheWrite = validatePrice(priceCacheWriteRaw, "缓存写价格");
  if (priceCacheWrite.error) return { error: priceCacheWrite.error };

  let contextLength: number | null = null;
  if (contextLengthRaw) {
    const parsed = parseInt(contextLengthRaw, 10);
    if (isNaN(parsed) || parsed <= 0) return { error: "context_length 必须为正整数" };
    contextLength = parsed;
  }

  try {
    await db.insert(models).values({
      slug,
      displayName,
      providerType: providerType as "openai" | "anthropic",
      priceInputCny: priceInput.value!,
      priceOutputCny: priceOutput.value!,
      priceCacheReadCny: priceCacheRead.value!,
      priceCacheWriteCny: priceCacheWrite.value!,
      contextLength,
      status: "active",
    });
    revalidatePath("/admin/models");
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const isUnique =
      msg.includes("models_slug") ||
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      causeMsg.includes("unique constraint") ||
      causeMsg.includes("duplicate key");
    if (isUnique) return { error: `slug "${slug}" 已存在,请使用唯一 slug` };
    console.error("createModelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 更新模型状态 */
export async function toggleModelStatusAction(
  modelId: string,
  currentStatus: string,
): Promise<ModelActionResult> {
  await requireAdmin();
  const next = currentStatus === "active" ? "disabled" : "active";
  try {
    await db
      .update(models)
      .set({ status: next as "active" | "disabled" })
      .where(eq(models.id, modelId));
    revalidatePath("/admin/models");
    return { success: true };
  } catch (err) {
    console.error("toggleModelStatusAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 删除模型(含 model_channels) */
export async function deleteModelAction(modelId: string): Promise<ModelActionResult> {
  await requireAdmin();
  try {
    await db.delete(modelChannels).where(eq(modelChannels.modelId, modelId));
    await db.delete(models).where(eq(models.id, modelId));
    revalidatePath("/admin/models");
    return { success: true };
  } catch (err) {
    console.error("deleteModelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 创建 model_channel 映射 */
export async function createModelChannelAction(
  modelId: string,
  formData: FormData,
): Promise<ModelActionResult> {
  await requireAdmin();

  const channelId = (formData.get("channelId") as string | null) ?? "";
  const upstreamModelId = (formData.get("upstreamModelId") as string | null)?.trim() ?? "";
  const priorityRaw = (formData.get("priority") as string | null) ?? "0";
  const weightRaw = (formData.get("weight") as string | null) ?? "1";

  if (!channelId) return { error: "请选择渠道" };
  if (!upstreamModelId) return { error: "上游模型 ID 不能为空" };

  const priority = parseInt(priorityRaw, 10);
  const weight = parseInt(weightRaw, 10);
  if (isNaN(priority)) return { error: "priority 必须为整数" };
  if (isNaN(weight) || weight < 1) return { error: "weight 必须为正整数" };

  // 校验渠道 provider 与模型 providerType 是否一致
  try {
    const [modelRow] = await db
      .select({ providerType: models.providerType })
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1);
    const [channelRow] = await db
      .select({ providerType: providers.type })
      .from(channels)
      .innerJoin(providers, eq(providers.id, channels.providerId))
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!modelRow) return { error: "模型不存在" };
    if (!channelRow) return { error: "渠道不存在" };
    if (channelRow.providerType !== modelRow.providerType) {
      return {
        error: `渠道 provider(${channelRow.providerType})与模型 providerType(${modelRow.providerType})不匹配`,
      };
    }
  } catch (err) {
    console.error("createModelChannelAction provider check error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }

  try {
    await db.insert(modelChannels).values({
      modelId,
      channelId,
      upstreamModelId,
      priority,
      weight,
    });
    revalidatePath("/admin/models");
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const isUnique =
      msg.includes("model_channels_pair_idx") ||
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      causeMsg.includes("unique constraint") ||
      causeMsg.includes("duplicate key");
    if (isUnique) return { error: "该模型与渠道的映射已存在" };
    console.error("createModelChannelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 删除 model_channel 映射 */
export async function deleteModelChannelAction(
  modelId: string,
  channelId: string,
): Promise<ModelActionResult> {
  await requireAdmin();
  try {
    await db
      .delete(modelChannels)
      .where(and(eq(modelChannels.modelId, modelId), eq(modelChannels.channelId, channelId)));
    revalidatePath("/admin/models");
    return { success: true };
  } catch (err) {
    console.error("deleteModelChannelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}
