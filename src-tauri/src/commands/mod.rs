//! IPC 命令层
//!
//! 所有命令通过 Tauri 的 `#[tauri::command]` 暴露给前端。
//! 按功能聚合:
//! - `vault`:     凭证库初始化/解锁/锁定
//! - `servers`:   服务器 CRUD + 连接 + 命令执行
//! - `providers`: LLM provider 档案管理
//! - `knowledge`: 审计日志 / Skills / 快捷指令 / 文档沉淀
//! - `sftp`:      SFTP 文件操作
//! - `ops`:       监控 / 容器 / systemd 运维命令
//! - `updates`:   应用更新检查(GitHub Releases)
//!
//! 注:terminal(交互式终端流)是顶层模块,在 lib.rs 直接声明

pub mod agent_chat;
pub mod knowledge;
pub mod ops;
pub mod proposals;
pub mod providers;
pub mod servers;
pub mod sessions;
pub mod sftp;
pub mod updates;
pub mod vault;

// 重新导出所有命令函数(供 lib.rs 的 generate_handler! 使用)
pub use agent_chat::*;
pub use knowledge::*;
pub use ops::*;
pub use proposals::*;
pub use providers::*;
pub use servers::*;
pub use sessions::*;
pub use sftp::*;
pub use updates::*;
pub use vault::*;
