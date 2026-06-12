#!/usr/bin/env bash
# CloudLLM 镜像级 e2e 验收:构建单镜像,docker network 内连 mock 上游,
# 全链路(登录→建渠道/模型→签 Key→网关调用→报表对账→撤销→排水)逐项断言。
# 对账锚定:input 21 CNY/MTok × 1000 tok + output 105 CNY/MTok × 500 tok = 73500 micro。
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=cloudllm-e2e
APP=cloudllm-e2e-app
MOCK=cloudllm-e2e-mock
BASE=http://localhost:17100
COOKIE=$(mktemp)
PASS=0

say()  { printf '\n== %s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '   ✔ %s\n' "$*"; }
die()  { printf '   ✘ %s\n' "$*"; exit 1; }

cleanup() {
  docker rm -f "$APP" "$MOCK" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$COOKIE"
}
trap cleanup EXIT

say "构建镜像"
docker build -q -t cloudllm:e2e . >/dev/null
ok "镜像构建完成"

say "启动 mock 上游与 cloudllm"
docker network create "$NET" >/dev/null
docker run -d --name "$MOCK" --network "$NET" \
  -v "$PWD/deploy/e2e/mock_upstream.py:/mock.py:ro" \
  python:3.12-alpine python3 /mock.py >/dev/null
docker run -d --name "$APP" --network "$NET" -p 17100:7100 cloudllm:e2e >/dev/null
for i in $(seq 1 30); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && die "healthz 30s 未就绪"
  sleep 1
done
ok "healthz 200"

say "断言嵌入的是真实 UI(非占位页)"
# SPA 挂在 /admin 下(根路径是网关协议面,无 SPA fallback)
INDEX=$(curl -fsS "$BASE/admin/")
echo "$INDEX" | grep -q 'assets/index-' || die "index.html 缺 vite 产物指纹"
echo "$INDEX" | grep -q '尚未构建' && die "镜像内仍是占位页(build.rs 占位逻辑被触发)"
ok "真实 admin-ui 已嵌入"

say "用日志中的初始密码登录"
PW=$(docker logs "$APP" 2>&1 | sed -n 's/.*初始密码: \([A-Za-z0-9_-]*\)(.*/\1/p')
[ -n "$PW" ] || die "未在容器日志找到初始密码"
curl -fsS -c "$COOKIE" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@cloudllm.local\",\"password\":\"$PW\"}" \
  "$BASE/admin/api/login" >/dev/null || die "登录失败"
ok "登录成功"

say "建渠道(指向 mock)/模型(21/105 CNY/MTok)"
curl -fsS -b "$COOKIE" -H 'content-type: application/json' -d '{
  "provider_type":"openai","name":"e2e-mock",
  "base_url":"http://'"$MOCK"':9000/v1","credential":"mock-secret"}' \
  "$BASE/admin/api/channels" >/dev/null || die "建渠道失败"
curl -fsS -b "$COOKIE" -H 'content-type: application/json' -d '{
  "slug":"openai/gpt-test","provider_type":"openai","upstream_model":"gpt-test",
  "input_price_cny":"21","output_price_cny":"105"}' \
  "$BASE/admin/api/models" >/dev/null || die "建模型失败"
ok "渠道与模型就绪"

say "签发 Key(owner=admin,月度预算 100 CNY)"
ADMIN_ID=$(curl -fsS -b "$COOKIE" "$BASE/admin/api/users" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["users"][0]["id"])')
ISSUE=$(curl -fsS -b "$COOKIE" -H 'content-type: application/json' -d '{
  "name":"e2e","owner_type":"user","owner_id":"'"$ADMIN_ID"'",
  "budget_limit_cny":"100","budget_period":"monthly"}' "$BASE/admin/api/keys")
KEY=$(echo "$ISSUE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["plaintext"])')
KID=$(echo "$ISSUE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"]["id"])')
case "$KEY" in sk-cloudllm-*) ;; *) die "Key 前缀异常: $KEY";; esac
echo "$ISSUE" | python3 -c 'import json,sys; h=json.load(sys.stdin)["handout"]; assert "ANTHROPIC" in h or "base_url" in h' \
  || die "handout 内容异常"
ok "Key 签发,明文与 handout 正常"

say "网关调用(经 mock 上游)"
RESP=$(curl -fsS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "model":"openai/gpt-test","messages":[{"role":"user","content":"ping"}]}' \
  "$BASE/v1/chat/completions")
echo "$RESP" | python3 -c 'import json,sys; u=json.load(sys.stdin)["usage"]; assert u["prompt_tokens"]==1000 and u["completion_tokens"]==500' \
  || die "网关响应 usage 异常: $RESP"
ok "网关 200,usage 透传 1000/500"

say "报表对账(结算异步,重试 ≤10s)"
WANT_COST=73500
for i in $(seq 1 10); do
  ROWS=$(curl -fsS -b "$COOKIE" "$BASE/admin/api/reports?dimension=model&from=0&to=4102444800")
  GOT=$(echo "$ROWS" | python3 -c 'import json,sys
rows=json.load(sys.stdin)["rows"]
print(rows[0]["cost_micro"] if rows else -1)')
  [ "$GOT" = "$WANT_COST" ] && break
  [ "$i" = 10 ] && die "对账失败:期望 $WANT_COST micro,实际 $GOT"
  sleep 1
done
echo "$ROWS" | python3 -c 'import json,sys
r=json.load(sys.stdin)["rows"][0]
assert r["requests"]==1 and r["input_tokens"]==1000 and r["output_tokens"]==500, r' \
  || die "报表行字段异常"
ok "对账一致:cost_micro=$WANT_COST,requests=1"

say "审计事件含 key.create"
curl -fsS -b "$COOKIE" "$BASE/admin/api/audit/events" | grep -q 'key.create' || die "audit 缺 key.create"
ok "管理审计在账"

say "撤销 Key 后网关 401"
curl -fsS -b "$COOKIE" -X POST "$BASE/admin/api/keys/$KID/revoke" >/dev/null || die "revoke 失败"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model":"openai/gpt-test","messages":[{"role":"user","content":"x"}]}' \
  "$BASE/v1/chat/completions")
[ "$CODE" = "401" ] || die "撤销后期望 401,实际 $CODE"
ok "撤销即失效(401)"

say "SIGTERM 优雅停机"
docker stop -t 35 "$APP" >/dev/null
EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
[ "$EXIT_CODE" = "0" ] || die "停机退出码 $EXIT_CODE ≠ 0"
docker logs "$APP" 2>&1 | grep -q '已优雅停机' || die "日志缺「已优雅停机」"
ok "排水后退出码 0"

printf '\n全部通过:%d 项断言。\n' "$PASS"
