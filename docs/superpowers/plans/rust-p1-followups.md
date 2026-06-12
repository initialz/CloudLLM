# Rust 重写 P1 遗留清单(P2/P3 时认领)

P1 各任务评审确认接受但未实现的事项。每条标注触发条件,实现时从本清单划掉。

| # | 事项 | 位置 | 触发条件 / 归属 |
|---|---|---|---|
| 1 | 登录限速(每 IP/每账号失败计数 + 退避或锁定),失败登录写 audit_events | admin/api.rs login | P2;暴露到办公网前必做 |
| 2 | 会话 cookie `Secure` 属性(配置项 cookie_secure 或跟随可信反代头) | admin/api.rs session_cookie | 生产 HTTPS 上线前必须拍板 |
| 3 | TraceLayer 对 healthz 503 记 ERROR 的噪音(自定义 on_failure 或 healthz 不挂 trace) | lib.rs app() | **P2 未单独处理**:P2 已接入数据面探活路径但未消噪,顺延 P3 |
| 4 | 静态资产 Content-Type 无 charset=utf-8(非 HTML 文本资产 mojibake 风险) | admin/assets.rs file_response | P3 UI 全量铺开时 |
| 5 | index/spa 路径 no-cache 但无 ETag/Last-Modified(永远 200 全量重传) | admin/assets.rs | 性能优化,有感知再做 |
| 6 | 前端 Guard 每次挂载都打 /admin/api/me(多页后变成每次导航一击) | admin-ui App.tsx | P3 多页接入时上提/缓存 |
| 7 | build.rs 探针资产 cloudllm-probe-cafebabe.js 随生产二进制 embed(18 字节,测试设施进发布物) | build.rs | 接受;若洁癖可改 cfg 控制 |

另:Rust 版与 TS 版的两点有意分歧已在代码注释落档——单层信封(crypto.rs encrypt_secret)、argon2id 取代 scrypt(切换=重建管理员,P4 README 必须写明)。

另(P2 落项):数据面已接入(鉴权/路由/计费/失败切换/SSE/落库/后台任务/排水)。
P1 遗留 #1(登录限速 + 失败登录 audit)属管理面,P2 未触及,顺延 P3 admin 强化。
新增 P2 自身遗留见下表。

## P2 自身遗留(P3 认领)

| # | 事项 | 位置 | 触发条件 |
|---|---|---|---|
| P2-1 | budget_exhausted 无 Retry-After 头(对齐 TS;客户端无退避提示) | gateway/error.rs | 接入限速/SLA 时 |
| P2-2 | check_budgets 读失败时放行(可用性优先,可能短暂超透) | billing.rs | 有严格硬预算需求时改"读失败即拒" |
| P2-3 | 无预算/渠道内存缓存,每请求 SELECT(内部几十 QPS 足够) | gateway/* | 压测证明热点后加 moka TTL |
| P2-4 | audit response_body 流式不存(仅非流式存) | gateway/mod.rs | 需要流式审计回放时 |
| P2-5 | reqwest 无连接级代理/自定义 CA 配置项 | build_http_client | 企业网代理上线前 |

## P2 评审遗留(P2 评审期间新发现,P3 酌情认领)

| # | 事项 | 位置 | 触发条件 / 说明 |
|---|---|---|---|
| P2R-1 | 后台 job 持续失败无退避,仅 interval 限频 error 日志 | jobs.rs | 评审建议连续失败 N 次降级/拉宽间隔;P3 酌情 |
| P2R-2 | Buffered/Passthrough 路径上游响应体无大小上限 | gateway/upstream.rs、gateway/mod.rs | 配置内上游,风险低;若上游不可信需加 cap |
| P2R-3 | 流中上游错误以 client_abort 落账(0001 status CHECK 无 stream_error,区分需未来迁移) | gateway/mod.rs、migrations | 需精确区分流式上游错误与客户端中断时 |
| P2R-4 | config env 解析失败静默保默认(与 P1 风格一致) | config.rs apply_overrides | 可加 warn 日志,排障期更友好 |
| P2R-5 | reqwest rustls 不读系统证书,私有 CA 上游需额外配置(同 P2-5,确认在列) | build_http_client | 私有 CA / 企业网上游上线前 |
| P2R-6 | check_budgets DB 读失败 fail-open(计划明定的可用性取舍,运维需知) | billing.rs | 严格硬预算场景需改 fail-close(同 P2-2) |
| P2R-7 | OpenAI 流式中断且无 usage 事件 → 零计费(不估算输入侧;spec §3.3 估算项未实现,差异清单 #12) | gateway/sse_tap.rs、gateway/mod.rs | 中断流量占比可观、需挽回输入侧成本时(P3 酌情实现粗估) |
