# Rust 重写 P1 遗留清单(P2/P3 时认领)

P1 各任务评审确认接受但未实现的事项。每条标注触发条件,实现时从本清单划掉。

| # | 事项 | 位置 | 触发条件 / 归属 |
|---|---|---|---|
| 1 | 登录限速(每 IP/每账号失败计数 + 退避或锁定),失败登录写 audit_events | admin/api.rs login | **P3 已处理**(进程内存态限速 + 失败登录 audit;遗留见 P3 自身遗留表) |
| 2 | 会话 cookie `Secure` 属性(配置项 cookie_secure 或跟随可信反代头) | admin/api.rs session_cookie | **P3 已处理** |
| 3 | TraceLayer 对 healthz 503 记 ERROR 的噪音(自定义 on_failure 或 healthz 不挂 trace) | lib.rs app() | **P3 已处理** |
| 4 | 静态资产 Content-Type 无 charset=utf-8(非 HTML 文本资产 mojibake 风险) | admin/assets.rs file_response | **P3 已处理** |
| 5 | index/spa 路径 no-cache 但无 ETag/Last-Modified(永远 200 全量重传) | admin/assets.rs | **P3 未认领,触发条件不变**:性能优化,有感知再做 |
| 6 | 前端 Guard 每次挂载都打 /admin/api/me(多页后变成每次导航一击) | admin-ui App.tsx | **P3 已处理**(AuthContext 缓存会话,Guard 读缓存不再发请求) |
| 7 | build.rs 探针资产 cloudllm-probe-cafebabe.js 随生产二进制 embed(18 字节,测试设施进发布物) | build.rs | **P3 未认领,触发条件不变**:接受;若洁癖可改 cfg 控制 |

另:Rust 版与 TS 版的两点有意分歧已在代码注释落档——单层信封(crypto.rs encrypt_secret)、argon2id 取代 scrypt(切换=重建管理员,P4 README 必须写明)。

另(P2 落项):数据面已接入(鉴权/路由/计费/失败切换/SSE/落库/后台任务/排水)。
P1 遗留 #1(登录限速 + 失败登录 audit)属管理面,P2 未触及,顺延 P3 admin 强化。
新增 P2 自身遗留见下表。

## P2 自身遗留(P3 认领)

> P3 说明:下表各项 **P3 未认领,触发条件不变**(P3 聚焦管理面 UI 与登录强化,数据面取舍维持原样)。

| # | 事项 | 位置 | 触发条件 |
|---|---|---|---|
| P2-1 | budget_exhausted 无 Retry-After 头(对齐 TS;客户端无退避提示) | gateway/error.rs | 接入限速/SLA 时 |
| P2-2 | check_budgets 读失败时放行(可用性优先,可能短暂超透) | billing.rs | 有严格硬预算需求时改"读失败即拒" |
| P2-3 | 无预算/渠道内存缓存,每请求 SELECT(内部几十 QPS 足够) | gateway/* | 压测证明热点后加 moka TTL |
| P2-4 | audit response_body 流式不存(仅非流式存) | gateway/mod.rs | 需要流式审计回放时 |
| P2-5 | reqwest 无连接级代理/自定义 CA 配置项 | build_http_client | 企业网代理上线前 |

## P2 评审遗留(P2 评审期间新发现,P3 酌情认领)

> P3 说明:下表各项 **P3 未认领,触发条件不变**(均为数据面取舍/上游可信度相关,P3 未触及数据面)。

| # | 事项 | 位置 | 触发条件 / 说明 |
|---|---|---|---|
| P2R-1 | 后台 job 持续失败无退避,仅 interval 限频 error 日志 | jobs.rs | 评审建议连续失败 N 次降级/拉宽间隔;P3 酌情 |
| P2R-2 | Buffered/Passthrough 路径上游响应体无大小上限 | gateway/upstream.rs、gateway/mod.rs | 配置内上游,风险低;若上游不可信需加 cap |
| P2R-3 | 流中上游错误以 client_abort 落账(0001 status CHECK 无 stream_error,区分需未来迁移) | gateway/mod.rs、migrations | 需精确区分流式上游错误与客户端中断时 |
| P2R-4 | config env 解析失败静默保默认(与 P1 风格一致) | config.rs apply_overrides | 可加 warn 日志,排障期更友好 |
| P2R-5 | reqwest rustls 不读系统证书,私有 CA 上游需额外配置(同 P2-5,确认在列) | build_http_client | 私有 CA / 企业网上游上线前 |
| P2R-6 | check_budgets DB 读失败 fail-open(计划明定的可用性取舍,运维需知) | billing.rs | 严格硬预算场景需改 fail-close(同 P2-2) |
| P2R-7 | OpenAI 流式中断且无 usage 事件 → 零计费(不估算输入侧;spec §3.3 估算项未实现,差异清单 #12) | gateway/sse_tap.rs、gateway/mod.rs | 中断流量占比可观、需挽回输入侧成本时(P3 酌情实现粗估) |

## P3 自身遗留(P4 酌情认领)

P3 管理面(登录强化 + admin-ui 11 页)交付期间新发现/有意取舍的事项。

| # | 事项 | 位置 | 触发条件 / 说明 |
|---|---|---|---|
| P3-1 | 登录限速为进程内存态(失败计数存内存,重启清零) | admin/api.rs login 限速 | 单实例可接受;多实例或需重启不丢计数时改 Redis/DB 后端 |
| P3-2 | 限速来源维度取 XFF/对端 IP,XFF 可伪造 | admin/api.rs 限速取 IP | 内网/可信反代威胁模型接受;直面公网需校验可信反代链或改账号维度为主 |
| P3-3 | audit-requests 列表接口单页含 request/response_body,理论最大约 12.8MB(100×128KB) | admin/keys.rs 或 admin audit 列表 | 大请求体高频审计时:建议 P4 列表只返回截断预览 + 独立详情接口取全文 |
| P3-4 | admin-ui 无自动化测试(Playwright 浏览器冒烟为人工,vitest 未引入) | admin-ui | 回归面变大时引入 vitest 组件测试 + Playwright e2e |
| P3-5 | admin-ui 徽标壳(OwnerBadge 等)与列表页 load/error/Modal 样板重复(8 页),抽象债 | admin-ui pages/* | P4 统一抽 useListPage hook + 通用 EntityBadge,降重复 |
| P3-6 | AuthContext 在 StrictMode 开发态会双发 me()(React 双调用副作用) | admin-ui AuthContext.tsx | 仅开发态;生产构建无 StrictMode 双发,无影响 |
| P3-7 | Channels weight 空串 Number('')=0 仅后端拦(P3 已补前端就地提示,但依赖前端) | admin-ui Channels.tsx | 已前端拦正整数;若绕过前端直打 API,后端仍兜底 400 |
