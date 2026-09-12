//! 交互式终端流
//!
//! 设计(actor 模式):
//! - 每个终端 = 一个 PTY channel + 一个 tokio task(读 channel 输出 → emit Tauri 事件)
//! - 前端输入/resize/close 通过 mpsc 通道发给 task
//! - task 退出时自动清理会话
//!
//! 事件流(后端 → 前端):
//!   `terminal_output_<id>`  : { data: string }  服务器输出(二进制安全,base64)
//!   `terminal_exit_<id>`    : { code: number }  会话结束
//!
//! 命令流(前端 → 后端):
//!   terminal_open    → 开 PTY,返回 terminal_id
//!   terminal_input   → 写入用户按键
//!   terminal_resize  → 改窗口大小
//!   terminal_close   → 关闭终端

use std::collections::HashMap;
use std::sync::Arc;
use base64::Engine;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::executor::{log_action, AuditContext};
use crate::AppState;

/// 发给终端 task 的指令
enum TerminalCmd {
    /// 用户输入(原始字节)
    Input(Vec<u8>),
    /// 终端 resize
    Resize { cols: u32, rows: u32 },
    /// 关闭终端
    Close,
}

/// 一个活跃的终端会话
struct TerminalSession {
    /// 发送指令的通道
    tx: mpsc::UnboundedSender<TerminalCmd>,
    /// task 句柄(用于等待结束)
    _task: JoinHandle<()>,
    /// 会话令牌:task 退出清理时只删除与自己令牌一致的条目,
    /// 防止同 id 并发打开时旧 task 的清理误删新会话
    token: Arc<()>,
}

/// 终端会话管理器(存 AppState)
#[derive(Default)]
pub struct TerminalManager {
    /// terminal_id → 会话
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 打开一个终端,返回 terminal_id
    pub async fn open(
        &self,
        app: AppHandle,
        ssh: &crate::ssh::SshManager,
        server_id: i64,
        cols: u32,
        rows: u32,
        terminal_id: Option<String>,
    ) -> AppResult<String> {
        // 前端可预生成 id(用于先建 xterm 再开 PTY,避免初始输出丢失)
        let terminal_id = terminal_id.unwrap_or_else(|| {
            format!("term_{}", uuid::Uuid::new_v4().simple())
        });

        // 防重复:id 已存在则报错,而不是覆盖会话表条目。
        // 覆盖会让旧 task 的退出清理把新会话的条目删掉,导致新终端失联。
        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&terminal_id) {
                return Err(AppError::InvalidInput(format!(
                    "终端 {terminal_id} 已存在,拒绝重复打开"
                )));
            }
        }

        // 查服务器 host(审计记录用):查不到只降级为空串并记日志,绝不阻断开终端
        let db = app.state::<AppState>().db.clone();
        let server_host = query_server_host(&db, server_id).await;

        // 开 PTY channel(所有权转移给 task)
        let channel = ssh.open_pty(server_id, cols, rows, "xterm-256color").await?;

        let (tx, mut rx) = mpsc::unbounded_channel::<TerminalCmd>();
        let id_for_task = terminal_id.clone();
        let app_for_task = app.clone();
        let token = Arc::new(());
        let token_for_task = token.clone();

        // 读 channel 输出 + 处理指令的 task
        let task = tokio::spawn(async move {
            run_terminal_loop(
                id_for_task,
                app_for_task,
                token_for_task,
                server_id,
                server_host,
                db,
                channel,
                &mut rx,
            )
            .await;
        });

        // 插入前在同一把锁内再次检查(覆盖并发打开同 id 的竞争);
        // 若期间被抢占,关闭刚开的 PTY task 并报错,绝不留孤儿覆盖条目
        {
            let mut sessions = self.sessions.lock().await;
            if sessions.contains_key(&terminal_id) {
                let _ = tx.send(TerminalCmd::Close);
                return Err(AppError::InvalidInput(format!(
                    "终端 {terminal_id} 已存在,拒绝重复打开"
                )));
            }
            sessions.insert(
                terminal_id.clone(),
                TerminalSession { tx, _task: task, token },
            );
        }

        log::info!("终端 {terminal_id} 已打开(server={server_id})");
        Ok(terminal_id)
    }

    /// 发送用户输入
    pub async fn input(&self, terminal_id: &str, data: Vec<u8>) -> AppResult<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("终端 {terminal_id}")))?;
        session
            .tx
            .send(TerminalCmd::Input(data))
            .map_err(|_| AppError::Internal("终端已关闭".into()))?;
        Ok(())
    }

    /// resize
    pub async fn resize(&self, terminal_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| AppError::NotFound(format!("终端 {terminal_id}")))?;
        session
            .tx
            .send(TerminalCmd::Resize { cols, rows })
            .map_err(|_| AppError::Internal("终端已关闭".into()))?;
        Ok(())
    }

    /// 关闭终端
    pub async fn close(&self, terminal_id: &str) -> AppResult<()> {
        let session = self.sessions.lock().await.remove(terminal_id);
        if let Some(session) = session {
            let _ = session.tx.send(TerminalCmd::Close);
            log::info!("终端 {terminal_id} 已关闭");
        }
        Ok(())
    }
}

/// 终端 task 的主循环
///
/// 同时处理:① channel 输出 → emit 给前端;② 前端指令(输入/resize/close)
/// 用户输入原样转发给 SSH。默认不记录输入内容：PTY 无法可靠判断当前是否为密码提示，
/// 也无法把每一行输入与准确的输出、退出码配对。
#[allow(clippy::too_many_arguments)]
async fn run_terminal_loop(
    terminal_id: String,
    app: AppHandle,
    token: Arc<()>,
    server_id: i64,
    server_host: String,
    db: SqlitePool,
    mut channel: russh::Channel<russh::client::Msg>,
    rx: &mut mpsc::UnboundedReceiver<TerminalCmd>,
) {
    use russh::ChannelMsg;

    let output_event = format!("terminal_output_{terminal_id}");
    let exit_event = format!("terminal_exit_{terminal_id}");
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut data_chunks: u64 = 0;

    log::debug!("终端 {terminal_id} 事件循环已启动,等待 channel 数据");

    loop {
        tokio::select! {
            // 服务器输出 → emit 给前端
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        data_chunks += 1;
                        // 诊断:前 5 个 chunk 必记,之后每 50 个记一次(debug 级)
                        if data_chunks <= 5 || data_chunks.is_multiple_of(50) {
                            log::debug!(
                                "终端 {terminal_id} 收到输出 chunk #{data_chunks} ({} 字节),已 emit",
                                data.len()
                            );
                        }
                        let encoded = b64.encode(data.as_ref());
                        let _ = app.emit(&output_event, serde_json::json!({ "data": encoded }));
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        // stderr 也发给前端(终端里合并显示)
                        let encoded = b64.encode(data.as_ref());
                        let _ = app.emit(&output_event, serde_json::json!({ "data": encoded }));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = app.emit(&exit_event, serde_json::json!({ "code": exit_status }));
                        break;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        log::info!("终端 {terminal_id} channel 已断开(Eof/Close/None),共收到 {data_chunks} 个输出 chunk");
                        let _ = app.emit(&exit_event, serde_json::json!({ "code": -1 }));
                        break;
                    }
                    _ => {}
                }
            }
            // 前端指令
            cmd = rx.recv() => {
                match cmd {
                    Some(TerminalCmd::Input(data)) => {
                        // channel.data 接受 AsyncRead,&[u8] 实现了它
                        // (原样转发,审计只是观察,不改动任何字节)
                        if channel.data(&data[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(TerminalCmd::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
        }
    }

    // 会话结束:写一条 terminal_close 审计(固定文案)。
    // 无论正常退出还是 channel 断开都会走到这里;与下方会话表清理互相独立
    let close_ctx = AuditContext {
        source: "manual_terminal".into(),
        session_id: None,
        tool_name: "terminal_close".into(),
        command: None,
        args: None,
        approved_by: None,
        proposal_id: None,
    };
    if let Err(e) = log_action(
        &db,
        Some(server_id),
        Some(&server_host),
        true,
        Some("终端会话已关闭"),
        &close_ctx,
    )
    .await
    {
        log::error!("终端关闭审计写入失败(server={server_id}): {e}");
    }

    // 清理:从会话表移除自己(task 结束说明 channel 已关)
    // 只删除与自身令牌一致的条目:并发打开同 id 时,旧 task 不得误删新会话的条目
    let id = terminal_id.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        if let Some(tm) = app_clone.try_state::<TerminalManagerHolder>() {
            let mut sessions = tm.0.sessions.lock().await;
            let owns_entry = sessions
                .get(&id)
                .map(|s| Arc::ptr_eq(&s.token, &token))
                .unwrap_or(false);
            if owns_entry {
                sessions.remove(&id);
                log::debug!("终端 {id} 已从会话表移除");
            }
        }
    });

    log::debug!("终端 {terminal_id} 循环结束");
}

// ==================== 终端会话审计 ====================

/// 查询服务器 host(用于审计记录)。
///
/// 查不到(服务器已删除/库故障)只降级为空串并记日志,**绝不阻断开终端**。
async fn query_server_host(db: &SqlitePool, server_id: i64) -> String {
    use sqlx::Row;
    match sqlx::query("SELECT host FROM servers WHERE id = ?")
        .bind(server_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(row)) => row.try_get::<String, _>("host").unwrap_or_else(|e| {
            log::warn!("服务器 {server_id} host 字段解析失败,审计 host 置空: {e}");
            String::new()
        }),
        Ok(None) => {
            log::warn!("服务器 {server_id} 不存在,审计 host 置空");
            String::new()
        }
        Err(e) => {
            log::warn!("查询服务器 {server_id} host 失败,审计 host 置空: {e}");
            String::new()
        }
    }
}

// ==================== Tauri 命令 ====================

/// TerminalManager 的包装(Tauri managed state 需要单独类型避免与 AppState 冲突)
pub struct TerminalManagerHolder(pub Arc<TerminalManager>);

/// 打开终端
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    tm: tauri::State<'_, TerminalManagerHolder>,
    server_id: i64,
    cols: Option<u32>,
    rows: Option<u32>,
    terminal_id: Option<String>,
) -> AppResult<String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    tm.0.open(app, &state.ssh, server_id, cols, rows, terminal_id).await
}

/// 用户输入
#[tauri::command]
pub async fn terminal_input(
    tm: tauri::State<'_, TerminalManagerHolder>,
    terminal_id: String,
    data: String, // base64 编码的字节
) -> AppResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|_| AppError::InvalidInput("base64 解码失败".into()))?;
    tm.0.input(&terminal_id, bytes).await
}

/// resize
#[tauri::command]
pub async fn terminal_resize(
    tm: tauri::State<'_, TerminalManagerHolder>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    tm.0.resize(&terminal_id, cols, rows).await
}

/// 关闭终端
#[tauri::command]
pub async fn terminal_close(
    tm: tauri::State<'_, TerminalManagerHolder>,
    terminal_id: String,
) -> AppResult<()> {
    tm.0.close(&terminal_id).await
}

/// 前端诊断日志桥(前端关键节点打到后端日志,排查黑屏链路)
#[tauri::command]
pub fn frontend_log(msg: String) {
    log::info!("[JS] {msg}");
}
