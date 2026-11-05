//! AgentHub 自己的默认工作目录。
//!
//! 角色助手借电脑上的 CLI 当模型用，CLI 进程必须在一个真实目录里启动。
//! 与其让用户每次挑项目目录，这里给一个固定位置：<文档>/AgentHub。
//! 放在文档目录而不是 app_config_dir：卸载重装后目录还在，助手会话也就一直能用。

use std::path::{Path, PathBuf};

use crate::claude::home_dir;

/// 文档目录：Windows 上可能被 OneDrive 重定向，优先挑真实存在的那个
pub fn documents_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(one) = std::env::var_os("OneDrive") {
        candidates.push(PathBuf::from(one).join("Documents"));
    }
    candidates.push(home.join("Documents"));
    // 少数系统把「文档」放在本地化名字下
    candidates.push(home.join("文档"));
    candidates.into_iter().find(|p| p.is_dir())
}

fn ensure_under(docs: &Path) -> Result<PathBuf, String> {
    let dir = docs.join("AgentHub");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建默认工作目录失败：{}（{e}）", dir.display()))?;
    Ok(dir)
}

/// <文档>/AgentHub：不存在就建出来；返回可直接当 cwd 用的路径字符串
pub fn ensure_default() -> Result<String, String> {
    let docs = documents_dir().ok_or("找不到文档目录（Documents），没法创建默认工作目录")?;
    let dir = ensure_under(&docs)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reuses_default_dir() {
        let root = std::env::temp_dir().join(format!("agenthub-workdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = ensure_under(&root).unwrap();
        assert!(dir.is_dir());
        assert_eq!(dir.file_name().unwrap(), "AgentHub");
        // 再调一次不会报错（目录已存在）
        assert_eq!(ensure_under(&root).unwrap(), dir);
        let _ = std::fs::remove_dir_all(&root);
    }
}
