//! 后台维护任务:月度预算翻转兜底、渠道冷却恢复、audit 体清理。
//! 每个 *_once 函数可直接调用(单测);loop 版在 serve 起。

use sqlx::SqlitePool;
use std::time::Duration;

/// 当前月首秒(UTC epoch)。预算/报表/Dashboard 共用的月初口径。
pub fn month_start_epoch(now: i64) -> i64 {
    use time::{Date, Month, OffsetDateTime, Time};
    let dt = OffsetDateTime::from_unix_timestamp(now).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let first = Date::from_calendar_date(dt.year(), dt.month(), 1)
        .unwrap_or(Date::from_calendar_date(1970, Month::January, 1).expect("常量日期"));
    first
        .with_time(Time::MIDNIGHT)
        .assume_utc()
        .unix_timestamp()
}

/// 月度翻转兜底:把跨月的 monthly 预算 used 归零、period_start 更新到当前月首。
///
/// 仅兜底:读路径 billing 已视角处理翻转,这里把长期不请求的预算行持久化到位。
/// 与 settle 内联翻转用同一行级 UPDATE 语义,且 `period_start < 当前月首` 幂等——
/// 若某行已被结算翻转到当前月首,本条件为假即跳过,二者并发不会重复扣减或互相覆盖。
pub async fn run_monthly_rollover_once(db: &SqlitePool, now: i64) -> anyhow::Result<u64> {
    let month_start = month_start_epoch(now);
    // 跨月判定用月首秒比较:period_start < 当前月首 即视为旧月
    let res = sqlx::query(
        "UPDATE budgets SET used_micro = 0, period_start = ? \
         WHERE period = 'monthly' AND status = 'active' AND period_start < ?",
    )
    .bind(month_start)
    .bind(month_start)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 冷却恢复:到期的冷却渠道回 active。
///
/// 恢复保留 cooldown_level:若渠道仍故障,下次 mark_cooldown 在更高 level 上指数升级
/// (30s→60s→…→600s);level 仅在成功请求时由 reset_cooldown 归零(见 0002 注释与 upstream.rs)。
/// 恢复即归零会让指数退避失效:冷却期不进候选,level 永不累积,持续故障渠道每 30s 被重试一次。
pub async fn run_cooldown_recovery_once(db: &SqlitePool, now: i64) -> anyhow::Result<u64> {
    // 仅改 status/cooldown_until,不动 cooldown_level —— 把退避级别留给下次冷却升级或成功归零。
    let res = sqlx::query(
        "UPDATE channels SET status = 'active', cooldown_until = NULL \
         WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?",
    )
    .bind(now)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// audit 清理:超保留期的 usage 体清空 + 超期 audit_events 删除。
///
/// 返回值为被清空体的 usage_records 行数;audit_events 删除数不计入(仅尽力删除)。
pub async fn run_audit_cleanup_once(
    db: &SqlitePool,
    now: i64,
    retention_days: i64,
) -> anyhow::Result<u64> {
    let cutoff = now - retention_days * 86_400;
    let r1 = sqlx::query(
        "UPDATE usage_records SET request_body = NULL, response_body = NULL \
         WHERE created_at < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
    )
    .bind(cutoff)
    .execute(db)
    .await?;
    sqlx::query("DELETE FROM audit_events WHERE created_at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(r1.rows_affected())
}

/// 起后台 interval 循环(serve 调用)。返回的 JoinHandle 由调用方在停机时 abort。
pub fn spawn_loops(db: SqlitePool, retention_days: i64) -> Vec<tokio::task::JoinHandle<()>> {
    let mut handles = Vec::new();

    let db1 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(e) = run_monthly_rollover_once(&db1, crate::now_epoch()).await {
                tracing::error!(error = %e, "月度翻转任务失败");
            }
        }
    }));

    let db2 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            if let Err(e) = run_cooldown_recovery_once(&db2, crate::now_epoch()).await {
                tracing::error!(error = %e, "冷却恢复任务失败");
            }
        }
    }));

    let db3 = db.clone();
    handles.push(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(e) = run_audit_cleanup_once(&db3, crate::now_epoch(), retention_days).await {
                tracing::error!(error = %e, "audit 清理任务失败");
            }
        }
    }));

    handles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::test_util::{insert_budget, insert_channel};

    #[tokio::test]
    async fn rollover_resets_old_month_only() {
        let db = open_memory().await.unwrap();
        let last_year = 1_704_067_200; // 2024-01
        insert_budget(&db, "key", "k1", "monthly", 1_000_000, 900_000, last_year).await;
        let now = crate::now_epoch();
        let cur_month = month_start_epoch(now);
        insert_budget(&db, "key", "k2", "monthly", 1_000_000, 100_000, cur_month).await; // 本月,不动
        insert_budget(&db, "key", "k3", "total", 1_000_000, 500_000, last_year).await; // total,不动

        let n = run_monthly_rollover_once(&db, now).await.unwrap();
        assert_eq!(n, 1);
        let (u1,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(u1, 0);
        let (u2,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k2'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(u2, 100_000);
        let (u3,): (i64,) = sqlx::query_as("SELECT used_micro FROM budgets WHERE subject_id='k3'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(u3, 500_000);
    }

    #[tokio::test]
    async fn cooldown_recovery_only_expired() {
        let db = open_memory().await.unwrap();
        let mk = [7u8; 32];
        let expired = insert_channel(&db, &mk, "openai", "http://x/v1", "c", 1, "active").await;
        let future = insert_channel(&db, &mk, "openai", "http://y/v1", "c", 1, "active").await;
        let now = crate::now_epoch();
        // 到期渠道 seed 一个非 0 的退避级别(3),验证恢复保留 level。
        sqlx::query(
            "UPDATE channels SET status='cooldown', cooldown_level=3, cooldown_until=? WHERE id=?",
        )
        .bind(now - 1)
        .bind(&expired)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE channels SET status='cooldown', cooldown_level=2, cooldown_until=? WHERE id=?",
        )
        .bind(now + 600)
        .bind(&future)
        .execute(&db)
        .await
        .unwrap();

        let n = run_cooldown_recovery_once(&db, now).await.unwrap();
        assert_eq!(n, 1);
        let (s1, l1): (String, i64) =
            sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id=?")
                .bind(&expired)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(s1, "active");
        // 恢复保留 level:level 仅在成功请求时由 reset_cooldown 归零,恢复不动它。
        assert_eq!(l1, 3);
        // 未到期渠道:status 与 level 都不变。
        let (s2, l2): (String, i64) =
            sqlx::query_as("SELECT status, cooldown_level FROM channels WHERE id=?")
                .bind(&future)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(s2, "cooldown");
        assert_eq!(l2, 2);
    }

    #[tokio::test]
    async fn audit_cleanup_nulls_old_bodies() {
        let db = open_memory().await.unwrap();
        let now = crate::now_epoch();
        let old = now - 40 * 86_400;
        sqlx::query("INSERT INTO usage_records (id, key_id, model_slug, status, request_body, response_body, created_at) VALUES ('r1','k','m','ok','req','resp',?)")
            .bind(old).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO usage_records (id, key_id, model_slug, status, request_body, response_body, created_at) VALUES ('r2','k','m','ok','req2','resp2',?)")
            .bind(now).execute(&db).await.unwrap();
        sqlx::query("INSERT INTO audit_events (id, action, created_at) VALUES ('a1','x',?)")
            .bind(old)
            .execute(&db)
            .await
            .unwrap();

        let n = run_audit_cleanup_once(&db, now, 30).await.unwrap();
        assert_eq!(n, 1);
        let (rb,): (Option<String>,) =
            sqlx::query_as("SELECT request_body FROM usage_records WHERE id='r1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(rb.is_none());
        let (rb2,): (Option<String>,) =
            sqlx::query_as("SELECT request_body FROM usage_records WHERE id='r2'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(rb2.as_deref(), Some("req2"));
        let (ac,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(ac, 0);
    }
}
