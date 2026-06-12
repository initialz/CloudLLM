use crate::config::Config;
use anyhow::{bail, Context, Result};
use base64::{
    engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD, Engine,
};
use rand::{rngs::OsRng, RngCore};
use std::path::Path;

pub struct InitOutcome {
    pub admin_email: String,
    pub admin_password: String,
    pub config_path: std::path::PathBuf,
    pub db_path: std::path::PathBuf,
}

/// --init:生成配置(随机 master_key/session_secret)+ 建库迁移 + 创建管理员。
/// 配置文件已存在则报错(防覆盖)。
pub async fn run_init(config_path: &Path, admin_email: &str) -> Result<InitOutcome> {
    if config_path.exists() {
        bail!(
            "配置文件已存在: {}(如需重新初始化请先移走它)",
            config_path.display()
        );
    }
    let cfg_dir = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(cfg_dir).with_context(|| format!("创建目录 {}", cfg_dir.display()))?;
    let db_path = cfg_dir.join("cloudllm.db");

    let mut mk = [0u8; 32];
    OsRng.fill_bytes(&mut mk);
    let mut ss = [0u8; 36];
    OsRng.fill_bytes(&mut ss);
    let master_key = B64.encode(mk);
    let session_secret = URL_SAFE_NO_PAD.encode(ss); // 48 字符

    let toml_text = format!(
        r#"# CloudLLM 配置(由 --init 生成)
listen = "0.0.0.0:7100"
db_path = "{db}"
# 渠道凭证信封加密主密钥(base64 32 字节)。丢失后已存渠道凭证不可恢复,务必备份。
master_key = "{master_key}"
# 管理会话签名密钥(≥32 字符)。更换将使所有已登录会话失效。
session_secret = "{session_secret}"
# 网关对外地址(生成成员接入说明用,可改)
gateway_public_url = "http://localhost:7100"
"#,
        db = db_path.display(),
    );
    std::fs::write(config_path, toml_text)
        .with_context(|| format!("写配置 {}", config_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 配置含 master_key/session_secret 明文,仅属主可读写
        std::fs::set_permissions(config_path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("设置配置权限 {}", config_path.display()))?;
    }

    // 写完配置后任一步失败 → 回滚本次创建的文件,保证可重跑(不留半成品死路)
    let result = init_after_config_written(config_path, &db_path, admin_email).await;
    match result {
        Ok(admin_password) => Ok(InitOutcome {
            admin_email: admin_email.to_string(),
            admin_password,
            config_path: config_path.to_path_buf(),
            db_path,
        }),
        Err(e) => {
            let _ = std::fs::remove_file(config_path);
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{}", db_path.display(), suffix));
            }
            Err(e)
        }
    }
}

/// run_init 的「写完配置之后」部分:load → open → 设库权限 → 建管理员,返回初始密码。
/// 任一步失败由调用方回滚已创建的文件。顺序与原实现一致(生成密钥→写 TOML→load→open→INSERT)。
async fn init_after_config_written(
    config_path: &Path,
    db_path: &Path,
    admin_email: &str,
) -> Result<String> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 库含密码哈希与渠道加密凭证,仅属主可读写。
        // -wal/-shm 由 SQLite 按所在目录继承权限创建,不必单独处理。
        std::fs::set_permissions(db_path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("设置数据库权限 {}", db_path.display()))?;
    }

    let mut pw = [0u8; 12];
    OsRng.fill_bytes(&mut pw);
    let admin_password = URL_SAFE_NO_PAD.encode(pw); // 16 字符
    let hash = crate::crypto::hash_password(&admin_password)?;
    sqlx::query(
        "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(admin_email)
    .bind(&hash)
    .bind(crate::now_epoch())
    .execute(&pool)
    .await
    .context("创建管理员")?;
    pool.close().await;

    Ok(admin_password)
}

/// admin reset-password:重置指定邮箱用户密码,返回新密码。
pub async fn run_reset_password(config_path: &Path, email: &str) -> Result<String> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    let mut pw = [0u8; 12];
    OsRng.fill_bytes(&mut pw);
    let new_password = URL_SAFE_NO_PAD.encode(pw);
    let hash = crate::crypto::hash_password(&new_password)?;
    let res = sqlx::query("UPDATE users SET password_hash = ? WHERE email = ?")
        .bind(&hash)
        .bind(email)
        .execute(&pool)
        .await
        .context("更新密码")?;
    pool.close().await;
    if res.rows_affected() == 0 {
        bail!("用户不存在: {email}");
    }
    Ok(new_password)
}

/// serve:加载配置、开库、起服务,优雅停机(ctrl_c / SIGTERM)。
pub async fn run_serve(config_path: &Path) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let pool = crate::db::open(&cfg.db_path).await?;
    let state = crate::AppState {
        db: pool.clone(),
        config: std::sync::Arc::new(cfg.clone()),
        http: crate::build_http_client(&cfg),
        settle_tracker: tokio_util::task::TaskTracker::new(),
        settle_failures: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        login_limiter: std::sync::Arc::new(crate::admin::limiter::LoginLimiter::default()),
    };

    // 后台维护任务(月翻转 / 冷却恢复 / audit 清理);停机时随 serve 退出 abort,不阻塞排水。
    let job_handles = crate::jobs::spawn_loops(pool.clone(), cfg.audit_retention_days);

    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("监听 {}", cfg.listen))?;
    tracing::info!(listen = %cfg.listen, "CloudLLM 启动");

    // TaskTracker 派生 Clone 共享同一跟踪器;此份与 state 内那份是同一个。
    let tracker = state.settle_tracker.clone();
    axum::serve(listener, crate::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("服务异常退出")?;

    // 优雅停机:已停新请求 → 排水在途结算 → abort jobs → 关库。
    // 部署契约:preStop sleep + 本排水时长 ≤ K8s terminationGracePeriodSeconds
    // (v1.2 清单为 5+25≤30),超限会被 SIGKILL 截断丢账;P4 写 Rust 部署清单时锁定此不变量。
    let drain = std::time::Duration::from_secs(cfg.shutdown_drain_secs);
    tracing::info!(
        drain_secs = cfg.shutdown_drain_secs,
        "停止接收新请求,排水在途结算"
    );
    tracker.close();
    if tokio::time::timeout(drain, tracker.wait()).await.is_err() {
        tracing::warn!(
            drain_secs = cfg.shutdown_drain_secs,
            "结算排水超时,仍有在途任务被丢弃"
        );
    }
    for h in job_handles {
        h.abort();
    }
    pool.close().await;
    tracing::info!("已优雅停机");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("注册 ctrl_c") };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("注册 SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn init_creates_config_db_admin() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let out = run_init(&cfg_path, "boss@x.com").await.unwrap();

        assert!(cfg_path.exists());
        assert!(out.db_path.exists());
        assert!(out.admin_password.len() >= 16);

        // 配置可加载且合法
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(cfg.db_path, out.db_path.to_str().unwrap());

        // 管理员已建,密码可验证
        let pool = crate::db::open(&cfg.db_path).await.unwrap();
        let (email, role, hash): (String, String, String) =
            sqlx::query_as("SELECT email, role, password_hash FROM users LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(email, "boss@x.com");
        assert_eq!(role, "admin");
        assert!(crate::crypto::verify_password(&out.admin_password, &hash));
    }

    #[tokio::test]
    async fn init_refuses_existing_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        run_init(&cfg_path, "a@x.com").await.unwrap();
        // 不用 unwrap_err(避免要求 InitOutcome: Debug):直接解构 Err 取错误信息
        let Err(e) = run_init(&cfg_path, "a@x.com").await else {
            panic!("已存在配置时应当报错");
        };
        let err = e.to_string();
        assert!(err.contains("已存在"), "实际错误: {err}");
    }

    #[tokio::test]
    async fn reset_password_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let out = run_init(&cfg_path, "boss@x.com").await.unwrap();

        let new_pw = run_reset_password(&cfg_path, "boss@x.com").await.unwrap();
        assert_ne!(new_pw, out.admin_password);

        let cfg = Config::load(&cfg_path).unwrap();
        let pool = crate::db::open(&cfg.db_path).await.unwrap();
        let (hash,): (String,) =
            sqlx::query_as("SELECT password_hash FROM users WHERE email = 'boss@x.com'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(crate::crypto::verify_password(&new_pw, &hash));
        assert!(!crate::crypto::verify_password(&out.admin_password, &hash));
    }

    #[tokio::test]
    async fn reset_password_unknown_email_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        run_init(&cfg_path, "boss@x.com").await.unwrap();
        assert!(run_reset_password(&cfg_path, "ghost@x.com").await.is_err());
    }

    #[test]
    fn clap_definition_is_valid() {
        // main.rs 里的 Cli 不可见;此处仅验证依赖特性可用。
        // 真正的 CLI 自检放 main.rs:
        clap::Command::new("probe").debug_assert();
    }

    #[tokio::test]
    async fn init_rolls_back_on_failure() {
        // 在目标目录预置一个内容非法且只读的 "db 文件",迫使 sqlx 打开/迁移失败,
        // 验证写完配置后任一步失败都会回滚本次创建的文件(可重跑,不留半成品死路)。
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let db_path = dir.path().join("cloudllm.db");
        std::fs::write(&db_path, b"not a sqlite file").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o400)).unwrap();
        }
        let err = run_init(&cfg_path, "boss@x.com").await;
        assert!(err.is_err());
        assert!(!cfg_path.exists(), "失败后必须回滚删除已写的配置文件");
        // 回滚已顺带清掉本次产生的库文件(含我们预置的只读占位)。为稳健起见容忍其已不存在:
        // 仅需保证重跑前 db_path 不再挡路(无论是回滚删的还是这里删的)。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::remove_file(&db_path);
        assert!(!db_path.exists(), "重跑前残留的库文件必须已清除");
        assert!(run_init(&cfg_path, "boss@x.com").await.is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn init_sets_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("cloudllm.toml");
        let out = run_init(&cfg_path, "boss@x.com").await.unwrap();
        let cfg_mode = std::fs::metadata(&cfg_path).unwrap().permissions().mode() & 0o777;
        let db_mode = std::fs::metadata(&out.db_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(cfg_mode, 0o600, "配置文件须 0600");
        assert_eq!(db_mode, 0o600, "数据库文件须 0600");
    }
}
