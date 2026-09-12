//! 数据库连接与初始化
//!
//! 单一 SQLite 数据库(借鉴 MaidKit 的单 AppDatabase 策略)。
//! 所有表集中在 [`migrations/0001_init.sql`],schema 变更走迁移文件。

use std::path::Path;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;

use crate::error::{AppError, AppResult};

/// 数据库连接池别名
pub type Db = SqlitePool;

/// 内嵌迁移文件列表(编译期嵌入,打包后依然可用)。
///
/// 新增 schema 变更的步骤:
///   1. 新建 `migrations/00NN_xxx.sql`(按数字递增,保证顺序);
///   2. 在此数组末尾追加一行 `(文件名, include_str!(...))`。
///
/// 已应用的迁移记录在 `_migrations` 表,重复启动不会重跑。
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_init.sql",
        include_str!("../migrations/0001_init.sql"),
    ),
    (
        "0002_agent_proposals.sql",
        include_str!("../migrations/0002_agent_proposals.sql"),
    ),
    (
        "0003_proposal_execution_state.sql",
        include_str!("../migrations/0003_proposal_execution_state.sql"),
    ),
    (
        "0004_audit_outcome.sql",
        include_str!("../migrations/0004_audit_outcome.sql"),
    ),
];

/// 初始化数据库连接池并执行迁移。
///
/// 数据库文件位于 `data_dir/app.db`。WAL 模式开启以提升并发。
pub async fn init_db(data_dir: &Path) -> AppResult<Db> {
    // 确保数据目录存在
    std::fs::create_dir_all(data_dir)
        .map_err(|e| AppError::Internal(format!("创建数据目录失败: {e}")))?;

    let db_path = data_dir.join("app.db");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    run_migrations(&pool).await?;
    recover_interrupted_proposals(&pool).await?;
    recover_interrupted_audits(&pool).await?;

    log::info!("数据库已初始化: {}", db_path.display());
    Ok(pool)
}

/// 进程退出时无法确认在途远程命令的结果。重新启动后将遗留 running 标成 unknown，
/// 由用户核对远端状态；绝不自动重放可能有副作用的命令。
async fn recover_interrupted_proposals(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "UPDATE agent_proposals
         SET status='unknown',
             execution_error=COALESCE(execution_error, '应用在执行完成前退出，实际结果需要人工核对'),
             finished_at=COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE status='running'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn recover_interrupted_audits(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "UPDATE audit_logs
         SET outcome='unknown', success=0,
             output=COALESCE(output, '应用在操作完成前退出，实际结果需要人工核对')
         WHERE outcome='pending'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// 按文件名顺序执行未应用的迁移(版本化,幂等)。
///
/// 注意:0001 对旧库(迁移机制引入前已建表)是幂等的 ——
/// 全部 `CREATE TABLE IF NOT EXISTS` + 无副作用的 PRAGMA,
/// 首次运行会"重放"一遍后标记已应用,不会破坏数据。
async fn run_migrations(pool: &SqlitePool) -> AppResult<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )",
    )
    .execute(pool)
    .await
    .map_err(AppError::Database)?;

    for (name, sql) in MIGRATIONS {
        let applied: Option<String> =
            sqlx::query_scalar("SELECT name FROM _migrations WHERE name = ?")
                .bind(name)
                .fetch_optional(pool)
                .await?;
        if applied.is_some() {
            continue;
        }

        sqlx::raw_sql(sql).execute(pool).await.map_err(|e| {
            log::error!("执行迁移 {name} 失败: {e}");
            AppError::Database(e)
        })?;

        sqlx::query("INSERT INTO _migrations (name) VALUES (?)")
            .bind(name)
            .execute(pool)
            .await?;
        log::info!("迁移已应用: {name}");
    }
    Ok(())
}

/// 读取单个标量值(`SELECT count(*)` 之类)
#[allow(dead_code)]
pub async fn count_rows(db: &Db, table: &str) -> AppResult<i64> {
    // table 名不能参数化,这里白名单校验
    assert!(
        table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "表名仅允许字母数字下划线"
    );
    let sql = format!("SELECT COUNT(*) AS c FROM {table}");
    let row = sqlx::query(&sql).fetch_one(db).await?;
    Ok(row.try_get::<i64, _>("c").unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存数据库上跑两遍迁移:必须幂等,且 _migrations 只记录一次
    #[tokio::test]
    async fn migrations_are_idempotent() {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("打开内存库");

        run_migrations(&pool).await.expect("首次迁移成功");
        run_migrations(&pool).await.expect("第二次迁移幂等");

        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _migrations")
            .fetch_one(&pool).await.expect("查询 _migrations");
        assert_eq!(applied, 4, "迁移只应记录一次(0001..0004)");

        // 0001/0002 建的表必须存在
        for table in ["servers", "audit_logs", "skills", "quick_actions", "docs",
                      "agent_sessions", "agent_providers", "vault_metadata",
                      "agent_proposals"] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool).await
                .unwrap_or_else(|e| panic!("表 {table} 应存在: {e}"));
            assert_eq!(n, 0);
        }
    }

    #[tokio::test]
    async fn migration_tracks_applied_names() {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("打开内存库");

        run_migrations(&pool).await.expect("迁移成功");

        let name: String = sqlx::query_scalar("SELECT name FROM _migrations LIMIT 1")
            .fetch_one(&pool).await.expect("有记录");
        assert_eq!(name, "0001_init.sql");
    }

    #[tokio::test]
    async fn interrupted_proposal_becomes_unknown_instead_of_retried() {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("打开内存库");

        run_migrations(&pool).await.expect("迁移成功");
        sqlx::query(
            "INSERT INTO agent_proposals (id, tool_name, status) VALUES ('prop_interrupted', 'run_command', 'running')",
        )
        .execute(&pool)
        .await
        .expect("写入中断提案");

        recover_interrupted_proposals(&pool).await.expect("恢复中断状态");
        sqlx::query(
            "INSERT INTO audit_logs (timestamp, source, tool_name, outcome) VALUES ('2026-01-01T00:00:00Z', 'agent', 'run_command', 'pending')",
        )
        .execute(&pool)
        .await
        .expect("写入中断审计");
        recover_interrupted_audits(&pool).await.expect("恢复中断审计");
        let status: String = sqlx::query_scalar(
            "SELECT status FROM agent_proposals WHERE id='prop_interrupted'",
        )
        .fetch_one(&pool)
        .await
        .expect("查询状态");
        assert_eq!(status, "unknown");
        let outcome: String = sqlx::query_scalar(
            "SELECT outcome FROM audit_logs WHERE tool_name='run_command'",
        )
        .fetch_one(&pool)
        .await
        .expect("查询审计状态");
        assert_eq!(outcome, "unknown");
    }
}
