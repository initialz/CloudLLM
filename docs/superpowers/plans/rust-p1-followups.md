# Rust 重写 P1 遗留清单(P2/P3 时认领)

P1 各任务评审确认接受但未实现的事项。每条标注触发条件,实现时从本清单划掉。

| # | 事项 | 位置 | 触发条件 / 归属 |
|---|---|---|---|
| 1 | 登录限速(每 IP/每账号失败计数 + 退避或锁定),失败登录写 audit_events | admin/api.rs login | P2;暴露到办公网前必做 |
| 2 | 会话 cookie `Secure` 属性(配置项 cookie_secure 或跟随可信反代头) | admin/api.rs session_cookie | 生产 HTTPS 上线前必须拍板 |
| 3 | TraceLayer 对 healthz 503 记 ERROR 的噪音(自定义 on_failure 或 healthz 不挂 trace) | lib.rs app() | P2 接探活轮询前 |
| 4 | 静态资产 Content-Type 无 charset=utf-8(非 HTML 文本资产 mojibake 风险) | admin/assets.rs file_response | P3 UI 全量铺开时 |
| 5 | index/spa 路径 no-cache 但无 ETag/Last-Modified(永远 200 全量重传) | admin/assets.rs | 性能优化,有感知再做 |
| 6 | 前端 Guard 每次挂载都打 /admin/api/me(多页后变成每次导航一击) | admin-ui App.tsx | P3 多页接入时上提/缓存 |
| 7 | build.rs 探针资产 cloudllm-probe-cafebabe.js 随生产二进制 embed(18 字节,测试设施进发布物) | build.rs | 接受;若洁癖可改 cfg 控制 |

另:Rust 版与 TS 版的两点有意分歧已在代码注释落档——单层信封(crypto.rs encrypt_secret)、argon2id 取代 scrypt(切换=重建管理员,P4 README 必须写明)。
