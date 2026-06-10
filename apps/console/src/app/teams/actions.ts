"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { apps, teamMembers, teams, users } from "@byok/db";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";

export interface TeamActionResult {
  error?: string;
  success?: boolean;
  teamId?: string;
}

/** 创建团队(admin only) */
export async function createTeamAction(formData: FormData): Promise<TeamActionResult> {
  const session = await requireUser();
  if (session.role !== "admin") {
    return { error: "无权限:仅管理员可创建团队" };
  }

  const name = (formData.get("name") as string | null)?.trim() ?? "";
  if (!name) {
    return { error: "团队名称不能为空" };
  }

  try {
    const rows = await db
      .insert(teams)
      .values({ name, status: "active" })
      .returning({ id: teams.id });
    revalidatePath("/teams");
    return { success: true, teamId: rows[0]!.id };
  } catch (err) {
    console.error("createTeamAction error:", err);
    return { error: "创建失败,请重试" };
  }
}

/** 判断当前操作者是否是某团队的 owner/admin 或系统 admin */
async function canManageTeam(userId: string, isAdmin: boolean, teamId: string): Promise<boolean> {
  if (isAdmin) return true;
  const rows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (rows.length === 0) return false;
  return rows[0]!.role === "owner" || rows[0]!.role === "admin";
}

/** 向团队添加成员(by email) */
export async function addTeamMemberAction(
  teamId: string,
  formData: FormData,
): Promise<TeamActionResult> {
  const session = await requireUser();

  if (!(await canManageTeam(session.userId, session.role === "admin", teamId))) {
    return { error: "无权限:需要团队 owner/admin 或系统管理员" };
  }

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
    // UPSERT: 已存在则更新角色
    const existing = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
      .limit(1);

    if (existing.length > 0) {
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

/** 修改成员角色 */
export async function changeTeamMemberRoleAction(
  teamId: string,
  targetUserId: string,
  newRole: "owner" | "admin" | "member",
): Promise<TeamActionResult> {
  const session = await requireUser();

  if (!(await canManageTeam(session.userId, session.role === "admin", teamId))) {
    return { error: "无权限:需要团队 owner/admin 或系统管理员" };
  }

  try {
    await db
      .update(teamMembers)
      .set({ role: newRole })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)));
    revalidatePath(`/teams/${teamId}`);
    return { success: true };
  } catch (err) {
    console.error("changeTeamMemberRoleAction error:", err);
    return { error: "操作失败,请重试" };
  }
}

/** 移除成员 */
export async function removeTeamMemberAction(
  teamId: string,
  targetUserId: string,
): Promise<TeamActionResult> {
  const session = await requireUser();

  if (!(await canManageTeam(session.userId, session.role === "admin", teamId))) {
    return { error: "无权限:需要团队 owner/admin 或系统管理员" };
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

/** 创建团队应用 */
export async function createTeamAppAction(
  teamId: string,
  formData: FormData,
): Promise<TeamActionResult> {
  const session = await requireUser();

  if (!(await canManageTeam(session.userId, session.role === "admin", teamId))) {
    return { error: "无权限:需要团队 owner/admin 或系统管理员" };
  }

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

/** 停用应用 */
export async function disableTeamAppAction(
  teamId: string,
  appId: string,
): Promise<TeamActionResult> {
  const session = await requireUser();

  if (!(await canManageTeam(session.userId, session.role === "admin", teamId))) {
    return { error: "无权限:需要团队 owner/admin 或系统管理员" };
  }

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
