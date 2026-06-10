# BYOK 网关（Bring Your Own Key Gateway）

企业级 AI API 代理网关：将上游 LLM API（OpenAI、Anthropic 等）封装为统一接口，支持自定义 Key 签发、成本预算管控、用量报表与审计日志。

---

## 架构

```
调用方 (curl / OpenAI SDK / Claude Code)
         │  Bearer byok_xxxx
         ▼
┌─────────────────────────┐
│  Gateway (Hono, :8080)  │  ← Key 认证 / 预算检查 / 上游路由
│  apps/gateway           │    结算事件写入 Redis Stream
└──────────┬──────────────┘
           │ Redis Stream (usage_events)
           ▼
┌─────────────────────────┐
│  Worker (消费者, BG)     │  ← 异步结算 usage_records / 审计日志
│  apps/worker            │    定时重置月度预算 / 清理审计过期
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  PostgreSQL (共享库)     │  ← 全部业务数据
│  packages/db (Drizzle)  │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Console (Next.js, :3000)│  ← 管理后台 Web UI
│  apps/console            │    登录 / Key 管理 / 渠道 / 预算 / 报表
└─────────────────────────┘
```

---

## 功能清单

| 模块 | 功能 |
|------|------|
| Key 管理 | 签发/撤销 API Key，支持 user/team/app 三级归属，模型白名单，可选过期时间 |
| 预算管控 | monthly/total 两种周期预算，微元精度（CNY 6 位小数），超限 429 |
| 渠道路由 | 多上游渠道，per-model 优先级/权重，凭证 AES-256-GCM 信封加密 |
| 用量报表 | 按模型/Key/天聚合，成本精确到微元 |
| 审计日志 | 可选 request/response 内容留存，可配保留天数 |
| 组织管理 | 用户 / 团队 / 应用三级组织，RBAC 两级（admin / user + 团队角色） |

---

## 快速开始（本地开发）

### 1. 依赖

- Node.js >= 22
- pnpm >= 10.12.1（`corepack enable` 后自动激活）
- Docker（PostgreSQL + Redis）

### 2. 启动 PG + Redis（本地 dev 用）

```bash
docker compose up -d   # 使用根目录 docker-compose.yml
```

### 3. 数据库迁移 & 种子数据

```bash
# 迁移
pnpm --filter @byok/db migrate

# 种子（首次；幂等可重复跑）
pnpm --filter @byok/db seed
# 默认管理员：admin@example.com / change-me-now
# 可通过环境变量覆盖：SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
```

### 4. 启动三个服务

```bash
# 终端 1：Gateway（:8080）
pnpm --filter @byok/gateway dev

# 终端 2：Worker（消费后台）
pnpm --filter @byok/worker dev 2>/dev/null || node --watch apps/worker/src/index.ts

# 终端 3：Console（:3000）
pnpm --filter @byok/console dev
```

### 5. 验证

```bash
curl localhost:8080/healthz          # 200 OK
open http://localhost:3000/login     # Console 登录
```

---

## 生产部署（Docker Compose）

### 1. 准备 .env

```bash
cd deploy
cp .env.prod.example .env
chmod 600 .env   # 限制读权限，防止其他用户读取敏感凭证
```

编辑 `.env`，填入由下方命令生成的随机值：

```bash
# PostgreSQL 密码
openssl rand -hex 24

# 信封加密主密钥（32 字节 base64）
openssl rand -base64 32

# Console 会话签名密钥
openssl rand -hex 32
```

`.env` 已在 `.gitignore` 中，**不会被提交到版本库**。

### 2. 启动（宿主端口验收用 18080/13000；默认 8080/3000）

```bash
cd deploy
# 验收用命令（避免与本机端口冲突）：
GATEWAY_PORT=18080 CONSOLE_PORT=13000 \
  docker compose -f docker-compose.prod.yml --env-file .env up -d --build

# 或直接在 .env 中设置 GATEWAY_PORT / CONSOLE_PORT
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

启动顺序：postgres → redis（healthcheck）→ migrate（一次性）→ gateway / worker / console。

### 3. 查看服务状态

```bash
docker compose -f docker-compose.prod.yml ps
```

期望输出：migrate 为 Exited(0)，其余服务为 running。

### 4. 初始化 seed（首次部署）

```bash
# 方式 1（推荐）：使用 worker 镜像一次性运行 seed
# DATABASE_URL 由 worker 服务定义自动注入，无需重复传递
docker compose -f docker-compose.prod.yml --env-file .env \
  run --rm \
  -e SEED_ADMIN_EMAIL=admin@yourcompany.com \
  -e SEED_ADMIN_PASSWORD='use-a-strong-password' \
  worker node node_modules/@byok/db/dist/seed.js

# 方式 2：直接 psql 手动插入（最简单兜底）
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U byok -d byok \
  -c "INSERT INTO users (id, email, password_hash, role) VALUES (...) ON CONFLICT DO NOTHING;"
```

> 推荐方式 1：seed.js 会自动 hashPassword（scrypt），方式 2 需自行处理哈希。

### 5. 验证

```bash
curl localhost:${GATEWAY_PORT:-8080}/healthz   # 200
curl -I localhost:${CONSOLE_PORT:-3000}/login  # 200 + HTML
```

### 6. 停止（保留数据卷）

```bash
docker compose -f docker-compose.prod.yml down
# 如需清除数据：docker compose ... down -v
```

---

## 调用方接入示例

Console 登录后，在 **Key 管理** 页签发 `byok_xxxx` 格式的 Key。

### OpenAI SDK（Python）

```python
from openai import OpenAI

client = OpenAI(
    api_key="byok_your_key_here",
    base_url="http://your-host:8080/v1",  # gateway 地址
)

response = client.chat.completions.create(
    model="gpt-4o",   # 需在 Console 渠道/模型中配置
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

### OpenAI SDK（Node.js / TypeScript）

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "byok_your_key_here",
  baseURL: "http://your-host:8080/v1",
});

const res = await client.chat.completions.create({
  model: "claude-3-5-sonnet-20241022",
  messages: [{ role: "user", content: "Hello" }],
});
```

### Claude Code / Claude CLI

```bash
# 设置环境变量，Claude Code 将请求转发至 BYOK Gateway
export ANTHROPIC_BASE_URL=http://your-host:8080
export ANTHROPIC_API_KEY=byok_your_key_here
claude "帮我写一个 hello world"
```

### curl（OpenAI 兼容）

```bash
curl http://your-host:8080/v1/chat/completions \
  -H "Authorization: Bearer byok_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "ping"}]
  }'
```

### curl（Anthropic Messages API 原生格式）

```bash
curl http://your-host:8080/v1/messages \
  -H "Authorization: Bearer byok_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

---

## 运维

### 数据库备份

```bash
# 备份 PostgreSQL 数据卷（pgdata）
docker compose -f deploy/docker-compose.prod.yml exec postgres \
  pg_dump -U byok byok | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# 恢复
gunzip < backup_xxx.sql.gz | \
  docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
  psql -U byok byok
```

### 监控 Redis Stream 积压

```bash
# 查看 usage_events 流长度（积压未消费条数）
docker compose -f deploy/docker-compose.prod.yml exec redis \
  redis-cli XLEN usage_events

# 查看 pending 条数（消费中但未 ACK）
docker compose -f deploy/docker-compose.prod.yml exec redis \
  redis-cli XPENDING usage_events console-worker - + 10

# 查看 DLQ（死信队列，投递次数超限的事件）
docker compose -f deploy/docker-compose.prod.yml exec redis \
  redis-cli XRANGE usage_events_dlq - + COUNT 20
```

> 正常情况 XLEN 应接近 0；DLQ 有条目需告警并人工检查原因。
> 注：时区全部使用 UTC，界面展示时请在客户端转换为本地时区（v1 现状，后续版本规划时区感知）。

### 密钥轮换

#### 轮换 SESSION_SECRET

SESSION_SECRET 仅用于签名 cookie，轮换后所有在线用户会话立即失效（需重新登录）。

```bash
# 1. 生成新 SECRET
openssl rand -hex 32

# 2. 更新 deploy/.env 中 SESSION_SECRET

# 3. 重启 console
docker compose -f deploy/docker-compose.prod.yml restart console
```

#### 轮换 MASTER_KEY（渠道凭证重加密）

MASTER_KEY 变更需要对所有渠道凭证重新加密，否则 gateway 无法解密上游 API Key。
建议步骤：

1. 在 Console **渠道管理** 页对每个渠道执行「轮换凭证」操作（界面录入明文凭证并以新 key 重加密）。
2. 更新 `.env` 中 `MASTER_KEY`。
3. 重启 gateway 和 console：`docker compose ... restart gateway console`。

### 升级流程

```bash
# 1. 拉最新代码
git pull

# 2. 重新构建并滚动重启（migrate 服务会自动执行增量迁移）
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  up -d --build --no-deps

# 3. 确认所有服务正常
docker compose -f deploy/docker-compose.prod.yml ps
curl localhost:${GATEWAY_PORT:-8080}/healthz
```

> **注意**：migrate 服务每次 `up --build` 时都会运行一次迁移（幂等）。确保备份数据后再执行大版本升级。

---

## 目录结构

```
byok/
├── apps/
│   ├── gateway/        # Hono API 网关（:8080）
│   │   ├── src/
│   │   └── Dockerfile
│   ├── worker/         # 结算/审计后台消费者
│   │   ├── src/
│   │   └── Dockerfile
│   └── console/        # Next.js 15 管理后台（:3000）
│       ├── src/
│       └── Dockerfile
├── packages/
│   ├── db/             # Drizzle schema、迁移、seed、migrate 入口
│   └── shared/         # 纯函数工具（Key 生成、加密、成本计算…）
├── deploy/
│   ├── docker-compose.prod.yml
│   └── .env.prod.example
├── docker-compose.yml  # 本地 dev 用（PG + Redis）
├── pnpm-workspace.yaml
└── README.md
```

---

## 许可

MIT License
