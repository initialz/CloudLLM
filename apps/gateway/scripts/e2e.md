# Gateway e2e 验收(真实 PG + Redis + 假上游)

前置:docker compose up -d postgres;本机 6379 已有 Redis(或 docker compose up -d redis);
.env 中 MASTER_KEY 已生成(openssl rand -base64 32)。

## 环境启动

1. 迁移+种子:`pnpm --filter @byok/db migrate && pnpm --filter @byok/db seed`
2. 假上游:`node apps/gateway/scripts/fake-upstream.mjs &`
3. 造数:`export $(grep -v '^#' .env | xargs) && pnpm --filter @byok/gateway e2e-seed`  
   输出示例:
   ```
   e2e Key: sk-wtg-xxxx
   Key ID: <uuid>
   OpenAI Channel ID: <uuid>
   Anthropic Channel ID: <uuid>
   ```
4. 设置环境变量:`export KEY=<e2e Key> OPENAI_CHAN=<OpenAI Channel ID> KEY_ID=<Key ID>`
5. 起网关:`export $(grep -v '^#' .env | xargs) && pnpm --filter @byok/gateway start &`

## 验收清单

- [x] OpenAI 非流式 → fake-openai
  ```bash
  curl -s localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-e2e","messages":[]}'
  # 预期响应: {"id":"fake-openai","model":"fake-real-model","usage":...}
  ```

- [x] Anthropic 非流式 → fake-anthropic
  ```bash
  curl -s localhost:8080/v1/messages \
    -H "x-api-key: $KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"anthropic/claude-e2e","messages":[],"max_tokens":8}'
  # 预期响应: {"id":"fake-anthropic","model":"fake-real-model","usage":...}
  ```

- [x] OpenAI 流式 → SSE + [DONE]
  ```bash
  curl -s localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-e2e","messages":[],"stream":true}'
  # 预期: data: {"choices":[...]} ... data: [DONE]
  ```

- [x] Redis Stream 事件:非流式 openai 的 costCny 应为 0.007350(100×21/1e6+50×105/1e6)
  ```bash
  redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning XRANGE usage_events - +
  # 预期第 1 条: "costCny":"0.007350"
  ```

- [x] 余额递减:`redis-cli GET bal:key:<keyId>` 随调用递减
  ```bash
  redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning GET "bal:key:$KEY_ID"
  # 预算 0.05 元 = 50000 micro-CNY;每次 OpenAI 调用扣 7350 micro
  ```

- [x] 预算截断:连续调用直至 429 budget_exhausted
  ```bash
  for i in $(seq 1 10); do
    http_code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8080/v1/chat/completions \
      -H "Authorization: Bearer $KEY" \
      -H 'content-type: application/json' \
      -d '{"model":"openai/gpt-e2e","messages":[]}')
    echo "Call $i: HTTP $http_code"
    [ "$http_code" = "429" ] && break
  done
  # 预期:约第 7 次出现 429 {"error":{"code":"budget_exhausted",...}}
  ```

- [x] 错误 Key → 401
  ```bash
  curl -s -w "\nHTTP: %{http_code}" localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer sk-wtg-INVALID_KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-e2e","messages":[]}'
  # 预期: HTTP 401 {"error":{"code":"invalid_api_key",...}}
  ```

- [x] 停掉假上游 → 502 + `redis-cli EXISTS cooldown:<channelId>` = 1
  ```bash
  kill $(lsof -ti tcp:9100)
  curl -s -w "\nHTTP: %{http_code}" localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-e2e","messages":[]}'
  # 预期: HTTP 502
  redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning EXISTS "cooldown:$OPENAI_CHAN"
  # 预期: 1
  ```

## 清理

```bash
kill $(lsof -ti tcp:9100) 2>/dev/null  # fake-upstream
kill $(lsof -ti tcp:8080) 2>/dev/null  # gateway
```

---

## Phase 3 worker 验收

### 前置

除 Phase 2 环境外,额外启动 worker,并开启测试 Key 的审计标志:

```bash
# 确保 audit_enabled=true(使 gateway 在事件中携带 audit 字段)
docker exec byok-postgres-1 psql -U byok -d byok \
  -c "UPDATE api_keys SET audit_enabled=true WHERE id='$KEY_ID';"

# 启动 worker
export $(grep -v '^#' .env | xargs)
node apps/worker/dist/index.js > /tmp/worker.log 2>&1 &
# 预期 /tmp/worker.log 第 1 行: worker 启动:stream=usage_events group=console-worker consumer=<hostname>-<pid>
```

### 验收项 1:发 2 次调用(含 audit)

```bash
# 调用 1: OpenAI 非流式
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-e2e","messages":[]}'
# 预期: {"id":"fake-openai","model":"fake-real-model","usage":{"prompt_tokens":100,"completion_tokens":50}}

# 调用 2: Anthropic 非流式
curl -s localhost:8080/v1/messages \
  -H "x-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-e2e","messages":[],"max_tokens":8}'
# 预期: {"id":"fake-anthropic","model":"fake-real-model","usage":{"input_tokens":80,"output_tokens":40}}
```

### 验收项 2:worker 落库——usage_records / ledger_entries / budgets

```bash
# usage_records:event_id 非空、costCny 正确
docker exec byok-postgres-1 psql -U byok -d byok \
  -c "SELECT model_slug, cost_cny, event_id, status FROM usage_records WHERE key_id='$KEY_ID' ORDER BY created_at DESC LIMIT 5;"
# 预期: openai/gpt-e2e → cost_cny=0.007350; anthropic/claude-e2e → cost_cny=0.005880; event_id 非空

# ledger_entries:key + user 两层各一条
docker exec byok-postgres-1 psql -U byok -d byok \
  -c "SELECT le.subject_type, le.amount_cny FROM ledger_entries le JOIN usage_records ur ON le.usage_record_id=ur.id WHERE ur.key_id='$KEY_ID' ORDER BY le.subject_type;"
# 预期: key/0.007350、key/0.005880、user/0.007350、user/0.005880

# budgets.used_amount_cny 累加
docker exec byok-postgres-1 psql -U byok -d byok \
  -c "SELECT used_amount_cny, limit_amount_cny FROM budgets WHERE subject_id='$KEY_ID';"
# 预期: used_amount_cny >= 0.013230 (0.007350+0.005880)
```

### 验收项 3:XPENDING = 0(worker 全部 ack)

```bash
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning XPENDING usage_events console-worker
# 预期: 0
```

联调实测输出:
```
0
```

### 验收项 4:余额校正——bal 键被 worker SET 为精确 (limit-used) micro

```bash
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning GET "bal:key:$KEY_ID"
# 预期: (limit_amount_cny - used_amount_cny) 换算为 micro-CNY 整数
# 例:limit=0.050000 CNY=50000 micro;used=0.013230 CNY=13230 micro → bal=36770
# worker SET 的值精确匹配 PG,不是 gateway DECRBY 的近似值
```

联调实测:
- limit=0.050000 CNY = 50000 micro
- used=0.013230 CNY = 13230 micro
- `GET bal:key:efc7090b-3731-4c71-8bd4-ce8ef45de457` → **36770** (= 50000 - 13230,精确)

### 验收项 5:request_logs 审计行(含过期时间)

```bash
docker exec byok-postgres-1 psql -U byok -d byok \
  -c "SELECT rl.id, rl.expires_at, (rl.expires_at - now()) AS ttl FROM request_logs rl JOIN usage_records ur ON rl.usage_record_id=ur.id WHERE ur.key_id='$KEY_ID';"
# 预期: 2 行;expires_at = 调用时刻 + 30d;ttl ≈ 29d 23h
```

联调实测:
```
 expires_at                   | ttl
 2026-07-10 10:31:17.765+00   | 29 days 23:59:13
 2026-07-10 10:31:17.774+00   | 29 days 23:59:13
```

### 验收项 6:持久性验证——P2 非持久缺口已闭合

```bash
# 步骤 1:DEL bal 键模拟 TTL 过期
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning DEL "bal:key:$KEY_ID"
# 预期: 1(已删除)

# 步骤 2:再次调用——gateway 从 PG 重建余额(含历史消费)
curl -s -w "\nHTTP: %{http_code}" localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-e2e","messages":[]}'
# 预期: HTTP 200(余额仍充足时)或 HTTP 429(余额耗尽时)
# 关键:gateway 从 PG 的 used_amount_cny 重建余额,包含历史消费,无法绕过

# 步骤 3:连续调用直至预算耗尽
for i in $(seq 1 10); do
  http_code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8080/v1/chat/completions \
    -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"openai/gpt-e2e","messages":[]}')
  echo "Call $i: HTTP $http_code"
  [ "$http_code" = "429" ] && break
done
# 预期:DEL 后重建的余额包含历史消费,约 3-4 次即 429;
# 若 P2 未修复,DEL 会清零余额让无限调用——但此处 PG 持久数据保证了 429
```

联调实测:DEL 后首次 200(从 PG 重建 36770 micro),再调 4 次触发 429:
```
Call 1: HTTP 200
Call 2: HTTP 200
Call 3: HTTP 200
Call 4: HTTP 200
Call 5: HTTP 200
Call 6: HTTP 429  ← budget_exhausted(PG 持久余额有效)
```

**结论:P2 非持久缺口已闭合。** DEL Redis 键后,gateway 从 PG 读取历史消费重建余额,budget_exhausted 判断基于持久数据,不可绕过。

### 验收项 7:DLQ 路径

```bash
# 注入畸形事件
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning XADD usage_events '*' payload 'not-json'

# 等待 ~5s,观察 worker 日志
sleep 5 && grep "死信" /tmp/worker.log
# 预期: 事件 <entry_id> 送死信: handler 判定不可处理

# 验证 DLQ 有条目
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning XRANGE usage_events_dlq - +
# 预期: 有 1 条, payload=not-json, reason=handler 判定不可处理

# 验证畸形事件已 ack(不留 PENDING)
redis-cli -a "<REDIS_PASSWORD>" --no-auth-warning XPENDING usage_events console-worker
# 预期: 0
```

联调实测:
```
# worker 日志:
事件 1781087565854-0 送死信: handler 判定不可处理

# XRANGE usage_events_dlq - +:
1781087565854-0
payload    not-json
origin_id  1781087565854-0
reason     handler 判定不可处理

# XPENDING: 0
```

### 清理

```bash
pkill -f "fake-upstream.mjs" 2>/dev/null
pkill -f "gateway/dist/index.js" 2>/dev/null
pkill -f "worker/dist/index.js" 2>/dev/null
echo "all processes terminated"
```
