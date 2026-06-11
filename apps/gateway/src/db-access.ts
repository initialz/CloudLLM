import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { apiKeys, apps, budgets, channels, modelChannels, models, type Db } from "@cloudllm/db";
import { cnyToMicro } from "@cloudllm/shared";
import type {
  AuthedKey, BudgetLoader, BudgetSubject, CatalogRepo, ChannelChoice, KeyRepo, ModelInfo,
} from "./types.js";

export class DrizzleKeyRepo implements KeyRepo {
  constructor(private db: Db) {}

  async findActiveByHash(keyHash: string): Promise<AuthedKey | null> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        ownerType: apiKeys.ownerType,
        ownerId: apiKeys.ownerId,
        allowedModels: apiKeys.allowedModels,
        auditEnabled: apiKeys.auditEnabled,
        teamId: apps.teamId,
      })
      .from(apiKeys)
      .leftJoin(apps, and(eq(apiKeys.ownerType, "app"), eq(apps.id, apiKeys.ownerId)))
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          eq(apiKeys.status, "active"),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      teamId: row.teamId ?? null,
      allowedModels: row.allowedModels,
      auditEnabled: row.auditEnabled,
    };
  }
}

export class DrizzleCatalogRepo implements CatalogRepo {
  constructor(private db: Db) {}

  async getModel(slug: string): Promise<ModelInfo | null> {
    const rows = await this.db
      .select()
      .from(models)
      .where(and(eq(models.slug, slug), eq(models.status, "active")))
      .limit(1);
    const m = rows[0];
    if (!m) return null;
    return {
      slug: m.slug,
      providerType: m.providerType,
      prices: {
        inputPerMTok: m.priceInputCny,
        outputPerMTok: m.priceOutputCny,
        cacheReadPerMTok: m.priceCacheReadCny,
        cacheWritePerMTok: m.priceCacheWriteCny,
      },
    };
  }

  async getChannelsForModel(slug: string): Promise<ChannelChoice[]> {
    return this.db
      .select({
        channelId: channels.id,
        baseUrl: channels.baseUrl,
        credentialEncrypted: channels.credentialEncrypted,
        upstreamModelId: modelChannels.upstreamModelId,
        priority: modelChannels.priority,
        weight: modelChannels.weight,
      })
      .from(modelChannels)
      .innerJoin(models, eq(models.id, modelChannels.modelId))
      .innerJoin(channels, eq(channels.id, modelChannels.channelId))
      .where(and(eq(models.slug, slug), eq(channels.status, "active")));
  }
}

export class DrizzleBudgetLoader implements BudgetLoader {
  constructor(private db: Db) {}

  async loadRemainingMicro(subject: BudgetSubject): Promise<bigint | null> {
    const rows = await this.db
      .select({
        remaining: sql<string>`(${budgets.limitAmountCny} - CASE
          WHEN ${budgets.period} = 'monthly'
           AND ${budgets.periodStart} IS NOT NULL
           AND date_trunc('month', ${budgets.periodStart}) < date_trunc('month', now())
          THEN 0
          ELSE ${budgets.usedAmountCny}
        END)::text`,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.subjectType, subject.type),
          eq(budgets.subjectId, subject.id),
          eq(budgets.status, "active"),
        ),
      );
    if (rows.length === 0) return null;
    // 同一主体可同时有 monthly 与 total 预算:取剩余最小者(任一耗尽即截断)
    let min: bigint | null = null;
    for (const row of rows) {
      const value = cnyToMicro(row.remaining);
      if (min === null || value < min) min = value;
    }
    return min;
  }
}
