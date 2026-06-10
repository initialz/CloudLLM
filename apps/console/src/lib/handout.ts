/**
 * handout.ts — 纯函数:生成成员接入说明 Markdown
 *
 * 规则(来自 README 接入示例风格):
 *   - ANTHROPIC_BASE_URL  不带 /v1
 *   - OpenAI base_url / baseURL  带 /v1
 *   - Key 前缀格式 sk-wtg-
 */

export interface HandoutOptions {
  /** 网关对外地址;末尾斜杠会被规整 */
  gatewayUrl: string;
  /** Key 明文(sk-wtg-...) */
  plaintextKey: string;
  /** 允许的模型 slug 列表;空数组 = 不限制 */
  modelSlugs: string[];
}

/** 规整 URL:去掉末尾斜杠 */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 判断是否含 anthropic/* 模型 */
function hasAnthropic(slugs: string[]): boolean {
  return slugs.some((s) => s.startsWith("anthropic/"));
}

/** 判断是否含 openai/* 模型 */
function hasOpenAI(slugs: string[]): boolean {
  return slugs.some((s) => s.startsWith("openai/"));
}

/**
 * 生成成员接入说明 Markdown 字符串
 */
export function buildHandout(opts: HandoutOptions): string {
  const base = normalizeUrl(opts.gatewayUrl);
  const key = opts.plaintextKey;
  const slugs = opts.modelSlugs;

  const modelSection =
    slugs.length === 0
      ? "全部模型可用(all models available,不受模型白名单限制)"
      : slugs.map((s) => `- \`${s}\``).join("\n");

  const sections: string[] = [];

  // ── 标题 & 基本信息 ──────────────────────────────────────────────────────
  sections.push(`# BYOK 网关接入说明

> 请妥善保管此 Key,请勿外泄。

## 基本信息

| 项目 | 值 |
|------|----|
| 网关地址 | \`${base}\` |
| API Key  | \`${key}\` |

## 可用模型

${modelSection}
`);

  // ── Claude Code 配置段(有 anthropic/* 时) ────────────────────────────────
  if (hasAnthropic(slugs) || slugs.length === 0) {
    // 空列表(不限)时也显示 Claude Code 段
    const anthropicSlugs = slugs.filter((s) => s.startsWith("anthropic/"));
    const modelPickNote =
      anthropicSlugs.length > 0
        ? `\n# 然后在 Claude Code 中选择模型:\n# /model ${anthropicSlugs[0]}`
        : "\n# 然后在 Claude Code 中选择可用模型:\n# /model <模型名>";

    sections.push(`## Claude Code 配置

\`\`\`bash
export ANTHROPIC_BASE_URL=${base}
export ANTHROPIC_AUTH_TOKEN=${key}
# 启动 Claude Code
claude "你好"${modelPickNote}
\`\`\`
`);
  }

  // ── OpenAI SDK 段(有 openai/* 时) ───────────────────────────────────────
  if (hasOpenAI(slugs) || slugs.length === 0) {
    // 空列表(不限)时也显示 OpenAI SDK 段
    const openaiSlugs = slugs.filter((s) => s.startsWith("openai/"));
    const exampleModel =
      openaiSlugs.length > 0 ? openaiSlugs[0]! : "gpt-4o";

    sections.push(`## OpenAI SDK（Python）

\`\`\`python
from openai import OpenAI

client = OpenAI(
    api_key="${key}",
    base_url="${base}/v1",
)

response = client.chat.completions.create(
    model="${exampleModel}",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
\`\`\`

## OpenAI SDK（Node.js / TypeScript）

\`\`\`typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${key}",
  baseURL: "${base}/v1",
});

const res = await client.chat.completions.create({
  model: "${exampleModel}",
  messages: [{ role: "user", content: "你好" }],
});
console.log(res.choices[0].message.content);
\`\`\`
`);
  }

  // ── 通用 curl 两例 ────────────────────────────────────────────────────────
  sections.push(`## curl 示例

### OpenAI 兼容格式

\`\`\`bash
curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "ping"}]
  }'
\`\`\`

### Anthropic Messages API 原生格式

\`\`\`bash
curl ${base}/v1/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
\`\`\`
`);

  return sections.join("\n");
}
