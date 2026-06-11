use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

/// 打开(必要时创建)文件库:WAL、busy_timeout 5s、外键开、迁移自动执行。
pub async fn open(path: &str) -> Result<SqlitePool> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建数据库目录 {}", parent.display()))?;
        }
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // WAL 下 NORMAL 即可保证崩溃不损库(至多丢最后未 checkpoint 的已提交事务),
        // 较默认 FULL 省去每写一次 fsync——内部网关计费写路径的务实取舍
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .with_context(|| format!("打开数据库 {path}"))?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("执行迁移")?;
    Ok(pool)
}

/// 测试用内存库。max_connections 必须为 1:
/// SQLite 的 :memory: 每个连接是独立的库,池 >1 会拿到互不相通的空库。
pub async fn open_memory() -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(":memory:")
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .context("打开内存数据库")?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("执行迁移")?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_create_all_tables() {
        let pool = open_memory().await.unwrap();
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' \
             AND name NOT LIKE '_sqlx%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            names,
            vec![
                "api_keys",
                "audit_events",
                "budgets",
                "channels",
                "models",
                "team_members",
                "teams",
                "usage_records",
                "users"
            ]
        );
    }

    #[tokio::test]
    async fn budgets_unique_subject_period() {
        let pool = open_memory().await.unwrap();
        let ins = "INSERT INTO budgets (id, subject_type, subject_id, period, limit_micro, period_start, created_at) \
                   VALUES (?, 'key', 'k1', 'monthly', 1000000, 0, 0)";
        sqlx::query(ins).bind("b1").execute(&pool).await.unwrap();
        let dup = sqlx::query(ins).bind("b2").execute(&pool).await;
        assert!(
            dup.is_err(),
            "相同 (subject_type, subject_id, period) 必须被唯一约束拒绝"
        );
    }

    #[tokio::test]
    async fn foreign_keys_enforced() {
        let pool = open_memory().await.unwrap();
        let r = sqlx::query(
            "INSERT INTO team_members (team_id, user_id) VALUES ('no-team', 'no-user')",
        )
        .execute(&pool)
        .await;
        assert!(r.is_err(), "外键必须在连接级开启");
    }

    #[tokio::test]
    async fn open_creates_file_and_wal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        let pool = open(p.to_str().unwrap()).await.unwrap();
        let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert!(p.exists());
    }
}
