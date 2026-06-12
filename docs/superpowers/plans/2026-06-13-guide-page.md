# 成员自助接入页(根路径)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网关根路径 `/` 提供成员自助接入页——简洁分工具配置文档 + 配置生成器(Key 纯浏览器本地处理),模型清单由服务端注入。

**Architecture:** `src/guide.html` 单文件静态页(内嵌 CSS/JS)经 `include_str!` 编译期嵌入;`src/guide.rs` handler 每请求查启用模型注入 `window.__MODELS__`;`src/lib.rs` 挂一条 `GET /` 路由。Key 生成全在前端 JS,CSP `default-src 'none'` 机制级禁止页面上行请求。

**Tech Stack:** axum 0.7、sqlx 运行时 API、serde_json、手写 HTML/CSS/JS(暗色霓虹 token,无 Tailwind/无构建)。

Spec:`docs/superpowers/specs/2026-06-13-member-guide-page-design.md`(已获用户批准)。

---

## 全局约定

- 分支 `feat-guide-page`(已切好);cargo 需 `export PATH="$HOME/.cargo/bin:$PATH"`。
- 三件套:`cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`(基线 215 测试)。
- 注释/文案/commit 全中文;sqlx 只用运行时 API(禁 query! 宏)。
- 视觉 token(与管理台一致,锁死不引新色):bg `#06080f`、panel `#0b0f1a` 系、line 半透明青、neon `#22d3ee`、violet `#8b5cf6`、ink `#e2e8f0`、dim/subtle `#8b9bb4`、错误 rose;网格底纹 + 双径向辉光 + 顶部 1px 渐变光带(参照 `admin-ui/src/index.css`);等宽字体用于代码与数值。
- 文案口径与 `src/admin/handout.rs` 对齐:ANTHROPIC_BASE_URL **不带** /v1;OpenAI 系 base_url **带** /v1。

## 既有事实(已核实,不必再查)

- 路由挂载点:`src/lib.rs` `app()` 中 `traced` Router(`.nest("/v1", ...)` 那条链);根路径当前无路由(404)。
- models 表:`slug TEXT UNIQUE`、`provider_type IN ('openai','anthropic')`、`status IN ('active','disabled')`。
- `src/test_util.rs`:`test_state() -> AppState`;`insert_model(db, slug, provider_type, upstream_model, in_micro, out_micro, cr_micro, cw_micro) -> String`(固定插 status='active';要 disabled 需再 `UPDATE models SET status='disabled' WHERE slug=?`)。
- 测试里发请求范式(参照 lib.rs healthz 测试):`app(state).oneshot(Request::builder().uri("/").body(Body::empty()).unwrap()).await.unwrap()`,需 `use tower::ServiceExt;`。
- `state.db.close().await` 可模拟 DB 故障(healthz 测试同款)。
- e2e 现状:`deploy/e2e/run.sh` 11 项断言,在「建渠道/模型」步骤后已有模型 `openai/gpt-test`;BASE=http://localhost:17200。

---

### Task 1: guide.rs handler + 路由 + 全部 Rust 测试(TDD)

**Files:**
- Create: `src/guide.rs`
- Create: `src/guide.html`(本任务先放最小可测模板,T2 替换为完整页面)
- Modify: `src/lib.rs`(声明模块 + 挂路由)

- [ ] **Step 1: 写最小模板 src/guide.html**(让 include_str! 可编译、测试可跑;T2 全量替换)

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>CloudLLM 接入</title>
</head>
<body>
<h1>CloudLLM 成员接入</h1>
<script>window.__MODELS__ = /*__MODELS_JSON__*/[];</script>
</body>
</html>
```

占位符设计:`/*__MODELS_JSON__*/[]` 本身是合法 JS(注释+空数组),未替换时页面也能工作;handler 整串替换为真实 JSON。

- [ ] **Step 2: 写失败测试(src/guide.rs 内联 tests)**

```rust
//! 成员自助接入页:GET / 返回嵌入式静态页,服务端注入启用模型清单。
//! Key 的拼接全在浏览器本地完成,本模块绝不接触任何 Key。

use crate::AppState;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

const GUIDE_HTML: &str = include_str!("guide.html");
/// 模板中的注入点:注释 + 空数组,未替换时模板本身仍是合法 JS
const MODELS_PLACEHOLDER: &str = "/*__MODELS_JSON__*/[]";

#[derive(serde::Serialize, sqlx::FromRow)]
struct GuideModel {
    slug: String,
    provider_type: String,
}

pub async fn serve_guide(State(state): State<AppState>) -> Response {
    // 查库失败降级为空清单:页面照常可用(模型框退化为手填),错误只进日志
    let models = fetch_active_models(&state).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "接入页查询模型清单失败,降级为空");
        Vec::new()
    });
    let json = serde_json::to_string(&models).unwrap_or_else(|_| "[]".into());
    // 防 </script> 逃逸:JSON 字符串值里出现的 "</" 转义为 "<\/"(JS 字符串语义不变)
    let json = json.replace("</", "<\\/");
    let html = GUIDE_HTML.replace(MODELS_PLACEHOLDER, &json);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

async fn fetch_active_models(state: &AppState) -> anyhow::Result<Vec<GuideModel>> {
    Ok(sqlx::query_as(
        "SELECT slug, provider_type FROM models WHERE status = 'active' ORDER BY slug",
    )
    .fetch_all(&state.db)
    .await?)
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{insert_model, test_state};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn get_root(state: crate::AppState) -> (StatusCode, String, String, String) {
        let resp = app(state)
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let ct = resp
            .headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let cc = resp
            .headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, ct, cc, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn root_serves_html_page() {
        let state = test_state().await;
        let (status, ct, cc, body) = get_root(state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ct, "text/html; charset=utf-8");
        assert_eq!(cc, "no-cache");
        assert!(body.contains("CloudLLM"));
        assert!(body.contains("window.__MODELS__"));
    }

    #[tokio::test]
    async fn injects_active_models_only() {
        let state = test_state().await;
        insert_model(&state.db, "openai/gpt-live", "openai", "gpt-live", 1, 1, 0, 0).await;
        insert_model(&state.db, "anthropic/claude-x", "anthropic", "claude-x", 1, 1, 0, 0).await;
        insert_model(&state.db, "openai/gpt-dead", "openai", "gpt-dead", 1, 1, 0, 0).await;
        sqlx::query("UPDATE models SET status = 'disabled' WHERE slug = 'openai/gpt-dead'")
            .execute(&state.db)
            .await
            .unwrap();
        let (_, _, _, body) = get_root(state).await;
        assert!(body.contains("openai/gpt-live"));
        assert!(body.contains("anthropic/claude-x"));
        assert!(!body.contains("openai/gpt-dead"), "禁用模型不得注入");
    }

    #[tokio::test]
    async fn injected_models_json_parseable() {
        let state = test_state().await;
        insert_model(&state.db, "openai/gpt-live", "openai", "gpt-live", 1, 1, 0, 0).await;
        let (_, _, _, body) = get_root(state).await;
        let start = body.find("window.__MODELS__ = ").unwrap() + "window.__MODELS__ = ".len();
        let end = body[start..].find(";</script>").unwrap() + start;
        let parsed: serde_json::Value = serde_json::from_str(&body[start..end]).unwrap();
        assert_eq!(parsed[0]["slug"], "openai/gpt-live");
        assert_eq!(parsed[0]["provider_type"], "openai");
    }

    #[tokio::test]
    async fn db_failure_degrades_to_empty_list() {
        let state = test_state().await;
        state.db.close().await;
        let (status, _, _, body) = get_root(state).await;
        assert_eq!(status, StatusCode::OK, "查库失败页面必须照常 200");
        assert!(body.contains("window.__MODELS__ = []"));
    }

    #[tokio::test]
    async fn script_close_tag_in_slug_is_escaped() {
        let state = test_state().await;
        // 管理面校验会拦这种 slug,但防御纵深:直插恶意值验证转义
        insert_model(&state.db, "x/</script><img>", "openai", "m", 1, 1, 0, 0).await;
        let (_, _, _, body) = get_root(state).await;
        assert!(!body.contains("</script><img>"), "JSON 注入区不得出现未转义的 </");
        assert!(body.contains("<\\/script>"), "应转义为 <\\/");
    }

    #[tokio::test]
    async fn gateway_404_semantics_unchanged() {
        let state = test_state().await;
        let resp = app(state)
            .oneshot(Request::builder().uri("/v1/nonexistent").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test --locked guide 2>&1 | tail -5`
Expected: 编译错误(lib.rs 尚无 `mod guide`、无路由)——这是本任务的"红"。

- [ ] **Step 4: 挂模块与路由(src/lib.rs)**

模块声明区加一行(与现有 `pub mod gateway;` 等并排):

```rust
pub mod guide;
```

`app()` 的 `traced` Router 链上、`.nest("/v1", ...)` 之前加:

```rust
.route("/", get(guide::serve_guide))
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test --locked guide`
Expected: 6 passed。再跑全量 `cargo test --locked`,Expected: 221 passed(215+6),无破坏。

- [ ] **Step 6: 三件套 + Commit**

```bash
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
git add src/guide.rs src/guide.html src/lib.rs
git commit -m "feat(rust): 根路径成员接入页骨架——GET / 注入启用模型清单(降级/转义/404 语义全测试)"
```

---

### Task 2: guide.html 完整页面(视觉 + 五 Tab 生成器)

**Files:**
- Rewrite: `src/guide.html`(替换 T1 最小模板;保留 `<script>window.__MODELS__ = /*__MODELS_JSON__*/[];</script>` 注入行与 CSP meta 逐字不变——T1 测试依赖)

- [ ] **Step 1: 实现完整页面**

硬性结构与行为(视觉细节在 token 约束内自由发挥):

1. `<head>`:charset、viewport、CSP meta(与 T1 逐字一致)、`<title>CloudLLM 接入</title>`、内嵌 `<style>`。
2. 头部:CloudLLM 渐变字标(neon→violet)+ 副标「成员自助接入」+ 右侧小链接 `管理台 →`(href="/admin")。
3. 生成器卡片(单列布局,移动端可用):
   - Key 输入:`<input type="password" id="key" placeholder="sk-cloudllm-...">` + 显示/隐藏切换按钮;
   - Base URL 输入:`<input id="base">`,JS 初始化为 `location.origin`;
   - 模型输入:`<input id="model" list="model-list">` + `<datalist id="model-list">`,候选 = `window.__MODELS__` 按当前 Tab 协议过滤(claude-code Tab → anthropic;codex/openai-py/openai-node Tab → openai;curl Tab 不过滤);Tab 切换时若当前值不属于新协议则清空并重填首个候选;无候选时留空手填。
   - Tab 条:`Claude Code | Codex | OpenAI Python | OpenAI Node | curl`;
   - 输出区:`<pre id="out">` 实时渲染(input/tab 任一变化即重算);**Key 为空时输出占位 `<请在上方填入你的 API Key>` 参与渲染**(页面始终有内容可看);
   - 按钮:`复制`(navigator.clipboard,失败回退 document.execCommand('copy'),带"已复制"瞬时反馈);Codex Tab 额外 `下载 config.toml`(Blob + a[download]);
   - 每 Tab 下方 2-3 行说明(放哪/如何验证)。
4. 页脚:`Key 仅在浏览器本地拼接,不会发送到任何服务器(本页 CSP 已禁止全部网络请求)。`
5. 全部 JS 内联、无外部资源、无 fetch/XHR(CSP 会拦,也不许写)。

五 Tab 生成模板(JS 模板字符串,`${base}`=Base URL 去尾斜杠、`${key}`、`${model}`;口径与 handout.rs 一致):

- **claude-code**(model 为空则省略 ANTHROPIC_MODEL 行):
```text
export ANTHROPIC_BASE_URL=${base}
export ANTHROPIC_AUTH_TOKEN=${key}
export ANTHROPIC_MODEL=${model}
# 写入 shell 配置后,启动 Claude Code:
claude "你好"
```
说明:加入 `~/.zshrc` 或 `~/.bashrc` 后 source;ANTHROPIC_BASE_URL 不带 /v1。

- **codex**(`~/.codex/config.toml`;model 为空用占位 `<模型名>`):
```text
# ~/.codex/config.toml
model = "${model}"
model_provider = "cloudllm"

[model_providers.cloudllm]
name = "CloudLLM"
base_url = "${base}/v1"
env_key = "CLOUDLLM_API_KEY"
wire_api = "chat"
```
说明:另需 `export CLOUDLLM_API_KEY=${key}`(单独一行展示,含真实 key);字段以 Codex 官方文档为准。下载按钮只下载 toml 部分(不含 export 行)。

- **openai-py**:
```python
from openai import OpenAI

client = OpenAI(
    api_key="${key}",
    base_url="${base}/v1",
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

- **openai-node**:
```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${key}",
  baseURL: "${base}/v1",
});

const res = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "你好" }],
});
console.log(res.choices[0].message.content);
```

- **curl**(双协议两段):
```bash
# OpenAI 兼容格式
curl ${base}/v1/chat/completions \
  -H "Authorization: Bearer ${key}" \
  -H "Content-Type: application/json" \
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "ping"}]}'

# Anthropic Messages 原生格式
curl ${base}/v1/messages \
  -H "Authorization: Bearer ${key}" \
  -H "Content-Type: application/json" \
  -d '{"model": "${model}", "max_tokens": 256, "messages": [{"role": "user", "content": "ping"}]}'
```

生成内容插入 `<pre>` 必须用 `textContent`(不是 innerHTML)——key/model 含特殊字符不解释为 HTML。

- [ ] **Step 2: 全量测试仍绿**

Run: `cargo test --locked`
Expected: 221 passed(T1 测试锁住注入行与标识,改版页面不许破坏)。

- [ ] **Step 3: Playwright 真浏览器冒烟**

`cargo run -- serve`(临时 init 到 /tmp 的配置或复用本机 dev 配置),用 Playwright MCP 打开 `http://localhost:7200/`:
- 填 Key/选 Tab,断言 `<pre>` 内容随输入变化、复制按钮反馈、Claude Code Tab 不带 /v1 而 OpenAI Tab 带 /v1;
- 检查浏览器 console 无报错、Network 面板除文档自身无任何请求(CSP 生效);
- 截图存 `/tmp/guide-page.png`(交付给用户)。

- [ ] **Step 4: Commit**

```bash
git add src/guide.html
git commit -m "feat(rust): 接入页完整实现——五 Tab 配置生成器(暗色霓虹/CSP 禁网/纯本地拼接)"
```

---

### Task 3: e2e 断言 + README + 终验

**Files:**
- Modify: `deploy/e2e/run.sh`(「建渠道/模型」步骤之后插入 1 项断言)
- Modify: `README.md`(快速开始之后新增一小节)

- [ ] **Step 1: e2e 增断言**(插在 `ok "渠道与模型就绪"` 之后)

```bash
say "根路径接入页注入模型清单"
GUIDE=$(curl -fsS "$BASE/")
echo "$GUIDE" | grep -q 'openai/gpt-test' || die "接入页未注入模型 openai/gpt-test"
echo "$GUIDE" | grep -q 'window.__MODELS__' || die "接入页缺模型注入点"
ok "接入页就绪,模型清单已注入"
```

末行计数同步:`全部通过:11 项断言。` 改 12(以实际 ok 数为准)。

- [ ] **Step 2: README 新增「成员自助接入」一节**(放在两个快速开始之后),必含:根路径 `/` 即成员接入页;五种工具配置生成;模型清单自动列出(启用模型);Key 在浏览器本地拼接不上传(CSP 禁网);管理员在管理台签 Key 后把网关地址发给成员即可。4-8 行,与全文风格一致。

- [ ] **Step 3: 全量终验**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked   # 221
(cd admin-ui && npm run build)
./deploy/e2e/run.sh   # 末行「全部通过:12 项断言。」
```

- [ ] **Step 4: Commit**

```bash
git add deploy/e2e/run.sh README.md
git commit -m "feat(rust): 接入页 e2e 断言 + README 成员接入说明"
```

---

## 任务依赖

T1 → T2 → T3 严格串行。

## 完成定义

- GET / 返回完整接入页,模型注入/降级/转义全有测试(221);五 Tab 生成口径与 handout 一致;e2e 12 断言;Playwright 截图交付;README 更新。合并 main 由主会话 finishing 流程执行。
