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
