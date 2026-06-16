-- 用户新增「真实姓名」字段。
-- 选 NOT NULL DEFAULT '':避免「未填」与「改成 null」歧义,与 users.rs 审计纪律一致。
-- SQLite 支持带常量默认值的 NOT NULL ADD COLUMN,现网平滑升级。
ALTER TABLE users ADD COLUMN real_name TEXT NOT NULL DEFAULT '';
