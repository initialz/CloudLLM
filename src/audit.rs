//! 管理操作审计:best-effort 落 audit_events。
//! 失败仅 warn 不冒泡——审计不阻断管理操作本身(取舍:可用性优先,内部系统)。

use sqlx::SqlitePool;

pub async fn record(
    db: &SqlitePool,
    actor_user_id: Option<&str>,
    action: &str,
    subject: Option<&str>,
    detail: serde_json::Value,
) {
    let r = sqlx::query(
        "INSERT INTO audit_events (id, actor_user_id, action, subject, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(actor_user_id)
    .bind(action)
    .bind(subject)
    .bind(detail.to_string())
    .bind(crate::now_epoch())
    .execute(db)
    .await;
    if let Err(e) = r {
        tracing::warn!(error = %e, action, "审计写入失败");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use serde_json::json;

    #[tokio::test]
    async fn record_then_query_back() {
        let db = open_memory().await.unwrap();
        record(
            &db,
            Some("admin-1"),
            "key.create",
            Some("key-42"),
            json!({"name": "测试 Key", "owner": "u1"}),
        )
        .await;

        let (actor, action, subject, detail): (Option<String>, String, Option<String>, String) =
            sqlx::query_as("SELECT actor_user_id, action, subject, detail FROM audit_events")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(actor.as_deref(), Some("admin-1"));
        assert_eq!(action, "key.create");
        assert_eq!(subject.as_deref(), Some("key-42"));
        // detail 以 JSON 文本落库,可重新解析回值
        let parsed: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(parsed["name"], "测试 Key");
        assert_eq!(parsed["owner"], "u1");
    }

    #[tokio::test]
    async fn record_allows_null_actor_and_subject() {
        // 系统发起(无 actor)/无明确主体的事件也能落库
        let db = open_memory().await.unwrap();
        record(&db, None, "system.startup", None, json!({})).await;
        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cnt, 1);
    }

    #[tokio::test]
    async fn record_on_closed_db_does_not_panic() {
        // best-effort:db 已关闭时只 warn,不冒泡、不 panic
        let db = open_memory().await.unwrap();
        db.close().await;
        record(&db, Some("a"), "noop", None, json!({})).await;
        // 走到这里即代表未 panic
    }
}
