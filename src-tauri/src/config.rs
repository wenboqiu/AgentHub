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
    /// 登录的邮箱（只用于显示；token 是登录后拿到的设备会话 token）
    pub email: String,
    /// 项目目录白名单（可选）：为空表示不限制目录；非空时会话 cwd 必须在其中某一项之下
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
            email: String::new(),
            allowed_roots: Vec::new(),
            remote_enabled: false,
        }
    }
}

pub type SharedConfig = Arc<RwLock<Config>>;

/// 登录失效（401 / 关闭码 4401）的提示文案
pub const AUTH_EXPIRED: &str = "登录已过期，请重新登录";

/// 收到 401 后记下失败的 token，在 token 变化（重新登录）之前不再发请求 / 重连
#[derive(Default, Debug)]
pub struct TokenBlock(Option<String>);

impl TokenBlock {
    pub fn set(&mut self, token: &str) {
        self.0 = Some(token.to_string());
    }
    pub fn is_set(&self) -> bool {
        self.0.is_some()
    }
    /// 这个 token 是否仍被拦住；token 变了就自动解除
    pub fn blocked(&mut self, token: &str) -> bool {
        match &self.0 {
            Some(b) if b == token => true,
            Some(_) => {
                self.0 = None;
                false
            }
            None => false,
        }
    }
}

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
            email: "a@b.c".into(),
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
        assert!(d.allowed_roots.is_empty() && d.email.is_empty());
        assert!(!d.machine.is_empty());
        // 旧版配置里的 controlToken 等多余字段直接忽略
        std::fs::write(&p, r#"{"serverUrl":"http://z","token":"t","controlToken":"old"}"#).unwrap();
        let o = load(&p);
        assert_eq!((o.server_url.as_str(), o.token.as_str()), ("http://z", "t"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn token_block_clears_when_token_changes() {
        let mut b = TokenBlock::default();
        assert!(!b.blocked("a"));
        b.set("a");
        assert!(b.is_set());
        assert!(b.blocked("a"));
        assert!(b.blocked("a"));
        assert!(!b.blocked("b"), "token 变了就恢复");
        assert!(!b.is_set());
        assert!(!b.blocked("a"));
    }
}
