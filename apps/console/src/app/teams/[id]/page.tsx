import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { apps, teamMembers, teams, users } from "@byok/db";
import { requireUser } from "../../../lib/auth";
import { db } from "../../../lib/db";
import TeamDetailClient from "./team-detail-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TeamDetailPage({ params }: PageProps) {
  const session = await requireUser();
  const { id: teamId } = await params;

  // Fetch team info
  const teamRows = await db
    .select({ id: teams.id, name: teams.name, status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (teamRows.length === 0) notFound();
  const team = teamRows[0]!;

  // Check access: user must be in the team, or be a system admin
  const isAdmin = session.role === "admin";
  if (!isAdmin) {
    const memberRows = await db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, session.userId)))
      .limit(1);
    if (memberRows.length === 0) notFound();
  }

  // Check if current user can manage the team
  const membershipRow = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, session.userId)))
    .limit(1);
  const myRole = membershipRow[0]?.role ?? null;
  const canManage = isAdmin || myRole === "owner" || myRole === "admin";

  // Fetch members with user info
  const memberList = await db
    .select({
      userId: teamMembers.userId,
      role: teamMembers.role,
      createdAt: teamMembers.createdAt,
      email: users.email,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(teamMembers.createdAt);

  // Fetch apps
  const appList = await db
    .select({
      id: apps.id,
      name: apps.name,
      env: apps.env,
      status: apps.status,
      createdAt: apps.createdAt,
    })
    .from(apps)
    .where(eq(apps.teamId, teamId))
    .orderBy(apps.createdAt);

  return (
    <TeamDetailClient
      team={team}
      members={memberList}
      apps={appList}
      teamId={teamId}
      canManage={canManage}
      currentUserId={session.userId}
    />
  );
}
