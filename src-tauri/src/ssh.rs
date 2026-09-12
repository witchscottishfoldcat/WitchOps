//! SSH 连接管理器
//!
//! 基于 russh 0.62。管理到各服务器的连接,提供命令执行能力。
//!
//! 设计:
//! - 每个服务器一条连接,用 HashMap<server_id, Handle> 缓存
//! - host key 首连确认:首次连接时 handler 捕获指纹回传给前端,用户确认后存库,后续严格校验
//! - 所有命令执行最终应汇聚到 [`crate::executor::execute_and_audit`] —— 这是安全命脉

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use russh::client;
use russh::keys::PublicKey;
use russh::{ChannelMsg, Disconnect};

use crate::error::{AppError, AppResult};

/// 构建带 keep-alive 的 SSH 客户端配置
///
/// 防空闲断连:服务器/防火墙/NAT 会在连接空闲一段时间后断开。
/// keepalive_interval: 服务器沉默 30 秒就发心跳包保活
/// keepalive_max: 连续 3 个心跳无回应才判定断开(≈90秒)
/// inactivity_timeout: None —— 不因空闲回收连接(交给 keepalive 管)
fn client_config() -> Arc<client::Config> {
    use std::time::Duration;
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..Default::default()
    })
}

/// SSH 连接管理器(全局单例,通过 Tauri state 共享)
pub struct SshManager {
    /// server_id → 已认证的连接句柄。
    ///
    /// 每个连接一把独立 Mutex:同一服务器的命令天然串行
    /// (russh Handle 的 channel_open_session 需要 &mut self),
    /// 但**不同服务器之间完全并行** —— 旧实现是全局单锁,
    /// 一台服务器跑长命令会阻塞所有服务器的全部操作。
    sessions: Mutex<HashMap<i64, Arc<Mutex<SshSession>>>>,
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 一条已建立的 SSH 会话
struct SshSession {
    /// russh 连接句柄
    handle: russh::client::Handle<ClientHandler>,
    /// 本次连接实际捕获到的 host key 指纹(check_server_key 回调写入)
    actual_fingerprint: String,
    /// 本连接是否已通过 host key 确认:
    /// - 连接时与库中期望指纹一致 → true(后续连接免再次确认)
    /// - 首连(库中无期望指纹)→ false,必须等用户 confirm_host_key 后才放行命令
    confirmed: bool,
}

/// 客户端 Handler(处理服务器事件,主要是 host key 校验)
struct ClientHandler {
    /// 期望的 host key 指纹(若已知),用于校验
    expected_fingerprint: Option<String>,
    /// 实际捕获到的指纹(由 check_server_key 回调写入,连接后读取)
    actual_fingerprint: Arc<Mutex<Option<String>>>,
}

impl ClientHandler {
    fn new(expected_fingerprint: Option<String>) -> (Self, Arc<Mutex<Option<String>>>) {
        let actual = Arc::new(Mutex::new(None));
        (
            Self {
                expected_fingerprint,
                actual_fingerprint: actual.clone(),
            },
            actual,
        )
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// host key 校验:
    /// - 若有期望指纹,严格比对一致才放行(防中间人)
    /// - 若无期望指纹(首连),放行但调用方会通过 actual_fingerprint 拿到实际指纹让用户确认
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = fingerprint_of(server_public_key);

        // 捕获实际指纹,供连接后读取
        *self.actual_fingerprint.lock().await = Some(fingerprint.clone());

        match &self.expected_fingerprint {
            Some(expected) => {
                let ok = expected == &fingerprint;
                if !ok {
                    log::warn!("host key 指纹不匹配! 期望={expected}, 实际={fingerprint}");
                }
                Ok(ok)
            }
            None => {
                log::info!("首次连接,host key 指纹={fingerprint}(待用户确认)");
                Ok(true)
            }
        }
    }
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 判断某服务器是否已连接
    pub async fn is_connected(&self, server_id: i64) -> bool {
        self.sessions.lock().await.contains_key(&server_id)
    }

    /// 建立连接(密码认证)
    ///
    /// 返回实际 host key 指纹(用于首连确认回传)
    pub async fn connect_with_password(
        &self,
        server_id: i64,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        expected_fingerprint: Option<String>,
    ) -> AppResult<String> {
        let config = client_config();
        let (handler, actual_fp) = ClientHandler::new(expected_fingerprint.clone());
        let addrs = (host, port);

        let mut session = client::connect(config, addrs, handler)
            .await
            .map_err(|e| AppError::Ssh(format!("连接失败: {e}")))?;

        let auth_ok = session
            .authenticate_password(username, password)
            .await
            .map_err(|e| AppError::Ssh(format!("认证请求失败: {e}")))?
            .success();

        if !auth_ok {
            return Err(AppError::Ssh("用户名或密码错误".into()));
        }

        let fp = actual_fp.lock().await.clone().unwrap_or_default();
        // 仅在本次连接实际指纹与库中期望指纹一致时才视为"已确认"
        let confirmed = !fp.is_empty() && expected_fingerprint.as_deref() == Some(fp.as_str());
        self.sessions.lock().await.insert(
            server_id,
            Arc::new(Mutex::new(SshSession {
                handle: session,
                actual_fingerprint: fp.clone(),
                confirmed,
            })),
        );

        log::info!("已连接到服务器 {server_id} ({host}:{port})");
        Ok(fp)
    }

    /// 建立连接(私钥认证)
    #[allow(clippy::too_many_arguments)]
    pub async fn connect_with_key(
        &self,
        server_id: i64,
        host: &str,
        port: u16,
        username: &str,
        private_key_pem: &str,
        passphrase: Option<&str>,
        expected_fingerprint: Option<String>,
    ) -> AppResult<String> {
        let config = client_config();
        let (handler, actual_fp) = ClientHandler::new(expected_fingerprint.clone());
        let addrs = (host, port);

        let mut session = client::connect(config, addrs, handler)
            .await
            .map_err(|e| AppError::Ssh(format!("连接失败: {e}")))?;

        let key_pair = parse_private_key(private_key_pem, passphrase)?;

        let hash_alg = session
            .best_supported_rsa_hash()
            .await
            .map_err(|e| AppError::Ssh(format!("协商 RSA hash 失败: {e}")))?
            .flatten();

        let auth_ok = session
            .authenticate_publickey(
                username,
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
            )
            .await
            .map_err(|e| AppError::Ssh(format!("认证请求失败: {e}")))?
            .success();

        if !auth_ok {
            return Err(AppError::Ssh("私钥认证失败".into()));
        }

        let fp = actual_fp.lock().await.clone().unwrap_or_default();
        // 仅在本次连接实际指纹与库中期望指纹一致时才视为"已确认"
        let confirmed = !fp.is_empty() && expected_fingerprint.as_deref() == Some(fp.as_str());
        self.sessions.lock().await.insert(
            server_id,
            Arc::new(Mutex::new(SshSession {
                handle: session,
                actual_fingerprint: fp.clone(),
                confirmed,
            })),
        );

        log::info!("已连接到服务器 {server_id} ({host}:{port}) via 私钥");
        Ok(fp)
    }

    /// 断开某服务器连接
    pub async fn disconnect(&self, server_id: i64) -> AppResult<()> {
        let session = self.sessions.lock().await.remove(&server_id);
        if let Some(session) = session {
            let session = session.lock().await;
            let _ = session
                .handle
                .disconnect(Disconnect::ByApplication, "", "English")
                .await;
            log::info!("已断开服务器 {server_id}");
        }
        Ok(())
    }

    /// 用户确认 host key(首连确认流程)。
    ///
    /// 前端提交的指纹必须与**本次连接实际捕获的指纹**一致才置为已确认;
    /// 不一致或无活动连接均报错,调用方(confirm_host_key 命令)不得落库。
    pub async fn confirm_host_key(&self, server_id: i64, fingerprint: &str) -> AppResult<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&server_id)
                .cloned()
                .ok_or_else(|| AppError::NotConnected(server_id))?
        };

        let mut s = session.lock().await;
        if s.actual_fingerprint != fingerprint {
            return Err(AppError::Ssh(format!(
                "主机密钥指纹不匹配:前端提交 {fingerprint},本次连接实际为 {}",
                s.actual_fingerprint
            )));
        }
        s.confirmed = true;
        log::info!("服务器 {server_id} host key 已由用户确认");
        Ok(())
    }

    /// 执行命令并获取结果(stdout / stderr / exit_code)
    ///
    /// 这是低层方法,供 [`crate::executor::execute_and_audit`] 调用,
    /// 以保证所有命令执行都经过审计。
    pub async fn run_command(
        &self,
        server_id: i64,
        command: &str,
    ) -> AppResult<CommandResult> {
        // 取该服务器的连接句柄(全局 map 锁只做查找,瞬间释放);
        // 后续只持有该服务器自己的锁,不同服务器之间完全并行。
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&server_id)
                .cloned()
                .ok_or(AppError::NotConnected(server_id))?
        };

        // 锁内仅打开 channel(russh 的 channel_open_session 需要 &mut Handle,
        // 同一连接的命令天然串行;channel 打开后即独立于 handle)
        let mut channel = {
            let session = session.lock().await;
            ensure_confirmed(server_id, &session)?;
            session
                .handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(format!("打开 channel 失败: {e}")))?
        };

        channel
            .exec(true, command)
            .await
            .map_err(|e| AppError::Ssh(format!("exec 失败: {e}")))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: Option<i32> = None;

        let read_loop = async {
            loop {
                let Some(msg) = channel.wait().await else {
                    break;
                };
                match msg {
                    ChannelMsg::Data { ref data } => {
                        // 输出超上限后停止累积(防 `yes`/`cat /dev/zero` 打爆内存),
                        // 但仍继续消费直到 EOF,保证协议状态正常
                        if stdout.len() < MAX_OUTPUT_BYTES {
                            stdout.extend_from_slice(data);
                        }
                    }
                    ChannelMsg::ExtendedData { ref data, .. } => {
                        // SSH 扩展数据(ext_code==1 即 stderr)
                        if stderr.len() < MAX_OUTPUT_BYTES {
                            stderr.extend_from_slice(data);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status as i32);
                        // 不立即 break,继续读完缓冲
                    }
                    _ => {}
                }
            }
        };

        // 总超时保护:远端命令挂起(网络半开/交互式命令误入)时
        // 不会永久占用连接资源;超时后 channel drop 即关闭该命令通道
        tokio::time::timeout(COMMAND_TIMEOUT, read_loop)
            .await
            .map_err(|_| {
                AppError::Ssh(format!(
                    "命令执行超时(超过 {} 秒),已中断: {command}",
                    COMMAND_TIMEOUT.as_secs()
                ))
            })?;

        Ok(CommandResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_code: exit_code.unwrap_or(-1),
        })
    }

    /// 打开 SFTP 子系统(Phase 2 文件管理用)
    /// 返回 SftpSession 供文件操作。注意:调用方需自行管理生命周期。
    #[allow(dead_code)]
    pub async fn open_sftp(
        &self,
        server_id: i64,
    ) -> AppResult<russh_sftp::client::SftpSession> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&server_id)
                .cloned()
                .ok_or(AppError::NotConnected(server_id))?
        };

        let session = session.lock().await;
        ensure_confirmed(server_id, &session)?;
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("打开 channel 失败: {e}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Ssh(format!("请求 sftp 子系统失败: {e}")))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::Ssh(format!("初始化 SFTP 失败: {e}")))
    }

    /// 打开一个 PTY(伪终端)用于交互式终端。
    ///
    /// 返回已请求 PTY + shell 的 channel。调用方(terminal 模块)负责
    /// 读写循环:读 channel 输出 → emit 给前端;前端输入 → channel.data()。
    ///
    /// 注意:channel 所有权移交给调用方,因为它需要独占的读写访问。
    pub async fn open_pty(
        &self,
        server_id: i64,
        cols: u32,
        rows: u32,
        term: &str,
    ) -> AppResult<russh::Channel<russh::client::Msg>> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&server_id)
                .cloned()
                .ok_or(AppError::NotConnected(server_id))?
        };

        let session = session.lock().await;
        ensure_confirmed(server_id, &session)?;
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("打开 channel 失败: {e}")))?;

        // 请求 PTY
        channel
            .request_pty(false, term, cols, rows, 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(format!("请求 PTY 失败: {e}")))?;

        // 请求交互式 shell
        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::Ssh(format!("请求 shell 失败: {e}")))?;

        log::info!("服务器 {server_id} PTY 已打开 ({cols}x{rows})");
        Ok(channel)
    }
}

/// 单次命令输出累积上限(防 `yes`/`cat /dev/zero` 类命令打爆内存)
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024; // 2 MB
/// 单次命令总执行超时(防远端命令挂起永久占用连接)
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// 命令执行结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl CommandResult {
    /// 合并输出(stdout + stderr)
    pub fn combined_output(&self) -> String {
        if self.stderr.is_empty() {
            self.stdout.clone()
        } else {
            format!("{}{}", self.stdout, self.stderr)
        }
    }

    pub fn success(&self) -> bool {
        self.exit_code == 0
    }
}

// ==================== 辅助函数 ====================

/// 主机密钥未确认的连接禁止执行任何操作(命令/PTY/SFTP),
/// 防止在可能被中间人的连接上运行命令。
fn ensure_confirmed(server_id: i64, session: &SshSession) -> AppResult<()> {
    if !session.confirmed {
        return Err(AppError::Ssh(format!(
            "服务器 {server_id} 主机密钥未确认,已拒绝执行(首次连接需先确认指纹)"
        )));
    }
    Ok(())
}

/// 计算 host key 指纹(SHA256,OpenSSH 格式 "SHA256:...")
fn fingerprint_of(pk: &PublicKey) -> String {
    pk.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

/// 解析私钥(支持 PEM 字符串)
fn parse_private_key(
    pem: &str,
    passphrase: Option<&str>,
) -> AppResult<russh::keys::PrivateKey> {
    russh::keys::decode_secret_key(pem, passphrase)
        .map_err(|e| AppError::Ssh(format!("私钥解析失败: {e}")))
}
