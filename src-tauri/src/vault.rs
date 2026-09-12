//! 凭证库(Vault)
//!
//! 借鉴 MaidKit 的分层加密设计:
//!   主密码 → PBKDF2(310000 次)→ 派生 kek → 解包 data key → data key 加密所有敏感数据
//!
//! data key 存 OS keychain(macOS Keychain / Windows Credential Manager / Linux Secret Service),
//! 数据库里只存"包装"版本作为备份。
//!
//! 边界:对话历史不进 vault,不云同步。待审批 Proposal 不持久化。

use base64::Engine;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// PBKDF2 迭代次数(借鉴 MaidKit 的 310000)
const PBKDF2_ITERATIONS: u32 = 310_000;
/// 盐长度
const SALT_LEN: usize = 16;
/// AES-256-GCM 密钥长度
const KEY_LEN: usize = 32;
/// AES-GCM nonce 长度
const NONCE_LEN: usize = 12;
/// data key 长度
const DATA_KEY_LEN: usize = 32;
/// verifier 明文(固定,用于校验主密码)
const VERIFIER_PLAINTEXT: &[u8] = b"witchcat-ops-vault-verifier-v1";
/// OS keychain 服务名
const KEYCHAIN_SERVICE: &str = "com.witchcat.ops";
/// data key 在 keychain 里的用户名
const KEYCHAIN_DATA_KEY_USER: &str = "vault-data-key";

/// 加密后的密文结构:nonce(12) + 密文(含 tag),统一 base64 编码
/// 解密时前 12 字节是 nonce,其余是密文。
/// Vault 状态(运行时,保存在内存,进程重启需重新解锁)
#[derive(Clone)]
pub struct Vault {
    /// 已解锁的 data key(明文,仅内存)
    data_key: [u8; DATA_KEY_LEN],
}

/// Vault 元数据(存数据库)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMetadata {
    pub salt: String,              // hex
    pub wrapped_data_key: Option<String>, // base64
    pub verifier: String,          // base64
    pub iterations: u32,
}

impl Vault {
    /// 初始化新的 vault:生成 data key,用主密码包装后存库 + keychain
    pub async fn setup(master_password: &str, db: &SqlitePool) -> AppResult<Self> {
        let rng = SystemRandom::new();

        // 1. 生成 salt 和 data key
        let mut salt = [0u8; SALT_LEN];
        let mut data_key = [0u8; DATA_KEY_LEN];
        rng.fill(&mut salt)
            .map_err(|e| AppError::Crypto(format!("生成 salt 失败: {e}")))?;
        rng.fill(&mut data_key)
            .map_err(|e| AppError::Crypto(format!("生成 data key 失败: {e}")))?;

        // 2. 用主密码派生 kek(key encryption key)
        let kek = derive_kek(master_password, &salt);

        // 3. 用 kek 包装 data key
        let wrapped = seal(&kek, &data_key)?;

        // 4. 生成 verifier(用 data key 加密固定明文)
        let verifier = seal(&data_key, VERIFIER_PLAINTEXT)?;

        // 5. data key 存 keychain(明文 base64)
        let data_key_b64 = base64::engine::general_purpose::STANDARD.encode(data_key);
        save_to_keychain(KEYCHAIN_DATA_KEY_USER, &data_key_b64)?;

        // 6. 元数据存库
        let metadata = VaultMetadata {
            salt: hex::encode(salt),
            wrapped_data_key: Some(base64::engine::general_purpose::STANDARD.encode(wrapped)),
            verifier: base64::engine::general_purpose::STANDARD.encode(verifier),
            iterations: PBKDF2_ITERATIONS,
        };
        save_metadata(&metadata, db).await?;

        log::info!("Vault 已初始化");
        Ok(Vault { data_key })
    }

    /// 用主密码解锁 vault
    pub async fn unlock(master_password: &str, db: &SqlitePool) -> AppResult<Self> {
        let metadata = load_metadata(db).await?
            .ok_or_else(|| AppError::Vault("Vault 尚未初始化,请先创建".into()))?;

        let salt = hex::decode(&metadata.salt)
            .map_err(|_| AppError::Crypto("salt 解码失败".into()))?;
        let kek = derive_kek(master_password, &salt);

        // 密码证明(强制):必须用主密码派生的 kek 解包 wrapped data key。
        // 密码错误 → AES-GCM tag 校验失败 → 拒绝解锁。
        // 绝不能走"keychain 直接取明文 data key"的捷径——那不校验密码,任何密码都能解锁。
        let wrapped = metadata.wrapped_data_key
            .ok_or_else(|| AppError::Vault("缺少 wrapped data key,Vault 数据不完整".into()))?;
        let wrapped_ct = base64::engine::general_purpose::STANDARD.decode(&wrapped)
            .map_err(|_| AppError::Crypto("wrapped key 解码失败".into()))?;
        let plaintext = open(&kek, &wrapped_ct)
            .map_err(|_| AppError::Vault("主密码错误,无法解密 Vault 数据 key".into()))?;
        if plaintext.len() != DATA_KEY_LEN {
            return Err(AppError::Crypto("解包后的 data key 长度异常".into()));
        }
        let mut key = [0u8; DATA_KEY_LEN];
        key.copy_from_slice(&plaintext);

        // 二次校验:data key 必须能解密 verifier 且明文正确(防数据损坏)
        let verifier_ct = base64::engine::general_purpose::STANDARD
            .decode(&metadata.verifier)
            .map_err(|_| AppError::Crypto("verifier 解码失败".into()))?;
        let verifier_pt = open(&key, &verifier_ct)
            .map_err(|_| AppError::Vault("Vault 数据损坏(verifier 校验失败)".into()))?;
        if verifier_pt != VERIFIER_PLAINTEXT {
            return Err(AppError::Vault("Vault 数据损坏(verifier 内容不符)".into()));
        }

        // 把 data key 写回 keychain 作备份(尽力而为;keychain 永不作为认证依据)
        let _ = save_to_keychain(
            KEYCHAIN_DATA_KEY_USER,
            &base64::engine::general_purpose::STANDARD.encode(key),
        );

        log::info!("Vault 已解锁");
        Ok(Vault { data_key: key })
    }

    /// 判断是否已初始化
    pub async fn is_initialized(db: &SqlitePool) -> AppResult<bool> {
        Ok(load_metadata(db).await?.is_some())
    }

    /// 忘记密码的本机恢复:用 OS keychain 里备份的 data key 重设主密码。
    ///
    /// 安全前提:能读取当前 OS 账户的 keychain,等价于已登录本机 ——
    /// 与 data key 存 keychain 的威胁模型一致。data key 不变,
    /// 所有已加密凭证保持可用,仅换 salt/wrapped/verifier。
    pub async fn recover_with_keychain(new_password: &str, db: &SqlitePool) -> AppResult<Self> {
        let metadata = load_metadata(db).await?
            .ok_or_else(|| AppError::Vault("Vault 尚未初始化".into()))?;

        // 从 keychain 取备份的 data key
        let b64 = load_from_keychain(KEYCHAIN_DATA_KEY_USER)
            .map_err(|_| AppError::Vault(
                "本机钥匙串中没有 Vault 备份,无法恢复(只能彻底重置)".into(),
            ))?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&b64)
            .map_err(|_| AppError::Crypto("钥匙串备份解码失败".into()))?;
        if decoded.len() != DATA_KEY_LEN {
            return Err(AppError::Crypto("钥匙串备份长度异常".into()));
        }
        let mut key = [0u8; DATA_KEY_LEN];
        key.copy_from_slice(&decoded);

        // 校验备份与库中 verifier 匹配(防止恢复到别的 Vault 上)
        let verifier_ct = base64::engine::general_purpose::STANDARD
            .decode(&metadata.verifier)
            .map_err(|_| AppError::Crypto("verifier 解码失败".into()))?;
        let pt = open(&key, &verifier_ct)
            .map_err(|_| AppError::Vault("钥匙串备份与当前 Vault 不匹配,无法恢复".into()))?;
        if pt != VERIFIER_PLAINTEXT {
            return Err(AppError::Vault("钥匙串备份与当前 Vault 不匹配,无法恢复".into()));
        }

        // 用新主密码重新包装同一个 data key
        let rng = SystemRandom::new();
        let mut salt = [0u8; SALT_LEN];
        rng.fill(&mut salt)
            .map_err(|e| AppError::Crypto(format!("生成 salt 失败: {e}")))?;
        let kek = derive_kek(new_password, &salt);
        let wrapped = seal(&kek, &key)?;
        let verifier = seal(&key, VERIFIER_PLAINTEXT)?;

        let new_metadata = VaultMetadata {
            salt: hex::encode(salt),
            wrapped_data_key: Some(base64::engine::general_purpose::STANDARD.encode(wrapped)),
            verifier: base64::engine::general_purpose::STANDARD.encode(verifier),
            iterations: PBKDF2_ITERATIONS,
        };
        save_metadata(&new_metadata, db).await?;

        log::info!("Vault 已通过钥匙串备份重设主密码");
        Ok(Vault { data_key: key })
    }

    /// 彻底重置:删除 Vault 元数据 + 清空所有已存敏感值(不可恢复!)
    pub async fn reset_all(db: &SqlitePool) -> AppResult<()> {
        sqlx::query("DELETE FROM vault_metadata WHERE id = 1")
            .execute(db)
            .await?;
        // 已加密的值没有 data key 永远无法解开,清空避免残留垃圾
        sqlx::query("UPDATE servers SET credential_enc = NULL WHERE credential_enc IS NOT NULL")
            .execute(db)
            .await?;
        sqlx::query("UPDATE agent_providers SET api_key_enc = '' WHERE api_key_enc != ''")
            .execute(db)
            .await?;
        // 其余加密列一并清空(防遗漏:任何存过密文的表都必须处理)
        sqlx::query("UPDATE saved_credentials SET secret_enc = '' WHERE secret_enc != ''")
            .execute(db)
            .await?;
        sqlx::query("UPDATE mcp_servers SET env_enc = NULL WHERE env_enc IS NOT NULL")
            .execute(db)
            .await?;
        let _ = delete_from_keychain(KEYCHAIN_DATA_KEY_USER);
        log::warn!("Vault 已彻底重置,所有已存凭证已清空");
        Ok(())
    }

    /// 加密明文,返回 base64 密文
    pub fn encrypt(&self, plaintext: &[u8]) -> AppResult<String> {
        let ct = seal(&self.data_key, plaintext)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(ct))
    }

    /// 解密 base64 密文,返回明文
    pub fn decrypt(&self, ciphertext_b64: &str) -> AppResult<Vec<u8>> {
        let ct = base64::engine::general_purpose::STANDARD.decode(ciphertext_b64)
            .map_err(|_| AppError::Crypto("密文 base64 解码失败".into()))?;
        open(&self.data_key, &ct)
    }

    /// 加密字符串(便捷方法,用于凭证、API key 等)
    pub fn encrypt_str(&self, plaintext: &str) -> AppResult<String> {
        self.encrypt(plaintext.as_bytes())
    }

    /// 解密为字符串
    pub fn decrypt_str(&self, ciphertext_b64: &str) -> AppResult<String> {
        let bytes = self.decrypt(ciphertext_b64)?;
        String::from_utf8(bytes).map_err(|_| AppError::Crypto("解密结果不是合法 UTF-8".into()))
    }
}

// ==================== 内部加密原语 ====================

/// PBKDF2 派生 kek
fn derive_kek(password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut kek = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(PBKDF2_ITERATIONS).unwrap(),
        salt,
        password.as_bytes(),
        &mut kek,
    );
    kek
}

/// AES-GCM-256 加密,返回 nonce(12) + 密文 + tag(16)
fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> AppResult<Vec<u8>> {
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|e| AppError::Crypto(format!("生成 nonce 失败: {e}")))?;

    let unbound = UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|e| AppError::Crypto(format!("创建 unbound key 失败: {e}")))?;
    let sealing_key = LessSafeKey::new(unbound);

    // ring 要求就地加密,且会把 tag append 到末尾
    let mut in_out = plaintext.to_vec();
    sealing_key
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce_bytes), Aad::empty(), &mut in_out)
        .map_err(|e| AppError::Crypto(format!("加密失败: {e}")))?;

    // 输出: nonce(12) || 密文+tag
    let mut out = Vec::with_capacity(NONCE_LEN + in_out.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&in_out);
    Ok(out)
}

/// AES-GCM-256 解密,输入 nonce(12) + 密文 + tag(16)
fn open(key: &[u8; KEY_LEN], ciphertext: &[u8]) -> AppResult<Vec<u8>> {
    if ciphertext.len() < NONCE_LEN {
        return Err(AppError::Crypto("密文过短".into()));
    }
    let (nonce_bytes, ct_with_tag) = ciphertext.split_at(NONCE_LEN);
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce_bytes);

    let unbound = UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|e| AppError::Crypto(format!("创建 unbound key 失败: {e}")))?;
    let opening_key = LessSafeKey::new(unbound);

    // open_in_place 就地解密,输入含密文+tag(末尾),返回明文切片
    let mut in_out = ct_with_tag.to_vec();
    let plaintext = opening_key
        .open_in_place(Nonce::assume_unique_for_key(nonce_arr), Aad::empty(), &mut in_out)
        .map_err(|_| AppError::Crypto("解密失败(密钥错误或数据损坏)".into()))?;
    Ok(plaintext.to_vec())
}

// ==================== OS Keychain ====================

fn save_to_keychain(username: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, username)
        .map_err(|e| AppError::Keychain(format!("创建 keychain entry 失败: {e}")))?;
    entry.set_password(secret)
        .map_err(|e| AppError::Keychain(format!("写入 keychain 失败: {e}")))?;
    Ok(())
}

fn load_from_keychain(username: &str) -> AppResult<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, username)
        .map_err(|e| AppError::Keychain(format!("创建 keychain entry 失败: {e}")))?;
    entry.get_password()
        .map_err(|e| AppError::Keychain(format!("读取 keychain 失败: {e}")))
}

fn delete_from_keychain(username: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, username)
        .map_err(|e| AppError::Keychain(format!("创建 keychain entry 失败: {e}")))?;
    entry
        .delete_credential()
        .map_err(|e| AppError::Keychain(format!("删除 keychain 失败: {e}")))?;
    Ok(())
}

// ==================== 元数据持久化 ====================

async fn save_metadata(metadata: &VaultMetadata, db: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO vault_metadata (id, salt, wrapped_data_key, verifier, iterations, updated_at)
         VALUES (1, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET
            salt = excluded.salt,
            wrapped_data_key = excluded.wrapped_data_key,
            verifier = excluded.verifier,
            iterations = excluded.iterations,
            updated_at = excluded.updated_at",
    )
    .bind(&metadata.salt)
    .bind(&metadata.wrapped_data_key)
    .bind(&metadata.verifier)
    .bind(metadata.iterations)
    .execute(db)
    .await?;
    Ok(())
}

async fn load_metadata(db: &SqlitePool) -> AppResult<Option<VaultMetadata>> {
    let row = sqlx::query(
        "SELECT salt, wrapped_data_key, verifier, iterations FROM vault_metadata WHERE id = 1",
    )
    .fetch_optional(db)
    .await?;

    match row {
        Some(row) => {
            use sqlx::Row;
            Ok(Some(VaultMetadata {
                salt: row.try_get("salt")?,
                wrapped_data_key: row.try_get("wrapped_data_key")?,
                verifier: row.try_get("verifier")?,
                iterations: row.try_get("iterations")?,
            }))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = [42u8; KEY_LEN];
        let plaintext = b"hello witchcat vault secret!";
        let ct = seal(&key, plaintext).unwrap();
        let pt = open(&key, &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn wrong_key_fails() {
        let key = [42u8; KEY_LEN];
        let wrong = [99u8; KEY_LEN];
        let ct = seal(&key, b"secret").unwrap();
        assert!(open(&wrong, &ct).is_err());
    }
}
