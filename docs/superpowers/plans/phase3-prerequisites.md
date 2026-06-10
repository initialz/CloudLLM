# Phase 3(Console worker + 定时任务)前置事项

来源:Phase 2 最终评审(2026-06-10)。写 Phase 3 计划时必须纳入。

## 关键认知

**Phase 2 单独部署时预算执行是"非持久"的**:PG `used_amount_cny` 无人更新,`bal:` 键 60s 过期后从过期 PG 数据重建 → 预算实质重置。Phase 3 worker 落库+校正 Redis 才闭合这个环。在 worker 上线前,网关不能当生产级预算执行用。

## 必做清单

1. **消费 `usage_events`**:XREADGROUP 消费组 + 启动时 `XGROUP CREATE ... MKSTREAM`;pending/重试;PG 事务提交后才 ack。
2. **契约提取**:把 UsageEvent 类型与 Redis 键约定(`bal:{type}:{id}`、哨兵 `"u"`、`cooldown:{id}`、流名 `USAGE_STREAM`)从 `apps/gateway/src/types.ts`/`redis-stores.ts` 提取到 `@byok/shared`,gateway 与 worker 共用。
3. **落库链**:usage_records + ledger_entries(从 keyId 复刻 `subjectsForKey` 推导主体)→ 更新 `budgets.used_amount_cny` → **SET 校正对应 `bal:` 键(带 TTL)**。
4. **月度预算重置 job**:period_start/计数真重置(公司时区月初对齐);gateway 读侧的翻月 CASE 只是兜底。
5. **审计链**:audit 事件 → request_logs(带 expires_at)+ TTL 清理 job。
6. **监控**:usage_events XLEN 告警(MAXLEN ~500k 裁剪线,超过意味着开始丢计费事件)、worker 消费滞后告警。
7. **渠道管理(Phase 4 UI 也要遵守)**:应用侧先生成 UUID 再 encryptSecret(AAD=channels.id);baseUrl 必须含 `/v1`;路由生效的 priority/weight 在 model_channels 表(channels 表同名列当前未被网关使用)。
8. **CI 流水线**(P2 遗留):test/typecheck/build/drizzle drift check。

## 次要(顺手做)

- Key 查询加 TtlCache(~30s,撤销延迟≤TTL,需同时缓存负查询)——等 PG 压力数据再决定。
- OpenAI 429 响应的 type 用 insufficient_quota + retry-after 头。
- decryptSecret 对 JSON.parse 非对象先给明确错误。
- e2e-seed 幂等化(重复运行不累积渠道)。
- 本机开发:docker-compose 的 redis 端口与本机已有 flow-redis(6379)冲突,建议映射 6380 并同步 .env.example 的 REDIS_URL 说明。
