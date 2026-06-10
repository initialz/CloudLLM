# Phase 4(Console UI + 部署交付)前置事项

来源:Phase 3 最终评审(2026-06-10)。写 Phase 4 计划时必须纳入。

## 优先(评审定为 Important 的测试债)

1. **CI 加 PG+Redis services**:`.github/workflows/ci.yml` 加 services 容器,去掉 worker 集成测试的 `skipIf(CI)`——当前 CI 绿 ≠ 持久层绿。
2. **claimStale 真 Redis 覆盖**:pending 重试 → 投递超限 → DLQ 链路目前零自动化覆盖(ioredis-mock 不支持 xautoclaim);加 CI Redis service 后补一个真 Redis 测试。

## Console UI 约束(实现时必须遵守)

3. **渠道管理**:应用侧先生成 UUID 再 `encryptSecret`(AAD=channels.id);baseUrl 必须含 `/v1`;生效的 priority/weight 在 `model_channels`(channels 表同名列网关未用,UI 隐藏)。
4. **台账符号**:报表不得假设 amount_cny 恒正(冲正为负是既定约定)。
5. **月度预算时区**:PG now() 是 UTC(北京时间 1 日 08:00 重置);若要公司时区对齐,jobs.ts 与两处 CASE 加 `AT TIME ZONE`,Console 展示预算周期前定下来。
6. **DLQ 运维**:Console 可加 DLQ 查看/重放页(条目带 origin_id+reason),或先写 runbook。
7. **认证/RBAC**:admin / 团队 owner-admin-member(spec §9),AuthProvider 抽象预留 SSO。

## 部署交付(用户已定:docker compose 为主)

8. **Dockerfiles**(gateway/worker/console)+ 生产 compose(全部服务)+ README 部署文档。
9. **监控清单**(交给公司告警体系):`XLEN usage_events`(逼近 500k 裁剪线=开始丢计费)、`XLEN usage_events_dlq`>0、worker 消费滞后。

## 次要(顺手)

- e2e-seed 幂等化;worker 删除未用的 ioredis-mock 依赖;config 数值范围校验(如 MAX_DELIVERIES>0);OpenAI 429 type/retry-after;Key 查询 TtlCache(等压力数据);redis 本地端口 6380 建议。
