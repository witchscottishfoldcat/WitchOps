//! Witchcat Ops 后端入口
//!
//! 架构(扁平 feature 结构,借鉴 MaidKit):
//! - `db`     数据库初始化
//! - `error`  统一错误类型
//! - `vault`  凭证库(PBKDF2 + AES-GCM-256 + keychain)
//! - `ssh`    SSH 连接管理(russh 0.62)
//! - `executor` 统一执行出口 execute_and_audit(安全命脉)
//! - `models` 数据模型
//! - `commands` IPC 命令层(供前端调用)

pub mod commands;
pub mod db;
pub mod error;
pub mod executor;
pub mod models;
pub mod ssh;
pub mod terminal;
pub mod vault;

use std::sync::Arc;
use sqlx::SqlitePool;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::ssh::SshManager;
use crate::vault::Vault;

/// 全局应用状态(通过 Tauri managed state 共享给所有命令)
pub struct AppState {
    /// 数据库连接池
    pub db: SqlitePool,
    /// SSH 连接管理器
    pub ssh: SshManager,
    /// 已解锁的 Vault(运行时持有 data key;未解锁时为 None)
    vault: RwLock<Option<Arc<Vault>>>,
    /// 数据目录路径(sessions JSONL 等文件存放于此)
    pub data_dir: std::path::PathBuf,
}

impl AppState {
    pub fn new(db: SqlitePool, data_dir: std::path::PathBuf) -> Self {
        Self {
            db,
            ssh: SshManager::new(),
            vault: RwLock::new(None),
            data_dir,
        }
    }

    /// 获取已解锁的 Vault(若未解锁则报错)— 同步版,适合无需等待的场景
    pub fn require_vault(&self) -> Result<Arc<Vault>, AppError> {
        self.vault
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| AppError::Vault("凭证库未解锁,请先解锁".into()))
    }

    /// 获取已解锁的 Vault(若未解锁则报错)— async 版,确保拿到最新状态
    pub async fn require_vault_arc(&self) -> Result<Arc<Vault>, AppError> {
        self.vault
            .read()
            .await
            .clone()
            .ok_or_else(|| AppError::Vault("凭证库未解锁,请先解锁".into()))
    }

    pub async fn vault(&self) -> Option<Arc<Vault>> {
        self.vault.read().await.clone()
    }

    pub async fn set_vault(&self, vault: Vault) {
        *self.vault.write().await = Some(Arc::new(vault));
    }

    pub async fn clear_vault(&self) {
        *self.vault.write().await = None;
    }

    pub fn db(&self) -> &SqlitePool {
        &self.db
    }

    // ==================== 敏感数据加解密封面 ====================
    //
    // 存储格式(自描述前缀,兼容各时代数据):
    //   "enc:v1:<base64>"  → Vault 密文(读取需已解锁)
    //   "plain:<原文>"     → Vault 未启用时的本地明文
    //   无前缀(历史数据)   → 已解锁则尝试按密文解,失败按明文;锁定则报错

    /// Vault 是否已初始化(用户是否启用过)
    pub async fn vault_initialized(&self) -> bool {
        Vault::is_initialized(&self.db).await.unwrap_or(false)
    }

    /// 加密敏感值:已解锁 → enc 密文;未启用 → plain 明文;已启用但锁定 → 拒绝
    pub async fn seal_secret(&self, plaintext: &str) -> AppResult<String> {
        if let Some(vault) = self.vault().await {
            return Ok(format!("{}{}", ENC_PREFIX, vault.encrypt_str(plaintext)?));
        }
        if self.vault_initialized().await {
            return Err(AppError::Vault("凭证库已锁定,请先解锁再保存".into()));
        }
        Ok(format!("{PLAIN_PREFIX}{plaintext}"))
    }

    /// 解密敏感值:按前缀分派,兼容无前缀的历史数据
    pub async fn open_secret(&self, stored: &str) -> AppResult<String> {
        if let Some(ct) = stored.strip_prefix(ENC_PREFIX) {
            let vault = self.require_vault_arc().await?;
            return vault.decrypt_str(ct);
        }
        if let Some(p) = stored.strip_prefix(PLAIN_PREFIX) {
            return Ok(p.to_string());
        }
        // 历史无前缀数据
        if let Some(vault) = self.vault().await {
            // 有锁时代的密文:尝试解密;失败说明是更早的明文残留
            if let Ok(plain) = vault.decrypt_str(stored) {
                return Ok(plain);
            }
            return Ok(stored.to_string());
        }
        if self.vault_initialized().await {
            return Err(AppError::Vault("凭证库已锁定,请先解锁".into()));
        }
        Ok(stored.to_string())
    }
}

/// 密文前缀(Vault 加密值)
pub const ENC_PREFIX: &str = "enc:v1:";
/// 明文前缀(Vault 未启用时的本地存储)
pub const PLAIN_PREFIX: &str = "plain:";

fn copy_legacy_data_dir(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_legacy_data_dir(&source_path, &destination_path)?;
        } else {
            std::fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 发布版使用运行时应用数据目录，不能依赖编译机器的源码路径。
            // WITCHCAT_DATA_DIR 仍可用于便携安装或测试环境。
            let explicit_data_dir = std::env::var("WITCHCAT_DATA_DIR").ok();
            let data_dir = explicit_data_dir
                .as_ref()
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)
                .expect("无法创建项目数据目录");

            // 0.1.0 曾把应用数据目录复制到源码目录后继续在那里写入，因此两边同时存在时
            // 源码目录通常更新。首次升级先备份当前应用目录，再完整导入旧目录并写迁移标记。
            if explicit_data_dir.is_none() {
                let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                let legacy_dir = manifest.parent().unwrap_or(&manifest).join("data");
                let migration_marker = data_dir.join(".legacy-project-data-imported");
                if legacy_dir.join("app.db").exists()
                    && legacy_dir != data_dir
                    && !migration_marker.exists()
                {
                    if data_dir.join("app.db").exists() {
                        let dir_name = data_dir
                            .file_name()
                            .and_then(|v| v.to_str())
                            .unwrap_or("witchcat-ops-data");
                        let backup_dir = data_dir.with_file_name(format!(
                            "{dir_name}.pre-legacy-import"
                        ));
                        if !backup_dir.exists() {
                            copy_legacy_data_dir(&data_dir, &backup_dir)?;
                            log::warn!("导入旧数据前的应用数据备份: {}", backup_dir.display());
                        }
                    }
                    copy_legacy_data_dir(&legacy_dir, &data_dir)?;
                    std::fs::write(&migration_marker, b"imported\n")?;
                    log::info!(
                        "已复制旧版数据目录: {} → {}（旧副本已保留）",
                        legacy_dir.display(),
                        data_dir.display()
                    );
                }
            }

            log::info!("数据目录: {}", data_dir.display());

            // 在 Tokio runtime 里初始化数据库(同步 setup 中需要异步)
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let db = match db::init_db(&data_dir).await {
                    Ok(db) => db,
                    Err(e) => {
                        log::error!("数据库初始化失败: {e}");
                        panic!("数据库初始化失败: {e}");
                    }
                };
                let state = AppState::new(db, data_dir.clone());
                handle.manage(state);
                // 终端会话管理器(单独 manage,供 terminal 命令使用)
                handle.manage(terminal::TerminalManagerHolder(std::sync::Arc::new(
                    terminal::TerminalManager::new(),
                )));
                log::info!("Witchcat Ops 后端启动完成");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // vault
            commands::vault_is_initialized,
            commands::vault_setup,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_is_unlocked,
            commands::vault_recover,
            commands::vault_reset,
            // servers
            commands::list_servers,
            commands::get_server,
            commands::create_server,
            commands::update_server,
            commands::delete_server,
            commands::connect_server,
            commands::confirm_host_key,
            commands::disconnect_server,
            commands::server_connection_status,
            // providers(LLM 配置)
            commands::list_providers,
            commands::get_provider,
            commands::create_provider,
            commands::update_provider,
            commands::delete_provider,
            // Agent LLM 调用代理(key 不出后端,流式事件走 Channel)
            commands::agent_chat,
            commands::agent_chat_cancel,
            // 终端流(交互式)
            terminal::terminal_open,
            terminal::terminal_input,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::frontend_log,
            // audit
            commands::query_audit_logs,
            commands::get_session_audit_logs,
            commands::audit_stats,
            // skills
            commands::list_skills,
            commands::list_enabled_skills,
            commands::get_skill,
            commands::upsert_skill,
            commands::delete_skill,
            commands::toggle_skill,
            // quick actions
            commands::list_quick_actions,
            commands::upsert_quick_action,
            commands::delete_quick_action,
            commands::execute_quick_action,
            // docs
            commands::list_docs,
            commands::get_doc,
            commands::upsert_doc,
            commands::update_doc_status,
            commands::delete_doc,
            commands::doc_to_skill,
            // SFTP 文件操作
            commands::sftp_list_dir,
            commands::sftp_read_file,
            commands::sftp_write_file,
            commands::sftp_delete_file,
            commands::sftp_mkdir,
            commands::sftp_rmdir,
            commands::sftp_rename,
            commands::sftp_stat,
            commands::sftp_download,
            commands::sftp_upload,
            // Agent 会话持久化
            commands::create_agent_session,
            commands::list_agent_sessions,
            commands::load_agent_messages,
            commands::append_agent_message,
            commands::rename_agent_session,
            commands::delete_agent_session,
            // Agent 提案审批状态机(服务端强制:审批/执行不可由前端伪造)
            commands::create_agent_proposal,
            commands::approve_agent_proposal,
            commands::reject_agent_proposal,
            commands::execute_agent_proposal,
            // 运维:监控 / 容器 / systemd
            commands::get_metrics,
            commands::list_containers,
            commands::control_container,
            commands::list_services,
            commands::control_service,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
