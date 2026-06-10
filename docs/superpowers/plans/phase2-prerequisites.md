# Phase 2(Gateway 数据面)前置事项

来源:Phase 1 最终评审(2026-06-10)。写 Phase 2 计划时必须把以下项放进前几个任务,防止遗失。

1. **`createDb` 暴露连接句柄**:`packages/db/src/client.ts` 当前隐藏了 postgres.js 客户端——无法 `sql.end()` 优雅停机,也没有池参数(`max`/`idle_timeout`/`prepare`)。Gateway 与 worker 的生命周期管理是硬阻塞。改为返回 `{ db, sql }` 或等价形式。
2. **`api_keys.updated_at` 加 `$onUpdate`**:目前只有 `defaultNow()`,UPDATE 时不会变,列形同虚设。
3. **`cnyToMicro` 支持负数解析**:`microToCny` 能输出负数(台账冲正),但 `cnyToMicro` 的正则拒绝 `-1.5`——Phase 3 worker 从 PG 读回 `ledger_entries.amount_cny` 时会抛错。补对称支持 + 测试。
4. **渠道创建的 UUID 约定**:信封加密 AAD = `channels.id`,但 id 是 DB 生成的——Console 创建渠道时必须**应用侧生成 UUID** 再加密入库(或先插后更)。把该约定写进渠道创建代码与文档。
5. **Redis 基础设施**(净新增,预期内):余额缓存读写、Redis Stream 生产/消费封装。
6. **CI 流水线**:test + typecheck + drizzle drift check(`drizzle-kit generate` 应报 "No schema changes")。再加两个包之前建好。

次要(顺手做):
- `decryptSecret` 对 `JSON.parse` 返回 null/非对象时先给出明确错误,再走结构校验。
- `limit_amount_cny`/模型价格列考虑 `CHECK (>= 0)`。
- `usage_records.channel_id` FK 保持 `no action` 是有意的(渠道走 status 软禁用),在 schema 注释里写明。
