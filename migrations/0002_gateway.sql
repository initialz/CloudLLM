-- P2 数据面:补两列。
-- 1) api_keys.expires_at:Key 过期时间(unix epoch 秒);NULL = 永不过期。
--    P1 schema 漏列,鉴权需「status='active' AND (expires_at IS NULL OR expires_at > now)」。
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;

-- 2) channels.cooldown_level:指数退避级别。每次冷却 level+1;成功请求归零。
--    cooldown_until = now + min(base * 2^level, max)。
ALTER TABLE channels ADD COLUMN cooldown_level INTEGER NOT NULL DEFAULT 0;
