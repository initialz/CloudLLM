# CloudLLM — 单二进制企业 LLM 网关

Rust + SQLite 编写的一体化 LLM 网关，**零外部依赖**：一个可执行文件、一个 SQLite 数据文件，即是完整服务。统一接入 OpenAI / Anthropic 协议的上游，对内自签 API Key、做预算管控、出用量报表、留审计记录。管理台（React SPA）经 `rust-embed` 直接嵌进二进制，无需单独部署前端。

核心能力：

- **协议代理**：调用方用 `Bearer sk-cloudllm-…` 访问，网关认证、按渠道路由到上游 OpenAI / Anthropic。
- **Key 签发**：明文 Key 仅签发瞬间返回一次，库内只存 SHA-256 哈希；附带「接入说明」一键复制发放。
- **预算管控**：按 Key / 用户设月度或总额度，micro-CNY 精度，超限直接 429。
- **渠道与凭证**：多上游加权 failover + 指数退避冷却；上游凭证 AES-256-GCM 信封加密，只写不读。
- **报表与审计**：模型 / Key / 天三维用量报表；请求级审计 + 管理操作审计双流，留存天数可配。

---

## 架构

```
                调用方（curl / OpenAI SDK / Claude Code）
                         │  Authorization: Bearer sk-cloudllm-…
                         ▼
        ┌──────────────────────────────────────────────┐
        │              cloudllm（单进程）                │
        │                                                │
        │   /v1/*          网关协议面（OpenAI/Anthropic） │
        │   /admin/api/*   管理 REST API                  │
        │   /admin         嵌入式管理台 SPA（rust-embed）  │
        │                       │                        │
        │                       ▼                        │
        │             SQLite（单文件 cloudllm.db, WAL）    │
        └──────────────────────────┬─────────────────────┘
                                   │  上游凭证（信封解密后注入）
                                   ▼
                      OpenAI / Anthropic 上游 API

  ✗ 无 PostgreSQL   ✗ 无 Redis   ✗ 无独立 worker 进程
```

调用方一律走 `/v1/*`；管理员与管理台走 `/admin`。两者同域同端口、同一个进程，背后只有一个 SQLite 文件。

---

## 功能清单

| 模块 | 说明 |
| --- | --- |
| **Key 签发** | 管理员签发 `sk-cloudllm-…` Key，明文一次性返回（库内只存 SHA-256 哈希）；签发后自动生成「接入说明」handout，一键复制连同明文 Key 发给成员 |
| **预算管控** | 支持 `monthly`（按自然月滚动重置）与 `total`（累计总额）两种周期；金额 micro-CNY 精度（CNY 的百万分之一）；超限请求直接返回 429 |
| **渠道路由** | 多上游渠道加权 failover；某渠道失败后指数退避冷却（基数 → 上限封顶）；上游凭证以 AES-256-GCM **信封加密**（AAD 绑定渠道行 id），库内**只写不读** |
| **模型定价** | 按模型配置 CNY/MTok 单价，分 `input` / `output` / `cache_read` / `cache_write` 四档，成本据此核算到 micro-CNY |
| **用量报表** | 按**模型 / Key / 天**三个维度聚合用量与成本 |
| **审计** | 请求级审计（留存天数可配，过期清空请求/响应体）+ 管理操作审计，**双流**分别留存 |
| **登录限速** | 管理台登录按**邮箱**与**来源**双维度限速，抵御撞库 |

---

## 快速开始（裸机）

需要 Rust 工具链（stable）。

```bash
cargo build --release

# 初始化：生成 cloudllm.toml + cloudllm.db，并打印初始管理员密码（仅此一次，请立即保存）
./target/release/cloudllm init

# 启动：默认监听 0.0.0.0:7200
./target/release/cloudllm serve
```

`init` 会在当前目录生成 `cloudllm.toml`（含随机 `master_key` / `session_secret`，文件权限 `0600`）与 `cloudllm.db`，并创建管理员（默认邮箱 `admin@cloudllm.local`），把初始密码打印到终端——**只打印这一次**。

启动后打开管理台登录：

```
http://localhost:7200/admin
```

> 根路径 `/` 是网关协议面（供 SDK / curl 调用），**管理台挂在 `/admin`**，别把浏览器指向根路径。

---

## 快速开始（Docker）

仓库根目录已带 `Dockerfile` 与单服务 `docker-compose.yml`。容器首次启动时 entrypoint 自动跑 `init`，随后常驻 `serve`。

```bash
docker compose up -d --build
```

取初始管理员密码（仅首跑日志里有）：

```bash
docker compose logs cloudllm | grep 初始密码
```

数据持久化在 named volume **`cloudllm-data`**，挂载到容器内 `/data`——**配置、`master_key`、SQLite 库全部落在那里**。删除该卷即丢失全部数据与密钥。管理台同样在 `http://localhost:7200/admin`。

> compose 默认通过 `CLOUDLLM_GATEWAY_PUBLIC_URL` 把网关对外地址设为 `http://localhost:7200`（接入说明里展示给成员），按实际部署改它。

---

## 成员自助接入

网关根路径 `/` 即**成员接入页**：管理员签发 Key 后，把网关地址发给成员，成员打开即可自助接入。

- **五种配置一键生成**：Claude Code、Codex、OpenAI SDK（Python / Node）、`curl`，按 Tab 切换、填入 Key 后一键复制。
- **启用模型自动列出**：页面读取网关当前启用的模型清单（服务端注入），无需手填模型名。
- **Key 绝不上传**：Key 只在浏览器**本地**拼接进配置片段，页面 CSP 禁止全部网络请求，输入的 Key 不会发往任何服务器。

---

## 配置参考

配置来源优先级：**`CLOUDLLM_*` 环境变量 > `cloudllm.toml` 文件 > 内置默认值**。进程启动即校验配置，失败立即退出。`init` 生成的配置文件权限为 `0600`。

| 字段 | 默认值 | 说明 | 环境变量覆盖名 |
| --- | --- | --- | --- |
| `listen` | `"0.0.0.0:7200"` | 监听地址 | `CLOUDLLM_LISTEN` |
| `db_path` | `"./cloudllm.db"` | SQLite 路径 | `CLOUDLLM_DB_PATH` |
| `master_key` | **必填** | 渠道凭证信封加密主密钥，base64（解码后 32 字节） | `CLOUDLLM_MASTER_KEY` |
| `session_secret` | **必填** | 管理会话 HMAC 密钥，≥32 字符 | `CLOUDLLM_SESSION_SECRET` |
| `gateway_public_url` | 无 | 接入说明中展示的网关对外地址 | `CLOUDLLM_GATEWAY_PUBLIC_URL` |
| `upstream_connect_timeout_secs` | `10` | 上游 TCP 连接超时（秒） | `CLOUDLLM_UPSTREAM_CONNECT_TIMEOUT_SECS` |
| `upstream_timeout_secs` | `300` | 非流式上游总超时（秒；流式不设） | `CLOUDLLM_UPSTREAM_TIMEOUT_SECS` |
| `cooldown_base_secs` | `30` | 渠道冷却指数退避基数（秒） | `CLOUDLLM_COOLDOWN_BASE_SECS` |
| `cooldown_max_secs` | `600` | 冷却退避上限（秒） | `CLOUDLLM_COOLDOWN_MAX_SECS` |
| `audit_body_limit` | `65536` | 审计体截断上限（字节） | `CLOUDLLM_AUDIT_BODY_LIMIT` |
| `audit_retention_days` | `30` | 审计体保留天数 | `CLOUDLLM_AUDIT_RETENTION_DAYS` |
| `max_body_bytes` | `2097152` | 客户端请求体上限（字节，超出 413） | `CLOUDLLM_MAX_BODY_BYTES` |
| `shutdown_drain_secs` | `25` | 优雅停机排水时长上限（秒） | `CLOUDLLM_SHUTDOWN_DRAIN_SECS` |
| `cookie_secure` | `false` | 会话 cookie 仅 HTTPS 下传（生产经 TLS 时置 `true`） | `CLOUDLLM_COOKIE_SECURE` |

> **环境变量始终覆盖 TOML 中的对应项。** 这让镜像/K8s 部署可以把密钥从 Secret 注入，不必把明文写进配置文件。
>
> **`master_key` 一旦丢失，库中已存的渠道凭证密文将不可恢复**（信封加密以它为根密钥）。务必随库一起备份配置文件。

---

## Kubernetes 部署

K8s 清单（单 Deployment + 单 PVC）与完整运维手册见 **[deploy/k8s/README.md](deploy/k8s/README.md)**。正文只点三件要事：

- **`replicas: 1` + `Recreate`（不可改）**：SQLite 是单写者，两个 pod 同挂一库并发写会损坏数据；`Recreate` 杜绝升级期间新旧 pod 短暂同挂一库，代价是秒级停机，这是刻意取舍。**严禁手动 `kubectl scale` 扩副本。**
- **排水契约**：`preStop sleep 5` + 应用排水 `shutdown_drain_secs`（默认 25）+ 余量 ≤ `terminationGracePeriodSeconds`（清单设 35）。调大排水时长必须同步调大 grace。
- **初始密码看 pod 日志**：首跑 `init` 只打印一次，`kubectl -n cloudllm logs deploy/cloudllm | grep 初始密码`。

---

## 备份与恢复

一套完整数据 = **两个文件**：`cloudllm.toml`（含 `master_key`）+ `cloudllm.db`。两者缺一不可——只有 `.db` 没有 `master_key` 就解不开渠道凭证密文。

**在线备份（推荐，本机装有 `sqlite3` 时）**：`.backup` 在 WAL 模式下安全，无需停服。

```bash
sqlite3 cloudllm.db ".backup backup.db"
# 同时拷一份配置（含 master_key）
cp cloudllm.toml backup.cloudllm.toml
```

**冷备（直接拷文件）**：WAL 模式下在线裸拷可能拷到不一致状态，**必须先停服**，且 `-wal` / `-shm` 边车文件要一并拷走：

```bash
# 先停服，再拷以下文件（存在哪个拷哪个）
cp cloudllm.toml cloudllm.db cloudllm.db-wal cloudllm.db-shm /backup/
```

**恢复**：把 `cloudllm.toml` 与 `cloudllm.db`（在线备份则是 `backup.db`，改回 `cloudllm.db`）放回原位，再 `cloudllm serve` 即可。

> K8s 环境下镜像未内置 `sqlite3`，备份方式（卷快照 / 停 pod 拷文件）见 [deploy/k8s/README.md](deploy/k8s/README.md)。

---

## 从 v1（TypeScript 版）迁移

> v1 是基于 Hono gateway + worker + Next.js console 的三服务版本，依赖 PostgreSQL 与 Redis、用 Drizzle / pnpm 构建。v2 是 Rust 单二进制重写，**两者数据格式不互通，不迁移历史数据**——v2 全新 `init` 起步，把 v1 的整套 PostgreSQL / Redis / 三服务栈整体下线即可。

逐项对照该如何过渡：

| 维度 | v1（TS） | v2（Rust） | 迁移动作 |
| --- | --- | --- | --- |
| **管理员密码哈希** | scrypt | argon2id | 算法不同、不可换算。用 `cloudllm init` 重建管理员账号 |
| **渠道凭证加密** | 旧信封格式 | 单层 AES-256-GCM（AAD = 渠道行 id） | 格式不同、密文不通用。在管理台**重新录入**每个渠道的上游凭证 |
| **API Key** | SHA-256 哈希 | 同为 SHA-256，但库不互通 | 全部**重新签发** Key，并发放新的接入说明给成员 |
| **基础设施** | PostgreSQL + Redis + 3 个服务 | 单二进制 + SQLite | 三服务栈整体下线，无需 PG / Redis |

---

## CLI 参考

```bash
# 初始化：生成配置与库、创建管理员、打印初始密码（仅一次）
cloudllm init [--config cloudllm.toml] [--email admin@cloudllm.local]

# 启动服务
cloudllm serve [--config cloudllm.toml]

# 重置指定邮箱用户的密码，打印新密码
cloudllm admin reset-password <email> [--config cloudllm.toml]
```

`--config` 默认 `cloudllm.toml`，`init` 的 `--email` 默认 `admin@cloudllm.local`。

---

## 开发

测试与三件套门禁：

```bash
cargo test                       # 215+ 测试

# 提交前三件套
cargo fmt --check && \
  cargo clippy --all-targets --locked -- -D warnings && \
  cargo test --locked
```

**管理台（admin-ui）开发**：`admin-ui/vite.config.ts` 已配 dev proxy，把 `/admin/api` 代理到本地 `http://localhost:7200` 的 cloudllm 进程。因此开发流程是——先起后端、再起 Vite dev server 调试前端：

```bash
# 终端 1：起后端（管理台 API 在 :7200）
cargo run -- serve

# 终端 2：起前端热重载（/admin/api 自动代理到 :7200）
cd admin-ui && npm install && npm run dev
```

改完前端、要验证嵌进二进制的成品时，跑 `npm run build` 产出静态资源，再 `cargo run -- serve`，访问 `http://localhost:7200/admin` 看 rust-embed 嵌入后的实际效果。

---

## 安全要点

- **文件权限**：`cloudllm.toml` 与 `cloudllm.db` 均为 `0600`（`init` 自动设置），仅属主可读。
- **明文 Key 一次性**：API Key 明文仅在签发瞬间返回一次，库内只存 SHA-256 哈希，事后无法回读。
- **渠道凭证只写不读**：上游凭证 AES-256-GCM 信封加密入库，管理 REST API **物理排除该列**，任何接口都读不出密文或明文。
- **生产开启 `cookie_secure`**：经 TLS 终结时置 `true`，会话 cookie 仅 HTTPS 下传。
- **更换 `session_secret` = 全员会话失效**：它是会话签名根密钥，一改所有在线用户需重新登录。
- **守住 `master_key`**：它是渠道凭证信封加密的根密钥，丢失即所有已存上游凭证不可恢复；备份时务必随库一并保留。

---

## 许可

MIT License
