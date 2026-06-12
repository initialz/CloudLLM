# CloudLLM Kubernetes 部署手册

CloudLLM 是 Rust 单二进制 LLM 网关,数据全部落在一个 SQLite 库(`/data/cloudllm.db`)与一份配置(`/data/cloudllm.toml`,含 `master_key`)上。本目录是 Rust 版 K8s 清单:**单 Deployment + 单 PVC**,副本固定 1、`Recreate` 升级。网关协议面在根路径 `/v1/*`,管理台在 `/admin`,两者同域同服务。

清单文件:

| 文件 | 资源 | 作用 |
| --- | --- | --- |
| `namespace.yaml` | Namespace | `cloudllm` 命名空间 |
| `pvc.yaml` | PersistentVolumeClaim | 10Gi 数据卷(库 + 配置 + 密钥) |
| `deployment.yaml` | Deployment | 单副本应用,Recreate,非 root,排水契约 35s |
| `service.yaml` | Service | ClusterIP,端口 7100 |
| `ingress.yaml` | Ingress | 对外 host,/ 全量转发到 7100 |

部署前先把清单里的占位符替换成你的环境:`<registry>/cloudllm:<tag>`(镜像)、`llm.<domain>`(对外域名,`deployment.yaml` 的 `CLOUDLLM_GATEWAY_PUBLIC_URL` 与 `ingress.yaml` 的 host 必须一致)、以及按需取消注释 `storageClassName`、`ingressClassName`、TLS / nginx SSE 注解。

---

## 一、镜像构建与推送

在**仓库根目录**执行(`<sha>` 推荐用 git commit SHA 作为不可变 tag):

```bash
docker build -t <registry>/cloudllm:<sha> .
docker push <registry>/cloudllm:<sha>
```

然后把 `deployment.yaml` 里的 `image: <registry>/cloudllm:<tag>` 替换成刚推送的 `<registry>/cloudllm:<sha>`。

容器以非 root(uid 65532)运行;K8s 用 `fsGroup: 65532` 接管 PVC 属组,卷写入权限无碍。首次启动时 entrypoint 会跑 `cloudllm init`(自动生成 `cloudllm.toml`、初始化库、打印初始管理员密码到日志),随后 `serve` 监听 7100。

---

## 二、首次部署

按顺序 apply(namespace 必须最先,其余资源都落在该命名空间下):

```bash
kubectl apply -f namespace.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml
```

等 pod 就绪后,从**首跑 pod 日志**取初始管理员密码(只在第一次 `init` 时打印一次):

```bash
kubectl -n cloudllm rollout status deploy/cloudllm
kubectl -n cloudllm logs deploy/cloudllm | grep 初始密码
```

用该密码登录管理台:

```
https://llm.<domain>/admin
```

健康检查在 `https://llm.<domain>/healthz`(DB 正常 200,故障 503),readiness/liveness 探针均指向它。

> 配置 / `master_key` / 库都生成在 PVC 上的 `/data/cloudllm.toml` 与 `/data/cloudllm.db`(文件权限 0600)。`CLOUDLLM_*` 环境变量可覆盖配置文件中的对应项(见下文"密钥与配置")。

---

## 三、日常运维

### 升级

换镜像 tag 后重新 apply 即可,`Recreate` 会**先停旧 pod 再起新 pod**,数据库 schema 迁移在新进程启动时自动执行:

```bash
# 把 deployment.yaml 的 image tag 改成新 <sha>,然后:
kubectl apply -f deployment.yaml
kubectl -n cloudllm rollout status deploy/cloudllm
```

由于是 `Recreate` + 单副本,升级期间有**秒级停机**,这是 SQLite 单写者下的有意取舍(见"约束与契约")。

### 回滚

```bash
kubectl -n cloudllm rollout undo deployment/cloudllm
```

> **注意:库 schema 向前迁移不可逆。** 回滚到的旧镜像若不认识新 schema,可能无法启动或数据异常。**跨迁移版本的回滚必须先从备份恢复库,再回滚镜像。** 仅当新旧版本 schema 一致(纯代码改动)时 `rollout undo` 才是安全的。

### 备份

**镜像是 debian-slim,内部未安装 `sqlite3`**(已用 `cloudllm:p4-smoke` 镜像验证:`which sqlite3` 返回空)。因此不要在 pod 内执行 `sqlite3 .backup`,那条命令会失败。推荐两种可行方式:

**方式 A(推荐)— 卷快照。** 用存储后端 / CSI 的 `VolumeSnapshot`(或云盘快照)对 `cloudllm-data` PVC 整卷打快照,库与 `cloudllm.toml` 一并捕获,最省事且与 WAL 模式无冲突。

**方式 B — 停 pod 后从卷拷文件。** SQLite 处于 WAL 模式,在线直接 `cp` 库文件可能拷到不一致状态(`-wal`/`-shm` 未合并)。安全做法是先停写再拷:

```bash
# 1) 缩到 0 副本,确保无人写库
kubectl -n cloudllm scale deploy/cloudllm --replicas=0
kubectl -n cloudllm rollout status deploy/cloudllm --timeout=60s

# 2) 临时起一个挂同一 PVC 的辅助 pod 拷文件,例如:
kubectl -n cloudllm run cloudllm-backup --restart=Never --image=busybox:1.36 \
  --overrides='{"spec":{"securityContext":{"fsGroup":65532},"containers":[{"name":"cloudllm-backup","image":"busybox:1.36","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"cloudllm-data"}}]}}'
kubectl -n cloudllm cp cloudllm-backup:/data/cloudllm.db   ./cloudllm.db
kubectl -n cloudllm cp cloudllm-backup:/data/cloudllm.toml ./cloudllm.toml
kubectl -n cloudllm delete pod cloudllm-backup

# 3) 恢复副本
kubectl -n cloudllm scale deploy/cloudllm --replicas=1
```

> 备份**务必同时保留 `cloudllm.toml`**——它含 `master_key`,丢了它即便有 `.db` 也解不开里面的密钥密文。**丢卷 = 丢库 + 丢密钥**,请把 PVC 纳入定期备份。

### 忘记管理员密码

用内置 CLI 在 pod 内重置(`cloudllm` 二进制在镜像里,无需 sqlite3):

```bash
kubectl -n cloudllm exec deploy/cloudllm -- \
  cloudllm admin reset-password <email> --config /data/cloudllm.toml
```

---

## 四、约束与契约

### replicas=1 + Recreate(不可改)

SQLite 是**单写者**:同一时刻只能有一个进程写库。

- `replicas: 1` 固定不动。**严禁手动 `kubectl scale` 扩副本**,两个 pod 同挂一库并发写会损坏 WAL、丢数据。
- `strategy.type: Recreate` 杜绝滚动升级期间新旧两个 pod 短暂同挂一库。代价是升级有**秒级停机**,这是刻意取舍。
- 真要横向扩容,先换存储引擎(如外置 Postgres),不要在 SQLite 上叠副本。

### 排水契约

应用收到 `SIGTERM` 后最长排水 `shutdown_drain_secs`(默认 25s)。Pod 的 `preStop` 先 `sleep 5`(给 Service/Ingress 摘流量留时间),之后才进入排水。三段相加必须 ≤ `terminationGracePeriodSeconds`:

| 阶段 | 时长 | 来源 |
| --- | --- | --- |
| preStop sleep | 5s | `deployment.yaml` lifecycle.preStop |
| 应用排水 | 25s | `CLOUDLLM_SHUTDOWN_DRAIN_SECS`(默认 25) |
| 余量 | 5s | — |
| **grace 合计** | **35s** | `terminationGracePeriodSeconds: 35` |

> **若调大 `CLOUDLLM_SHUTDOWN_DRAIN_SECS`,必须同步调大 `terminationGracePeriodSeconds`**(保持 `preStop 5 + drain + 余量 ≤ grace`),否则 K8s 会在排水未完成时强杀 pod,可能截断在途请求。

### 密钥与配置

- 默认:配置与密钥落在 PVC 上的 `/data/cloudllm.toml`(0600,首跑自动生成),`master_key` 在其中。无需额外注入即可工作。
- 可选(更符合密钥管理规范):用 **K8s Secret 注入环境变量**覆盖文件里的值。`CLOUDLLM_*` env 优先于配置文件,常用:
  - `CLOUDLLM_MASTER_KEY` —— 覆盖 master_key(用于加密 provider 密钥密文)
  - `CLOUDLLM_SESSION_SECRET` —— 覆盖管理台会话签名密钥
  - `CLOUDLLM_GATEWAY_PUBLIC_URL` —— 成员接入说明里展示的网关对外地址(须与 Ingress host 一致)
  - `CLOUDLLM_COOKIE_SECURE` —— 经 Ingress TLS 终结时设 `true`,会话 cookie 仅 HTTPS 下传
  - `CLOUDLLM_SHUTDOWN_DRAIN_SECS` —— 排水时长(改动须同步 grace,见上)

  注入示例(片段):

  ```yaml
  env:
    - name: CLOUDLLM_MASTER_KEY
      valueFrom:
        secretKeyRef:
          name: cloudllm-secrets
          key: master-key
    - name: CLOUDLLM_SESSION_SECRET
      valueFrom:
        secretKeyRef:
          name: cloudllm-secrets
          key: session-secret
  ```

  注意:用 env 覆盖 `CLOUDLLM_MASTER_KEY` 后,库中密文以该 key 加解密;**一旦启用就不要再变**,改 key 会导致已有密文无法解密。

---

## 五、清单校验

本机无 `kubeconform` 二进制,用官方镜像校验:

```bash
docker run --rm -v "$PWD:/k8s:ro" ghcr.io/yannh/kubeconform:latest \
  -strict -summary \
  /k8s/namespace.yaml /k8s/pvc.yaml /k8s/deployment.yaml /k8s/service.yaml /k8s/ingress.yaml
```

预期输出:`Valid: 5, Invalid: 0, Errors: 0`。
