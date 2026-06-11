import { eq } from "drizzle-orm";
import { apiKeys, apps, budgets, teams, users } from "@cloudllm/db";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import BudgetsClient from "./budgets-client";
import type { SubjectOption } from "./actions";

export interface BudgetRow {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  period: string;
  limitAmountCny: string;
  usedAmountCny: string;
  remainCny: string;
  periodStart: Date | null;
  alertThreshold: string | null;
  status: string;
  createdAt: Date;
}

export default async function AdminBudgetsPage() {
  await requireAdmin();

  // Fetch all budgets
  const rawBudgets = await db
    .select({
      id: budgets.id,
      subjectType: budgets.subjectType,
      subjectId: budgets.subjectId,
      period: budgets.period,
      limitAmountCny: budgets.limitAmountCny,
      usedAmountCny: budgets.usedAmountCny,
      periodStart: budgets.periodStart,
      alertThreshold: budgets.alertThreshold,
      status: budgets.status,
      createdAt: budgets.createdAt,
    })
    .from(budgets)
    .orderBy(budgets.createdAt);

  // Resolve subject labels
  async function getLabel(type: string, id: string): Promise<string> {
    if (type === "user") {
      const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
      return rows[0]?.email ?? `user:${id.slice(0, 8)}`;
    }
    if (type === "team") {
      const rows = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, id)).limit(1);
      return rows[0]?.name ?? `team:${id.slice(0, 8)}`;
    }
    if (type === "app") {
      const rows = await db.select({ name: apps.name }).from(apps).where(eq(apps.id, id)).limit(1);
      return rows[0]?.name ?? `app:${id.slice(0, 8)}`;
    }
    if (type === "key") {
      const rows = await db.select({ keyPrefix: apiKeys.keyPrefix, name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      const r = rows[0];
      if (r) return `${r.keyPrefix}... ${r.name ? `(${r.name})` : ""}`;
      return `key:${id.slice(0, 8)}`;
    }
    return `${type}:${id.slice(0, 8)}`;
  }

  const budgetRows: BudgetRow[] = await Promise.all(
    rawBudgets.map(async (b) => {
      const label = await getLabel(b.subjectType, b.subjectId);
      // Compute remain = limit - used (may be negative)
      const limitNum = parseFloat(b.limitAmountCny);
      const usedNum = parseFloat(b.usedAmountCny);
      const remain = (limitNum - usedNum).toFixed(6);
      return {
        id: b.id,
        subjectType: b.subjectType,
        subjectId: b.subjectId,
        subjectLabel: label,
        period: b.period,
        limitAmountCny: b.limitAmountCny,
        usedAmountCny: b.usedAmountCny,
        remainCny: remain,
        periodStart: b.periodStart,
        alertThreshold: b.alertThreshold,
        status: b.status,
        createdAt: b.createdAt,
      };
    }),
  );

  // Fetch subject options for create form
  const [userRows, teamRows, appRows, keyRows] = await Promise.all([
    db.select({ id: users.id, email: users.email }).from(users).where(eq(users.status, "active")),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.status, "active")),
    db.select({ id: apps.id, name: apps.name }).from(apps).where(eq(apps.status, "active")),
    db
      .select({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix, name: apiKeys.name })
      .from(apiKeys)
      .where(eq(apiKeys.status, "active")),
  ]);

  const subjectOptions: SubjectOption[] = [
    ...userRows.map((u) => ({ id: u.id, label: u.email, type: "user" as const })),
    ...teamRows.map((t) => ({ id: t.id, label: t.name, type: "team" as const })),
    ...appRows.map((a) => ({ id: a.id, label: a.name, type: "app" as const })),
    ...keyRows.map((k) => ({
      id: k.id,
      label: `${k.keyPrefix}... ${k.name ? `(${k.name})` : ""}`,
      type: "key" as const,
    })),
  ];

  return <BudgetsClient budgets={budgetRows} subjectOptions={subjectOptions} />;
}
