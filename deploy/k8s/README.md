# CloudLLM K8s 生产部署计划

本文档描述将 CloudLLM 网关系统部署到 Kubernetes 的完整流程。

> 如果部署规模较小（单机或少量节点），推荐使用 [Docker Compose 方案](../docker-compose.prod.yml)，运维门槛更低。K8s 方案适合需要高可用、水平扩缩容、多节点部署的场景。

---

## 目录

1. [清单文件说明](#1-清单文件说明)
2. [外部依赖（PG / Redis）](#2-外部依赖pg--redis)
3. [镜像构建与推送](#3-镜像构建与推送)
4. [前置准备：创建 Secret](#4-前置准备创建-secret)
5. [部署顺序](#5-部署顺序)
6. [升级流程](#6-升级流程)
7. [回滚](#7-回滚)
8. [扩缩容建议](#8-扩缩容建议)
9. [监控接入点](#9-监控接入点)
10. [与 Docker Compose 方案的取舍](#10-与-docker-compose-方案的取舍)

---

## 1. 清单文件说明

```
deploy/k8s/
├── namespace.yaml          # Namespace: cloudllm
├── migrate-job.yaml        # 数据库迁移 Job（每次升级前单独运行）
├── gateway.yaml            # Gateway Deployment（3 副本）+ Service
├── worker.yaml             # Worker Deployment（1 副本，可扩）
├── console.yaml            # Console Deployment（2 副本）+ Service
├── ingress.yaml            # Ingress（api.<domain> + console.<domain>）
└── examples/
    └── secrets.example.yaml  # Secret 模板（不含真实值，供参考）
```

> `examples/` 子目录下的文件不参与 `kubectl apply -f deploy/k8s/` 的批量 apply，
> 避免将模板值误 apply 到集群。正式 Secret 通过 `kubectl create secret` 或
> SealedSecrets/SOPS 管理（见[第 4 节](#4-前置准备创建-secret)）。

### 镜像占位符说明

所有 Deployment 中的 `image` 字段使用 `<registry>/cloudllm-<service>:<tag>` 占位符，
**apply 前必须替换为实际镜像地址**。推荐使用 `sed` 或 `kustomize` 批量替换：

```bash
# 示例：用 sed 替换占位符后 apply
TAG=v1.2.0-$(git rev-parse --short HEAD)
REGISTRY=registry.company.com/cloudllm

for f in gateway worker console; do
  sed "s|<registry>/cloudllm-${f}:<tag>|${REGISTRY}/cloudllm-${f}:${TAG}|g" \
    deploy/k8s/${f}.yaml | kubectl apply -f -
done
```

---

## 2. 外部依赖（PG / Redis）

**PostgreSQL 和 Redis 不部署在集群内。** 推荐使用公司托管实例或云服务：

| 依赖 | 推荐方案 | 理由 |
|------|----------|------|
| PostgreSQL | 公司 DBA 托管实例 / 云 RDS（阿里云 RDS、AWS RDS 等） | 有状态服务运维复杂，云托管提供自动备份、HA、慢查日志 |
| Redis | 公司托管 Redis / 云 Redis（阿里云 Tair、AWS ElastiCache 等） | 主从/集群 HA 由托管服务保证，避免自管 StatefulSet 的维护负担 |

连接串通过 Secret 注入，见下方[第 4 节](#4-前置准备创建-secret)。

> 如需在开发/测试 K8s 环境中使用集群内 PG/Redis（不推荐用于生产），
> 可参考项目根目录的 [docker-compose.dev.yml](../../docker-compose.dev.yml) 了解服务配置，
> 自行编写 StatefulSet 清单（不在本部署物范围内）。

---

## 3. 镜像构建与推送

### Tag 约定

推荐使用 `<semver>-<git-short-sha>` 格式，例如 `v1.2.0-abc1234`。
这样既有语义版本便于人工识别，又有 commit SHA 确保唯一性和可追溯性。

```bash
# 在 repo 根目录执行
TAG="v1.2.0-$(git rev-parse --short HEAD)"
REGISTRY="registry.company.com/cloudllm"   # 替换为公司实际 registry

# 构建三个镜像（使用各自 Dockerfile，context 均为 repo 根）
docker build -f apps/gateway/Dockerfile  -t ${REGISTRY}/cloudllm-gateway:${TAG}  .
docker build -f apps/worker/Dockerfile   -t ${REGISTRY}/cloudllm-worker:${TAG}   .
docker build -f apps/console/Dockerfile  -t ${REGISTRY}/cloudllm-console:${TAG}  .

# 同时打 latest 标签（可选）
docker tag ${REGISTRY}/cloudllm-gateway:${TAG} ${REGISTRY}/cloudllm-gateway:latest
docker tag ${REGISTRY}/cloudllm-worker:${TAG}  ${REGISTRY}/cloudllm-worker:latest
docker tag ${REGISTRY}/cloudllm-console:${TAG} ${REGISTRY}/cloudllm-console:latest

# 推送到 registry
docker push ${REGISTRY}/cloudllm-gateway:${TAG}
docker push ${REGISTRY}/cloudllm-worker:${TAG}
docker push ${REGISTRY}/cloudllm-console:${TAG}
```

### CI/CD 集成建议

在 CI pipeline（GitHub Actions / GitLab CI 等）中：
1. PR 合并到主分支时自动构建并推送带 SHA tag 的镜像；
2. 打 semver tag 时额外推送 `vX.Y.Z` 和 `latest` 标签；
3. CI 产出 `TAG` 变量供后续部署步骤使用。

---

## 4. 前置准备：创建 Secret

Secret 中包含 PG 连接串、Redis 连接串、信封加密主密钥和会话密钥。

### 推荐方案 A：SealedSecrets

[SealedSecrets](https://github.com/bitnami-labs/sealed-secrets) 使用集群公钥加密，
加密后的 `SealedSecret` 资源可安全提交到 Git：

```bash
# 安装 kubeseal CLI（macOS）
brew install kubeseal

# 创建临时明文 Secret（不 apply 到集群）
kubectl create secret generic cloudllm-secrets \
  --namespace=cloudllm \
  --dry-run=client \
  --from-literal=DATABASE_URL='postgres://cloudllm:PASSWORD@pg-host:5432/cloudllm' \
  --from-literal=REDIS_URL='redis://:PASSWORD@redis-host:6379' \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  -o yaml | kubeseal --format yaml > deploy/k8s/secrets-sealed.yaml

# apply SealedSecret（集群内 controller 解密并生成真实 Secret）
kubectl apply -f deploy/k8s/secrets-sealed.yaml
```

### 推荐方案 B：SOPS + age

[SOPS](https://github.com/mozilla/sops) + [age](https://github.com/FiloSottile/age) 加密 YAML 文件：

```bash
# 生成 age 密钥对（私钥保管在安全处）
age-keygen -o key.txt

# 加密 secret 文件
sops --encrypt --age $(cat key.txt | grep 'public key' | awk '{print $4}') \
  deploy/k8s/examples/secrets.example.yaml > deploy/k8s/secrets-encrypted.yaml

# 解密并 apply
sops --decrypt deploy/k8s/secrets-encrypted.yaml | kubectl apply -f -
```

### 方案 C：直接 kubectl（适合快速测试，不推荐生产）

```bash
kubectl create secret generic cloudllm-secrets \
  --namespace=cloudllm \
  --from-literal=DATABASE_URL='postgres://cloudllm:YOUR_PASSWORD@your-pg-host:5432/cloudllm' \
  --from-literal=REDIS_URL='redis://:YOUR_PASSWORD@your-redis-host:6379' \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)"
```

> 重要：`MASTER_KEY` 必须备份。丢失此值将导致所有渠道 API 凭证无法解密，
> 需要在 Console 逐一重新录入上游凭证。

---

## 5. 部署顺序

按以下顺序部署，确保依赖关系正确。

### 5.1 创建 Namespace

```bash
kubectl apply -f deploy/k8s/namespace.yaml
```

### 5.2 创建 Secret

按[第 4 节](#4-前置准备创建-secret)选择方案创建 `cloudllm-secrets`。

验证：
```bash
kubectl get secret cloudllm-secrets -n cloudllm
```

### 5.3 运行数据库迁移 Job

**首次部署时**，先替换镜像 tag，然后：

```bash
# 替换镜像占位符后 apply
TAG="v1.2.0-$(git rev-parse --short HEAD)"
REGISTRY="registry.company.com/cloudllm"
sed "s|<registry>/cloudllm-worker:<tag>|${REGISTRY}/cloudllm-worker:${TAG}|g" \
  deploy/k8s/migrate-job.yaml | kubectl apply -f -

# 等待 Job 完成（超时 5 分钟）
kubectl wait job/cloudllm-migrate \
  --namespace=cloudllm \
  --for=condition=complete \
  --timeout=300s
# Job 失败时该命令会等满超时；可另开终端执行
# kubectl wait job/cloudllm-migrate -n cloudllm --for=condition=failed --timeout=300s
# 或直接查看状态：kubectl get job cloudllm-migrate -n cloudllm -o wide
# 以及查看日志：kubectl logs job/cloudllm-migrate -n cloudllm

# 查看日志确认无错误
kubectl logs -n cloudllm -l app.kubernetes.io/name=cloudllm-migrate
```

### 5.4 部署三个 Deployment

```bash
TAG="v1.2.0-$(git rev-parse --short HEAD)"
REGISTRY="registry.company.com/cloudllm"

for svc in gateway worker console; do
  sed "s|<registry>/cloudllm-${svc}:<tag>|${REGISTRY}/cloudllm-${svc}:${TAG}|g" \
    deploy/k8s/${svc}.yaml | kubectl apply -f -
done

# 等待所有 Deployment rollout 完成
kubectl rollout status deployment/cloudllm-gateway -n cloudllm --timeout=300s
kubectl rollout status deployment/cloudllm-worker  -n cloudllm --timeout=300s
kubectl rollout status deployment/cloudllm-console -n cloudllm --timeout=300s
```

### 5.5 部署 Ingress

在部署 Ingress 前，**替换 `ingress.yaml` 中的 `<domain>` 为实际域名**，
并根据公司环境取消注释 IngressClass 和 TLS 相关注解：

```bash
# 编辑 ingress.yaml 后 apply
kubectl apply -f deploy/k8s/ingress.yaml
```

### 5.6 初始化 seed 数据（首次部署）

首次部署需要创建初始管理员账号。

> 不使用 `kubectl run --env=...$(kubectl get secret...)` 的原因：该写法会将 Secret 明文展开到
> 进程参数或 shell history，存在凭证泄露风险。下方 Job 通过 `secretRef` / `secretKeyRef` 在
> 集群内安全注入，凭证不经过本地终端。

修改下方 YAML 中的 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` 值后执行：

```bash
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: cloudllm-seed
  namespace: cloudllm
  labels:
    app.kubernetes.io/name: cloudllm-seed
    app.kubernetes.io/part-of: cloudllm
spec:
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: seed
          image: <registry>/cloudllm-worker:<tag>
          command: ["node", "node_modules/@cloudllm/db/dist/seed.js"]
          envFrom:
            - secretRef:
                name: cloudllm-secrets
          env:
            - name: SEED_ADMIN_EMAIL
              value: "admin@yourcompany.com"   # 改为实际管理员邮箱
            - name: SEED_ADMIN_PASSWORD
              value: "change-me-strong-password"  # 改为强密码
EOF
```

seed Job 完成后可通过 `kubectl logs -n cloudllm job/cloudllm-seed` 确认执行结果；
600 秒后 Job 自动清理（`ttlSecondsAfterFinished: 600`）。

### 5.7 验证部署

```bash
# 检查所有 Pod 状态（期望全部 Running）
kubectl get pods -n cloudllm

# 检查 gateway healthz（通过 port-forward）
kubectl port-forward svc/cloudllm-gateway 8080:80 -n cloudllm &
curl localhost:8080/healthz   # 期望 {"ok":true}
kill %1

# 检查 console 登录页（通过 port-forward）
kubectl port-forward svc/cloudllm-console 3000:80 -n cloudllm &
curl -I localhost:3000/login   # 期望 200
kill %1
```

---

## 6. 升级流程

**原则：先跑新版 migrate Job，再滚动更新 Deployment。**

```bash
NEW_TAG="v1.3.0-$(git rev-parse --short HEAD)"
REGISTRY="registry.company.com/cloudllm"

# 步骤 1：构建并推送新镜像
docker build -f apps/gateway/Dockerfile  -t ${REGISTRY}/cloudllm-gateway:${NEW_TAG}  .
docker build -f apps/worker/Dockerfile   -t ${REGISTRY}/cloudllm-worker:${NEW_TAG}   .
docker build -f apps/console/Dockerfile  -t ${REGISTRY}/cloudllm-console:${NEW_TAG}  .
docker push ${REGISTRY}/cloudllm-gateway:${NEW_TAG}
docker push ${REGISTRY}/cloudllm-worker:${NEW_TAG}
docker push ${REGISTRY}/cloudllm-console:${NEW_TAG}

# 步骤 2：删除旧的 migrate Job 并运行新版本迁移
kubectl delete job cloudllm-migrate -n cloudllm --ignore-not-found
sed "s|<registry>/cloudllm-worker:<tag>|${REGISTRY}/cloudllm-worker:${NEW_TAG}|g" \
  deploy/k8s/migrate-job.yaml | kubectl apply -f -
kubectl wait job/cloudllm-migrate --namespace=cloudllm --for=condition=complete --timeout=300s
# Job 失败时该命令会等满超时；可另开终端执行
# kubectl wait job/cloudllm-migrate -n cloudllm --for=condition=failed --timeout=300s
# 或直接查看状态：kubectl get job cloudllm-migrate -n cloudllm -o wide
# 以及查看日志：kubectl logs job/cloudllm-migrate -n cloudllm

# 步骤 3：滚动更新三个 Deployment（零停机）
kubectl set image deployment/cloudllm-gateway gateway=${REGISTRY}/cloudllm-gateway:${NEW_TAG} -n cloudllm
kubectl set image deployment/cloudllm-worker  worker=${REGISTRY}/cloudllm-worker:${NEW_TAG}  -n cloudllm
kubectl set image deployment/cloudllm-console console=${REGISTRY}/cloudllm-console:${NEW_TAG} -n cloudllm

# 步骤 4：等待 rollout 完成
kubectl rollout status deployment/cloudllm-gateway -n cloudllm
kubectl rollout status deployment/cloudllm-worker  -n cloudllm
kubectl rollout status deployment/cloudllm-console -n cloudllm
```

> 大版本升级前建议先备份 PostgreSQL 数据库。

---

## 7. 回滚

```bash
# 查看 rollout 历史
kubectl rollout history deployment/cloudllm-gateway -n cloudllm

# 回滚到上一个版本
kubectl rollout undo deployment/cloudllm-gateway -n cloudllm
kubectl rollout undo deployment/cloudllm-worker  -n cloudllm
kubectl rollout undo deployment/cloudllm-console -n cloudllm

# 回滚到指定版本（--to-revision=N）
# kubectl rollout undo deployment/cloudllm-gateway --to-revision=2 -n cloudllm
```

> 注意：Deployment 回滚后，如果新版本有 DB schema 变更，
> 旧版本应用可能无法正常工作，需要评估是否需要数据库回滚（风险较高）。
> 建议迁移脚本设计为向后兼容（新列先添加可 null，应用版本稳定后再加约束）。

---

## 8. 扩缩容建议

### Gateway 手动扩缩

Gateway 是无状态服务，可随流量水平扩缩：

```bash
# 手动扩缩（临时）
kubectl scale deployment/cloudllm-gateway --replicas=5 -n cloudllm

# 或修改 gateway.yaml 中 replicas 字段后 apply（推荐，GitOps 友好）
```

### Gateway HPA（水平自动扩缩）

基于 CPU 利用率自动扩缩（需集群安装 metrics-server）：

```bash
kubectl autoscale deployment/cloudllm-gateway \
  --namespace=cloudllm \
  --min=3 \
  --max=10 \
  --cpu-percent=70
```

HPA YAML 示例（可加入 `deploy/k8s/` 目录）：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cloudllm-gateway-hpa
  namespace: cloudllm
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cloudllm-gateway
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Worker 扩缩

Worker 使用 Redis XREADGROUP 消费组，每个 Pod 注册为独立消费者（consumer name = Pod hostname）。
增加副本数即水平扩展消费能力，Redis 自动分配消息到各消费者；
`XAUTOCLAIM` 会认领崩溃 Pod 遗留的 pending 消息，确保不丢事件。

```bash
# 当 Redis Stream 积压（XLEN usage_events 持续升高）时扩容
kubectl scale deployment/cloudllm-worker --replicas=3 -n cloudllm
```

### Console 扩缩

Console 是 Next.js 无状态服务，Session 用密钥签名 cookie（无服务端 session 状态），
多副本可直接水平扩缩：

```bash
kubectl scale deployment/cloudllm-console --replicas=4 -n cloudllm
```

---

## 9. 监控接入点

### 健康检查

| 端点 | 服务 | 说明 |
|------|------|------|
| `GET /healthz` | gateway | 返回 `{"ok":true}`，K8s readiness/liveness 探针目标 |
| `GET /login` | console | 200 OK 表示 Next.js 服务正常 |

### Redis Stream 积压监控

```bash
# 通过 redis-cli 检查（需有 redis 访问权限）
# 或通过 kubectl exec 到临时 Pod 执行

# 流积压长度（正常应接近 0）
redis-cli -h <redis-host> XLEN usage_events

# Pending 条数（消费中但未 ACK）
redis-cli -h <redis-host> XPENDING usage_events console-worker - + 10

# DLQ（死信队列，超过投递次数上限的事件）
redis-cli -h <redis-host> XRANGE usage_events_dlq - + COUNT 20
```

**告警阈值建议：**
- `XLEN usage_events > 10000`：Worker 滞后，考虑扩容或排查 Worker 日志；
- `XLEN usage_events > 500000`：接近 MAXLEN 裁剪阈值，计费事件可能丢失，紧急处理；
- DLQ 有新条目：计费事件投递失败，需人工检查原因并决定是否重放。

### Prometheus 接入（可选）

Gateway 和 Worker 暂未内置 `/metrics` 端点。如需接入 Prometheus，可考虑：
1. 在 Gateway 添加 `prom-client` 暴露 HTTP 请求 QPS、延迟分布等指标；
2. 使用 Redis Exporter 采集 Stream 积压指标。

---

## 10. 与 Docker Compose 方案的取舍

| 维度 | Docker Compose（推荐） | K8s |
|------|----------------------|-----|
| 适用场景 | 单机/少量节点，内部工具，中小团队 | 多节点，需高可用，已有 K8s 基础设施 |
| 运维门槛 | 低（一条命令） | 高（需熟悉 K8s 概念和工具链） |
| 高可用 | 单机 SPOF，依赖 Docker 重启 | 多副本，跨节点调度，自动恢复 |
| 水平扩缩 | 需手动，同机资源有限 | HPA 自动，多节点线性扩缩 |
| 滚动升级 | 需停机或手动蓝绿 | 原生滚动更新，零停机 |
| Secret 管理 | .env 文件，手动保管 | SealedSecrets/SOPS/External Secrets |
| 资源隔离 | 容器级，依赖 cgroup | Namespace + ResourceQuota + NetworkPolicy |
| 配置复杂度 | 1 个 compose 文件 | 6+ YAML 清单，需了解 K8s 对象 |

**建议：** 团队规模小（< 50 人使用）、无专职 K8s 运维时，优先使用 Docker Compose 方案。
当 Gateway 需要多节点水平扩缩应对高并发 LLM 调用，或公司已有 K8s 平台时，再迁移到 K8s。
