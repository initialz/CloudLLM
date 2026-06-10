# BYOK 网关（Bring Your Own Key Gateway）

企业级 AI API 代理网关：将上游 LLM API（OpenAI、Anthropic 等）封装为统一接口，支持自定义 Key 签发、成本预算管控、用量报表与审计日志。

---

## 架构

```
调用方 (curl / OpenAI SDK / Claude Code)
         │  Bearer sk-wtg-xxxx
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
| Key 管理 | 管理员为成员签发/撤销 API Key（可归属团队），签发时可一并设预算，模型白名单，可选过期时间 |
| 预算管控 | monthly/total 两种周期预算，微元精度（CNY 6 位小数），超限 429 |
| 渠道路由 | 多上游渠道，per-model 优先级/权重，凭证 AES-256-GCM 信封加密 |
| 用量报表 | 按模型/Key/天聚合，成本精确到微元 |
| 审计日志 | 可选 request/response 内容留存，可配保留天数 |
| 组织管理 | 管理员账号 + 团队分组（成员不登录 Console，只持 Key 调用网关） |

---

## 快速开始（本地开发）

### 方式 A：Docker 全栈（推荐，免装 Node/pnpm）

只需 Docker，一条命令起全栈（postgres + redis + migrate + seed + gateway + worker + console）：

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

等待约 1 分钟（首次构建）。启动后验证：

```bash
curl localhost:8080/healthz            # {"ok":true}
open http://localhost:3000/login       # Console 登录页
```

默认管理员账号：`admin@example.com` / `change-me-now`

停止（保留数据卷，下次 up 不需重跑 migrate/seed）：

```bash
docker compose -f docker-compose.dev.yml down
```

> **端口说明**：dev compose 使用 `15432:5432`（postgres）和 `6380:6379`（redis）映射到宿主，
> 避免与本地已有 PG/Redis 冲突。容器内互联不受影响。

---

### 方式 B：pnpm 代码迭代（改代码 + 热重载）

适合正在开发某个服务时，可与方式 A 混合：用 compose 跑基础设施，只 pnpm dev 正在修改的服务。

#### 1. 依赖

- Node.js >= 22
- pnpm >= 10.12.1（`corepack enable` 后自动激活）
- Docker（PostgreSQL + Redis）

#### 2. 启动 PG + Redis（本地 dev 用）

```bash
docker compose up -d   # 使用根目录 docker-compose.yml（PG:5432, Redis:6379）
```

#### 3. 数据库迁移 & 种子数据

```bash
# 迁移
pnpm --filter @byok/db migrate

# 种子（首次；幂等可重复跑）
pnpm --filter @byok/db seed
# 默认管理员：admin@example.com / change-me-now
# 可通过环境变量覆盖：SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
```

#### 4. 启动三个服务

```bash
# 终端 1：Gateway（:8080）
pnpm --filter @byok/gateway dev

# 终端 2：Worker（消费后台）
pnpm --filter @byok/worker build && node apps/worker/dist/index.js

# 终端 3：Console（:3000）
pnpm --filter @byok/console dev
```

#### 5. 验证

```bash
curl localhost:8080/healthz          # 200 OK
open http://localhost:3000/login     # Console 登录
```

#### 混合模式（推荐进阶用法）

用 dev compose 跑基础设施和不修改的服务，pnpm dev 跑正在迭代的服务：

```bash
# 起基础设施 + gateway + worker（不改这些）
docker compose -f docker-compose.dev.yml up -d postgres redis gateway worker

# 本地热重载 console（正在迭代）
DATABASE_URL=postgres://byok:byok_dev@localhost:15432/byok \
  MASTER_KEY=/o4Hoi3CCed8CohTkzih2Ni634Os4g16ZHPNU8SXsx8= \
  SESSION_SECRET=8eaacf2d4f8f9d3019e9a3bab0ad343baba77f6a6af9cc2ce20990de0eb8cca5 \
  GATEWAY_PUBLIC_URL=http://localhost:8080 \
  pnpm --filter @byok/console dev
```

> 注意混合模式时，本地服务的端口（`:3000`）不能与 compose 中同服务冲突。
> 如需两者共存，可在 compose 中先 `docker compose -f docker-compose.dev.yml stop console`。

---

## 生产部署（Docker Compose）

> K8s 部署方式（多节点高可用、水平扩缩容）：见 [deploy/k8s/README.md](deploy/k8s/README.md)

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

## 成员接入（无需登录 Console）

成员不需要管理员账号，只需持有一个 API Key 即可直接调用网关。

**工作流（3 步）：**

1. **管理员签发 Key（可带预算）**：登录 Console → Key 管理 → 新建 Key，选择团队归属，可选设置月度/总额度预算。
2. **复制接入说明发给成员**：Key 签发成功后，点击"接入说明"按钮（或访问导航中的 **接入说明** 页面），复制生成好的配置说明，连同明文 Key 一并发给成员。
3. **成员按说明配置工具**：成员收到说明后，按对应工具（Claude Code / OpenAI SDK / curl 等）的配置步骤操作，无需登录 Console。

详细示例见下方 [调用方接入示例](#调用方接入示例)。

---

## 调用方接入示例

Console 登录后，在 **Key 管理** 页签发 `sk-wtg-xxxx` 格式的 Key。

### OpenAI SDK（Python）

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-wtg-your-key-here",
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
  apiKey: "sk-wtg-your-key-here",
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
export ANTHROPIC_API_KEY=sk-wtg-your-key-here
claude "帮我写一个 hello world"
```

### curl（OpenAI 兼容）

```bash
curl http://your-host:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-wtg-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "ping"}]
  }'
```

### curl（Anthropic Messages API 原生格式）

```bash
curl http://your-host:8080/v1/messages \
  -H "Authorization: Bearer sk-wtg-your-key-here" \
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
> 该流以 MAXLEN ~500000 近似裁剪，长度逼近 50 万说明 worker 滞后、已开始丢计费事件，必须立即处理。
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
├── docker-compose.yml      # 本地 dev 基础设施（PG + Redis，与 pnpm 方式 B 配合）
├── docker-compose.dev.yml  # 全容器化开发（方式 A，免装 Node/pnpm）
├── pnpm-workspace.yaml
└── README.md
```

---

## 许可

MIT License
