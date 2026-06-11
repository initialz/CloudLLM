import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { teams } from "@cloudllm/db";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import TeamDetailClient from "./team-detail-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TeamDetailPage({ params }: PageProps) {
  // v1.1: 团队详情仅管理员可访问;团队 member 管理区块已移除
  await requireAdmin();
  const { id: teamId } = await params;

  // Fetch team info
  const teamRows = await db
    .select({ id: teams.id, name: teams.name, status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (teamRows.length === 0) notFound();
  const team = teamRows[0]!;

  return (
    <TeamDetailClient
      team={team}
      teamId={teamId}
    />
  );
}
