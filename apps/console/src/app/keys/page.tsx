import { and, eq } from "drizzle-orm";
import { apiKeys, models, users, teams } from "@cloudllm/db";
import { requireAdmin } from "../../lib/auth";
import { db } from "../../lib/db";
import KeysClient from "./keys-client";

// 网关对外地址,由 server 端读 env 透传给客户端
const GATEWAY_PUBLIC_URL = process.env.GATEWAY_PUBLIC_URL ?? "";

interface KeysPageProps {
  searchParams: Promise<{ ownerType?: string; ownerId?: string }>;
}

export default async function KeysPage({ searchParams }: KeysPageProps) {
  // Key 管理仅管理员可访问(v1.1)
  const session = await requireAdmin();

  // 通过 searchParams 预筛:ownerType / ownerId(v1.1: app 选项已移除,仅 user/team)
  const params = await searchParams;
  const filterOwnerType =
    params.ownerType && ["user", "team"].includes(params.ownerType)
      ? (params.ownerType as "user" | "team")
      : undefined;
  const filterOwnerId = params.ownerId ? params.ownerId : undefined;

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

  // 全量或按 ownerType/ownerId 预筛
  const conditions = [];
  if (filterOwnerType) conditions.push(eq(apiKeys.ownerType, filterOwnerType));
  if (filterOwnerId) conditions.push(eq(apiKeys.ownerId, filterOwnerId));

  const keyRows =
    conditions.length > 0
      ? await db
          .select(selectColumns)
          .from(apiKeys)
          .where(and(...conditions))
          .orderBy(apiKeys.createdAt)
      : await db.select(selectColumns).from(apiKeys).orderBy(apiKeys.createdAt);

  // 查询 active 模型 slug
  const modelRows = await db
    .select({ slug: models.slug })
    .from(models)
    .where(eq(models.status, "active"));
  const modelSlugs = modelRows.map((r) => r.slug);

  // 归属实体列表:仅 user/team(v1.1 移除 app)
  const userList = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.status, "active"));
  const teamList = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.status, "active"));

  return (
    <KeysClient
      initialKeys={keyRows}
      modelSlugs={modelSlugs}
      currentUserId={session.userId}
      userList={userList}
      teamList={teamList}
      initialFilterOwnerType={filterOwnerType}
      initialFilterOwnerId={filterOwnerId}
      gatewayUrl={GATEWAY_PUBLIC_URL}
    />
  );
}
