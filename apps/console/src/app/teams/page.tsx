import { eq } from "drizzle-orm";
import Link from "next/link";
import { teamMembers, teams } from "@byok/db";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";
import TeamsClient from "./teams-client";

export default async function TeamsPage() {
  const session = await requireUser();
  const isAdmin = session.role === "admin";

  let teamList: { id: string; name: string; status: string; createdAt: Date }[];

  if (isAdmin) {
    // Admin sees all teams
    teamList = await db
      .select({
        id: teams.id,
        name: teams.name,
        status: teams.status,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .orderBy(teams.createdAt);
  } else {
    // Regular user: only teams they belong to
    teamList = await db
      .select({
        id: teams.id,
        name: teams.name,
        status: teams.status,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, session.userId))
      .orderBy(teams.createdAt);
  }

  return <TeamsClient teams={teamList} isAdmin={isAdmin} />;
}
