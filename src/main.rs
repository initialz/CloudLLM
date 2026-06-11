use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "cloudllm",
    version,
    about = "CloudLLM — 一体化 LLM 网关(hub + admin-ui)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 初始化:生成配置与数据库,创建管理员并打印初始密码
    Init {
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
        /// 管理员邮箱
        #[arg(long, default_value = "admin@cloudllm.local")]
        email: String,
    },
    /// 启动服务
    Serve {
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
    },
    /// 管理操作
    Admin {
        #[command(subcommand)]
        cmd: AdminCmd,
    },
}

#[derive(Subcommand)]
enum AdminCmd {
    /// 重置用户密码并打印新密码
    ResetPassword {
        /// 目标用户邮箱
        email: String,
        #[arg(long, default_value = "cloudllm.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Init { config, email } => {
            let out = cloudllm::cli::run_init(&config, &email).await?;
            println!("初始化完成。");
            println!("  配置文件: {}", out.config_path.display());
            println!("  数据库:   {}", out.db_path.display());
            println!("  管理员:   {}", out.admin_email);
            println!("  初始密码: {}(仅此一次,请立即保存)", out.admin_password);
            println!(
                "启动: cloudllm serve --config {}",
                out.config_path.display()
            );
        }
        Cmd::Serve { config } => cloudllm::cli::run_serve(&config).await?,
        Cmd::Admin {
            cmd: AdminCmd::ResetPassword { email, config },
        } => {
            let pw = cloudllm::cli::run_reset_password(&config, &email).await?;
            println!("已重置 {email} 的密码: {pw}");
        }
    }
    Ok(())
}
