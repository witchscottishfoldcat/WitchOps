//! 知识闭环相关命令:审计日志 / Skills / 快捷指令 / 文档沉淀
//!
//! 这三个需求(记录Agent操作、设置skills、收集运维文档)的核心实现。

use tauri::State;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::executor::AuditLog;
use crate::executor::{execute_and_audit, AuditContext};
use crate::models::{AuditFilter, Doc, QuickAction, Skill};
use crate::AppState;

// ============================================================
// 审计日志(需求1)
// ============================================================

/// 查询审计日志(支持筛选)
#[tauri::command]
pub async fn query_audit_logs(
    state: State<'_, AppState>,
    filter: AuditFilter,
) -> AppResult<Vec<AuditLog>> {
    // 动态拼 SQL(sqlx 运行时模式,参数化绑定)
    let sql = build_audit_query(&filter);
    let mut q = sqlx::query_as::<_, AuditLog>(&sql);

    if let Some(v) = &filter.server_id {
        q = q.bind(v);
    }
    if let Some(v) = &filter.session_id {
        q = q.bind(v);
    }
    if let Some(v) = &filter.source {
        q = q.bind(v);
    }
    if let Some(v) = filter.success {
        q = q.bind(v);
    }
    if let Some(v) = &filter.search {
        // search 子句含 3 个占位符(command/tool_name/output),必须绑定 3 次
        // (用 owned String 逐次绑定,避免借用生命周期问题)
        let like = format!("%{v}%");
        q = q.bind(like.clone()).bind(like.clone()).bind(like);
    }
    if let Some(v) = &filter.from {
        q = q.bind(v);
    }
    if let Some(v) = &filter.to {
        q = q.bind(v);
    }
    q = q.bind(filter.limit.clamp(1, 500));
    q = q.bind(filter.offset.max(0));

    let logs = q.fetch_all(state.db()).await?;
    Ok(logs)
}

/// 构建审计查询 SQL(参数用 ? 占位,顺序与 binds 一致)
fn build_audit_query(f: &AuditFilter) -> String {
    let mut clauses = Vec::new();
    if f.server_id.is_some() {
        clauses.push("server_id = ?");
    }
    if f.session_id.is_some() {
        clauses.push("session_id = ?");
    }
    if f.source.is_some() {
        clauses.push("source = ?");
    }
    if f.success.is_some() {
        clauses.push("success = ?");
    }
    if f.search.is_some() {
        clauses.push("(command LIKE ? OR tool_name LIKE ? OR output LIKE ?)");
    }
    if f.from.is_some() {
        clauses.push("timestamp >= ?");
    }
    if f.to.is_some() {
        clauses.push("timestamp <= ?");
    }

    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };

    format!(
        "SELECT * FROM audit_logs {where_sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    )
}

/// 获取某次会话的所有审计日志(按时间正序,用于复盘)
#[tauri::command]
pub async fn get_session_audit_logs(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<AuditLog>> {
    let logs = sqlx::query_as::<_, AuditLog>(
        "SELECT * FROM audit_logs WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(session_id)
    .fetch_all(state.db())
    .await?;
    Ok(logs)
}

/// 获取审计日志统计(总数 / 成功率)
#[tauri::command]
pub async fn audit_stats(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    use sqlx::Row;
    let total: i64 = sqlx::query("SELECT COUNT(*) AS c FROM audit_logs")
        .fetch_one(state.db())
        .await?
        .try_get("c")
        .unwrap_or(0);
    let success: i64 = sqlx::query("SELECT COUNT(*) AS c FROM audit_logs WHERE outcome = 'succeeded'")
        .fetch_one(state.db()).await?.try_get("c").unwrap_or(0);
    let failed: i64 = sqlx::query("SELECT COUNT(*) AS c FROM audit_logs WHERE outcome = 'failed'")
        .fetch_one(state.db()).await?.try_get("c").unwrap_or(0);
    let unknown: i64 = sqlx::query("SELECT COUNT(*) AS c FROM audit_logs WHERE outcome = 'unknown'")
        .fetch_one(state.db()).await?.try_get("c").unwrap_or(0);
    let pending: i64 = sqlx::query("SELECT COUNT(*) AS c FROM audit_logs WHERE outcome = 'pending'")
        .fetch_one(state.db()).await?.try_get("c").unwrap_or(0);
    Ok(serde_json::json!({
        "total": total,
        "success": success,
        "failed": failed,
        "unknown": unknown,
        "pending": pending,
    }))
}

// ============================================================
// Skills - 运维 SOP 技能包(需求2-A)
// ============================================================

/// 列出所有技能
#[tauri::command]
pub async fn list_skills(state: State<'_, AppState>) -> AppResult<Vec<Skill>> {
    let skills = sqlx::query_as::<_, Skill>("SELECT * FROM skills ORDER BY title")
        .fetch_all(state.db())
        .await?;
    Ok(skills)
}

/// 列出启用的技能(注入 Agent 系统提示用)
#[tauri::command]
pub async fn list_enabled_skills(state: State<'_, AppState>) -> AppResult<Vec<Skill>> {
    let skills =
        sqlx::query_as::<_, Skill>("SELECT * FROM skills WHERE enabled = 1 ORDER BY title")
            .fetch_all(state.db())
            .await?;
    Ok(skills)
}

/// 获取单个技能完整内容(Agent get_skill 工具调用此命令)
#[tauri::command]
pub async fn get_skill(state: State<'_, AppState>, id: String) -> AppResult<Skill> {
    sqlx::query_as::<_, Skill>("SELECT * FROM skills WHERE id = ?")
        .bind(&id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("技能 {id}")))
}

/// 新建/更新技能(upsert)
#[tauri::command]
pub async fn upsert_skill(state: State<'_, AppState>, skill: Skill) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO skills (id, title, content, triggers, tags, applies_to, risk_level,
                             enabled, source, source_doc_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, content=excluded.content, triggers=excluded.triggers,
            tags=excluded.tags, applies_to=excluded.applies_to, risk_level=excluded.risk_level,
            enabled=excluded.enabled, source=excluded.source, source_doc_id=excluded.source_doc_id,
            version=excluded.version + 1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&skill.id)
    .bind(&skill.title)
    .bind(&skill.content)
    .bind(&skill.triggers)
    .bind(&skill.tags)
    .bind(&skill.applies_to)
    .bind(&skill.risk_level)
    .bind(skill.enabled)
    .bind(&skill.source)
    .bind(&skill.source_doc_id)
    .bind(skill.version)
    .execute(state.db())
    .await?;
    Ok(())
}

/// 删除技能
#[tauri::command]
pub async fn delete_skill(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM skills WHERE id = ?")
        .bind(id)
        .execute(state.db())
        .await?;
    Ok(())
}

/// 启用/禁用技能
#[tauri::command]
pub async fn toggle_skill(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE skills SET enabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    )
    .bind(enabled)
    .bind(id)
    .execute(state.db())
    .await?;
    Ok(())
}

// ============================================================
// 快捷指令(需求2-B)
// ============================================================

/// 列出所有快捷指令
#[tauri::command]
pub async fn list_quick_actions(state: State<'_, AppState>) -> AppResult<Vec<QuickAction>> {
    let actions =
        sqlx::query_as::<_, QuickAction>("SELECT * FROM quick_actions ORDER BY name")
            .fetch_all(state.db())
            .await?;
    Ok(actions)
}

/// 新建/更新快捷指令
#[tauri::command]
pub async fn upsert_quick_action(
    state: State<'_, AppState>,
    action: QuickAction,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO quick_actions (id, name, icon, target, steps, approval, audit)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, icon=excluded.icon, target=excluded.target,
            steps=excluded.steps, approval=excluded.approval, audit=excluded.audit,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&action.id)
    .bind(&action.name)
    .bind(&action.icon)
    .bind(&action.target)
    .bind(&action.steps)
    .bind(&action.approval)
    .bind(action.audit)
    .execute(state.db())
    .await?;
    Ok(())
}

/// 删除快捷指令
#[tauri::command]
pub async fn delete_quick_action(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM quick_actions WHERE id = ?")
        .bind(id)
        .execute(state.db())
        .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct QuickActionCommandStep {
    #[serde(rename = "type")]
    step_type: String,
    value: String,
    #[serde(default)]
    guard: Option<String>,
    #[serde(default)]
    confirm: bool,
}

#[derive(Debug, Serialize)]
pub struct QuickActionStepResult {
    pub step_index: usize,
    pub kind: String,
    pub command: String,
    pub audit_id: i64,
    pub exit_code: i32,
    pub success: bool,
}

#[derive(Debug, Serialize)]
pub struct QuickActionExecutionResult {
    pub action_id: String,
    pub success: bool,
    pub stopped_at: Option<usize>,
    pub steps: Vec<QuickActionStepResult>,
}

fn parse_quick_action_steps(raw: &str) -> AppResult<Vec<QuickActionCommandStep>> {
    let steps: Vec<QuickActionCommandStep> = serde_json::from_str(raw)
        .map_err(|e| AppError::InvalidInput(format!("快捷指令步骤不是合法 JSON: {e}")))?;
    if steps.is_empty() {
        return Err(AppError::InvalidInput("快捷指令没有可执行步骤".into()));
    }
    for (index, step) in steps.iter().enumerate() {
        if step.step_type != "command" {
            return Err(AppError::InvalidInput(format!(
                "快捷指令第 {} 步类型 {} 尚不支持",
                index + 1,
                step.step_type
            )));
        }
        if step.value.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "快捷指令第 {} 步命令为空",
                index + 1
            )));
        }
    }
    Ok(steps)
}

/// 执行快捷指令。服务端重新读取并校验用户预览过的版本，构造可信审计上下文，
/// 串行执行 guard/command；任一步非零退出后立即停止。
#[tauri::command]
pub async fn execute_quick_action(
    state: State<'_, AppState>,
    action_id: String,
    server_id: i64,
    expected_updated_at: String,
    user_confirmed: bool,
) -> AppResult<QuickActionExecutionResult> {
    let action = sqlx::query_as::<_, QuickAction>("SELECT * FROM quick_actions WHERE id = ?")
        .bind(&action_id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("快捷指令 {action_id}")))?;
    if action.updated_at != expected_updated_at {
        return Err(AppError::InvalidInput(
            "快捷指令在预览后已被修改，请重新检查并批准".into(),
        ));
    }
    let steps = parse_quick_action_steps(&action.steps)?;
    let requires_confirmation = action.approval != "always_approve" || steps.iter().any(|s| s.confirm);
    if requires_confirmation && !user_confirmed {
        return Err(AppError::InvalidInput("该快捷指令需要人工确认".into()));
    }

    use sqlx::Row;
    let server_host: String = sqlx::query("SELECT host FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("服务器 {server_id}")))?
        .try_get("host")?;
    let approved_by = if user_confirmed {
        "user:quick_action"
    } else {
        "policy:always_approve"
    };
    let mut results = Vec::new();

    for (index, step) in steps.iter().enumerate() {
        if let Some(guard) = step.guard.as_deref().filter(|g| !g.trim().is_empty()) {
            let ctx = AuditContext {
                source: "quick_action".into(),
                session_id: None,
                tool_name: "quick_action_guard".into(),
                command: Some(guard.to_string()),
                args: Some(serde_json::json!({ "action_id": action_id, "step": index }).to_string()),
                approved_by: Some(approved_by.into()),
                proposal_id: None,
            };
            let (result, audit_id) = execute_and_audit(
                &state.ssh,
                state.db(),
                server_id,
                &server_host,
                guard,
                &ctx,
            )
            .await?;
            let success = result.success();
            results.push(QuickActionStepResult {
                step_index: index,
                kind: "guard".into(),
                command: guard.into(),
                audit_id,
                exit_code: result.exit_code,
                success,
            });
            if !success {
                return Ok(QuickActionExecutionResult {
                    action_id,
                    success: false,
                    stopped_at: Some(index),
                    steps: results,
                });
            }
        }

        let ctx = AuditContext {
            source: "quick_action".into(),
            session_id: None,
            tool_name: "run_quick_action".into(),
            command: Some(step.value.clone()),
            args: Some(serde_json::json!({ "action_id": action_id, "step": index }).to_string()),
            approved_by: Some(approved_by.into()),
            proposal_id: None,
        };
        let (result, audit_id) = execute_and_audit(
            &state.ssh,
            state.db(),
            server_id,
            &server_host,
            &step.value,
            &ctx,
        )
        .await?;
        let success = result.success();
        results.push(QuickActionStepResult {
            step_index: index,
            kind: "command".into(),
            command: step.value.clone(),
            audit_id,
            exit_code: result.exit_code,
            success,
        });
        if !success {
            return Ok(QuickActionExecutionResult {
                action_id,
                success: false,
                stopped_at: Some(index),
                steps: results,
            });
        }
    }

    Ok(QuickActionExecutionResult {
        action_id,
        success: true,
        stopped_at: None,
        steps: results,
    })
}

// ============================================================
// 文档沉淀(需求3)
// ============================================================

/// 列出文档
#[tauri::command]
pub async fn list_docs(state: State<'_, AppState>) -> AppResult<Vec<Doc>> {
    let docs = sqlx::query_as::<_, Doc>(
        "SELECT * FROM docs ORDER BY datetime(created_at) DESC",
    )
    .fetch_all(state.db())
    .await?;
    Ok(docs)
}

/// 获取单个文档
#[tauri::command]
pub async fn get_doc(state: State<'_, AppState>, id: String) -> AppResult<Doc> {
    sqlx::query_as::<_, Doc>("SELECT * FROM docs WHERE id = ?")
        .bind(&id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("文档 {id}")))
}

/// 新建/更新文档
#[tauri::command]
pub async fn upsert_doc(state: State<'_, AppState>, doc: Doc) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO docs (id, type, title, content, session_id, server_id, generated_by,
                           tags, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            type=excluded.type, title=excluded.title, content=excluded.content,
            session_id=excluded.session_id, server_id=excluded.server_id,
            generated_by=excluded.generated_by, tags=excluded.tags, status=excluded.status,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&doc.id)
    .bind(&doc.doc_type)
    .bind(&doc.title)
    .bind(&doc.content)
    .bind(&doc.session_id)
    .bind(doc.server_id)
    .bind(&doc.generated_by)
    .bind(&doc.tags)
    .bind(&doc.status)
    .execute(state.db())
    .await?;
    Ok(())
}

/// 更新文档状态(draft → reviewed → archived)
#[tauri::command]
pub async fn update_doc_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE docs SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    )
    .bind(&status)
    .bind(&id)
    .execute(state.db())
    .await?;
    Ok(())
}

/// 删除文档
#[tauri::command]
pub async fn delete_doc(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM docs WHERE id = ?")
        .bind(id)
        .execute(state.db())
        .await?;
    Ok(())
}

/// 把文档转换为技能(打通经验飞轮闭环)
#[tauri::command]
pub async fn doc_to_skill(
    state: State<'_, AppState>,
    doc_id: String,
    skill_id: String,
    title: String,
) -> AppResult<()> {
    // 直接查文档(不经过 command 函数,避免 State clone 问题)
    let doc = sqlx::query_as::<_, Doc>("SELECT * FROM docs WHERE id = ?")
        .bind(&doc_id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("文档 {doc_id}")))?;
    if doc.status != "reviewed" {
        return Err(AppError::InvalidInput(
            "只有已审核（reviewed）的文档才能转换为技能".into(),
        ));
    }

    sqlx::query(
        "INSERT INTO skills (id, title, content, triggers, tags, applies_to, risk_level,
                             enabled, source, source_doc_id, version)
         VALUES (?, ?, ?, NULL, ?, NULL, 'low', 0, 'from_doc', ?, 1)
         ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, content=excluded.content, tags=excluded.tags,
            source_doc_id=excluded.source_doc_id,
            enabled=0,
            version=skills.version + 1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&skill_id)
    .bind(&title)
    .bind(&doc.content)
    .bind(&doc.tags)
    .bind(&doc_id)
    .execute(state.db())
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_quick_action_steps;

    #[test]
    fn quick_action_steps_accept_supported_commands() {
        let steps = parse_quick_action_steps(
            r#"[{"type":"command","value":"nginx -t","guard":"test -f /etc/nginx/nginx.conf"}]"#,
        )
        .expect("合法步骤");
        assert_eq!(steps.len(), 1);
    }

    #[test]
    fn quick_action_steps_reject_unknown_type() {
        let error = parse_quick_action_steps(
            r#"[{"type":"script","value":"echo unsafe"}]"#,
        )
        .expect_err("未知类型必须拒绝");
        assert!(error.to_string().contains("尚不支持"));
    }

    #[test]
    fn quick_action_steps_reject_blank_command() {
        let error = parse_quick_action_steps(
            r#"[{"type":"command","value":"   "}]"#,
        )
        .expect_err("空命令必须拒绝");
        assert!(error.to_string().contains("命令为空"));
    }
}
