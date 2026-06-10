import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const cny = (name: string) => numeric(name, { precision: 18, scale: 6 });

// ── 组织 ────────────────────────────────────────────────

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const teams = pgTable("teams", {
  id: id(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const apps = pgTable("apps", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id),
  name: text("name").notNull(),
  env: text("env", { enum: ["prod", "dev"] }).notNull().default("prod"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

// ── Key 与预算 ──────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    ownerType: text("owner_type", { enum: ["user", "team", "app"] }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name"),
    /** null = 不限制 */
    allowedModels: text("allowed_models").array(),
    auditEnabled: boolean("audit_enabled").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "disabled", "revoked"] })
      .notNull()
      .default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_owner_idx").on(t.ownerType, t.ownerId),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    subjectType: text("subject_type", { enum: ["user", "team", "app", "key"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    period: text("period", { enum: ["monthly", "total"] }).notNull(),
    limitAmountCny: cny("limit_amount_cny").notNull(),
    usedAmountCny: cny("used_amount_cny").notNull().default("0"),
    /** monthly 时为当前周期起点 */
    periodStart: timestamp("period_start", { withTimezone: true }),
    /** 0~1,如 0.8 表示 80% 告警 */
    alertThreshold: numeric("alert_threshold", { precision: 5, scale: 4 }),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("budgets_subject_idx").on(t.subjectType, t.subjectId)],
);

// ── 供应商 / 渠道 / 模型 ─────────────────────────────────

export const providers = pgTable("providers", {
  id: id(),
  type: text("type", { enum: ["openai", "anthropic"] }).notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const channels = pgTable("channels", {
  id: id(),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  /** 信封加密 JSON(@byok/shared encryptSecret 产物,AAD=本行 id) */
  credentialEncrypted: text("credential_encrypted").notNull(),
  priority: integer("priority").notNull().default(0),
  weight: integer("weight").notNull().default(1),
  status: text("status", { enum: ["active", "disabled", "cooldown"] })
    .notNull()
    .default("active"),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  createdAt: createdAt(),
});

export const models = pgTable("models", {
  id: id(),
  /** 对外统一目录名,如 anthropic/claude-opus-4-8 */
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  providerType: text("provider_type", { enum: ["openai", "anthropic"] }).notNull(),
  /** 单价:每百万 token 的 CNY */
  priceInputCny: cny("price_input_cny").notNull(),
  priceOutputCny: cny("price_output_cny").notNull(),
  priceCacheReadCny: cny("price_cache_read_cny").notNull().default("0"),
  priceCacheWriteCny: cny("price_cache_write_cny").notNull().default("0"),
  contextLength: integer("context_length"),
  capabilities: text("capabilities").array(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: createdAt(),
});

export const modelChannels = pgTable(
  "model_channels",
  {
    id: id(),
    modelId: uuid("model_id").notNull().references(() => models.id),
    channelId: uuid("channel_id").notNull().references(() => channels.id),
    /** 该渠道上的真实模型名 */
    upstreamModelId: text("upstream_model_id").notNull(),
    priority: integer("priority").notNull().default(0),
    weight: integer("weight").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("model_channels_pair_idx").on(t.modelId, t.channelId)],
);

// ── 用量 / 流水 / 审计 ──────────────────────────────────

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    keyId: uuid("key_id").notNull().references(() => apiKeys.id),
    modelSlug: text("model_slug").notNull(),
    channelId: uuid("channel_id").references(() => channels.id),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costCny: cny("cost_cny").notNull().default("0"),
    costSrcAmount: numeric("cost_src_amount", { precision: 18, scale: 6 }),
    costSrcCurrency: text("cost_src_currency"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    status: text("status", { enum: ["ok", "upstream_error", "rejected"] }).notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_records_key_time_idx").on(t.keyId, t.createdAt)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    subjectType: text("subject_type", { enum: ["user", "team", "app", "key"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    amountCny: cny("amount_cny").notNull(),
    usageRecordId: uuid("usage_record_id").references(() => usageRecords.id),
    balanceAfterCny: cny("balance_after_cny"),
    createdAt: createdAt(),
  },
  (t) => [index("ledger_subject_time_idx").on(t.subjectType, t.subjectId, t.createdAt)],
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: id(),
    usageRecordId: uuid("usage_record_id")
      .notNull()
      .unique()
      .references(() => usageRecords.id),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("request_logs_expires_idx").on(t.expiresAt)],
);
