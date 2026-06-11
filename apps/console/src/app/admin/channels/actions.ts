"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { channels } from "@cloudllm/db";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { createChannel, rotateChannelCredential } from "../../../lib/channels";

export interface ChannelActionResult {
  error?: string;
  success?: boolean;
}

function getMasterKey(): string {
  const key = process.env.MASTER_KEY;
  if (!key) throw new Error("MASTER_KEY 环境变量未设置");
  return key;
}

/** 创建渠道 */
export async function createChannelAction(formData: FormData): Promise<ChannelActionResult> {
  await requireAdmin();

  const providerId = (formData.get("providerId") as string | null) ?? "";
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const baseUrl = (formData.get("baseUrl") as string | null)?.trim() ?? "";
  const credential = (formData.get("credential") as string | null) ?? "";

  if (!providerId) return { error: "请选择供应商" };
  if (!name) return { error: "渠道名称不能为空" };
  if (!baseUrl) return { error: "baseUrl 不能为空" };
  if (!credential) return { error: "凭证不能为空" };

  try {
    await createChannel(db, getMasterKey(), { providerId, name, baseUrl, credential });
    revalidatePath("/admin/channels");
    return { success: true };
  } catch (err: unknown) {
    console.error("createChannelAction error:", err instanceof Error ? err.message : String(err));
    const msg = err instanceof Error ? err.message : String(err);
    // 凭证/格式类校验错误保留原信息;其他 DB 异常返回通用文案
    const isValidationError =
      msg.includes("baseUrl 必须以 /v1 结尾") ||
      msg.includes("MASTER_KEY");
    return { error: isValidationError ? msg : "操作失败,请查看服务端日志" };
  }
}

/** 停用渠道 */
export async function disableChannelAction(channelId: string): Promise<ChannelActionResult> {
  await requireAdmin();
  try {
    await db
      .update(channels)
      .set({ status: "disabled" })
      .where(eq(channels.id, channelId));
    revalidatePath("/admin/channels");
    return { success: true };
  } catch (err) {
    console.error("disableChannelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 启用渠道 */
export async function enableChannelAction(channelId: string): Promise<ChannelActionResult> {
  await requireAdmin();
  try {
    await db
      .update(channels)
      .set({ status: "active" })
      .where(eq(channels.id, channelId));
    revalidatePath("/admin/channels");
    return { success: true };
  } catch (err) {
    console.error("enableChannelAction error:", err instanceof Error ? err.message : String(err));
    return { error: "操作失败,请查看服务端日志" };
  }
}

/** 轮换凭证 */
export async function rotateCredentialAction(
  channelId: string,
  formData: FormData,
): Promise<ChannelActionResult> {
  await requireAdmin();

  const credential = (formData.get("credential") as string | null) ?? "";
  if (!credential) return { error: "新凭证不能为空" };

  try {
    await rotateChannelCredential(db, getMasterKey(), channelId, credential);
    revalidatePath("/admin/channels");
    return { success: true };
  } catch (err: unknown) {
    console.error("rotateCredentialAction error:", err instanceof Error ? err.message : String(err));
    const msg = err instanceof Error ? err.message : String(err);
    const isValidationError = msg.includes("MASTER_KEY");
    return { error: isValidationError ? msg : "操作失败,请查看服务端日志" };
  }
}
