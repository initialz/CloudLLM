import { teams } from "@byok/db";
import { requireAdmin } from "../../lib/auth";
import { db } from "../../lib/db";
import TeamsClient from "./teams-client";

export default async function TeamsPage() {
  await requireAdmin();

  // v1.1: 管理员查看所有团队(team_members 不再使用)
  const teamList = await db
    .select({
      id: teams.id,
      name: teams.name,
      status: teams.status,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .orderBy(teams.createdAt);

  return <TeamsClient teams={teamList} />;
}
