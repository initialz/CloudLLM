//! 计费纯函数:token 用量提取(两协议、流式事件与非流式同源)、micro-CNY 逐档 ceil 计费、
//! UTF-8 安全截断。下半部分(check_budgets / settle_usage 事务)在 T7 追加。

use serde_json::Value;

/// 四档 token 用量。i64 避免与 micro 计算混用 usize。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

/// 模型四档单价(micro-CNY per 1M tokens),来自 models 表四列。
#[derive(Debug, Clone, Copy)]
pub struct Prices {
    pub input_micro: i64,
    pub output_micro: i64,
    pub cache_read_micro: i64,
    pub cache_write_micro: i64,
}

/// 单档:ceil(tokens × price_per_mtok / 1_000_000)。tokens=0 记 0。
/// 负单价:debug_assert 触发(开发期暴露脏数据),release 下 clamp 到 0(不让脏价格炸热路径)。
fn line_cost_micro(tokens: i64, price_per_mtok: i64) -> i64 {
    if tokens <= 0 {
        return 0;
    }
    debug_assert!(price_per_mtok >= 0, "模型单价不能为负: {price_per_mtok}");
    // release 下脏价格 clamp,不炸热路径
    let price = price_per_mtok.max(0);
    // ceil(tokens * price / 1e6);i128 防溢出(tokens ~1e7、price ~1e9 → 1e16,仍在 i64 内,
    // 但乘积中间值用 i128 稳妥)
    let numerator = tokens as i128 * price as i128;
    let micro = 1_000_000i128;
    (((numerator + micro - 1) / micro) as i64).max(0)
}

/// 四档求和。token / price 任一非法在各自档位处理:负 token clamp 0、负价 clamp 0。
pub fn compute_cost_micro(usage: &Usage, prices: &Prices) -> i64 {
    line_cost_micro(usage.input_tokens, prices.input_micro)
        + line_cost_micro(usage.output_tokens, prices.output_micro)
        + line_cost_micro(usage.cache_read_tokens, prices.cache_read_micro)
        + line_cost_micro(usage.cache_write_tokens, prices.cache_write_micro)
}

/// 协议枚举。与 gateway 其余模块共用(此处定义,gateway 内 re-export)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Openai,
    Anthropic,
}

/// 取整型字段,缺失/非整数视为 0(与 TS num() 一致)
fn num(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// 从完整 JSON(非流式响应体,或流式单个事件对象)提取用量。
/// 解析不出 usage → 全零。
pub fn extract_usage_from_json(protocol: Protocol, body: &Value) -> Usage {
    let usage = match body.get("usage") {
        Some(u) if u.is_object() => u,
        _ => return Usage::default(),
    };
    match protocol {
        Protocol::Openai => {
            let prompt = num(usage, "prompt_tokens");
            let cached = usage
                .get("prompt_tokens_details")
                .map(|d| num(d, "cached_tokens"))
                .unwrap_or(0);
            Usage {
                input_tokens: (prompt - cached).max(0),
                output_tokens: num(usage, "completion_tokens"),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            }
        }
        Protocol::Anthropic => Usage {
            input_tokens: num(usage, "input_tokens"),
            output_tokens: num(usage, "output_tokens"),
            cache_read_tokens: num(usage, "cache_read_input_tokens"),
            cache_write_tokens: num(usage, "cache_creation_input_tokens"),
        },
    }
}

/// UTF-8 安全截断:超过 limit 字节则截到不破坏字符的边界并加后缀「…[截断]」。
/// 未超长返回原串。limit 指原文字节上限(后缀不计入 limit)。
pub fn truncate_utf8(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    // 从 limit 处向左找到字符边界
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[截断]", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── compute_cost_micro:固定向量对账(数值算清楚)──

    #[test]
    fn cost_split_input_output() {
        // 价格:输入 21_000_000 micro/MTok(=21 CNY),输出 105_000_000(=105 CNY)
        // 1000/1e6*21e6 = 21000 micro;500/1e6*105e6 = 52500 micro → 73500
        let p = Prices {
            input_micro: 21_000_000,
            output_micro: 105_000_000,
            cache_read_micro: 0,
            cache_write_micro: 0,
        };
        let u = Usage {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        };
        assert_eq!(compute_cost_micro(&u, &p), 73_500);
    }

    #[test]
    fn cost_cache_tokens() {
        // 缓存读 2_100_000 micro/MTok(=2.1 CNY),缓存写 26_250_000(=26.25 CNY)
        // 100000/1e6*2.1e6 = 210000;10000/1e6*26.25e6 = 262500 → 472500
        let p = Prices {
            input_micro: 0,
            output_micro: 0,
            cache_read_micro: 2_100_000,
            cache_write_micro: 26_250_000,
        };
        let u = Usage {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 100_000,
            cache_write_tokens: 10_000,
        };
        assert_eq!(compute_cost_micro(&u, &p), 472_500);
    }

    #[test]
    fn cost_ceil_per_line() {
        // 1 token × 0.5 CNY/MTok = 500_000 micro/MTok;1*500000/1e6 = 0.5 micro → ceil 1
        let p = Prices {
            input_micro: 500_000,
            output_micro: 0,
            cache_read_micro: 0,
            cache_write_micro: 0,
        };
        let u = Usage {
            input_tokens: 1,
            ..Usage::default()
        };
        assert_eq!(compute_cost_micro(&u, &p), 1);
    }

    #[test]
    fn cost_zero_tokens_zero() {
        let p = Prices {
            input_micro: 21_000_000,
            output_micro: 105_000_000,
            cache_read_micro: 1,
            cache_write_micro: 1,
        };
        assert_eq!(compute_cost_micro(&Usage::default(), &p), 0);
    }

    #[test]
    fn cost_each_line_ceils_independently() {
        // 两档各 0.5 micro,独立进位 → 1 + 1 = 2(印证"逐行 ceil 后求和",非合并后 ceil)
        let p = Prices {
            input_micro: 500_000,
            output_micro: 500_000,
            cache_read_micro: 0,
            cache_write_micro: 0,
        };
        let u = Usage {
            input_tokens: 1,
            output_tokens: 1,
            ..Usage::default()
        };
        assert_eq!(compute_cost_micro(&u, &p), 2);
    }

    #[test]
    fn cost_negative_price_clamps_to_zero() {
        // release 下 clamp;测试构建会触发 debug_assert,故此用例用 catch:改为直接验证 clamp 语义
        // —— 见实现说明:debug_assert 只在 debug_assertions 开;cargo test 默认开 debug_assertions。
        // 因此这里不喂负价(会 panic),改测负 token clamp。
        let p = Prices {
            input_micro: 21_000_000,
            output_micro: 0,
            cache_read_micro: 0,
            cache_write_micro: 0,
        };
        let u = Usage {
            input_tokens: -100,
            ..Usage::default()
        };
        assert_eq!(compute_cost_micro(&u, &p), 0);
    }

    // ── extract_usage_from_json ──

    #[test]
    fn extract_openai_splits_cache() {
        let u = extract_usage_from_json(
            Protocol::Openai,
            &json!({
                "usage": { "prompt_tokens": 1000, "completion_tokens": 50, "prompt_tokens_details": { "cached_tokens": 600 } }
            }),
        );
        assert_eq!(
            u,
            Usage {
                input_tokens: 400,
                output_tokens: 50,
                cache_read_tokens: 600,
                cache_write_tokens: 0
            }
        );
    }

    #[test]
    fn extract_openai_no_cache_detail() {
        let u = extract_usage_from_json(
            Protocol::Openai,
            &json!({ "usage": { "prompt_tokens": 10, "completion_tokens": 5 } }),
        );
        assert_eq!(
            u,
            Usage {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: 0,
                cache_write_tokens: 0
            }
        );
    }

    #[test]
    fn extract_anthropic_four_fields() {
        let u = extract_usage_from_json(
            Protocol::Anthropic,
            &json!({
                "usage": { "input_tokens": 7, "output_tokens": 9, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20 }
            }),
        );
        assert_eq!(
            u,
            Usage {
                input_tokens: 7,
                output_tokens: 9,
                cache_read_tokens: 100,
                cache_write_tokens: 20
            }
        );
    }

    #[test]
    fn extract_missing_usage_is_zero() {
        assert_eq!(
            extract_usage_from_json(Protocol::Openai, &Value::Null),
            Usage::default()
        );
        assert_eq!(
            extract_usage_from_json(Protocol::Anthropic, &json!({ "usage": "bad" })),
            Usage::default()
        );
    }

    #[test]
    fn extract_openai_cached_exceeds_prompt_clamps_input_zero() {
        // prompt - cached 下限 0
        let u = extract_usage_from_json(
            Protocol::Openai,
            &json!({
                "usage": { "prompt_tokens": 5, "completion_tokens": 0, "prompt_tokens_details": { "cached_tokens": 9 } }
            }),
        );
        assert_eq!(u.input_tokens, 0);
        assert_eq!(u.cache_read_tokens, 9);
    }

    // ── truncate_utf8 ──

    #[test]
    fn truncate_short_unchanged() {
        assert_eq!(truncate_utf8("hi", 65536), "hi");
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // "你好世界" 每字 3 字节 = 12 字节;limit=7 应截到 6 字节(2 字)不切碎第 3 字
        let out = truncate_utf8("你好世界", 7);
        assert!(out.starts_with("你好"));
        assert!(out.ends_with("…[截断]"));
        assert!(!out.contains("世"));
    }

    #[test]
    fn truncate_exact_limit_unchanged() {
        let s = "abcdef"; // 6 字节
        assert_eq!(truncate_utf8(s, 6), s);
    }
}
