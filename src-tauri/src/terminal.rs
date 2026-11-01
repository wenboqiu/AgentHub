//! 「在终端打开」：Claude 会话在原目录新开一个 Windows Terminal 跑 `claude --resume <id>`，
//! 已经在终端里开着就切过去；Codex 会话把 Codex Desktop 切到前台。
//!
//! 命令行用纯函数构建并有单测；调用时逐个传参，不拼 shell 字符串。

use crate::runner::{claude_open_entries, valid_key};

/// 目录里的 `;`（wt 命令行的分隔符）和 `"` 都不允许
fn valid_cwd_text(cwd: &str) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Err("没有项目目录".into());
    }
    if cwd.contains(';') || cwd.contains('"') {
        return Err("项目目录里含有 ; 或 \"，不能在终端打开".into());
    }
    Ok(())
}

/// (程序, 参数)：`wt.exe -d <cwd> claude --resume <key>`
pub fn wt_command(cwd: &str, key: &str) -> Result<(String, Vec<String>), String> {
    if !valid_key(key) {
        return Err("会话 id 格式不对".into());
    }
    valid_cwd_text(cwd)?;
    Ok(("wt.exe".into(), ["-d", cwd, "claude", "--resume", key].iter().map(|s| s.to_string()).collect()))
}

/// wt 启动失败时的回退：`cmd.exe /c start "AgentHub" /D <cwd> cmd /k claude --resume <key>`
pub fn fallback_command(cwd: &str, key: &str) -> Result<(String, Vec<String>), String> {
    if !valid_key(key) {
        return Err("会话 id 格式不对".into());
    }
    valid_cwd_text(cwd)?;
    Ok((
        "cmd.exe".into(),
        ["/c", "start", "AgentHub", "/D", cwd, "cmd", "/k", "claude", "--resume", key].iter().map(|s| s.to_string()).collect(),
    ))
}

#[cfg(windows)]
pub fn open_in_terminal(agent: &str, session_key: &str, cwd: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    match agent {
        "codex" => {
            crate::focus::focus_session(None, "codex")?;
            Ok("已切到 Codex Desktop，请在左侧列表里打开这个会话".into())
        }
        "claude" => {
            if !valid_key(session_key) {
                return Err("会话 id 格式不对".into());
            }
            if !std::path::Path::new(cwd).is_dir() {
                return Err(format!("项目目录不存在：{cwd}"));
            }
            // 先校验命令行（含 ; 和 " 的拒绝），再去查终端里有没有开着
            let (prog, args) = wt_command(cwd, session_key)?;
            if let Some((_, pid)) = claude_open_entries()?.into_iter().find(|(id, _)| id == session_key) {
                crate::focus::focus_session(pid, "claude")?;
                return Ok("这个会话已经在终端里开着，已切换过去".into());
            }
            // 要显示窗口，不加 CREATE_NO_WINDOW
            if Command::new(&prog).args(&args).spawn().is_ok() {
                return Ok("已在终端打开".into());
            }
            let (prog, args) = fallback_command(cwd, session_key)?;
            // 外层 cmd 自己不要弹黑窗；`start` 会另开一个窗口
            Command::new(prog).args(args).creation_flags(0x0800_0000).spawn().map_err(|e| format!("打开终端失败：{e}"))?;
            Ok("已在终端打开".into())
        }
        other => Err(format!("不认识的 agent：{other}")),
    }
}

#[cfg(not(windows))]
pub fn open_in_terminal(_agent: &str, _session_key: &str, _cwd: &str) -> Result<String, String> {
    Err("目前只支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wt_args() {
        let (p, a) = wt_command("D:\\Work2\\My App", "abc-1_2").unwrap();
        assert_eq!(p, "wt.exe");
        assert_eq!(a, vec!["-d", "D:\\Work2\\My App", "claude", "--resume", "abc-1_2"]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(wt_command("D:\\a", "").is_err());
        assert!(wt_command("D:\\a", "a b").is_err());
        assert!(wt_command("D:\\a", "..\\x").is_err());
        assert!(wt_command("D:\\a;calc", "k").is_err(), "分号会被 wt 当成分隔符");
        assert!(wt_command("D:\\a\"b", "k").is_err());
        assert!(wt_command("", "k").is_err());
        assert!(fallback_command("D:\\a;x", "k").is_err());
        assert!(fallback_command("D:\\a\"x", "k").is_err());
        assert!(fallback_command("D:\\a", "bad key").is_err());
    }

    #[test]
    fn fallback_args() {
        let (p, a) = fallback_command("D:\\Work2\\x", "k1").unwrap();
        assert_eq!(p, "cmd.exe");
        assert_eq!(a, vec!["/c", "start", "AgentHub", "/D", "D:\\Work2\\x", "cmd", "/k", "claude", "--resume", "k1"]);
    }
}
