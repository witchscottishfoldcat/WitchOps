//! Agent 提案服务端审批状态机
//!
//! 安全设计(修复「前端伪造审批」漏洞):
//! - 前端只能:创建提案([`create_agent_proposal`])、请求批准([`approve_agent_proposal`])、请求拒绝([`reject_agent_proposal`]);
//! - 执行唯一合法入口是 [`execute_agent_proposal`]:校验提案必须处于 approved 状态,
//!   且执行前先原子地把状态改为 running,防止并发重复执行危险命令;
//! - 不暴露接受任意命令和审计来源的通用 IPC；
//!   审计上下文(source / approved_by / proposal_id)完全由服务端构建。

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::commands::sftp::write_file_with_ctx;
use crate::error::{AppError, AppResult};
use crate::executor::{execute_and_audit, AuditContext};
use crate::ssh::CommandResult;
use crate::AppState;

/// 允许经提案执行流程创建的工具白名单
const ALLOWED_TOOLS: &[&str] = &["run_command", "write_file"];

/// 提案行(execute_agent_proposal 加载用)
#[derive(Debug)]
struct ProposalRow {
    session_id: Option<String>,
    server_id: Option<i64>,
    tool_name: String,
    command: Option<String>,
    args: Option<String>,
    status: String,
}

/// Agent 提案执行结果(返回给前端)
#[derive(Debug, Serialize)]
pub struct AgentExecutionResult {
    pub proposal_id: String,
    pub result: CommandResult,
    pub audit_id: i64,
}

/// 创建 Agent 提案(初始状态 pending)
///
/// 仅登记,不执行。id 由服务端生成(`prop_` + UUID),前端无法自造。
#[tauri::command]
pub async fn create_agent_proposal(
    state: State<'_, AppState>,
    session_id: Option<String>,
    server_id: i64,
    tool_name: String,
    command: Option<String>,
    args: Option<String>,
) -> AppResult<String> {
    if !ALLOWED_TOOLS.contains(&tool_name.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "不支持的工具: {tool_name}(仅支持 run_command / write_file)"
        )));
    }
    match tool_name.as_str() {
        "run_command" => {
            if command.as_deref().map(str::trim).unwrap_or("").is_empty() {
                return Err(AppError::InvalidInput(
                    "run_command 提案必须提供非空 command".into(),
                ));
            }
        }
        "write_file" => {
            let args = args.as_deref().ok_or_else(|| {
                AppError::InvalidInput("write_file 提案必须提供 args(JSON,含 path/content)".into())
            })?;
            let v: serde_json::Value = serde_json::from_str(args).map_err(|e| {
                AppError::InvalidInput(format!("write_file 提案的 args 不是合法 JSON: {e}"))
            })?;
            let path_ok = v
                .get("path")
                .and_then(|p| p.as_str())
                .is_some_and(|s| !s.is_empty());
            if !path_ok || !v.get("content").is_some() {
                return Err(AppError::InvalidInput(
                    "write_file 提案的 args 必须包含 path(非空字符串)与 content".into(),
                ));
            }
        }
        _ => unreachable!(),
    }

    // 目标服务器必须存在:挂不上服务器的提案没有执行意义
    let exists = sqlx::query("SELECT 1 FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(state.db())
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("服务器 {server_id}")));
    }

    let id = format!("prop_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO agent_proposals (id, session_id, server_id, tool_name, command, args, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    )
    .bind(&id)
    .bind(&session_id)
    .bind(server_id)
    .bind(&tool_name)
    .bind(&command)
    .bind(&args)
    .execute(state.db())
    .await?;

    log::info!(
        "[proposal] 创建提案 {id} tool={tool_name} server={server_id} session={:?}",
        session_id
    );
    Ok(id)
}

/// 批准提案(pending → approved)
///
/// approved_by 由服务端写死为 "user",前端无法伪造审批人。
/// 仅 pending 状态允许批准;已批准/已拒绝/已执行的提案 rows_affected=0 报错。
#[tauri::command]
pub async fn approve_agent_proposal(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let res = sqlx::query(
        "UPDATE agent_proposals
         SET status='approved', approved_by='user',
             approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status='pending'",
    )
    .bind(&id)
    .execute(state.db())
    .await?;
    if res.rows_affected() != 1 {
        return Err(AppError::InvalidInput(format!(
            "提案 {id} 不存在或状态不允许批准"
        )));
    }
    log::info!("[proposal] 批准提案 {id}");
    Ok(())
}

/// 拒绝提案(pending → rejected)
///
/// 仅 pending 状态允许拒绝;已执行/已批准的提案 rows_affected=0 报错。
#[tauri::command]
pub async fn reject_agent_proposal(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let res = sqlx::query(
        "UPDATE agent_proposals SET status='rejected' WHERE id = ? AND status='pending'",
    )
    .bind(&id)
    .execute(state.db())
    .await?;
    if res.rows_affected() != 1 {
        return Err(AppError::InvalidInput(format!(
            "提案 {id} 不存在或状态不允许拒绝"
        )));
    }
    log::info!("[proposal] 拒绝提案 {id}");
    Ok(())
}

/// 执行已批准的提案(Agent 提案的唯一执行入口)
///
/// 流程:加载提案 → 校验 approved → **原子占位 running** → 执行 → 持久化最终结果。
///
/// 为什么要「先标记后执行」:两个并发 execute 调用同时通过状态校验后,
/// 只有一个能把 approved → running 改成功(单条 UPDATE 原子,SQLite 串行化写),
/// 另一个 rows_affected=0 直接报错退出 —— 危险命令绝不会被执行两次。
#[tauri::command]
pub async fn execute_agent_proposal(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AgentExecutionResult> {
    let row: ProposalRow = {
        let r = sqlx::query(
            "SELECT session_id, server_id, tool_name, command, args, status
             FROM agent_proposals WHERE id = ?",
        )
        .bind(&id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("提案 {id}")))?;
        ProposalRow {
            session_id: r.get("session_id"),
            server_id: r.get("server_id"),
            tool_name: r.get("tool_name"),
            command: r.get("command"),
            args: r.get("args"),
            status: r.get("status"),
        }
    };
    if row.status != "approved" {
        return Err(AppError::InvalidInput(format!(
            "提案 {id} 状态为 {},必须经服务端批准后才能执行",
            row.status
        )));
    }

    // 原子占位(见函数注释):先改为 running 再执行,防并发重复执行。
    // 应用在远程命令返回前退出时会留下 running；下次启动可将它作为待核对状态处理，
    // 绝不能把“已开始”误报成“已成功”。
    let claim = sqlx::query(
        "UPDATE agent_proposals
         SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             finished_at=NULL, execution_error=NULL, audit_id=NULL, exit_code=NULL
         WHERE id = ? AND status='approved'",
    )
    .bind(&id)
    .execute(state.db())
    .await?;
    if claim.rows_affected() != 1 {
        return Err(AppError::InvalidInput(format!(
            "提案 {id} 已在执行、已完成或状态非法,拒绝重复执行"
        )));
    }

    let execution: AppResult<AgentExecutionResult> = async {
        let server_id = row
            .server_id
            .ok_or_else(|| AppError::InvalidInput(format!("提案 {id} 缺少目标服务器")))?;

        match row.tool_name.as_str() {
        "run_command" => {
            let cmd = row
                .command
                .as_deref()
                .filter(|c| !c.trim().is_empty())
                .ok_or_else(|| AppError::InvalidInput(format!("提案 {id} 缺少命令内容")))?;
            let host: String = {
                let r = sqlx::query("SELECT host FROM servers WHERE id = ?")
                    .bind(server_id)
                    .fetch_optional(state.db())
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("服务器 {server_id}")))?;
                r.try_get("host")?
            };
            // 审计上下文完全由服务端构建:前端无法伪造 source / approved_by / proposal_id
            let ctx = AuditContext {
                source: "agent".into(),
                session_id: row.session_id.clone(),
                tool_name: "run_command".into(),
                command: Some(cmd.to_string()),
                args: row.args.clone(),
                approved_by: Some("user".into()),
                proposal_id: Some(id.clone()),
            };
            let (result, audit_id) =
                execute_and_audit(&state.ssh, state.db(), server_id, &host, cmd, &ctx).await?;
            Ok(AgentExecutionResult {
                proposal_id: id.clone(),
                result,
                audit_id,
            })
        }
        "write_file" => {
            let args_json = row
                .args
                .as_deref()
                .ok_or_else(|| AppError::InvalidInput(format!("提案 {id} 缺少 write_file 参数")))?;
            let args: serde_json::Value = serde_json::from_str(args_json).map_err(|e| {
                AppError::InvalidInput(format!("提案 {id} 的 args 不是合法 JSON: {e}"))
            })?;
            let path = args
                .get("path")
                .and_then(|p| p.as_str())
                .ok_or_else(|| AppError::InvalidInput(format!("提案 {id} 的 args 缺少 path")))?;
            let content = args
                .get("content")
                .and_then(|c| c.as_str())
                .ok_or_else(|| AppError::InvalidInput(format!("提案 {id} 的 args 缺少 content")))?;
            // 审计上下文完全由服务端构建(同 run_command 分支)
            let ctx = AuditContext {
                source: "agent".into(),
                session_id: row.session_id.clone(),
                tool_name: "write_file".into(),
                command: None,
                args: row.args.clone(),
                approved_by: Some("user".into()),
                proposal_id: Some(id.clone()),
            };
            let audit_id = write_file_with_ctx(&state, server_id, path, content, ctx).await?;
            let result = CommandResult {
                stdout: format!("文件 {path} 已写入({} 字符)", content.chars().count()),
                stderr: String::new(),
                exit_code: 0,
            };
            Ok(AgentExecutionResult {
                proposal_id: id.clone(),
                result,
                audit_id,
            })
        }
        other => Err(AppError::InvalidInput(format!(
            "提案 {id} 的工具类型 {other} 不可执行"
        ))),
        }
    }
    .await;

    match execution {
        Ok(done) => {
            let status = if done.result.success() { "succeeded" } else { "failed" };
            sqlx::query(
                "UPDATE agent_proposals
                 SET status=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     execution_error=?, audit_id=?, exit_code=?
                 WHERE id=? AND status='running'",
            )
            .bind(status)
            .bind(if done.result.success() {
                None::<String>
            } else {
                Some(format!("远程命令退出码为 {}", done.result.exit_code))
            })
            .bind(done.audit_id)
            .bind(done.result.exit_code)
            .bind(&id)
            .execute(state.db())
            .await?;
            Ok(done)
        }
        Err(error) => {
            // 领取成功后出现错误时，SSH/SFTP 操作可能已经发送到远端。
            // 在缺少远端幂等键的情况下只能标 unknown，禁止把它自动重试成第二次变更。
            let message = error.to_string();
            if let Err(db_error) = sqlx::query(
                "UPDATE agent_proposals
                 SET status='unknown', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     execution_error=?
                 WHERE id=? AND status='running'",
            )
            .bind(&message)
            .bind(&id)
            .execute(state.db())
            .await
            {
                log::error!("提案 {id} 执行失败后无法持久化 unknown 状态: {db_error}");
            }
            Err(error)
        }
    }
}
