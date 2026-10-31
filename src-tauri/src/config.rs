//! 桌面配置：<app_config_dir>/config.json

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server_url: String,
    pub token: String,
    pub machine: String,
    pub notify_desktop: bool,
    /// 远程控制密钥（和服务端 AGENTHUB_CONTROL_TOKEN 一致）
    pub control_token: String,
    /// 允许手机远程执行的项目目录（会话 cwd 必须在其中某一项之下）
    pub allowed_roots: Vec<String>,
    /// 总开关：关闭时不连服务端的执行器通道
    pub remote_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            server_url: String::new(),
            token: String::new(),
            machine: hostname(),
            notify_desktop: true,
            control_token: String::new(),
            allowed_roots: Vec::new(),
            remote_enabled: false,
        }
    }
}

pub type SharedConfig = Arc<RwLock<Config>>;

pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "my-pc".to_string())
}

pub fn load(path: &Path) -> Config {
    let mut c: Config = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if c.machine.trim().is_empty() {
        c.machine = hostname();
    }
    c
}

pub fn save(path: &Path, c: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn config_path(dir: PathBuf) -> PathBuf {
    dir.join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("agenthub-cfg-{}", std::process::id()));
        let p = config_path(dir.clone());
        let c = Config {
            server_url: "http://x".into(),
            token: "t".into(),
            machine: "m".into(),
            notify_desktop: false,
            control_token: "c".into(),
            allowed_roots: vec!["D:/Tmp".into()],
            remote_enabled: true,
        };
        save(&p, &c).unwrap();
        assert_eq!(load(&p), c);
        // 缺字段用默认值，machine 为空时回落主机名
        std::fs::write(&p, r#"{"serverUrl":"http://y","machine":""}"#).unwrap();
        let d = load(&p);
        assert_eq!(d.server_url, "http://y");
        assert!(d.notify_desktop);
        assert!(!d.remote_enabled);
        assert!(d.allowed_roots.is_empty() && d.control_token.is_empty());
        assert!(!d.machine.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
