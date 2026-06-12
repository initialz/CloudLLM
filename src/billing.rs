//! 计费纯函数:token 用量提取(两协议、流式事件与非流式同源)、micro-CNY 逐档 ceil 计费、
//! UTF-8 安全截断。下半部分(check_budgets / settle_usage 事务)在 T7 追加。

use crate::gateway::auth::AuthedKey;
use serde_json::Value;
use sqlx::SqlitePool;

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
    // release 下负单价 clamp 为 0;debug 下由上方 debug_assert 拦截,故无法在测试中直接覆盖
    let price = price_per_mtok.max(0);
    // ceil(tokens * price / 1e6);i128 防溢出(tokens ~1e7、price ~1e9 → 1e16,仍在 i64 内,
    // 但乘积中间值用 i128 稳妥)
    let numerator = tokens as i128 * price as i128;
    let micro = 1_000_000i128;
    let quotient = (numerator + micro - 1) / micro;
    // 极端 tokens×price 下饱和到 i64::MAX,宁多记不少记;TS 版以阈值抛错,Rust 选饱和
    i64::try_from(quotient).unwrap_or(i64::MAX).max(0)
}

/// 四档求和。token / price 任一非法在各自档位处理:负 token clamp 0、负价 clamp 0。
pub fn compute_cost_micro(usage: &Usage, prices: &Prices) -> i64 {
    line_cost_micro(usage.input_tokens, prices.input_micro)
        + line_cost_micro(usage.output_tokens, prices.output_micro)
        + line_cost_micro(usage.cache_read_tokens, prices.cache_read_micro)
        + line_cost_micro(usage.cache_write_tokens, prices.cache_write_micro)
}

/// 解析 CNY 字符串为 micro-CNY:接受 "100" / "100.50",最多 6 位小数,非负。
/// 校验「必须为正」由调用方按业务判断(模型价格允许 0,预算限额要 >0)。
pub fn parse_cny_to_micro(s: &str) -> anyhow::Result<i64> {
    let s = s.trim();
    anyhow::ensure!(!s.is_empty(), "金额不能为空");
    anyhow::ensure!(!s.starts_with('-'), "金额不能为负");
    let (int_part, frac_part) = s.split_once('.').unwrap_or((s, ""));
    anyhow::ensure!(frac_part.len() <= 6, "最多 6 位小数");
    anyhow::ensure!(
        !int_part.is_empty() && int_part.bytes().all(|b| b.is_ascii_digit()),
        "金额格式无效"
    );
    anyhow::ensure!(
        frac_part.bytes().all(|b| b.is_ascii_digit()),
        "金额格式无效"
    );
    let int: i64 = int_part.parse().map_err(|_| anyhow::anyhow!("金额过大"))?;
    let frac: i64 = if frac_part.is_empty() {
        0
    } else {
        format!("{frac_part:0<6}").parse()?
    };
    int.checked_mul(1_000_000)
        .and_then(|v| v.checked_add(frac))
        .ok_or_else(|| anyhow::anyhow!("金额过大"))
}

/// 协议枚举。与 gateway 其余模块共用(此处定义,gateway 内 re-export)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Openai,
    Anthropic,
}

/// 取整型字段,缺失/非整数视为 0(与 TS num() 一致)
/// 有意分歧:JSON 浮点(如 10.0)返回 0,TS 版会接受;两家上游 token 计数恒为整数,选更严格的 as_i64
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

/// 预算主体:Key 自身 + owner。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub subject_type: String,
    pub subject_id: String,
}

/// 无 app→team 三级上卷:0001 schema owner_type 仅 user/team(TS 版有 app 类型);
/// 若未来加 owner_type 需同步扩展此处。
pub fn subjects_for_key(key: &AuthedKey) -> Vec<Subject> {
    vec![
        Subject {
            subject_type: "key".into(),
            subject_id: key.id.clone(),
        },
        Subject {
            subject_type: key.owner_type.clone(),
            subject_id: key.owner_id.clone(),
        },
    ]
}

/// 落库时的请求结局。
#[derive(Debug, Clone)]
pub struct SettleInput {
    pub key_id: String,
    pub model_slug: String,
    pub channel_id: Option<String>,
    pub usage: Usage,
    pub cost_micro: i64,
    pub latency_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub status: &'static str, // ok / rejected / upstream_error / client_abort
    pub error_code: Option<String>,
    pub request_body: Option<String>,  // 已截断(audit)
    pub response_body: Option<String>, // 已截断(audit)
    /// 预算累加用的主体(rejected 时可空)
    pub subjects: Vec<Subject>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BudgetCheck {
    Ok,
    Exhausted(Subject),
}

/// (year, month) 元组:ts 所在 UTC 自然月。非法时间戳视为最早 (0, 0)。
fn year_month(ts: i64) -> (i32, u8) {
    match time::OffsetDateTime::from_unix_timestamp(ts) {
        Ok(dt) => (dt.year(), dt.month() as u8),
        Err(_) => (0, 0), // 非法时间戳:视为最早,触发翻转重置(安全侧)
    }
}

/// (year, month) 比较:ts 所在月是否早于 now 所在月(UTC)。
/// 用元组比较以正确处理跨年(12 月 < 次年 1 月)。
fn is_earlier_month(ts: i64, now: i64) -> bool {
    year_month(ts) < year_month(now)
}

/// 读路径预算检查。月翻转仅视角处理,不写库。
/// TOCTOU:检查与落库之间存在并发窗口,接受少量超透(准实时截断);
/// usage_records 台账为事实源,对齐 TS 版取舍。
pub async fn check_budgets(db: &SqlitePool, subjects: &[Subject], now: i64) -> BudgetCheck {
    for s in subjects {
        let rows: Vec<(String, i64, i64, i64)> = match sqlx::query_as(
            "SELECT period, limit_micro, used_micro, period_start FROM budgets \
             WHERE subject_type = ? AND subject_id = ? AND status = 'active'",
        )
        .bind(&s.subject_type)
        .bind(&s.subject_id)
        .fetch_all(db)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, "查询预算失败");
                // 读失败放行(可用性优先;落库台账仍记账)——与 TS「PG 为事实源」取舍一致
                continue;
            }
        };
        for (period, limit, used, period_start) in rows {
            let remaining = if period == "monthly" && is_earlier_month(period_start, now) {
                limit // 视角翻转:本月未用
            } else {
                limit - used
            };
            if remaining <= 0 {
                return BudgetCheck::Exhausted(s.clone());
            }
        }
    }
    BudgetCheck::Ok
}

/// 单事务落库:INSERT usage_records + 命中预算行 UPDATE(含月翻转内联)。
pub async fn settle_usage(db: &SqlitePool, input: &SettleInput, now: i64) -> anyhow::Result<()> {
    // 负成本只能来自调用方绕过 compute_cost_micro 的 bug:宁响不哑(对齐 TS 版 settleBudgets 抛错的意图,Rust 不 panic 写路径,改为响亮日志)
    debug_assert!(input.cost_micro >= 0, "settle_usage 收到负 cost_micro");
    if input.cost_micro < 0 {
        tracing::error!(cost_micro = input.cost_micro, key_id = %input.key_id, "settle_usage 收到负 cost_micro,按 0 处理");
    }

    let mut tx = db.begin().await?;

    sqlx::query(
        "INSERT INTO usage_records \
         (id, key_id, model_slug, channel_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, \
          cost_micro, latency_ms, ttft_ms, status, error_code, request_body, response_body, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&input.key_id)
    .bind(&input.model_slug)
    .bind(&input.channel_id)
    .bind(input.usage.input_tokens)
    .bind(input.usage.output_tokens)
    .bind(input.usage.cache_read_tokens)
    .bind(input.usage.cache_write_tokens)
    // 负值以 0 落库,防污染 SUM 报表
    .bind(input.cost_micro.max(0))
    .bind(input.latency_ms)
    .bind(input.ttft_ms)
    .bind(input.status)
    .bind(&input.error_code)
    .bind(&input.request_body)
    .bind(&input.response_body)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    // 仅成功结局且 cost>0 累加预算
    let accrue = matches!(input.status, "ok" | "client_abort") && input.cost_micro > 0;
    if accrue {
        for s in &input.subjects {
            let rows: Vec<(String, String, i64)> = sqlx::query_as(
                "SELECT id, period, period_start FROM budgets \
                 WHERE subject_type = ? AND subject_id = ? AND status = 'active'",
            )
            .bind(&s.subject_type)
            .bind(&s.subject_id)
            .fetch_all(&mut *tx)
            .await?;
            for (bid, period, period_start) in rows {
                if period == "monthly" && is_earlier_month(period_start, now) {
                    // 翻转:同事务内重置 used=0、更新 period_start,再累加
                    // 此分支是读-改-写:跨月首笔并发结算存在丢失更新窗口(仅月界瞬间),
                    // 由 T9 月度翻转 job 兜底校正;非翻转分支的 used_micro = used_micro + ? 是引擎级原子,无此窗口。
                    // :memory: 测试单连接跑不出并发,绿灯不证明并发安全
                    sqlx::query("UPDATE budgets SET used_micro = ?, period_start = ? WHERE id = ?")
                        .bind(input.cost_micro)
                        // period_start 此处是「本周期首笔结算时间」而非自然月起点;
                        // 读路径按 (year,month) 比较,月内不会重复翻转;报表不得把它当账期边界
                        .bind(now)
                        .bind(&bid)
                        .execute(&mut *tx)
                        .await?;
                } else {
                    sqlx::query("UPDATE budgets SET used_micro = used_micro + ? WHERE id = ?")
                        .bind(input.cost_micro)
                        .bind(&bid)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
    }

    tx.commit().await?;
    Ok(())
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
    fn cost_all_four_tiers_each_ceil_up() {
        // 四档各 1 token、单价各 500_000 micro/MTok:每档 1*500000/1e6 = 0.5 micro 独立 ceil → 1
        // 总额恰为 4,锁定「最多多记 4 micro」性质(逐档 ceil 后求和的上界)
        let p = Prices {
            input_micro: 500_000,
            output_micro: 500_000,
            cache_read_micro: 500_000,
            cache_write_micro: 500_000,
        };
        let u = Usage {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 1,
            cache_write_tokens: 1,
        };
        assert_eq!(compute_cost_micro(&u, &p), 4);
    }

    #[test]
    fn cost_negative_tokens_clamp_to_zero() {
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

    #[test]
    fn truncate_tiny_limit_returns_suffix_only() {
        // 超长输入,limit 极小(0 与 1):首字符为 3 字节多字节字符,
        // 边界回退至 0 → 输出恰为后缀「…[截断]」且不 panic
        let s = "你好世界"; // 12 字节
        assert_eq!(truncate_utf8(s, 0), "…[截断]");
        assert_eq!(truncate_utf8(s, 1), "…[截断]");
    }

    // ── 预算检查 / 落库事务(T7)──

    use crate::db::open_memory;
    use crate::test_util::insert_budget;

    fn subj(t: &str, id: &str) -> Subject {
        Subject {
            subject_type: t.into(),
            subject_id: id.into(),
        }
    }

    #[tokio::test]
    async fn check_no_budget_is_unlimited_ok() {
        let db = open_memory().await.unwrap();
        assert_eq!(
            check_budgets(&db, &[subj("key", "k1")], 1000).await,
            BudgetCheck::Ok
        );
    }

    #[tokio::test]
    async fn check_exhausted_returns_subject() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 1_000_000, 1_000_000, 0).await; // 剩 0
        assert_eq!(
            check_budgets(&db, &[subj("key", "k1")], 1000).await,
            BudgetCheck::Exhausted(subj("key", "k1"))
        );
    }

    #[tokio::test]
    async fn check_min_remaining_across_periods() {
        let db = open_memory().await.unwrap();
        // 同主体 monthly 剩 500,total 剩 0 → 取最小 0 → 耗尽
        insert_budget(
            &db,
            "user",
            "u1",
            "monthly",
            1_000_000,
            999_500,
            crate::now_epoch(),
        )
        .await;
        insert_budget(&db, "user", "u1", "total", 1_000_000, 1_000_000, 0).await;
        assert_eq!(
            check_budgets(&db, &[subj("user", "u1")], crate::now_epoch()).await,
            BudgetCheck::Exhausted(subj("user", "u1"))
        );
    }

    #[tokio::test]
    async fn check_monthly_rollover_view_resets_remaining() {
        let db = open_memory().await.unwrap();
        // period_start 在去年(2024-01),used 满额;视角翻转后剩余 = limit,不拒
        let last_year = 1_704_067_200; // 2024-01-01 00:00:00 UTC
        insert_budget(&db, "key", "k1", "monthly", 1_000_000, 1_000_000, last_year).await;
        let now = crate::now_epoch(); // 2026,远晚于 2024-01
        assert_eq!(
            check_budgets(&db, &[subj("key", "k1")], now).await,
            BudgetCheck::Ok
        );
    }

    #[tokio::test]
    async fn settle_inserts_record_and_accrues_on_ok() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 0, 0).await;
        let input = SettleInput {
            key_id: "k1".into(),
            model_slug: "gpt-x".into(),
            channel_id: Some("c1".into()),
            usage: Usage {
                input_tokens: 100,
                output_tokens: 20,
                ..Usage::default()
            },
            cost_micro: 73_500,
            latency_ms: Some(120),
            ttft_ms: Some(40),
            status: "ok",
            error_code: None,
            request_body: None,
            response_body: None,
            subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (cnt, cost): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(cost_micro),0) FROM usage_records")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(cnt, 1);
        assert_eq!(cost, 73_500);
        // 逐列断言:锁死 INSERT 的 16 个绑定位置序,任何列错位都会被这条揪出
        #[allow(clippy::type_complexity)]
        let row: (
            Option<String>, // channel_id
            String,         // model_slug
            Option<i64>,    // latency_ms
            Option<i64>,    // ttft_ms
            Option<String>, // error_code
            i64,            // input_tokens
            i64,            // output_tokens
            i64,            // cache_read_tokens
            i64,            // cache_write_tokens
            String,         // status
        ) = sqlx::query_as(
            "SELECT channel_id, model_slug, latency_ms, ttft_ms, error_code, \
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status \
             FROM usage_records",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.0, input.channel_id);
        assert_eq!(row.1, input.model_slug);
        assert_eq!(row.2, input.latency_ms);
        assert_eq!(row.3, input.ttft_ms);
        assert_eq!(row.4, input.error_code);
        assert_eq!(row.5, input.usage.input_tokens);
        assert_eq!(row.6, input.usage.output_tokens);
        assert_eq!(row.7, input.usage.cache_read_tokens);
        assert_eq!(row.8, input.usage.cache_write_tokens);
        assert_eq!(row.9, input.status);
        let (used,): (i64,) =
            sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(used, 73_500);
    }

    #[tokio::test]
    async fn settle_rejected_does_not_accrue() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 5000, 0).await;
        let input = SettleInput {
            key_id: "k1".into(),
            model_slug: "gpt-x".into(),
            channel_id: None,
            usage: Usage::default(),
            cost_micro: 0,
            latency_ms: Some(1),
            ttft_ms: None,
            status: "rejected",
            error_code: Some("budget_exhausted".into()),
            request_body: None,
            response_body: None,
            subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (used,): (i64,) =
            sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(used, 5000); // 未变
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM usage_records WHERE status='rejected'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(cnt, 1);
    }

    #[tokio::test]
    async fn settle_monthly_rollover_inline_reset_then_accrue() {
        let db = open_memory().await.unwrap();
        let last_year = 1_704_067_200; // 2024-01
        insert_budget(
            &db, "key", "k1", "monthly", 10_000_000, 9_999_000, last_year,
        )
        .await;
        let now = crate::now_epoch();
        let input = SettleInput {
            key_id: "k1".into(),
            model_slug: "gpt-x".into(),
            channel_id: Some("c1".into()),
            usage: Usage {
                input_tokens: 1,
                ..Usage::default()
            },
            cost_micro: 500,
            latency_ms: Some(1),
            ttft_ms: Some(1),
            status: "ok",
            error_code: None,
            request_body: None,
            response_body: None,
            subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, now).await.unwrap();
        let (used, ps): (i64, i64) =
            sqlx::query_as("SELECT used_micro, period_start FROM budgets WHERE subject_id='k1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(used, 500, "翻转后应从 0 起累加,而非 9999000+500");
        assert!(ps > last_year, "period_start 应更新到当前月");
    }

    #[tokio::test]
    async fn settle_client_abort_accrues() {
        let db = open_memory().await.unwrap();
        insert_budget(&db, "key", "k1", "total", 10_000_000, 0, 0).await;
        let input = SettleInput {
            key_id: "k1".into(),
            model_slug: "gpt-x".into(),
            channel_id: Some("c1".into()),
            usage: Usage {
                input_tokens: 10,
                ..Usage::default()
            },
            cost_micro: 210,
            latency_ms: Some(5),
            ttft_ms: Some(2),
            status: "client_abort",
            error_code: None,
            request_body: None,
            response_body: None,
            subjects: vec![subj("key", "k1")],
        };
        settle_usage(&db, &input, crate::now_epoch()).await.unwrap();
        let (used,): (i64,) =
            sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(used, 210);
    }

    // ── parse_cny_to_micro ──

    #[test]
    fn parse_cny_to_micro_vectors() {
        assert_eq!(parse_cny_to_micro("100").unwrap(), 100_000_000);
        assert_eq!(parse_cny_to_micro("100.50").unwrap(), 100_500_000);
        assert_eq!(parse_cny_to_micro("0.000001").unwrap(), 1);
        assert_eq!(parse_cny_to_micro("21.000000").unwrap(), 21_000_000);
        assert_eq!(parse_cny_to_micro("0").unwrap(), 0);
        assert!(parse_cny_to_micro("").is_err());
        assert!(parse_cny_to_micro("1.2345678").is_err()); // 7 位小数
        assert!(parse_cny_to_micro("-5").is_err());
        assert!(parse_cny_to_micro("abc").is_err());
        assert!(parse_cny_to_micro("1e3").is_err());
        assert!(parse_cny_to_micro("9300000000000").is_err()); // 溢出 i64 micro
    }

    #[tokio::test]
    async fn subjects_for_key_two_levels() {
        let key = AuthedKey {
            id: "k1".into(),
            owner_type: "user".into(),
            owner_id: "u1".into(),
            allowed_models: None,
            audit: false,
        };
        assert_eq!(
            subjects_for_key(&key),
            vec![subj("key", "k1"), subj("user", "u1")]
        );
    }
}
