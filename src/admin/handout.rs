//! handout.rs — 纯函数:生成成员接入说明 Markdown(移植自 TS 版 apps/console/src/lib/handout.ts)。
//!
//! 与 TS buildHandout 逐字对齐的硬规则:
//!   - ANTHROPIC_BASE_URL 不带 /v1(Claude Code 自行补);
//!   - OpenAI base_url / baseURL 带 /v1;
//!   - gateway_url 末尾斜杠规整;model_slugs 为空 = 不限模型(两段 SDK 示例都显示)。

/// 规整 URL:去掉末尾连续斜杠。
fn normalize_url(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// 生成成员接入说明 Markdown。
/// gateway_url 末尾斜杠规整;model_slugs 空 = 不限模型(显示全部两段 SDK 示例)。
/// 规则:ANTHROPIC_BASE_URL 不带 /v1;OpenAI base_url 带 /v1(与 TS buildHandout 逐字对齐)。
pub fn build_handout(gateway_url: &str, plaintext_key: &str, model_slugs: &[String]) -> String {
    let base = normalize_url(gateway_url);
    let key = plaintext_key;
    let slugs = model_slugs;

    // 空列表 = 不限模型;否则逐 slug 列成 markdown 列表。
    let model_section = if slugs.is_empty() {
        "全部模型可用(all models available,不受模型白名单限制)".to_string()
    } else {
        slugs
            .iter()
            .map(|s| format!("- `{s}`"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let mut sections: Vec<String> = Vec::new();

    // ── 标题 & 基本信息 ──────────────────────────────────────────────
    sections.push(format!(
        "# CloudLLM 网关接入说明\n\
\n\
> 请妥善保管此 Key,请勿外泄。\n\
\n\
## 基本信息\n\
\n\
| 项目 | 值 |\n\
|------|----|\n\
| 网关地址 | `{base}` |\n\
| API Key  | `{key}` |\n\
\n\
## 可用模型\n\
\n\
{model_section}\n"
    ));

    // ── Claude Code 配置段(有 anthropic/* 或不限模型时) ──────────────
    let has_anthropic = slugs.iter().any(|s| s.starts_with("anthropic/"));
    if has_anthropic || slugs.is_empty() {
        // 有具体 anthropic slug 时给出 `/model {首个}`,否则给占位提示。
        let first_anthropic = slugs.iter().find(|s| s.starts_with("anthropic/"));
        let model_pick_note = match first_anthropic {
            Some(s) => format!("\n# 然后在 Claude Code 中选择模型:\n# /model {s}"),
            None => "\n# 然后在 Claude Code 中选择可用模型:\n# /model <模型名>".to_string(),
        };
        sections.push(format!(
            "## Claude Code 配置\n\
\n\
```bash\n\
export ANTHROPIC_BASE_URL={base}\n\
export ANTHROPIC_AUTH_TOKEN={key}\n\
# 启动 Claude Code\n\
claude \"你好\"{model_pick_note}\n\
```\n"
        ));
    }

    // ── OpenAI SDK 段(有 openai/* 或不限模型时) ─────────────────────
    let has_openai = slugs.iter().any(|s| s.starts_with("openai/"));
    if has_openai || slugs.is_empty() {
        // 示例模型 = 首个 openai slug,否则 "gpt-4o"。
        let example_model = slugs
            .iter()
            .find(|s| s.starts_with("openai/"))
            .map(String::as_str)
            .unwrap_or("gpt-4o");
        sections.push(format!(
            "## OpenAI SDK（Python）\n\
\n\
```python\n\
from openai import OpenAI\n\
\n\
client = OpenAI(\n\
    api_key=\"{key}\",\n\
    base_url=\"{base}/v1\",\n\
)\n\
\n\
response = client.chat.completions.create(\n\
    model=\"{example_model}\",\n\
    messages=[{{\"role\": \"user\", \"content\": \"你好\"}}],\n\
)\n\
print(response.choices[0].message.content)\n\
```\n\
\n\
## OpenAI SDK（Node.js / TypeScript）\n\
\n\
```typescript\n\
import OpenAI from \"openai\";\n\
\n\
const client = new OpenAI({{\n\
  apiKey: \"{key}\",\n\
  baseURL: \"{base}/v1\",\n\
}});\n\
\n\
const res = await client.chat.completions.create({{\n\
  model: \"{example_model}\",\n\
  messages: [{{ role: \"user\", content: \"你好\" }}],\n\
}});\n\
console.log(res.choices[0].message.content);\n\
```\n\
\n\
> Cursor 等支持自定义 OpenAI Base URL 的工具同样适用(填网关地址 `{base}/v1` + Key)。\n"
        ));
    }

    // ── 通用 curl 两例(恒显) ────────────────────────────────────────
    sections.push(format!(
        "## curl 示例\n\
\n\
### OpenAI 兼容格式\n\
\n\
```bash\n\
curl {base}/v1/chat/completions \\\n\
  -H \"Authorization: Bearer {key}\" \\\n\
  -H \"Content-Type: application/json\" \\\n\
  -d '{{\n\
    \"model\": \"gpt-4o\",\n\
    \"messages\": [{{\"role\": \"user\", \"content\": \"ping\"}}]\n\
  }}'\n\
```\n\
\n\
### Anthropic Messages API 原生格式\n\
\n\
```bash\n\
curl {base}/v1/messages \\\n\
  -H \"Authorization: Bearer {key}\" \\\n\
  -H \"Content-Type: application/json\" \\\n\
  -d '{{\n\
    \"model\": \"claude-3-5-sonnet-20241022\",\n\
    \"max_tokens\": 256,\n\
    \"messages\": [{{\"role\": \"user\", \"content\": \"Hello\"}}]\n\
  }}'\n\
```\n"
    ));

    sections.join("\n")
}

#[cfg(test)]
mod tests {
    use super::build_handout;

    fn slugs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_slugs_all_models_and_both_sdk_sections() {
        // 空 slugs:含明文 Key、规整后的网关地址(无尾斜杠)、「全部模型」、curl 两例、两段 SDK 都在。
        let out = build_handout("http://gw:8080/", "sk-cloudllm-abc123", &[]);
        assert!(out.contains("sk-cloudllm-abc123"));
        // 末尾斜杠已规整:基本信息表里是 `http://gw:8080` 不带尾斜杠
        assert!(out.contains("| 网关地址 | `http://gw:8080` |"));
        // 全部模型说明
        assert!(out.contains("全部模型可用"));
        // curl 两例
        assert!(out.contains("/v1/chat/completions"));
        assert!(out.contains("/v1/messages"));
        // Claude Code + OpenAI 两段都在
        assert!(out.contains("ANTHROPIC_BASE_URL"));
        assert!(out.contains("from openai import"));
    }

    #[test]
    fn anthropic_only_has_claude_code_no_openai() {
        // 仅 anthropic/*:ANTHROPIC_BASE_URL 不带 /v1;/model 指向首个 anthropic slug;不含 OpenAI 段。
        let out = build_handout(
            "http://localhost:8080",
            "sk-cloudllm-testkey",
            &slugs(&["anthropic/claude-x", "anthropic/claude-haiku"]),
        );
        assert!(out.contains("ANTHROPIC_BASE_URL=http://localhost:8080"));
        // 不带 /v1
        assert!(!out.contains("ANTHROPIC_BASE_URL=http://localhost:8080/v1"));
        assert!(out.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(out.contains("/model anthropic/claude-x"));
        // 无 openai/* → 不含 OpenAI SDK 段
        assert!(!out.contains("from openai import"));
    }

    #[test]
    fn openai_only_has_v1_base_url_no_anthropic() {
        // 仅 openai/*:Python base_url 与 Node baseURL 都带 /v1;不含 ANTHROPIC_BASE_URL。
        let out = build_handout(
            "http://my-gw:9000",
            "sk-cloudllm-mixed",
            &slugs(&["openai/gpt-4o"]),
        );
        assert!(out.contains("base_url=\"http://my-gw:9000/v1\""));
        assert!(out.contains("baseURL: \"http://my-gw:9000/v1\""));
        assert!(!out.contains("ANTHROPIC_BASE_URL="));
    }

    #[test]
    fn mixed_slugs_both_sections() {
        // 混合(两类 slug):Claude Code 段与 OpenAI 段都出。
        let out = build_handout(
            "http://gw:8080",
            "sk-cloudllm-both",
            &slugs(&["openai/gpt-4o", "anthropic/claude-opus-4"]),
        );
        assert!(out.contains("ANTHROPIC_BASE_URL"));
        assert!(out.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(out.contains("from openai import"));
        assert!(out.contains("import OpenAI"));
        // 示例模型 = 首个 openai slug
        assert!(out.contains("model=\"openai/gpt-4o\""));
    }
}
