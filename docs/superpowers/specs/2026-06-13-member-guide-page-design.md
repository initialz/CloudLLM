# CloudLLM 成员自助接入页(根路径)设计

日期:2026-06-13。状态:已获用户批准(对话内)。

## 1. 目标

网关根路径 `/` 当前为 404。新增一个面向**持 Key 成员**的自助接入页:简洁的分工具配置文档 + 配置生成器——成员把自己的 `sk-cloudllm-` Key 填进页面,就地生成各工具的配置文件/代码片段,一键复制或下载。

## 2. 用户已拍板的三个决策

| 决策点 | 结论 |
|---|---|
| 工具覆盖 | 五个 Tab:Claude Code、Codex、OpenAI Python SDK、OpenAI Node SDK、curl |
| 模型名来源 | 公开自动列出(接受向能访问网关的人暴露启用模型清单) |
| 实现形态 | 单文件静态页(内嵌 CSS/JS),include_str! 嵌入二进制 |

## 3. 路由与数据流

- `GET /` → 新 handler(`src/guide.rs::serve_guide`),返回 `text/html; charset=utf-8`。
- 页面模板 `src/guide.html` 经 `include_str!` 编译期嵌入;handler 每请求查一次库:`SELECT slug, provider_type FROM models WHERE status = 'active' ORDER BY slug`,序列化为 JSON 替换模板占位符,以 `window.__MODELS__ = [{"slug":...,"provider_type":...}]` 注入。**不开独立 JSON 端点**——根页面本身即公开端点,少一次 fetch、少一个路由。
- 查库失败:注入 `[]` 并照常 200(页面可用,模型框退化为纯手填),错误仅进 tracing。
- 缓存头:`Cache-Control: no-cache`(模型列表会变)。
- `/v1/*`、`/admin*`、`/healthz` 语义零变化;`GET /` 挂在 traced Router 内(与 /v1 同层)。

## 4. 页面内容与交互

视觉:复刻管理台暗色霓虹 token(bg `#06080f`、panel、line、neon `#22d3ee`、violet `#8b5cf6`、网格底纹、顶部光带、等宽字体数值),纯手写 CSS,不引入 Tailwind。

结构:
1. **头部**:CloudLLM 渐变字标 + 一句话定位(成员自助接入;管理员入口链接到 `/admin`)。
2. **生成器卡片**:
   - API Key 输入(`type=password` + 显示/隐藏切换;占位提示 `sk-cloudllm-...`);
   - Base URL 输入(默认 `window.location.origin`,可改);
   - 模型选择:`<datalist>`(下拉可选 + 手填兜底),候选按当前 Tab 协议过滤(Claude Code → anthropic;Codex/OpenAI/curl → openai;curl 双协议各一例不强制过滤);
   - 五个 Tab,实时生成配置内容 `<pre>`,每 Tab 复制按钮;Codex Tab 另给 `config.toml` 下载按钮(Blob);
   - 每 Tab 配 2-3 行说明:配置放哪、如何验证。
3. **页脚安全提示**:Key 仅在浏览器本地拼接,绝不发送到服务器。

各 Tab 生成内容口径(与 `src/admin/handout.rs` 逐字对齐:ANTHROPIC_BASE_URL **不带** /v1,OpenAI 系 base_url **带** /v1):
- **Claude Code**:`export ANTHROPIC_BASE_URL={base}` + `export ANTHROPIC_AUTH_TOKEN={key}`(+ 可选 `export ANTHROPIC_MODEL={slug}`)。
- **Codex**:`~/.codex/config.toml` 片段——`model = "{slug}"`、`model_provider = "cloudllm"`、`[model_providers.cloudllm]` 下 `name`/`base_url = "{base}/v1"`/`env_key = "CLOUDLLM_API_KEY"`/`wire_api = "chat"`,并提示 `export CLOUDLLM_API_KEY={key}`;说明注明格式以 Codex 文档为准。
- **OpenAI Python**:`OpenAI(base_url="{base}/v1", api_key="{key}")` + 最小调用。
- **OpenAI Node**:`new OpenAI({ baseURL: "{base}/v1", apiKey: "{key}" })` + 最小调用。
- **curl**:双协议各一例(`{base}/v1/chat/completions` Bearer;`{base}/v1/messages` x-api-key + anthropic-version)。

## 5. 安全

- Key 永不离开浏览器:页面无任何上行请求;CSP meta 机制级兜底——`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`,连 connect-src 都被 default 关死,JS 即使被改坏也发不出请求。
- 注入的模型 JSON 用 serde_json 序列化(天然转义),slug 字符集本就受管理面校验(`[A-Za-z0-9_./-]`),无 XSS 面;模板替换点位于 `<script>` 块内,额外把 `</` 序列转义(`</`)防脚本逃逸。
- 页面不含任何密钥/内部信息;暴露面 = 启用模型 slug 清单(用户已接受)。

## 6. 测试

- Rust(`src/guide.rs` 内联 tests):GET / 200 + text/html + 含页面标识;模型注入(插入 active/disabled 模型各一,断言只含 active);DB 关闭仍 200 且注入 `[]`;`window.__MODELS__` JSON 可解析;`</script>` 逃逸用例;GET /v1/nonexistent 仍 404(协议面不受影响)。
- e2e(`deploy/e2e/run.sh`):建模型后追加 1 条断言——GET / 200 且含 `openai/gpt-test`(注入生效),断言总数 11→12。
- Playwright 手动冒烟:截图交付。

## 7. 交付物

`src/guide.rs`(新)、`src/guide.html`(新)、`src/lib.rs`(挂路由一行)、`deploy/e2e/run.sh`(+1 断言)、`README.md`(成员接入页一节)。不动 admin-ui、K8s、Dockerfile。
