"use server";

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { apps, teamMembers, teams, users } from "@cloudllm/db";
import { requireAdmin } from "../../lib/auth";
import { db } from "../../lib/db";

export interface TeamActionResult {
  error?: string;
  success?: boolean;
  teamId?: string;
}

/** 创建团队(admin only) */
export async function createTeamAction(formData: FormData): Promise<TeamActionResult> {
  const session = await requireAdmin();

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  if (!name) {
    return { error: "团队名称不能为空" };
  }

  try {
    const rows = await db
      .insert(teams)
      .values({ name, status: "active" })
      .returning({ id: teams.id });
    const teamId = rows[0]!.id;

    // 创建者自动成为 owner(team_members 表 v1.1 虽不再用于成员管理,
    // 但保留此插入以维持数据完整性,无害)
    await db.insert(teamMembers).values({
      teamId,
      userId: session.userId,
      role: "owner",
    });

    revalidatePath("/teams");
    return { success: true, teamId };
  } catch (err) {
    console.error("createTeamAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/**
 * 以下 actions 在 v1.1 中 UI 层已移除对应区块(隐藏而非删除),
 * 路由仍通过 requireAdmin 保护,未来恢复零成本。
 */

/**
 * 查询某团队的 owner 数量
 */
async function countTeamOwners(teamId: string): Promise<number> {
  const rows = await db
    .select({ cnt: count() })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")));
  return Number(rows[0]!.cnt);
}

/**
 * 查询某用户在某团队的当前角色,不存在返回 null
 */
async function getTeamMemberRole(
  teamId: string,
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const rows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows.length > 0 ? (rows[0]!.role as "owner" | "admin" | "member") : null;
}

/** 向团队添加成员(by email) — v1.1 UI 已隐藏 */
export async function addTeamMemberAction(
  teamId: string,
  formData: FormData,
): Promise<TeamActionResult> {
  const session = await requireAdmin();

  const email = (formData.get("email") as string | null)?.trim().toLowerCase() ?? "";
  const role = (formData.get("role") as string | null) ?? "member";

  if (!email) {
    return { error: "请输入邮箱" };
  }
  if (!["owner", "admin", "member"].includes(role)) {
    return { error: "无效角色" };
  }

  const userRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (userRows.length === 0) {
    return { error: "用户不存在" };
  }
  const targetUserId = userRows[0]!.id;

  try {
    const existing = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
      .limit(1);

    if (existing.length > 0) {
      const currentRole = await getTeamMemberRole(teamId, targetUserId);
      if (currentRole === "owner" && role !== "owner") {
        const ownerCount = await countTeamOwners(teamId);
        if (ownerCount <= 1) {
          return { error: "团队至少保留一名 owner" };
        }
      }
      await db
        .update(teamMembers)
        .set({ role: role as "owner" | "admin" | "member" })
        .where(
          and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)),
        );
    } else {
      await db.insert(teamMembers).values({
        teamId,
        userId: targetUserId,
        role: role as "owner" | "admin" | "member",
      });
    }
    revalidatePath(`/teams/${teamId}`);
    return { success: true };
  } catch (err) {
    console.error("addTeamMemberAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 修改成员角色 — v1.1 UI 已隐藏 */
export async function changeTeamMemberRoleAction(
  teamId: string,
  targetUserId: string,
  newRole: string,
): Promise<TeamActionResult> {
  const session = await requireAdmin();

  if (!["owner", "admin", "member"].includes(newRole)) {
    return { error: "无效角色" };
  }

  const currentRole = await getTeamMemberRole(teamId, targetUserId);
  if (currentRole === "owner" && newRole !== "owner") {
    const ownerCount = await countTeamOwners(teamId);
    if (ownerCount <= 1) {
      return { error: "团队至少保留一名 owner" };
    }
  }

  try {
    await db
      .update(teamMembers)
      .set({ role: newRole as "owner" | "admin" | "member" })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)));
    revalidatePath(`/teams/${teamId}`);
    return { success: true };
  } catch (err) {
    console.error("changeTeamMemberRoleAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 移除成员 — v1.1 UI 已隐藏 */
export async function removeTeamMemberAction(
  teamId: string,
  targetUserId: string,
): Promise<TeamActionResult> {
  const session = await requireAdmin();

  const currentRole = await getTeamMemberRole(teamId, targetUserId);
  if (currentRole === "owner") {
    const ownerCount = await countTeamOwners(teamId);
    if (ownerCount <= 1) {
      return { error: "团队至少保留一名 owner" };
    }
  }

  try {
    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)));
    revalidatePath(`/teams/${teamId}`);
    return { success: true };
  } catch (err) {
    console.error("removeTeamMemberAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 创建团队应用 — v1.1 UI 已隐藏 */
export async function createTeamAppAction(
  teamId: string,
  formData: FormData,
): Promise<TeamActionResult> {
  const session = await requireAdmin();

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const env = (formData.get("env") as string | null) ?? "prod";

  if (!name) {
    return { error: "应用名称不能为空" };
  }
  if (!["prod", "dev"].includes(env)) {
    return { error: "无效环境类型" };
  }

  try {
    const rows = await db
      .insert(apps)
      .values({ teamId, name, env: env as "prod" | "dev", status: "active" })
      .returning({ id: apps.id });
    revalidatePath(`/teams/${teamId}`);
    return { success: true, teamId: rows[0]!.id };
  } catch (err) {
    console.error("createTeamAppAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/** 停用应用 — v1.1 UI 已隐藏 */
export async function disableTeamAppAction(
  teamId: string,
  appId: string,
): Promise<TeamActionResult> {
  const session = await requireAdmin();

  try {
    await db
      .update(apps)
      .set({ status: "disabled" })
      .where(and(eq(apps.id, appId), eq(apps.teamId, teamId)));
    revalidatePath(`/teams/${teamId}`);
    return { success: true };
  } catch (err) {
    console.error("disableTeamAppAction error:", err);
    return { error: "操作失败,请重试" };
  }
}
