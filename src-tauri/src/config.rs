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
    /// 项目目录黑名单（可选）：为空表示不限制目录；非空时会话 cwd 落在其中某一项之下（含该项本身）就拒绝执行
    /// 旧版这里是 allowedRoots 白名单，语义相反，因此不兼容旧键：老配置读进来等于「黑名单为空」，
    /// 不会因为升级就把原来的工作目录全部封掉。
    pub denied_roots: Vec<String>,
    /// 总开关：关闭时不连服务端的执行器通道
    pub remote_enabled: bool,
    /// 对话页（待处理 / 进行中）用气泡图展示；false = 卡片列表
    pub graph_mode: bool,
    /// ZCode 权限请求的自动放行档位：off = 每条都弹审批卡；low = 只放行 low；
    /// medium = low 与 medium 都放行。high / critical 永远弹卡，riskLevel 缺失也不放。
    pub zcode_auto_approve: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            server_url: String::new(),
            token: String::new(),
            machine: hostname(),
            notify_desktop: true,
            email: String::new(),
            denied_roots: Vec::new(),
            remote_enabled: false,
            graph_mode: true,
            zcode_auto_approve: "low".into(),
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

/// 老版本兜底出来的名字：读不到主机名时写死成 "my-pc"，界面上看着像一台陌生电脑。
/// 升级后遇到这些名字就换回系统里的真名，并把服务端记在旧名下的记录一起改名（见 machines.rs）。
pub const LEGACY_NAMES: [&str; 3] = ["my-pc", "my pc", "unknown"];

/// 这个机器名是不是老版本兜底出来的占位名（空字符串也算）
pub fn is_legacy_name(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    n.is_empty() || LEGACY_NAMES.contains(&n.as_str())
}

/// 本机名：先看环境变量，再问系统。
/// macOS 从访达 / LaunchAgent 启动时没有 HOSTNAME，所以必须问系统，
/// 用 `scutil --get ComputerName`（就是访达「共享」里显示的名字，例如「wenboqiu's Mac mini」）。
pub fn hostname() -> String {
    let env = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    env.or_else(system_hostname).unwrap_or_else(|| "这台电脑".to_string())
}

fn system_hostname() -> Option<String> {
    // macOS：和朋友在访达里看到的一致，带空格和撇号也没关系（上报时会 URL 编码）
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    // 其余系统：hostname 命令到处都有，省得为一件事加依赖
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("hostname").output().ok()?;
        let mut s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // macOS 回的是 "wenboqius-Mac-mini.local"，去掉尾缀才像台自己的电脑
        if let Some(t) = s.strip_suffix(".local").map(str::to_string) {
            s = t;
        }
        return (!s.is_empty()).then_some(s);
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("hostname").output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    }
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
            denied_roots: vec!["D:/Tmp".into()],
            remote_enabled: true,
            graph_mode: true,
            zcode_auto_approve: "medium".into(),
        };
        save(&p, &c).unwrap();
        assert_eq!(load(&p), c);
        // 缺字段用默认值，machine 为空时回落主机名
        std::fs::write(&p, r#"{"serverUrl":"http://y","machine":""}"#).unwrap();
        let d = load(&p);
        assert_eq!(d.server_url, "http://y");
        assert!(d.notify_desktop);
        assert!(!d.remote_enabled);
        // 气泡图是默认展示方式：老配置里没有 graphMode 时按 true 读
        assert!(d.graph_mode);
        assert_eq!(d.zcode_auto_approve, "low", "老配置里没有这个键时按 low 读");
        assert!(d.denied_roots.is_empty() && d.email.is_empty());
        // 旧配置的 allowedRoots（白名单）不会被当成黑名单读进来，避免升级后把工作目录封死
        std::fs::write(&p, r#"{"serverUrl":"http://w","allowedRoots":["D:/Work2"]}"#).unwrap();
        assert!(load(&p).denied_roots.is_empty());
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
