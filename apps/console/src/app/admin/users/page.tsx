import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { users } from "@cloudllm/db";
import { asc } from "drizzle-orm";
import UsersClient from "./users-client";

export default async function AdminUsersPage() {
  const session = await requireAdmin();

  const userList = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));

  return (
    <UsersClient
      users={userList}
      currentUserId={session.userId}
    />
  );
}
