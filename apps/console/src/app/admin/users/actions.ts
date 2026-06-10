"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { users } from "@byok/db";
import { hashPassword } from "@byok/shared";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";

export interface CreateUserResult {
  error?: string;
  success?: boolean;
}

export interface UpdateUserResult {
  error?: string;
  success?: boolean;
}

/** 创建用户(admin only) */
export async function createUserAction(formData: FormData): Promise<CreateUserResult> {
  const session = await requireAdmin();

  const email = (formData.get("email") as string | null)?.trim().toLowerCase() ?? "";
  const password = (formData.get("password") as string | null) ?? "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "请输入有效邮箱地址" };
  }
  if (!password || password.length < 8) {
    return { error: "密码至少 8 位" };
  }

  // 检查邮箱是否已存在
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return { error: "该邮箱已注册" };
  }

  try {
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({
      email,
      passwordHash,
      role: "user",
      status: "active",
    });
    revalidatePath("/admin/users");
    return { success: true };
  } catch (err) {
    console.error("createUserAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/** 停用/启用用户(admin only;不可停用自己) */
export async function toggleUserStatusAction(
  targetUserId: string,
  newStatus: "active" | "disabled",
): Promise<UpdateUserResult> {
  const session = await requireAdmin();

  // 不可停用自己
  if (newStatus === "disabled" && targetUserId === session.userId) {
    return { error: "不能停用自己的账号" };
  }

  try {
    await db
      .update(users)
      .set({ status: newStatus })
      .where(eq(users.id, targetUserId));
    revalidatePath("/admin/users");
    return { success: true };
  } catch (err) {
    console.error("toggleUserStatusAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 修改用户角色(admin only;不可降级自己) */
export async function changeUserRoleAction(
  targetUserId: string,
  newRole: "admin" | "user",
): Promise<UpdateUserResult> {
  const session = await requireAdmin();

  // 不可降级自己
  if (targetUserId === session.userId && newRole === "user") {
    return { error: "不能降级自己的角色" };
  }

  try {
    await db
      .update(users)
      .set({ role: newRole })
      .where(eq(users.id, targetUserId));
    revalidatePath("/admin/users");
    return { success: true };
  } catch (err) {
    console.error("changeUserRoleAction error:", err);
    return { error: "操作失败,请重试" };
  }
}
