//! 团队资源:列表/创建/详情 + 成员增改删。
//! 不变式「团队至少保留一名 owner」:从创建起成立(创建者自动入队为 owner),
//! 任何 owner 降级/移除都在事务内做「最后 owner」守护(SQLite 单写者,事务即互斥)。

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::{now_epoch, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use axum_extra::extract::WithRejection;
use serde::{Deserialize, Serialize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/teams", get(list).post(create))
        .route("/teams/:id", get(detail).patch(update))
        .route("/teams/:id/members", axum::routing::post(add_member))
        .route(
            "/teams/:id/members/:user_id",
            patch(update_member).delete(remove_member),
        )
}

#[derive(Serialize, sqlx::FromRow)]
struct TeamRow {
    id: String,
    name: String,
    created_at: i64,
    member_count: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct MemberRow {
    user_id: String,
    email: String,
    role: String,
}

async fn list(
    _user: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // 次级键 id 兜底:created_at 为秒级,同秒创建的行单凭它排序不稳定。
    let rows: Vec<TeamRow> = sqlx::query_as(
        "SELECT t.id, t.name, t.created_at, COUNT(m.user_id) AS member_count \
         FROM teams t LEFT JOIN team_members m ON m.team_id = t.id \
         GROUP BY t.id ORDER BY t.created_at, t.id",
    )
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "teams": rows })))
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
}

async fn create(
    user: AdminUser,
    State(state): State<AppState>,
    WithRejection(Json(req), _): WithRejection<Json<CreateReq>, ApiError>,
) -> Result<(StatusCode, Json<TeamRow>), ApiError> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("团队名称不能为空"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_epoch();
    // 单事务:团队 + 创建者 owner 一起落,不变式「至少一名 owner」从创建起成立。
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(&id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "team.create",
        Some(&id),
        serde_json::json!({"name": name}),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(TeamRow {
            id,
            name,
            created_at,
            member_count: 1, // 创建者
        }),
    ))
}

async fn detail(
    _user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let team: Option<(String, i64)> =
        sqlx::query_as("SELECT name, created_at FROM teams WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
    let Some((name, created_at)) = team else {
        return Err(ApiError::not_found("团队不存在"));
    };
    // owner 在前(CASE 排序),组内 email 升序。
    let members: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.user_id, u.email, m.role \
         FROM team_members m JOIN users u ON u.id = m.user_id \
         WHERE m.team_id = ? \
         ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({
        "id": id,
        "name": name,
        "created_at": created_at,
        "members": members,
    })))
}

#[derive(Deserialize)]
struct UpdateReq {
    name: String,
}

async fn update(
    user: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateReq>, ApiError>,
) -> Result<Json<TeamRow>, ApiError> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("团队名称不能为空"));
    }
    let res = sqlx::query("UPDATE teams SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("团队不存在"));
    }
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "team.update",
        Some(&id),
        serde_json::json!({"name": name}),
    )
    .await;
    // 回读带 member_count,返回形状与 create 一致(单写者下无并发可见性问题)。
    let row: TeamRow = sqlx::query_as(
        "SELECT t.id, t.name, t.created_at, COUNT(m.user_id) AS member_count \
         FROM teams t LEFT JOIN team_members m ON m.team_id = t.id \
         WHERE t.id = ? GROUP BY t.id",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct AddMemberReq {
    email: String,
    role: String,
}

async fn add_member(
    user: AdminUser,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    WithRejection(Json(req), _): WithRejection<Json<AddMemberReq>, ApiError>,
) -> Result<StatusCode, ApiError> {
    if !["owner", "member"].contains(&req.role.as_str()) {
        return Err(ApiError::bad_request("无效角色"));
    }
    // 团队存在性先于业务校验,保证不存在团队稳定回 404。
    let team_exists: Option<(String,)> = sqlx::query_as("SELECT id FROM teams WHERE id = ?")
        .bind(&team_id)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if team_exists.is_none() {
        return Err(ApiError::not_found("团队不存在"));
    }
    let email = req.email.trim().to_lowercase();
    let target: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    let Some((target_id,)) = target else {
        return Err(ApiError::not_found("用户不存在"));
    };
    // 预检已是成员 → 干净 409;并发窗口由复合 PK 唯一冲突在 INSERT 处兜底。
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(&team_id)
            .bind(&target_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::internal)?;
    if exists.is_some() {
        return Err(ApiError::conflict("该用户已是团队成员"));
    }
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)")
        .bind(&team_id)
        .bind(&target_id)
        .bind(&req.role)
        .execute(&state.db)
        .await
        .map_err(|e| ApiError::from_db_unique(e, "该用户已是团队成员"))?;
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "team.member_add",
        Some(&team_id),
        serde_json::json!({"user_id": target_id, "role": req.role}),
    )
    .await;
    Ok(StatusCode::CREATED)
}

/// 最后 owner 守护(PATCH 降级与 DELETE 共用;事务内调用)。
/// 只拦「owner 降级/移除且是最后一个」;成员不存在 → 404。
async fn guard_last_owner(
    tx: &mut sqlx::SqliteConnection,
    team_id: &str,
    target_user_id: &str,
) -> Result<(), ApiError> {
    let cur: Option<(String,)> =
        sqlx::query_as("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(team_id)
            .bind(target_user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    let Some((role,)) = cur else {
        return Err(ApiError::not_found("成员不存在"));
    };
    if role == "owner" {
        let (owners,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'owner'",
        )
        .bind(team_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        if owners <= 1 {
            return Err(ApiError::forbidden("团队至少保留一名 owner"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct UpdateMemberReq {
    role: String,
}

async fn update_member(
    user: AdminUser,
    State(state): State<AppState>,
    Path((team_id, user_id)): Path<(String, String)>,
    WithRejection(Json(req), _): WithRejection<Json<UpdateMemberReq>, ApiError>,
) -> Result<StatusCode, ApiError> {
    if !["owner", "member"].contains(&req.role.as_str()) {
        return Err(ApiError::bad_request("无效角色"));
    }
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    // 守护只在「目标降为 member」时拦最后 owner;升级/同级不触发(只读当前 role 决定)。
    if req.role == "member" {
        guard_last_owner(&mut tx, &team_id, &user_id).await?;
    } else {
        // 升为/保持 owner 也要确认成员存在,否则 UPDATE 0 行需回 404。
        let cur: Option<(String,)> =
            sqlx::query_as("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
                .bind(&team_id)
                .bind(&user_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        if cur.is_none() {
            return Err(ApiError::not_found("成员不存在"));
        }
    }
    sqlx::query("UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?")
        .bind(&req.role)
        .bind(&team_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "team.member_role",
        Some(&team_id),
        serde_json::json!({"user_id": user_id, "role": req.role}),
    )
    .await;
    Ok(StatusCode::OK)
}

async fn remove_member(
    user: AdminUser,
    State(state): State<AppState>,
    Path((team_id, user_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    // 守护:成员不存在 → 404;移除最后一个 owner → 403。
    guard_last_owner(&mut tx, &team_id, &user_id).await?;
    sqlx::query("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(&team_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    crate::audit::record(
        &state.db,
        Some(&user.id),
        "team.member_remove",
        Some(&team_id),
        serde_json::json!({"user_id": user_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::app;
    use crate::test_util::{admin_session, authed_request, body_json, insert_user, json_request};
    use axum::http::StatusCode;
    use serde_json::json;
    use tower::ServiceExt;

    /// 建一个团队,返回 team_id。
    async fn create_team(state: &crate::AppState, cookie: &str, name: &str) -> String {
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/teams",
                cookie,
                Some(json!({ "name": name })),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        body_json(resp).await["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn create_team_creator_becomes_owner() {
        let (state, cookie) = admin_session().await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/teams",
                &cookie,
                Some(json!({"name": "  红队  "})), // trim
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = body_json(resp).await;
        assert_eq!(body["name"], "红队");
        assert_eq!(body["member_count"], 1);
        let team_id = body["id"].as_str().unwrap().to_string();

        // GET 详情:创建者自己在内且 role=owner
        let resp = app(state.clone())
            .oneshot(authed_request(
                "GET",
                &format!("/admin/api/teams/{team_id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        let members = body["members"].as_array().unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(members[0]["email"], "admin@x.com");
        assert_eq!(members[0]["role"], "owner");

        // audit team.create 落行
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='team.create'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn create_team_empty_name_400() {
        let (state, cookie) = admin_session().await;
        for body in [json!({"name": ""}), json!({"name": "   "})] {
            let resp = app(state.clone())
                .oneshot(authed_request(
                    "POST",
                    "/admin/api/teams",
                    &cookie,
                    Some(body),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            let msg = body_json(resp).await["error"]["message"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(msg.contains("团队名称"), "文案应含「团队名称」: {msg}");
        }
    }

    #[tokio::test]
    async fn list_teams_member_count() {
        let (state, cookie) = admin_session().await;
        let team_id = create_team(&state, &cookie, "甲队").await;
        insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "m@x.com", "role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/teams", &cookie, None))
            .await
            .unwrap();
        let body = body_json(resp).await;
        let teams = body["teams"].as_array().unwrap();
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0]["member_count"], 2); // 创建者 + 新成员
    }

    #[tokio::test]
    async fn add_member_by_email() {
        let (state, cookie) = admin_session().await;
        let team_id = create_team(&state, &cookie, "乙队").await;
        insert_user(&state.db, "bob@x.com", "memberpw1", "user", "active").await;

        // 正常加入(邮箱带大小写/空白,验证 trim+lowercase)
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "  Bob@X.com ", "role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // 详情可见
        let resp = app(state.clone())
            .oneshot(authed_request(
                "GET",
                &format!("/admin/api/teams/{team_id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        let body = body_json(resp).await;
        let emails: Vec<&str> = body["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["email"].as_str().unwrap())
            .collect();
        assert!(emails.contains(&"bob@x.com"));

        // 重复加 → 409
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "bob@x.com", "role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        // 不存在邮箱 → 404
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "ghost@x.com", "role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // role 传 "admin" → 400「无效角色」
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "bob@x.com", "role": "admin"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(body_json(resp).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("无效角色"));

        // 成员变更 audit 落行
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='team.member_add'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1); // 仅首次成功那次
    }

    #[tokio::test]
    async fn last_owner_cannot_be_demoted_or_removed() {
        let (state, cookie) = admin_session().await;
        let team_id = create_team(&state, &cookie, "丙队").await;
        let (admin_id,): (String,) =
            sqlx::query_as("SELECT id FROM users WHERE email='admin@x.com'")
                .fetch_one(&state.db)
                .await
                .unwrap();

        // 唯一 owner 降级 → 403
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/teams/{team_id}/members/{admin_id}"),
                &cookie,
                Some(json!({"role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(body_json(resp).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("至少保留一名 owner"));

        // 唯一 owner 移除 → 403
        let resp = app(state.clone())
            .oneshot(authed_request(
                "DELETE",
                &format!("/admin/api/teams/{team_id}/members/{admin_id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // 加第二个 owner
        let bob = insert_user(&state.db, "bob@x.com", "memberpw1", "user", "active").await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                &format!("/admin/api/teams/{team_id}/members"),
                &cookie,
                Some(json!({"email": "bob@x.com", "role": "owner"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // 现在降级第一个 owner → 200
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/teams/{team_id}/members/{admin_id}"),
                &cookie,
                Some(json!({"role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // 成员不存在 → 404(PATCH 与 DELETE)
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/teams/{team_id}/members/nope"),
                &cookie,
                Some(json!({"role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let resp = app(state.clone())
            .oneshot(authed_request(
                "DELETE",
                &format!("/admin/api/teams/{team_id}/members/nope"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // 现在 bob 是唯一 owner,移除非 owner 的 admin(已是 member)→ 204
        let resp = app(state.clone())
            .oneshot(authed_request(
                "DELETE",
                &format!("/admin/api/teams/{team_id}/members/{admin_id}"),
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // 成员变更 audit 落行:member_role(降级) + member_remove(移除 admin)各一条
        let (role_n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='team.member_role'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(role_n, 1);
        let (rm_n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='team.member_remove'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(rm_n, 1);
        let _ = bob;
    }

    #[tokio::test]
    async fn team_not_found_404() {
        let (state, cookie) = admin_session().await;
        // GET 详情
        let resp = app(state.clone())
            .oneshot(authed_request(
                "GET",
                "/admin/api/teams/nope",
                &cookie,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(body_json(resp).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("团队不存在"));

        // POST members 对不存在团队
        insert_user(&state.db, "m@x.com", "memberpw1", "user", "active").await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "POST",
                "/admin/api/teams/nope/members",
                &cookie,
                Some(json!({"email": "m@x.com", "role": "member"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(body_json(resp).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("团队不存在"));
    }

    #[tokio::test]
    async fn rename_team() {
        let (state, cookie) = admin_session().await;
        let team_id = create_team(&state, &cookie, "旧名").await;

        // 改名成功:回显新名,member_count 形状与 create 一致
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                &format!("/admin/api/teams/{team_id}"),
                &cookie,
                Some(json!({"name": "  新名  "})), // trim
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["name"], "新名", "应回显 trim 后的新名");
        assert_eq!(body["id"], team_id);
        assert_eq!(body["member_count"], 1, "改名应保留 member_count");

        // 列表已是新名
        let resp = app(state.clone())
            .oneshot(authed_request("GET", "/admin/api/teams", &cookie, None))
            .await
            .unwrap();
        let teams = body_json(resp).await["teams"].as_array().unwrap().clone();
        assert_eq!(teams[0]["name"], "新名");

        // 审计落 team.update 一条
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action='team.update'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 1, "应落 team.update 审计一条");
    }

    #[tokio::test]
    async fn rename_team_empty_name_400() {
        let (state, cookie) = admin_session().await;
        let team_id = create_team(&state, &cookie, "甲队").await;
        for body in [json!({"name": ""}), json!({"name": "   "})] {
            let resp = app(state.clone())
                .oneshot(authed_request(
                    "PATCH",
                    &format!("/admin/api/teams/{team_id}"),
                    &cookie,
                    Some(body),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "空名/纯空格应 400");
            let msg = body_json(resp).await["error"]["message"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(msg.contains("团队名称"), "文案应含「团队名称」: {msg}");
        }
    }

    #[tokio::test]
    async fn rename_team_not_found_404() {
        let (state, cookie) = admin_session().await;
        let resp = app(state.clone())
            .oneshot(authed_request(
                "PATCH",
                "/admin/api/teams/nope",
                &cookie,
                Some(json!({"name": "新名"})),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "不存在 id 应 404");
        assert!(body_json(resp).await["error"]["message"]
            .as_str()
            .unwrap()
            .contains("团队不存在"));
    }

    #[tokio::test]
    async fn requires_admin_session() {
        let (state, _) = admin_session().await;
        let resp = app(state)
            .oneshot(json_request("GET", "/admin/api/teams", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
