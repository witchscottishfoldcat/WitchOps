//! 服务器管理相关 IPC 命令

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{Server, ServerInput};
use crate::AppState;

/// 列出所有服务器
#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> AppResult<Vec<Server>> {
    let servers = sqlx::query_as::<_, Server>("SELECT * FROM servers ORDER BY name")
        .fetch_all(state.db())
        .await?;
    Ok(servers)
}

/// 获取单个服务器
#[tauri::command]
pub async fn get_server(state: State<'_, AppState>, id: i64) -> AppResult<Server> {
    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = ?")
        .bind(id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("服务器 {id}")))?;
    Ok(server)
}

/// 新建服务器(credential 为明文,后端用 vault 加密)
#[tauri::command]
pub async fn create_server(
    state: State<'_, AppState>,
    input: ServerInput,
) -> AppResult<i64> {
    input.validate()?;

    let credential_enc = match (&input.auth_method, &input.credential) {
        (_, Some(cred)) if !cred.is_empty() => {
            Some(state.seal_secret(cred).await?)
        }
        _ => None,
    };

    let tags_json = input
        .tags
        .as_ref()
        .map(|t| serde_json::to_string(t).unwrap_or_default());

    use sqlx::Row;
    let row = sqlx::query(
        "INSERT INTO servers (name, host, port, username, auth_method, credential_enc, tags, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_method)
    .bind(&credential_enc)
    .bind(&tags_json)
    .bind(&input.note)
    .fetch_one(state.db())
    .await?;

    let id: i64 = row.try_get("id")?;
    Ok(id)
}

/// 更新服务器
#[tauri::command]
pub async fn update_server(
    state: State<'_, AppState>,
    id: i64,
    input: ServerInput,
) -> AppResult<()> {
    input.validate()?;

    // 读旧值:① 用于连接参数变更检测(变更后须断开旧会话);
    // ② 旧 credential_enc 交给 SQL 的 COALESCE 保留,不再"读-改-写"
    let old = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = ?")
        .bind(id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("服务器 {id}")))?;

    // 提供非空新凭证才重新加密;None 或空串(表单未改动)→ 传 NULL,
    // 由 UPDATE 里的 COALESCE(?, credential_enc) 保留库中原值。
    // 单条 UPDATE 原子完成,避免并发 vault_reset 清空密文后又被这里的旧值写回。
    let credential_enc = match input.credential.as_deref() {
        Some(cred) if !cred.is_empty() => Some(state.seal_secret(cred).await?),
        _ => None,
    };

    let tags_json = input
        .tags
        .as_ref()
        .map(|t| serde_json::to_string(t).unwrap_or_default());

    sqlx::query(
        "UPDATE servers SET name=?, host=?, port=?, username=?, auth_method=?,
         credential_enc=COALESCE(?, credential_enc), tags=?, note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?",
    )
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_method)
    .bind(&credential_enc)
    .bind(tags_json)
    .bind(&input.note)
    .bind(id)
    .execute(state.db())
    .await?;

    // 连接目标或凭证变化 → 断开缓存会话:防止命令继续打到旧主机,而审计却记新主机。
    // 注意凭证变化用 credential_enc.is_some() 判断(即"本次确实提供了新凭证"),
    // 不能与 old.credential_enc 直接比较:未提供时这里是 None 而库中恒为 Some(密文),
    // 直接比较会导致任何一次编辑(哪怕只改备注)都误断开会话。
    let target_changed = old.host != input.host
        || old.port != input.port
        || old.username != input.username
        || old.auth_method != input.auth_method
        || credential_enc.is_some();
    if target_changed {
        state.ssh.disconnect(id).await.ok();
    }

    Ok(())
}

/// 删除服务器
#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    // 先断开连接
    state.ssh.disconnect(id).await.ok();
    sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(id)
        .execute(state.db())
        .await?;
    Ok(())
}

/// 连接服务器(用存储的加密凭证解密后连接)
///
/// 返回 host key 指纹(首连时前端应展示给用户确认)
#[tauri::command]
pub async fn connect_server(state: State<'_, AppState>, id: i64) -> AppResult<String> {
    let server = sqlx::query_as::<_, Server>("SELECT * FROM servers WHERE id = ?")
        .bind(id)
        .fetch_optional(state.db())
        .await?
        .ok_or_else(|| AppError::NotFound(format!("服务器 {id}")))?;

    if state.ssh.is_connected(id).await {
        return Ok(server.host_key_fingerprint.unwrap_or_default());
    }

    // 解密凭证(Vault 未启用时为本地明文,无需解锁)
    let credential = server
        .credential_enc
        .as_ref()
        .ok_or_else(|| AppError::Vault(format!("服务器 {} 未设置凭证", server.name)))?;
    let credential_plain = state.open_secret(credential).await?;

    let port = server.port as u16;
    match server.auth_method.as_str() {
        "password" => state
            .ssh
            .connect_with_password(
                id,
                &server.host,
                port,
                &server.username,
                &credential_plain,
                server.host_key_fingerprint.clone(),
            )
            .await,
        "private_key" => state
            .ssh
            .connect_with_key(
                id,
                &server.host,
                port,
                &server.username,
                &credential_plain,
                None,
                server.host_key_fingerprint.clone(),
            )
            .await,
        other => Err(AppError::InvalidInput(format!(
            "不支持的认证方式: {other}"
        ))),
    }
    // 指纹由前端拿到后存回(见 confirm_host_key 命令)
}

/// 确认 host key 指纹(首连后用户确认,存入数据库)
///
/// 安全要求:前端提交的指纹必须与活动连接**实际捕获**的指纹一致才落库;
/// 无活动连接直接报错(不能盲目持久化任意字符串,重连会重新按库中指纹校验)。
#[tauri::command]
pub async fn confirm_host_key(
    state: State<'_, AppState>,
    id: i64,
    fingerprint: String,
) -> AppResult<()> {
    // 先比对活动连接的实际指纹:不一致或无连接都在这里返回错误,不落库
    state.ssh.confirm_host_key(id, &fingerprint).await?;

    sqlx::query(
        "UPDATE servers SET host_key_fingerprint=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    )
    .bind(&fingerprint)
    .bind(id)
    .execute(state.db())
    .await?;
    Ok(())
}

/// 断开服务器连接
#[tauri::command]
pub async fn disconnect_server(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.ssh.disconnect(id).await
}

/// 查询服务器连接状态
#[tauri::command]
pub async fn server_connection_status(
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<bool> {
    Ok(state.ssh.is_connected(id).await)
}
