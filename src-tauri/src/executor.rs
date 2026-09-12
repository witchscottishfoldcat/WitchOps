//! 统一执行出口 —— 安全命脉
//!
//! Agent、快捷指令与服务控制等结构化命令必须经过 [`execute_and_audit`]。
//! 交互式 PTY 具有不同语义，只记录会话生命周期，默认不保存可能包含密码的输入行。
//!
//! 这对应 MaidKit 的 `ssh_agent_service.dart::executeProposal` 的执行部分,
//! 但扩展为跨来源的统一入口。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::ssh::{CommandResult, SshManager};

/// 审计日志记录的输入(执行上下文)
#[derive(Debug, Clone, Deserialize)]
pub struct AuditContext {
    /// 操作来源:agent / manual_terminal / quick_action / mcp_external
    pub source: String,
    /// 关联的会话 ID(Agent 流程用)
    #[serde(default)]
    pub session_id: Option<String>,
    /// 工具名:run_command / read_file / write_file / ...
    pub tool_name: String,
    /// 实际命令(对 run_command 即命令字符串)
    #[serde(default)]
    pub command: Option<String>,
    /// 参数(JSON 字符串)
    #[serde(default)]
    pub args: Option<String>,
    /// 审批人/策略:"user:zhang" 或 "policy:auto_review"
    #[serde(default)]
    pub approved_by: Option<String>,
    /// 关联的提案 ID
    #[serde(default)]
    pub proposal_id: Option<String>,
}

/// 审计日志记录(返回给前端查看用)
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuditLog {
    pub id: i64,
    pub timestamp: String,
    pub session_id: Option<String>,
    pub server_id: Option<i64>,
    pub server_host: Option<String>,
    pub source: String,
    pub tool_name: String,
    pub command: Option<String>,
    pub args: Option<String>,
    pub exit_code: Option<i32>,
    pub output: Option<String>,
    pub success: bool,
    /// pending / succeeded / failed / unknown
    pub outcome: String,
    pub approved_by: Option<String>,
    pub proposal_id: Option<String>,
    pub duration_ms: Option<i64>,
}

/// 审计日志输出截断阈值(防 token 爆炸,借鉴 MaidKit 的 12000 字符)
const OUTPUT_TRUNCATE: usize = 2000;

/// 统一执行 + 审计出口
///
/// 这是所有 SSH 命令执行的**唯一**入口(对于 run_command 类操作)。
/// 执行命令 → 自动写审计日志 → 返回结果。
///
/// 返回 (命令结果, 审计日志 ID)
pub async fn execute_and_audit(
    ssh: &SshManager,
    db: &SqlitePool,
    server_id: i64,
    server_host: &str,
    command: &str,
    ctx: &AuditContext,
) -> AppResult<(CommandResult, i64)> {
    // debug 级:命令串可能内嵌密码/令牌等敏感信息,不能进 info 日志
    log::debug!(
        "[audit] 执行 server={server_id} tool={} source={} cmd={:?}",
        ctx.tool_name,
        ctx.source,
        command
    );

    // 先落执行意图。此处失败就不向远端发送命令，避免产生无记录的变更。
    let audit_id = begin_audit_action(
        db,
        Some(server_id),
        Some(server_host),
        ctx.command.as_deref().or(Some(command)),
        ctx,
    )
    .await?;

    let start = std::time::Instant::now();
    let result = ssh.run_command(server_id, command).await;
    let duration_ms = start.elapsed().as_millis() as i64;

    let (success, outcome, exit_code, output) = match &result {
        Ok(r) => {
            let combined = r.combined_output();
            (
                r.success(),
                if r.success() { "succeeded" } else { "failed" },
                Some(r.exit_code),
                combined,
            )
        }
        // SSH 错误可能发生在命令发出之后，保守标 unknown，禁止调用方自动重试。
        Err(e) => (false, "unknown", None, e.to_string()),
    };

    if let Err(e) = finish_audit_action(
        db,
        audit_id,
        outcome,
        exit_code,
        Some(&output),
        success,
        duration_ms,
    )
    .await {
        log::error!("审计结果更新失败(命令可能已执行,server={server_id},audit={audit_id}): {e}");
        return Err(AppError::Internal(format!(
            "命令可能已在服务器 {server_id} 上执行，但审计结果更新失败（audit_id={audit_id}）：{e}。请人工核对后再操作"
        )));
    }

    let result = result?;
    Ok((result, audit_id))
}

/// 仅记录审计日志(不执行,用于 read_file 等不需要 SSH 执行的操作记录)
#[allow(clippy::too_many_arguments)]
pub async fn log_action(
    db: &SqlitePool,
    server_id: Option<i64>,
    server_host: Option<&str>,
    success: bool,
    output: Option<&str>,
    ctx: &AuditContext,
) -> AppResult<i64> {
    let timestamp = Utc::now().to_rfc3339();
    let truncated = output.map(truncate_output);
    write_audit_log(
        db,
        &timestamp,
        ctx.session_id.as_deref(),
        server_id,
        server_host,
        &ctx.source,
        &ctx.tool_name,
        ctx.command.as_deref(),
        ctx.args.as_deref(),
        None,
        truncated.as_deref(),
        success,
        if success { "succeeded" } else { "failed" },
        ctx.approved_by.as_deref(),
        ctx.proposal_id.as_deref(),
        0,
    )
    .await
}

/// 在操作开始前创建 pending 审计。失败时调用方不得执行远端变更。
pub async fn begin_audit_action(
    db: &SqlitePool,
    server_id: Option<i64>,
    server_host: Option<&str>,
    command: Option<&str>,
    ctx: &AuditContext,
) -> AppResult<i64> {
    let timestamp = Utc::now().to_rfc3339();
    write_audit_log(
        db,
        &timestamp,
        ctx.session_id.as_deref(),
        server_id,
        server_host,
        &ctx.source,
        &ctx.tool_name,
        command.or(ctx.command.as_deref()),
        ctx.args.as_deref(),
        None,
        None,
        false,
        "pending",
        ctx.approved_by.as_deref(),
        ctx.proposal_id.as_deref(),
        0,
    )
    .await
}

/// 补齐已经登记的审计结果。
pub async fn finish_audit_action(
    db: &SqlitePool,
    audit_id: i64,
    outcome: &str,
    exit_code: Option<i32>,
    output: Option<&str>,
    success: bool,
    duration_ms: i64,
) -> AppResult<()> {
    if !matches!(outcome, "succeeded" | "failed" | "unknown") {
        return Err(AppError::InvalidInput(format!("非法审计结果状态: {outcome}")));
    }
    let truncated = output.map(truncate_output);
    let changed = sqlx::query(
        "UPDATE audit_logs
         SET outcome=?, exit_code=?, output=?, success=?, duration_ms=?
         WHERE id=? AND outcome='pending'",
    )
    .bind(outcome)
    .bind(exit_code)
    .bind(truncated)
    .bind(success)
    .bind(duration_ms)
    .bind(audit_id)
    .execute(db)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::Internal(format!(
            "审计记录 {audit_id} 不存在或已经完成"
        )));
    }
    Ok(())
}

/// 截断输出到 OUTPUT_TRUNCATE 字符
fn truncate_output(s: &str) -> String {
    if s.len() <= OUTPUT_TRUNCATE {
        s.to_string()
    } else {
        // 按字节边界回退到合法 UTF-8 边界,避免切断多字节字符
        let mut i = OUTPUT_TRUNCATE;
        while i > 0 && !s.is_char_boundary(i) {
            i -= 1;
        }
        format!(
            "{}\n...(输出已截断,共 {} 字符)",
            &s[..i],
            s.chars().count()
        )
    }
}

/// 写审计日志到数据库
#[allow(clippy::too_many_arguments)]
async fn write_audit_log(
    db: &SqlitePool,
    timestamp: &str,
    session_id: Option<&str>,
    server_id: Option<i64>,
    server_host: Option<&str>,
    source: &str,
    tool_name: &str,
    command: Option<&str>,
    args: Option<&str>,
    exit_code: Option<i32>,
    output: Option<&str>,
    success: bool,
    outcome: &str,
    approved_by: Option<&str>,
    proposal_id: Option<&str>,
    duration_ms: i64,
) -> AppResult<i64> {
    use sqlx::Row;

    let row = sqlx::query(
        "INSERT INTO audit_logs
            (timestamp, session_id, server_id, server_host, source, tool_name,
             command, args, exit_code, output, success, outcome, approved_by, proposal_id, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(timestamp)
    .bind(session_id)
    .bind(server_id)
    .bind(server_host)
    .bind(source)
    .bind(tool_name)
    .bind(command)
    .bind(args)
    .bind(exit_code)
    .bind(output)
    .bind(success)
    .bind(outcome)
    .bind(approved_by)
    .bind(proposal_id)
    .bind(duration_ms)
    .fetch_one(db)
    .await?;

    let id: i64 = row.try_get("id")?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_output_unchanged() {
        let s = "hello world";
        assert_eq!(truncate_output(s), s);
    }

    #[test]
    fn truncate_long_output_appends_note() {
        let s = "x".repeat(3000);
        let t = truncate_output(&s);
        assert!(t.len() < s.len());
        assert!(t.ends_with("...(输出已截断,共 3000 字符)"), "尾部注释: {t}");
    }

    #[test]
    fn truncate_never_cuts_multibyte_utf8() {
        // 中文 3 字节/字符,构造恰好跨越截断边界的长字符串
        let s = "运维自动化运维自动化".repeat(200);
        assert!(s.len() > OUTPUT_TRUNCATE);
        let t = truncate_output(&s);
        // 结果必须是合法 UTF-8(截断按字符边界回退,不得 panic/产生非法字节)
        assert!(String::from_utf8(t.clone().into_bytes()).is_ok());
        assert!(t.contains("...(输出已截断"));
    }

    #[test]
    fn truncate_exact_boundary_ok() {
        let s = "y".repeat(OUTPUT_TRUNCATE);
        assert_eq!(truncate_output(&s), s);
    }
}
