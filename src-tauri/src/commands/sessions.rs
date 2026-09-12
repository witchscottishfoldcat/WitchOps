//! Agent 会话持久化
//!
//! 设计:
//! - 元信息存 `agent_sessions` 表(id/title/server_id/updated_at 等)
//! - 对话内容存 JSONL 文件(`data/sessions/<id>.jsonl`),每行一条消息
//! - 前端 AgentMessage 直接序列化存盘,加载时反序列化恢复

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::AppState;

/// 存储的消息(前端 AgentMessage 的持久化形式)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub sender: String,
    pub content: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<serde_json::Value>,
}

/// 会话元信息(返回给前端列表用)
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AgentSessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub server_ids: Option<String>, // JSON 数组字符串,如 "[1]" 或 null
    pub model: Option<String>,
    pub tool_calls_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 获取 data/sessions 目录路径(不存在则创建)
fn sessions_dir(data_dir: &Path) -> AppResult<PathBuf> {
    let dir = data_dir.join("sessions");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("创建 sessions 目录失败: {e}")))?;
    Ok(dir)
}

/// JSONL 文件全局写锁:所有会话文件的创建/追加/删除都串行化,
/// 防止并发 append 交错产生 `{..}{..}` 坏行,以及 append 与 delete 竞争。
/// 会话写入是低频路径,一把全局锁足够。
static JSONL_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 校验 session_id 格式。
///
/// `create_agent_session` 生成的 id 恒为 `sess_` + UUID 简单形式(32 位小写十六进制),
/// 即 `^sess_[0-9a-f]{32}$`。session_id 来自前端,直接拼进文件路径,
/// 必须严格校验以防 `../` 穿越 `data/sessions` 目录。
fn validate_session_id(session_id: &str) -> AppResult<()> {
    let valid = session_id
        .strip_prefix("sess_")
        .map(|rest| {
            rest.len() == 32
                && rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "非法会话 ID: {session_id}(必须是 sess_ + 32 位十六进制)"
        )))
    }
}

/// JSONL 文件路径(内部再校验一次 id,纵深防御)
fn transcript_path(data_dir: &Path, session_id: &str) -> AppResult<PathBuf> {
    validate_session_id(session_id)?;
    Ok(sessions_dir(data_dir)?.join(format!("{session_id}.jsonl")))
}

/// 创建新会话
#[tauri::command]
pub async fn create_agent_session(
    state: State<'_, AppState>,
    title: Option<String>,
    server_id: Option<i64>,
    model: Option<String>,
) -> AppResult<String> {
    let id = format!("sess_{}", uuid::Uuid::new_v4().simple());
    let transcript = format!("sessions/{id}.jsonl");

    // 表里 server_ids 是 JSON 数组字符串(如 "[1]"),由单个 server_id 参数转换
    let server_ids_json = server_id.map(|id| format!("[{id}]"));

    sqlx::query(
        "INSERT INTO agent_sessions (id, title, server_ids, model, transcript_path)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&server_ids_json)
    .bind(&model)
    .bind(&transcript)
    .execute(state.db())
    .await?;

    // 创建空 JSONL 文件(持锁,与 append/delete 串行,防竞争)
    let path = transcript_path(&state.data_dir, &id)?;
    let _guard = JSONL_WRITE_LOCK.lock().await;
    tokio::fs::File::create(&path).await
        .map_err(|e| AppError::Internal(format!("创建会话文件失败: {e}")))?;

    log::info!("[session] 创建会话 {id} title={:?} server={:?}", title, server_id);
    Ok(id)
}

/// 列出所有会话(按更新时间倒序)
#[tauri::command]
pub async fn list_agent_sessions(state: State<'_, AppState>) -> AppResult<Vec<AgentSessionInfo>> {
    let sessions = sqlx::query_as::<_, AgentSessionInfo>(
        "SELECT id, title, server_ids, model, tool_calls_count, created_at, updated_at
         FROM agent_sessions ORDER BY datetime(updated_at) DESC",
    )
    .fetch_all(state.db())
    .await?;
    Ok(sessions)
}

/// 加载会话的全部消息
#[tauri::command]
pub async fn load_agent_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<StoredMessage>> {
    validate_session_id(&session_id)?;
    let path = transcript_path(&state.data_dir, &session_id)?;
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()), // 文件不存在视为空会话
    };

    let mut contents = String::new();
    file.read_to_string(&mut contents).await
        .map_err(|e| AppError::Internal(format!("读取会话文件失败: {e}")))?;

    let mut messages = Vec::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<StoredMessage>(line) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("会话 {session_id} 消息解析失败,跳过: {e}"),
        }
    }

    // 按 id 去重:同一消息可能被多次持久化(流式→最终),取最后一条
    let mut result: Vec<StoredMessage> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for msg in messages {
        if let Some(&i) = index.get(&msg.id) {
            result[i] = msg; // 原位置替换(保持顺序)
        } else {
            index.insert(msg.id.clone(), result.len());
            result.push(msg);
        }
    }
    Ok(result)
}

/// 追加一条消息到会话
#[tauri::command]
pub async fn append_agent_message(
    state: State<'_, AppState>,
    session_id: String,
    message: StoredMessage,
) -> AppResult<()> {
    validate_session_id(&session_id)?;
    let path = transcript_path(&state.data_dir, &session_id)?;

    // 序列化为一行 JSON
    let line = serde_json::to_string(&message)
        .map_err(|e| AppError::Internal(format!("消息序列化失败: {e}")))?;

    // 持全局锁:open + write 必须原子,否则并发 append 会交错成 `{..}{..}` 坏行;
    // 也防止 delete 在 open 之后把文件删掉
    let _guard = JSONL_WRITE_LOCK.lock().await;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| AppError::Internal(format!("打开会话文件失败: {e}")))?;

    // JSON 行 + 换行拼进同一个缓冲区,单次 write_all 写入(原子性依赖 O_APPEND
    // 的每次 write 完整落盘;两次独立 write 之间可能被其他 append 插入)
    let line_len = line.len();
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    file.write_all(&buf).await
        .map_err(|e| AppError::Internal(format!("写入会话失败: {e}")))?;
    drop(_guard);

    log::info!("[session] 追加消息到 {session_id}: {} ({}字节)", message.id, line_len);

    // 更新会话的 updated_at
    sqlx::query("UPDATE agent_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&session_id)
        .execute(state.db())
        .await?;

    Ok(())
}

/// 重命名会话
#[tauri::command]
pub async fn rename_agent_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<()> {
    sqlx::query("UPDATE agent_sessions SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&title)
        .bind(&id)
        .execute(state.db())
        .await?;
    Ok(())
}

/// 删除会话(表记录 + JSONL 文件)
#[tauri::command]
pub async fn delete_agent_session(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    validate_session_id(&id)?;
    sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
        .bind(&id)
        .execute(state.db())
        .await?;

    let path = transcript_path(&state.data_dir, &id)?;
    // 持锁删除:与并发 append 的 open+write 串行,避免"先删除、append 又重建文件"的僵尸会话
    let _guard = JSONL_WRITE_LOCK.lock().await;
    let _ = tokio::fs::remove_file(&path).await; // 文件不存在不算错误

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_accepts_generated_format() {
        assert!(validate_session_id("sess_0123456789abcdef0123456789abcdef").is_ok());
    }

    #[test]
    fn session_id_rejects_path_traversal() {
        assert!(validate_session_id("../evil").is_err());
        assert!(validate_session_id("sess_../../etc/passwd").is_err());
        assert!(validate_session_id("..\\..\\windows\\x.jsonl").is_err());
    }

    #[test]
    fn session_id_rejects_absolute_paths() {
        assert!(validate_session_id("/etc/passwd").is_err());
        assert!(validate_session_id("C:\\Windows\\system32\\x.jsonl").is_err());
        assert!(validate_session_id("D:/ADM/foo.jsonl").is_err());
    }

    #[test]
    fn session_id_rejects_malformed_ids() {
        // 大写十六进制、长度错误、非法字符、缺前缀
        assert!(validate_session_id("sess_0123456789ABCDEF0123456789ABCDEF").is_err());
        assert!(validate_session_id("sess_abc").is_err());
        assert!(validate_session_id("sess_0123456789abcdef0123456789abcdef0").is_err());
        assert!(validate_session_id("0123456789abcdef0123456789abcdef").is_err());
        assert!(validate_session_id("").is_err());
    }
}
