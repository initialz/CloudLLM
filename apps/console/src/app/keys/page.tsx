import { and, eq } from "drizzle-orm";
import { apiKeys, models, users, teams, apps } from "@byok/db";
import { requireUser } from "../../lib/auth";
import { db } from "../../lib/db";
import KeysClient from "./keys-client";

interface KeysPageProps {
  searchParams: Promise<{ ownerType?: string; ownerId?: string }>;
}

export default async function KeysPage({ searchParams }: KeysPageProps) {
  const session = await requireUser();
  const isAdmin = session.role === "admin";

  // Admin 可通过 searchParams 预筛:ownerType / ownerId
  const params = await searchParams;
  const filterOwnerType =
    isAdmin && params.ownerType && ["user", "team", "app"].includes(params.ownerType)
      ? (params.ownerType as "user" | "team" | "app")
      : undefined;
  const filterOwnerId = isAdmin && params.ownerId ? params.ownerId : undefined;

  // 查询可见 key 列表
  const selectColumns = {
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    name: apiKeys.name,
    ownerType: apiKeys.ownerType,
    ownerId: apiKeys.ownerId,
    allowedModels: apiKeys.allowedModels,
    auditEnabled: apiKeys.auditEnabled,
    expiresAt: apiKeys.expiresAt,
    status: apiKeys.status,
    createdAt: apiKeys.createdAt,
  };

  let keyRows;
  if (isAdmin) {
    // Admin: 全量或按 ownerType/ownerId 预筛
    const conditions = [];
    if (filterOwnerType) conditions.push(eq(apiKeys.ownerType, filterOwnerType));
    if (filterOwnerId) conditions.push(eq(apiKeys.ownerId, filterOwnerId));

    keyRows =
      conditions.length > 0
        ? await db
            .select(selectColumns)
            .from(apiKeys)
            .where(and(...conditions))
            .orderBy(apiKeys.createdAt)
        : await db.select(selectColumns).from(apiKeys).orderBy(apiKeys.createdAt);
  } else {
    keyRows = await db
      .select(selectColumns)
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.ownerType, "user"),
          eq(apiKeys.ownerId, session.userId),
        ),
      )
      .orderBy(apiKeys.createdAt);
  }

  // 查询 active 模型 slug
  const modelRows = await db
    .select({ slug: models.slug })
    .from(models)
    .where(eq(models.status, "active"));
  const modelSlugs = modelRows.map((r) => r.slug);

  // Admin 需要各实体列表供下拉
  let userList: { id: string; email: string }[] = [];
  let teamList: { id: string; name: string }[] = [];
  let appList: { id: string; name: string; teamId: string }[] = [];

  if (isAdmin) {
    userList = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.status, "active"));
    teamList = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.status, "active"));
    appList = await db
      .select({ id: apps.id, name: apps.name, teamId: apps.teamId })
      .from(apps)
      .where(eq(apps.status, "active"));
  }

  return (
    <KeysClient
      initialKeys={keyRows}
      modelSlugs={modelSlugs}
      isAdmin={isAdmin}
      currentUserId={session.userId}
      userList={userList}
      teamList={teamList}
      appList={appList}
      initialFilterOwnerType={filterOwnerType}
      initialFilterOwnerId={filterOwnerId}
    />
  );
}
