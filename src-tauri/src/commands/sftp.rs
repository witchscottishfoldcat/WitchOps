//! SFTP 文件操作命令
//!
//! 每个命令打开一次 SFTP 子系统会话执行操作。
//! (实现简单;若需高频操作,可后续优化为复用 session)
//!
//! 设计约定:所有**写操作**(write/delete/mkdir/rmdir/rename)必须调用
//! [`crate::executor::begin_audit_action`] 先登记操作，再执行并补齐结果。

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::executor::{begin_audit_action, finish_audit_action, AuditContext};
use crate::AppState;

/// 查询服务器 host(用于审计记录),失败返回空串
async fn fetch_server_host(state: &State<'_, AppState>, server_id: i64) -> String {
    use sqlx::Row;
    sqlx::query("SELECT host FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(state.db())
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("host").ok())
        .unwrap_or_default()
}

/// 写操作执行 + 审计的公共包装。先登记 pending，登记失败则不执行远端操作；
/// 操作完成后补齐结果，补写失败时明确提示用户人工核对。
async fn audit_sftp_action(
    state: &State<'_, AppState>,
    server_id: i64,
    tool_name: &str,
    args: serde_json::Value,
    op: impl std::future::Future<Output = AppResult<()>>,
) -> AppResult<()> {
    let server_host = fetch_server_host(state, server_id).await;
    let ctx = AuditContext {
        source: "sftp".into(),
        session_id: None,
        tool_name: tool_name.into(),
        command: None,
        args: Some(args.to_string()),
        approved_by: Some("user".into()),
        proposal_id: None,
    };

    let audit_id = begin_audit_action(
        state.db(),
        Some(server_id),
        Some(&server_host),
        None,
        &ctx,
    )
    .await?;
    let start = std::time::Instant::now();
    let result = op.await;
    let duration_ms = start.elapsed().as_millis() as i64;
    let (success, output) = match &result {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };
    if let Err(e) = finish_audit_action(
        state.db(),
        audit_id,
        if success { "succeeded" } else { "unknown" },
        None,
        output.as_deref(),
        success,
        duration_ms,
    )
    .await {
        return Err(AppError::Internal(format!(
            "SFTP 操作可能已执行，但审计结果更新失败（audit_id={audit_id}）：{e}。请人工核对后再操作"
        )));
    }
    result
}

/// 目录条目
#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub permissions: Option<u32>,
}

/// 列出目录
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<Vec<DirEntry>> {
    log::info!("SFTP list_dir: server={server_id} path='{path}'");
    let sftp = state.ssh.open_sftp(server_id).await.map_err(|e| {
        log::error!("SFTP 子系统打开失败(server={server_id}): {e}");
        e
    })?;
    let entries = sftp
        .read_dir(&path)
        .await
        .map_err(|e| {
            log::error!("SFTP read_dir('{path}') 失败: {e}");
            AppError::Ssh(format!("读取目录失败: {e}"))
        })?;

    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let is_symlink = meta.is_symlink();
        let size = meta.len();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });
        let permissions = meta.permissions;
        result.push(DirEntry {
            name,
            is_dir,
            is_symlink,
            size,
            modified,
            permissions,
        });
    }
    // 目录在前,文件在后,各自按名字排序
    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    log::info!("SFTP read_dir('{path}') 成功: {} 个条目", result.len());
    Ok(result)
}

/// 读取文本文件(限 1MB)
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<String> {
    let sftp = state.ssh.open_sftp(server_id).await?;

    // 先 stat 大小:避免把超大文件整个读进内存后才拒绝(OOM 风险)
    if let Ok(meta) = sftp.metadata(&path).await {
        if meta.is_dir() {
            return Err(AppError::InvalidInput("这是一个目录,无法作为文本读取".into()));
        }
        if meta.len() > 1024 * 1024 {
            return Err(AppError::InvalidInput(format!(
                "文件 {:.1} MB 超过 1MB 限制,请下载后用专门编辑器打开",
                meta.len() as f64 / 1024.0 / 1024.0
            )));
        }
    }

    let mut file = sftp
        .open(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("打开文件失败: {e}")))?;

    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件失败: {e}")))?;

    String::from_utf8(buf).map_err(|_| AppError::InvalidInput("文件不是合法 UTF-8 文本(可能是二进制文件)".into()))
}

/// 写入文本文件
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
    content: String,
) -> AppResult<()> {
    // 审计上下文与重构前 audit_sftp_action 构造的完全一致(source=sftp),行为不变
    let ctx = AuditContext {
        source: "sftp".into(),
        session_id: None,
        tool_name: "write_file".into(),
        command: None,
        args: Some(serde_json::json!({ "path": path }).to_string()),
        approved_by: Some("user".into()),
        proposal_id: None,
    };
    write_file_with_ctx(&state, server_id, &path, &content, ctx).await.map(|_| ())
}

/// SFTP 写文件核心:执行写入 + 用给定审计上下文写审计日志,返回审计日志 ID。
///
/// 供 [`sftp_write_file`] 命令与 Agent 提案执行(`execute_agent_proposal` 的 write_file 分支)复用:
/// Agent 路径由调用方传入服务端构建的 ctx(source=agent、approved_by、proposal_id),
/// 前端无法伪造。Agent 路径审计写库失败 fail-closed(与 execute_and_audit 一致);
/// 手动 SFTP 路径保持原行为(告警不吞结果)。
pub async fn write_file_with_ctx(
    state: &State<'_, AppState>,
    server_id: i64,
    path: &str,
    content: &str,
    ctx: AuditContext,
) -> AppResult<i64> {
    let server_host = fetch_server_host(state, server_id).await;
    // 审计只保存路径和长度。文件正文仍保留在提案执行快照中，但不能复制到审计、文档或模型摘要。
    let ctx = AuditContext {
        args: Some(serde_json::json!({
            "path": path,
            "content_chars": content.chars().count()
        }).to_string()),
        ..ctx
    };

    let audit_id = begin_audit_action(
        state.db(),
        Some(server_id),
        Some(&server_host),
        None,
        &ctx,
    )
    .await?;
    let start = std::time::Instant::now();
    let result: AppResult<()> = async {
        let sftp = state.ssh.open_sftp(server_id).await?;

        use russh_sftp::protocol::OpenFlags;
        let mut file = sftp
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| AppError::Ssh(format!("打开文件失败: {e}")))?;

        use tokio::io::AsyncWriteExt;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| AppError::Ssh(format!("写入失败: {e}")))?;
        file.flush()
            .await
            .map_err(|e| AppError::Ssh(format!("flush 失败: {e}")))?;
        Ok(())
    }
    .await;
    let duration_ms = start.elapsed().as_millis() as i64;

    let (success, output) = match &result {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };
    if let Err(e) = finish_audit_action(
        state.db(),
        audit_id,
        if success { "succeeded" } else { "unknown" },
        None,
        output.as_deref(),
        success,
        duration_ms,
    )
    .await {
        return Err(AppError::Internal(format!(
            "文件可能已写入服务器 {server_id}，但审计结果更新失败（audit_id={audit_id}）：{e}。请人工核对后再操作"
        )));
    }
    result?;
    Ok(audit_id)
}

/// 删除文件
#[tauri::command]
pub async fn sftp_delete_file(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "path": path });
    audit_sftp_action(&state, server_id, "delete_file", args, async {
        let sftp = state.ssh.open_sftp(server_id).await?;
        sftp.remove_file(&path)
            .await
            .map_err(|e| AppError::Ssh(format!("删除文件失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 创建目录
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "path": path });
    audit_sftp_action(&state, server_id, "mkdir", args, async {
        let sftp = state.ssh.open_sftp(server_id).await?;
        sftp.create_dir(&path)
            .await
            .map_err(|e| AppError::Ssh(format!("创建目录失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 删除目录
#[tauri::command]
pub async fn sftp_rmdir(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "path": path });
    audit_sftp_action(&state, server_id, "rmdir", args, async {
        let sftp = state.ssh.open_sftp(server_id).await?;
        sftp.remove_dir(&path)
            .await
            .map_err(|e| AppError::Ssh(format!("删除目录失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 重命名
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    server_id: i64,
    from: String,
    to: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "from": from, "to": to });
    audit_sftp_action(&state, server_id, "rename", args, async {
        let sftp = state.ssh.open_sftp(server_id).await?;
        sftp.rename(&from, &to)
            .await
            .map_err(|e| AppError::Ssh(format!("重命名失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 下载远程文件到本地(后端直连:远程 SFTP → 本地磁盘,不经前端 IPC)
///
/// local_path 由前端通过 Tauri dialog.save() 获取。
/// 数据在后端内存中分块流转(64KB chunks),大文件也不会 OOM。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    server_id: i64,
    remote_path: String,
    local_path: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "remote": remote_path, "local": local_path });
    audit_sftp_action(&state, server_id, "download", args, async {
        let sftp = state.ssh.open_sftp(server_id).await?;

        // 拒绝目录下载
        let meta = sftp.metadata(&remote_path).await
            .map_err(|e| AppError::Ssh(format!("无法获取远程文件信息: {e}")))?;
        if meta.is_dir() {
            return Err(AppError::InvalidInput("远程路径是目录,无法下载为单个文件".into()));
        }

        // 打开远程文件 + 本地文件
        let mut remote = sftp.open(&remote_path).await
            .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {e}")))?;
        let mut local = tokio::fs::File::create(&local_path).await
            .map_err(|e| AppError::Internal(format!("创建本地文件失败: {e}")))?;

        // 分块拷贝(64KB / chunk)
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = remote.read(&mut buf).await
                .map_err(|e| AppError::Ssh(format!("读取远程文件失败: {e}")))?;
            if n == 0 { break; }
            local.write_all(&buf[..n]).await
                .map_err(|e| AppError::Internal(format!("写入本地文件失败: {e}")))?;
        }
        local.flush().await.map_err(|e| AppError::Internal(format!("flush 失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 上传本地文件到远程(后端直连:本地磁盘 → 远程 SFTP,不经前端 IPC)
///
/// local_path 由前端通过 Tauri dialog.open() 获取。
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    server_id: i64,
    local_path: String,
    remote_path: String,
) -> AppResult<()> {
    let args = serde_json::json!({ "local": local_path, "remote": remote_path });
    audit_sftp_action(&state, server_id, "upload", args, async {
        // 检查本地文件
        let local_meta = tokio::fs::metadata(&local_path).await
            .map_err(|e| AppError::Internal(format!("无法访问本地文件: {e}")))?;
        if local_meta.is_dir() {
            return Err(AppError::InvalidInput("本地路径是目录,无法上传为单个文件".into()));
        }

        let sftp = state.ssh.open_sftp(server_id).await?;
        use russh_sftp::protocol::OpenFlags;
        let mut remote = sftp.open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        ).await.map_err(|e| AppError::Ssh(format!("打开远程文件失败: {e}")))?;
        let mut local = tokio::fs::File::open(&local_path).await
            .map_err(|e| AppError::Internal(format!("打开本地文件失败: {e}")))?;

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = local.read(&mut buf).await
                .map_err(|e| AppError::Internal(format!("读取本地文件失败: {e}")))?;
            if n == 0 { break; }
            remote.write_all(&buf[..n]).await
                .map_err(|e| AppError::Ssh(format!("写入远程文件失败: {e}")))?;
        }
        remote.flush().await.map_err(|e| AppError::Ssh(format!("flush 失败: {e}")))?;
        Ok(())
    })
    .await
}

/// 路径信息(规范路径、是否存在)
#[derive(Debug, Serialize, Deserialize)]
pub struct PathInfo {
    pub canonical: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
}

/// 获取路径规范形式
#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    server_id: i64,
    path: String,
) -> AppResult<PathInfo> {
    let sftp = state.ssh.open_sftp(server_id).await?;
    match sftp.metadata(&path).await {
        Ok(meta) => Ok(PathInfo {
            canonical: path,
            exists: true,
            is_dir: meta.is_dir(),
            size: meta.len(),
        }),
        Err(_) => Ok(PathInfo {
            canonical: path,
            exists: false,
            is_dir: false,
            size: 0,
        }),
    }
}
