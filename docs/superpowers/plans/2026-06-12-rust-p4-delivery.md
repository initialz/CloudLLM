# CloudLLM v2 Rust P4 替换交付 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 TS 版(apps/packages/旧部署物/旧 CI),交付 Rust 单二进制的 Dockerfile、K8s 单 Deployment+PVC、重写 README,并以 Docker 镜像级 e2e 验收(精确对账)收口 v2 重写。

**Architecture:** 仓库从 TS monorepo 收敛为 Rust 单 crate + admin-ui;运行形态为单容器(/data 卷承载 cloudllm.toml + cloudllm.db),K8s 用 Recreate 策略单副本(SQLite 单写者);e2e 用 docker network 内 mock 上游对真实镜像跑全链路并对账到 micro。

**Tech Stack:** Docker 多阶段构建(node:22-slim → rust:1-slim → debian:bookworm-slim)、K8s(Deployment/PVC/Service/Ingress)、bash + python3 标准库(e2e mock)、GitHub Actions。

---

## 全局约定(每个任务都适用)

- 分支:`rust-p4-delivery`(从 main 切出)。
- cargo 不在默认 PATH:每个 shell 先 `export PATH="$HOME/.cargo/bin:$PATH"`。
- Rust 三件套验证:`cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`(当前基线 215 个测试全绿)。
- admin-ui 验证:`cd admin-ui && npm run build`(build 脚本已含 `tsc --noEmit`)。
- commit 信息一律中文,格式 `feat(rust)/chore(rust)/docs(rust): P4-Tn 描述`。
- 本机 docker server 29.x 可用;kubeconform 本机未装,用 docker 镜像 `ghcr.io/yannh/kubeconform:latest` 校验。
- 注释/文档全中文;不引入新依赖、不动 Rust 功能面代码(本阶段是交付,不是开发)。

## 关键决策(已裁决,执行时勿再摇摆)

| # | 决策 | 理由 |
|---|---|---|
| 1 | 容器引导:entrypoint 首跑(`/data/cloudllm.toml` 不存在)执行 `cloudllm init`,初始密码打进容器日志(一次性);随后 `exec cloudllm serve` | 复用现成 init(随机 master_key/session_secret、0600、建管理员),配置/密钥/库全在卷上,K8s 无需 Secret 即可起步;CLOUDLLM_* env 覆盖仍可用 |
| 2 | K8s `strategy: Recreate` + `replicas: 1` | SQLite 单写者;RollingUpdate 会出现两个 pod 同挂一库(WAL 损坏风险),必须杜绝 |
| 3 | 排水契约锁定:preStop sleep 5 + 应用排水 25(shutdown_drain_secs 默认)≤ terminationGracePeriodSeconds 35 | cli.rs 中 P2 留下的部署契约注释,本阶段落成清单 |
| 4 | 根 `docker-compose.yml` 重建为单服务统一入口;删 `docker-compose.dev.yml` | spec §9:"缩成单服务,compose 仅为统一入口保留" |
| 5 | CI:删 TS `ci.yml`,`rust-ci.yml` 改名为 `ci.yml`,admin-ui job 移除"目录不存在则跳过"豁免,硬性构建 | TS 已删,Rust CI 即唯一 CI;P1 的豁免注释本就说"admin-ui 落地后应改为硬失败" |
| 6 | 不在 CI 加 docker build job | e2e 脚本本地覆盖镜像构建;CI 保持轻(fmt/clippy/test + ui build),符合极简偏好 |
| 7 | P3 遗留(P3-1..7)及 P1 #5/#7、P2 全部遗留:P4 一律不认领,交付阶段不动功能面 | followups 文档统一标注「P4 未认领,触发条件不变」;P3-3 的"建议 P4 截断预览"顺延到有真实大体量审计需求时 |
| 8 | 运行镜像 debian:bookworm-slim + 非 root(uid 65532),不装 ca-certificates | reqwest 用 rustls-tls(webpki-roots 内置根证书),不读系统证书;entrypoint 需要 /bin/sh 所以不用 distroless |
| 9 | e2e 对账锚定值:input 21 CNY/MTok、output 105 CNY/MTok,mock usage 1000/500 → cost = 21000 + 52500 = **73500 micro**(整除,无 ceil 歧义) | 与 billing.rs 单测同款数字,双向印证 |

## 既有事实(已核实源码,implementer 不必再查)

- CLI:`cloudllm init --config <path> --email <email>`(config 已存在则报错;db 落在 config 同目录 `cloudllm.db`)、`cloudllm serve --config <path>`、`cloudllm admin reset-password <email> --config <path>`。
- init 输出含行:`  初始密码: <16字符>(仅此一次,请立即保存)`。
- serve 启动时 `db::open` 自动跑 sqlx 迁移;监听默认 `0.0.0.0:7100`;`/healthz` 在 DB 正常时 200。
- Config env 覆盖名:`CLOUDLLM_LISTEN / CLOUDLLM_DB_PATH / CLOUDLLM_MASTER_KEY / CLOUDLLM_SESSION_SECRET / CLOUDLLM_GATEWAY_PUBLIC_URL / CLOUDLLM_UPSTREAM_CONNECT_TIMEOUT_SECS / CLOUDLLM_UPSTREAM_TIMEOUT_SECS / CLOUDLLM_COOLDOWN_BASE_SECS / CLOUDLLM_COOLDOWN_MAX_SECS / CLOUDLLM_AUDIT_BODY_LIMIT / CLOUDLLM_AUDIT_RETENTION_DAYS / CLOUDLLM_MAX_BODY_BYTES / CLOUDLLM_SHUTDOWN_DRAIN_SECS / CLOUDLLM_COOKIE_SECURE`。
- 管理 API(e2e 用到的):
  - `POST /admin/api/login` 入参 `{"email","password"}`,Set-Cookie `cloudllm_session`;
  - `GET /admin/api/users` → `{"users":[{ "id", "email", ...}]}`(me 不返回 id,取 owner_id 用这个);
  - `POST /admin/api/channels` 入参 `{"provider_type","name","base_url","credential","weight"?}`,base_url 须匹配 `^https?://.+/v1$`,201;
  - `POST /admin/api/models` 入参 `{"slug","provider_type","upstream_model","input_price_cny","output_price_cny"}`(价格 CNY 字符串),201;
  - `POST /admin/api/keys` 入参 `{"name","owner_type":"user"|"team","owner_id","budget_limit_cny"?,"budget_period"?}`,201 → `{"plaintext","handout","gateway_url_configured","key":{"id",...}}`;
  - `POST /admin/api/keys/:id/revoke` → 200 `{"status":"disabled"}`;
  - `GET /admin/api/reports?dimension=model&from=<epoch>&to=<epoch>` → `{"rows":[{"bucket","requests","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","cost_micro"}]}`(from<to 必须);
  - `GET /admin/api/audit/events` → events 列表,key 签发产生 action `key.create`。
- 网关:`POST /v1/chat/completions`,`Authorization: Bearer sk-cloudllm-...`,请求体 `model` 用 slug(如 `openai/gpt-test`),转发时改写为 upstream_model;非流式响应体透传(usage 原样可见);结算为异步任务,报表断言需重试等待。
- build.rs:admin-ui/dist 缺失时生成占位 index.html(文案含「admin-ui 尚未构建」)——Docker 构建顺序错了会静默打出占位镜像,e2e 必须断言真 UI。
- vite 真实产物 index.html 含 `/assets/index-<hash>.js` 引用,可作"真 UI"指纹。
- admin-ui 有 package-lock.json(`npm ci` 可用)。
- 根 `.env` 本机存在且含别项目 Redis 密码:**.gitignore 的 `.env`/`.env.local` 条目必须保留**,防误提交。
- 现 git 跟踪的 TS 相关文件:apps/ 99 个、packages/ 32 个,以及根级工程文件(见 T1 删除清单)。

---

### Task 1: 删除 TS 版与工程文件清理

**Files:**
- Delete(git rm):`apps/`、`packages/`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`docker-compose.yml`、`docker-compose.dev.yml`、`.env.example`、`deploy/docker-compose.prod.yml`、`deploy/docker-compose.acceptance.yml`、`deploy/k8s/`(整目录:namespace/console/gateway/worker/migrate-job/ingress/README/examples)、`.github/workflows/ci.yml`
- Modify: `.gitignore`
- Rewrite: `.dockerignore`

- [ ] **Step 1: git rm 删除清单**

```bash
cd /Users/vtech/cloudcode-agent/workspaces/petez/byok
git rm -r -q apps packages deploy/k8s
git rm -q package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json \
  docker-compose.yml docker-compose.dev.yml .env.example \
  deploy/docker-compose.prod.yml deploy/docker-compose.acceptance.yml \
  .github/workflows/ci.yml
```

- [ ] **Step 2: 本地未跟踪残留清理**

```bash
rm -rf node_modules
rmdir tests 2>/dev/null || true
```
(根 node_modules 是 TS 工作区残留;tests/ 是空目录。admin-ui/node_modules 保留。)

- [ ] **Step 3: 重写 .gitignore**

删除 TS 专属条目(`.next/`、`*.tsbuildinfo`、`coverage/`),**保留 `.env`/`.env.local`**(本机 .env 含别项目密钥)。完整新内容:

```gitignore
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
.playwright-mcp/
/target
Cargo.lock.orig
# CloudLLM 运行期产物(含 master_key/session_secret 明文与凭证哈希),严禁提交
cloudllm.toml
cloudllm.db
cloudllm.db-wal
cloudllm.db-shm
```

- [ ] **Step 4: 重写 .dockerignore**(Rust 构建上下文)

```dockerignore
.git
target
node_modules
**/node_modules
admin-ui/dist
docs
*.log
*.md
# 运行期产物与密钥,绝不进镜像构建上下文
cloudllm.toml
cloudllm.db
cloudllm.db-wal
cloudllm.db-shm
.env
.env.*
**/.env
**/.env.*
.playwright-mcp
```
(排除 admin-ui/dist:镜像内由 node 阶段重建,防本机旧产物污染;排除 *.md 不影响 cargo build;**不排除 deploy/**——T2 的 Dockerfile 要 COPY deploy/docker/entrypoint.sh,目录很小,整体进上下文最稳。)

- [ ] **Step 5: 验证 Rust 与 admin-ui 不受影响**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
cd admin-ui && npm run build
```
Expected: 215 测试全绿;vite build 成功。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(rust): P4-T1 删除 TS 版(apps/packages/旧部署物/旧 CI)与工程文件清理"
```

---

### Task 2: Dockerfile 单镜像 + entrypoint + 单服务 compose

**Files:**
- Create: `Dockerfile`
- Create: `deploy/docker/entrypoint.sh`
- Create: `docker-compose.yml`

- [ ] **Step 1: 写 deploy/docker/entrypoint.sh**

```sh
#!/bin/sh
# CloudLLM 容器入口:首跑初始化(配置/库/管理员,初始密码仅本次打印进日志),随后常驻 serve。
# 配置、master_key、数据库全部落在 /data(卷);CLOUDLLM_* 环境变量仍可覆盖配置项。
set -eu
CONFIG="${CLOUDLLM_CONFIG:-/data/cloudllm.toml}"
if [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] 首次启动:初始化 $CONFIG(初始管理员密码仅打印这一次,请立即保存)"
  cloudllm init --config "$CONFIG" --email "${CLOUDLLM_ADMIN_EMAIL:-admin@cloudllm.local}"
fi
exec cloudllm serve --config "$CONFIG"
```

- [ ] **Step 2: 写 Dockerfile**

```dockerfile
# CloudLLM 单镜像:node 构建 admin-ui → rust 构建单二进制(嵌入 SPA)→ debian-slim 运行。
# 运行数据(配置+密钥+SQLite)全在 /data 卷;非 root(uid 65532)运行。

FROM node:22-slim AS ui
WORKDIR /build/admin-ui
COPY admin-ui/package.json admin-ui/package-lock.json ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build

FROM rust:1-slim AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY migrations ./migrations
# 真实 UI 产物必须先于 cargo build 就位,否则 build.rs 会嵌入"尚未构建"占位页
COPY --from=ui /build/admin-ui/dist ./admin-ui/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 65532 --user-group cloudllm \
    && mkdir /data && chown cloudllm:cloudllm /data
COPY --from=builder /build/target/release/cloudllm /usr/local/bin/cloudllm
COPY --chmod=0755 deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER cloudllm
WORKDIR /data
EXPOSE 7100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 3: 写根 docker-compose.yml(单服务统一入口)**

```yaml
# CloudLLM 单服务 compose:docker compose up -d --build 即起全部功能。
# 初始管理员密码看日志:docker compose logs cloudllm | grep 初始密码
services:
  cloudllm:
    build: .
    ports:
      - "7100:7100"
    volumes:
      - cloudllm-data:/data
    environment:
      # 接入说明里展示给成员的网关地址,按实际部署改
      CLOUDLLM_GATEWAY_PUBLIC_URL: "http://localhost:7100"
    restart: unless-stopped
volumes:
  cloudllm-data:
```

- [ ] **Step 4: 构建并冒烟**

```bash
docker build -t cloudllm:p4-smoke .
docker run -d --name p4-smoke -p 17100:7100 cloudllm:p4-smoke
for i in $(seq 1 30); do curl -fsS http://localhost:17100/healthz && break; sleep 1; done
# 真 UI 指纹:vite 产物引用 /assets/index-*.js,且不得出现占位文案
curl -fsS http://localhost:17100/ | grep -q 'assets/index-' 
curl -fsS http://localhost:17100/ | grep -q '尚未构建' && echo "FAIL: 占位页" && exit 1 || true
# 初始密码可登录
PW=$(docker logs p4-smoke 2>&1 | sed -n 's/.*初始密码: \([A-Za-z0-9_-]*\)(.*/\1/p')
curl -fsS -c /tmp/p4-cookie -H 'content-type: application/json' \
  -d "{\"email\":\"admin@cloudllm.local\",\"password\":\"$PW\"}" \
  http://localhost:17100/admin/api/login
# 优雅停机:SIGTERM 后退出码 0 且日志含「已优雅停机」
docker stop -t 35 p4-smoke
test "$(docker wait p4-smoke 2>/dev/null || docker inspect -f '{{.State.ExitCode}}' p4-smoke)" = "0"
docker logs p4-smoke 2>&1 | grep -q '已优雅停机'
docker rm p4-smoke
```
Expected: 全部命令成功,无 FAIL。

- [ ] **Step 5: Commit**

```bash
git add Dockerfile deploy/docker/entrypoint.sh docker-compose.yml .dockerignore
git commit -m "feat(rust): P4-T2 单镜像 Dockerfile(node→rust→debian-slim)+ entrypoint 首跑初始化 + 单服务 compose"
```

---

### Task 3: K8s 单 Deployment + PVC 清单

**Files:**
- Create: `deploy/k8s/namespace.yaml`、`deploy/k8s/pvc.yaml`、`deploy/k8s/deployment.yaml`、`deploy/k8s/service.yaml`、`deploy/k8s/ingress.yaml`、`deploy/k8s/README.md`

- [ ] **Step 1: namespace.yaml**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cloudllm
  labels:
    app.kubernetes.io/part-of: cloudllm
```

- [ ] **Step 2: pvc.yaml**

```yaml
# CloudLLM 数据卷:cloudllm.toml(含 master_key)+ cloudllm.db 都在这里。
# 丢卷 = 丢库 + 丢密钥,务必纳入备份(见 deploy/k8s/README.md)。
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cloudllm-data
  namespace: cloudllm
  labels:
    app.kubernetes.io/name: cloudllm
    app.kubernetes.io/part-of: cloudllm
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
  # storageClassName: <按集群填写;注释掉则用默认 StorageClass>
```

- [ ] **Step 3: deployment.yaml**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudllm
  namespace: cloudllm
  labels:
    app.kubernetes.io/name: cloudllm
    app.kubernetes.io/part-of: cloudllm
spec:
  # SQLite 单写者:副本数固定 1,勿调;扩容需求出现时先换存储引擎
  replicas: 1
  # Recreate 杜绝滚动升级期两个 pod 同挂一库(WAL 损坏风险);代价是升级有秒级停机
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: cloudllm
  template:
    metadata:
      labels:
        app.kubernetes.io/name: cloudllm
        app.kubernetes.io/part-of: cloudllm
    spec:
      # 排水契约:preStop 5s + 应用排水 25s(shutdown_drain_secs 默认)+ 余量 5s = 35
      terminationGracePeriodSeconds: 35
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
      containers:
        - name: cloudllm
          # 替换 <registry>/<tag>;tag 推荐 git commit SHA
          image: <registry>/cloudllm:<tag>
          ports:
            - containerPort: 7100
              protocol: TCP
          env:
            # 成员接入说明中展示的网关对外地址,与 Ingress host 一致
            - name: CLOUDLLM_GATEWAY_PUBLIC_URL
              value: "https://llm.<domain>"
            # 会话 cookie 仅 HTTPS 下传(经 Ingress TLS 终结时开启)
            - name: CLOUDLLM_COOKIE_SECURE
              value: "true"
          volumeMounts:
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet:
              path: /healthz
              port: 7100
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 7100
            initialDelaySeconds: 10
            periodSeconds: 20
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: cloudllm-data
```

- [ ] **Step 4: service.yaml**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cloudllm
  namespace: cloudllm
  labels:
    app.kubernetes.io/name: cloudllm
    app.kubernetes.io/part-of: cloudllm
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: cloudllm
  ports:
    - name: http
      port: 7100
      targetPort: 7100
```

- [ ] **Step 5: ingress.yaml**(单 host,网关与管理台同进程同端口;保留 SSE 注解模板)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cloudllm
  namespace: cloudllm
  labels:
    app.kubernetes.io/name: cloudllm
    app.kubernetes.io/part-of: cloudllm
  annotations:
    # nginx-ingress 流式(SSE)必需项,按控制器调整:
    # nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    # nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    # nginx.ingress.kubernetes.io/proxy-buffering: "off"
    # TLS/cert-manager:
    # cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  # ingressClassName: nginx
  rules:
    # 替换 <domain>;网关(/v1)与管理台(/)同一域名同一服务
    - host: llm.<domain>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: cloudllm
                port:
                  number: 7100
  # tls:
  #   - hosts: [llm.<domain>]
  #     secretName: cloudllm-tls
```

- [ ] **Step 6: deploy/k8s/README.md**(部署手册,必含以下事实)

- 镜像构建与推送:`docker build -t <registry>/cloudllm:<sha> . && docker push ...`
- 首次部署顺序:namespace → pvc → deployment → service → ingress;`kubectl -n cloudllm logs deploy/cloudllm | grep 初始密码` 取初始管理员密码。
- replicas=1 + Recreate 的原因(SQLite 单写者)与升级停机预期(秒级);**严禁手动扩副本**。
- 排水契约表:preStop 5 + drain 25 ≤ grace 35;若调大 `CLOUDLLM_SHUTDOWN_DRAIN_SECS` 必须同步调大 terminationGracePeriodSeconds。
- 密钥位置:PVC 上的 /data/cloudllm.toml(0600);可选改用环境变量管理(CLOUDLLM_MASTER_KEY/CLOUDLLM_SESSION_SECRET 经 Secret 注入可覆盖文件值)。
- 备份:`kubectl exec` 进 pod 用 `sqlite3 /data/cloudllm.db ".backup /data/backup.db"` 后拷出,连同 cloudllm.toml;或卷快照。注意 WAL 模式直接 cp 库文件需先停写。
- 升级:换 image tag 后 `kubectl apply`,Recreate 自动先停旧再起新,迁移在启动时自动执行。
- 回滚:`kubectl rollout undo deployment/cloudllm -n cloudllm`(库 schema 向前迁移不可逆,回滚跨迁移版本需先恢复备份)。
- 管理员密码忘记:`kubectl -n cloudllm exec deploy/cloudllm -- cloudllm admin reset-password <email> --config /data/cloudllm.toml`。

- [ ] **Step 7: kubeconform 校验**

```bash
docker run --rm -v "$PWD/deploy/k8s:/k8s:ro" ghcr.io/yannh/kubeconform:latest \
  -strict -summary /k8s/namespace.yaml /k8s/pvc.yaml /k8s/deployment.yaml /k8s/service.yaml /k8s/ingress.yaml
```
Expected: `Valid: 5, Invalid: 0, Errors: 0`(image/host 占位符不影响 schema 校验)。

- [ ] **Step 8: Commit**

```bash
git add deploy/k8s
git commit -m "feat(rust): P4-T3 K8s 单 Deployment+PVC 清单(Recreate/排水契约 35s/非 root)与部署手册"
```

---

### Task 4: CI 收口

**Files:**
- Rename + Modify: `.github/workflows/rust-ci.yml` → `.github/workflows/ci.yml`

- [ ] **Step 1: git mv 并重写**

```bash
git mv .github/workflows/rust-ci.yml .github/workflows/ci.yml
```

完整新内容:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
      - run: cargo clippy --all-targets --locked -- -D warnings
      - run: cargo test --locked

  admin-ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: admin-ui/package-lock.json
      - run: npm ci
        working-directory: admin-ui
      # build 含 tsc --noEmit,类型错误即红
      - run: npm run build
        working-directory: admin-ui
```

- [ ] **Step 2: 本地等价验证**(CI 不本地跑,逐条命令验证)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
cd admin-ui && npm ci && npm run build
```
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "chore(rust): P4-T4 CI 收口——rust-ci 更名唯一 ci,admin-ui 硬性构建"
```

---

### Task 5: README 重写

**Files:**
- Rewrite: `README.md`(现为 431 行 TS 版,全量替换)

- [ ] **Step 1: 重写 README.md**,章节与必含事实:

1. **标题与定位**:CloudLLM——单二进制企业 LLM 网关(Rust + SQLite,零外部依赖);统一接入 OpenAI/Anthropic 协议上游,自签 Key、预算管控、用量报表、审计。
2. **架构图**(ASCII):调用方(Bearer sk-cloudllm-)→ cloudllm 单进程(网关 /v1/* + 管理 API /admin/api/* + 嵌入式管理台 SPA)→ SQLite(/data);上游 OpenAI/Anthropic。标注:无 PG、无 Redis、无独立 worker。
3. **功能清单表**:Key 签发(明文一次性+接入说明 handout)、预算(monthly/total,micro-CNY,429)、渠道(加权 failover+指数冷却,凭证 AES-256-GCM 信封)、模型定价(CNY/MTok 四档)、报表(模型/Key/天)、审计(请求留存+管理操作)、登录限速。
4. **快速开始(裸机)**:
   ```bash
   cargo build --release
   ./target/release/cloudllm init            # 打印初始管理员密码(仅一次)
   ./target/release/cloudllm serve           # 默认 0.0.0.0:7100
   ```
   打开 http://localhost:7100/admin 登录管理台(根路径是网关协议面,管理台挂在 /admin)。
5. **快速开始(Docker)**:`docker compose up -d --build`;初始密码 `docker compose logs cloudllm | grep 初始密码`;数据持久化在 named volume `cloudllm-data`。
6. **配置参考**:cloudllm.toml 全字段表(字段 / 默认值 / 说明 / env 覆盖名)——14 个字段照 src/config.rs 抄全:listen(0.0.0.0:7100)、db_path(./cloudllm.db)、master_key(必填,base64 32B)、session_secret(必填,≥32 字符)、gateway_public_url、upstream_connect_timeout_secs(10)、upstream_timeout_secs(300)、cooldown_base_secs(30)、cooldown_max_secs(600)、audit_body_limit(65536)、audit_retention_days(30)、max_body_bytes(2MiB)、shutdown_drain_secs(25)、cookie_secure(false)。注明:env 覆盖 TOML;配置文件 0600;master_key 丢失=已存渠道凭证不可恢复。
7. **K8s 部署**:指向 `deploy/k8s/README.md`;正文只放三行要点(replicas=1+Recreate 原因、排水契约 5+25≤35、初始密码看 pod 日志)。
8. **备份与恢复**:备份 = cloudllm.toml + cloudllm.db;在线备份用 `sqlite3 cloudllm.db ".backup backup.db"`(WAL 安全),冷备可直接拷文件(需先停服,-wal/-shm 一并);恢复 = 放回两个文件再 serve。
9. **从 v1(TS 版)迁移**:明确**不迁数据**,v2 全新初始化。原因与动作:
   - 密码哈希 argon2id 取代 scrypt → 管理员用 `init` 重建(或 reset-password 不适用,旧库不读);
   - 渠道凭证信封格式不同(单层 AES-256-GCM,AAD=行 id)→ 渠道在管理台重新录入;
   - API Key 哈希虽同为 SHA-256 但库不互通 → 全部重新签发并发放新接入说明;
   - v1 的 PostgreSQL/Redis/三服务栈可整体下线。
10. **CLI 参考**:init(--config/--email)、serve(--config)、admin reset-password(email 位置参数 + --config)。
11. **开发**:`cargo test`(215+);admin-ui 开发流程照 `admin-ui/vite.config.ts` 实况写(查后如实写,有 proxy 写 proxy,没有写 build+cargo run);CI 等价命令三件套。
12. **安全要点**:配置/库 0600;明文 Key 仅签发瞬间返回;渠道凭证只写不读;cookie_secure 生产开启;session_secret 更换=全员会话失效。

写作要求:中文;命令块可直接复制执行;不留 TS 时代残句(grep 检查 `pnpm|Hono|Next|Drizzle|Redis|Postgres` 仅允许出现在「从 v1 迁移」章节)。

- [ ] **Step 2: 验证**

```bash
grep -nE "pnpm|Hono|Next\.js|Drizzle" README.md   # 仅允许出现在迁移章节,其他位置为 0 命中
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(rust): P4-T5 README 重写——单二进制安装/配置/Docker/K8s/备份/v1 迁移说明"
```

---

### Task 6: Docker 镜像级 e2e 验收

**Files:**
- Create: `deploy/e2e/mock_upstream.py`
- Create: `deploy/e2e/run.sh`

- [ ] **Step 1: 写 deploy/e2e/mock_upstream.py**(python3 标准库,零依赖)

```python
#!/usr/bin/env python3
"""e2e mock 上游:固定返回 OpenAI chat completion(usage 1000/500),供精确对账。"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({
            "id": "chatcmpl-e2e",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-test",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "pong"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
```

- [ ] **Step 2: 写 deploy/e2e/run.sh**

```bash
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
```

- [ ] **Step 2.1: 赋执行权限**

```bash
chmod +x deploy/e2e/run.sh
```

- [ ] **Step 3: 跑通 e2e**

```bash
./deploy/e2e/run.sh
```
Expected: 末行 `全部通过:11 项断言。`(构建/healthz/真UI/登录/渠道模型/Key/网关/对账/审计/撤销/停机 共 11 个 ok)。

- [ ] **Step 4: Commit**

```bash
git add deploy/e2e
git commit -m "feat(rust): P4-T6 镜像级 e2e 验收脚本(mock 上游全链路 + 73500 micro 精确对账)"
```

---

### Task 7: 遗留清单标注 + 全量终验

**Files:**
- Modify: `docs/superpowers/plans/rust-p1-followups.md`

- [ ] **Step 1: 更新 followups 文档**

- 「P3 自身遗留(P4 酌情认领)」表头下加一行说明:`> P4 说明:P4 为替换交付阶段(删 TS/Docker/K8s/README/e2e),不动功能面代码,下表各项 **P4 未认领,触发条件不变**。P3-3 的"列表截断预览"顺延至出现真实大体量审计场景时。`
- P1 #5、#7 与 P2/P2R 各表,无需逐条改文字(其标注已是"未认领,触发条件不变"),仅在文档顶部加一段 P4 总结:TS 版已删除、交付物(Dockerfile/K8s/README/e2e)清单、后续遗留认领由运行反馈驱动。
- 如 T1–T6 执行期间发现新遗留(例如 docker 构建缓存慢、e2e 偶发竞态),新增「P4 自身遗留」表登记;没有则写「P4 自身遗留:无」。

- [ ] **Step 2: 全量终验**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
(cd admin-ui && npm run build)
./deploy/e2e/run.sh
```
Expected: 215 测试全绿、UI 构建成功、e2e 全部断言通过。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/rust-p1-followups.md
git commit -m "docs(rust): P4-T7 遗留清单 P4 裁决标注 + 全量终验记录"
```

---

## 任务依赖

T1 → T2 → T6;T3/T4/T5 在 T1 之后任意顺序(T3 依赖 T1 删掉旧 deploy/k8s);T7 最后。

## 完成定义

- TS 版全部源文件与部署物已从 git 删除,仓库只剩 Rust + admin-ui + docs。
- `docker compose up -d --build` 一条命令可用;K8s 清单 kubeconform 全 valid。
- README 是 Rust 版事实;e2e 在干净容器对账精确到 73500 micro。
- 三件套 + admin-ui build + e2e 全绿;分支等待合并 main(合并由主会话 finishing-a-development-branch 流程执行,不在任务内)。
