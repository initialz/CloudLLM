-- CloudLLM v2 初始 schema。
-- 约定:id 一律 uuid 文本;时间一律 unix epoch 秒(INTEGER);金额一律 micro-CNY(INTEGER,1 CNY = 1,000,000)。

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  key_hash       TEXT NOT NULL UNIQUE,
  key_prefix     TEXT NOT NULL,
  name           TEXT NOT NULL,
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('user', 'team')),
  owner_id       TEXT NOT NULL,
  allowed_models TEXT,            -- JSON 数组;NULL = 不限模型
  audit          INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     INTEGER NOT NULL
);

CREATE TABLE channels (
  id                   TEXT PRIMARY KEY,  -- uuid,同时是凭证信封加密的 AAD
  provider_type        TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic')),
  name                 TEXT NOT NULL,
  base_url             TEXT NOT NULL,     -- 应用层校验以 /v1 结尾
  credential_encrypted BLOB NOT NULL,
  weight               INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'cooldown')),
  cooldown_until       INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE models (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL UNIQUE,   -- 客户端可见模型名
  provider_type           TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic')),
  upstream_model          TEXT NOT NULL,          -- 转发时替换的真实模型名
  input_price_micro       INTEGER NOT NULL,       -- micro-CNY / 1M tokens
  output_price_micro      INTEGER NOT NULL,
  cache_read_price_micro  INTEGER NOT NULL DEFAULT 0,
  cache_write_price_micro INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at              INTEGER NOT NULL
);

CREATE TABLE budgets (
  id              TEXT PRIMARY KEY,
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('key', 'user', 'team')),
  subject_id      TEXT NOT NULL,
  period          TEXT NOT NULL CHECK (period IN ('monthly', 'total')),
  limit_micro     INTEGER NOT NULL,
  used_micro      INTEGER NOT NULL DEFAULT 0,
  period_start    INTEGER NOT NULL,
  alert_threshold REAL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      INTEGER NOT NULL,
  UNIQUE (subject_type, subject_id, period)
);

CREATE TABLE usage_records (
  id                 TEXT PRIMARY KEY,
  key_id             TEXT NOT NULL,    -- 软引用 api_keys.id(不设 FK:Key 删除后账单保留)
  model_slug         TEXT NOT NULL,
  channel_id         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro         INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  ttft_ms            INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'upstream_error', 'client_abort')),
  error_code         TEXT,
  request_body       TEXT,             -- 仅 audit key,截断后存
  response_body      TEXT,             -- 仅 audit key,截断后存
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_usage_key_created ON usage_records (key_id, created_at);
CREATE INDEX idx_usage_created ON usage_records (created_at);

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  subject       TEXT,
  detail        TEXT,                  -- JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events (created_at);
