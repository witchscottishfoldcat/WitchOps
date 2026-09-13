//! 应用更新检查(对接 GitHub Releases)
//!
//! 版本比较逻辑纯函数化并带单元测试;网络请求走 reqwest(10s 超时),
//! GitHub API 要求 User-Agent。仅读公开 releases 接口,无需凭证。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const RELEASES_API_URL: &str =
    "https://api.github.com/repos/witchscottishfoldcat/WitchOps/releases/latest";

/// 更新检查结果(前端展示用)
#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_tag: String,
    pub latest_version: String,
    pub release_url: String,
    pub published_at: Option<String>,
    pub update_available: bool,
}

/// GitHub Releases latest 接口返回体(只取需要的字段)
#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
}

/// 解析版本号为 (major, minor, patch)。
/// 容忍 `v` 前缀与 1~3 段数字(`0.1` 等价 `0.1.0`);
/// 存在但非数字的段视为非法(如 `0.1.x`),超过 3 段也非法。
fn parse_version(tag: &str) -> Option<(u64, u64, u64)> {
    let raw = tag.trim().strip_prefix(['v', 'V']).unwrap_or(tag.trim());
    let mut it = raw.split('.');
    let mut nums = [0u64; 3];
    for (i, slot) in nums.iter_mut().enumerate() {
        match it.next() {
            Some(part) => *slot = part.parse::<u64>().ok()?,
            None if i > 0 => break, // 段数不足,后续补 0
            None => return None,    // 空串
        }
    }
    if it.next().is_some() {
        return None; // 超过 3 段
    }
    Some((nums[0], nums[1], nums[2]))
}

/// 检查 GitHub Releases 是否有新版本。
/// 手动触发(设置页"检查更新"按钮),不做后台轮询。
#[tauri::command]
pub async fn check_app_update() -> AppResult<UpdateCheckResult> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Internal(format!("构建 HTTP 客户端失败: {e}")))?;

    let resp = client
        .get(RELEASES_API_URL)
        .header("User-Agent", format!("WitchcatOps/{}", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("请求 GitHub Releases 失败: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "GitHub API 返回 {}(可能是限流,稍后再试)",
            resp.status()
        )));
    }

    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("解析 GitHub 响应失败: {e}")))?;

    // 发布页 URL 只信任本仓库域,防止异常响应注入外部跳转
    if !release.html_url.starts_with("https://github.com/witchscottishfoldcat/WitchOps/") {
        return Err(AppError::Internal("GitHub 返回的发布页地址异常".into()));
    }

    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();

    let update_available = match (parse_version(&current), parse_version(&latest)) {
        (Some(cur), Some(new)) => new > cur,
        // 版本号不规范时不误报,按"无更新"处理并原样展示
        _ => false,
    };

    Ok(UpdateCheckResult {
        current_version: current,
        latest_tag: release.tag_name,
        latest_version: latest,
        release_url: release.html_url,
        published_at: release.published_at,
        update_available,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_handles_common_forms() {
        assert_eq!(parse_version("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("v0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_version("V1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("0.1"), Some((0, 1, 0)));
        assert_eq!(parse_version("2"), Some((2, 0, 0)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("0.1.x"), None);
        assert_eq!(parse_version("0.1.0.1"), None);
    }

    #[test]
    fn newer_version_detected() {
        let cur = parse_version("0.1.0").unwrap();
        assert!(parse_version("0.1.1").unwrap() > cur);
        assert!(parse_version("0.2.0").unwrap() > cur);
        assert!(parse_version("v1.0.0").unwrap() > cur);
        assert!(!(parse_version("0.1.0").unwrap() > cur));
        assert!(!(parse_version("0.0.9").unwrap() > cur));
    }

    /// 实网冒烟:真实调用 GitHub API(手动 `cargo test -- --ignored`)
    #[tokio::test]
    #[ignore = "访问真实 GitHub API,仅在需要联网冒烟时运行"]
    async fn live_check_against_github() {
        let r = check_app_update().await.expect("live check failed");
        assert!(r.release_url.starts_with("https://github.com/"));
        assert_eq!(r.current_version, env!("CARGO_PKG_VERSION"));
        // 当前仓库最新 release 即 v0.1.0,应判定为无更新
        assert!(!r.update_available, "unexpected: {r:?}");
    }
}
