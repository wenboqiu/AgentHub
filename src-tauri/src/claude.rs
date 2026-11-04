//! Claude Code：hook JSON -> 事件，transcript 末尾取摘要，hook 安装/卸载

use crate::forwarder::Event;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const SCRIPT_NAME: &str = "agenthub-report.sh";
const SCRIPT: &str = include_str!("../resources/agenthub-report.sh");
const NOTIFY_MATCHER: &str = "permission_prompt|agent_needs_input|elicitation_dialog";
const NOTIFY_TYPES: [&str; 3] = ["permission_prompt", "agent_needs_input", "elicitation_dialog"];
const EVENTS: [&str; 5] = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
const TAIL_BYTES: u64 = 256 * 1024;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn one_line(s: &str, n: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&flat, n)
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

/// 取 transcript 最后一个含 text 段的 assistant 行，text 段拼接后截断到 300 字符
pub fn last_assistant_text(transcript_tail: &str) -> Option<String> {
    for line in transcript_tail.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(parts) = v.pointer("/message/content").and_then(|c| c.as_array()) else { continue };
        let text: Vec<&str> = parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect();
        if text.is_empty() {
            continue;
        }
        let joined = text.join("\n");
        if joined.trim().is_empty() {
            continue;
        }
        return Some(truncate_chars(joined.trim(), 300));
    }
    None
}

/// 只读文件末尾 256KB；不是从头读时丢掉第一个不完整的行
fn read_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        return text.split_once('\n').map(|(_, rest)| rest.to_string());
    }
    Some(text)
}

pub fn hook_to_event(v: &Value, pid: Option<u32>) -> Option<Event> {
    let session_id = str_field(v, "session_id")?.to_string();
    let name = str_field(v, "hook_event_name")?;
    let cwd = str_field(v, "cwd").unwrap_or("").to_string();
    let mut ev = Event {
        agent: "claude".into(),
        session_id,
        machine: String::new(),
        cwd,
        state: String::new(),
        at: now_iso(),
        title: None,
        summary: None,
        pid: pid.filter(|p| *p > 0),
        quiet: false,
        buckets: Vec::new(),
    };
    match name {
        "SessionStart" => ev.state = "idle".into(),
        "UserPromptSubmit" => {
            ev.state = "running".into();
            ev.title = str_field(v, "prompt").map(|p| one_line(p, 80)).filter(|t| !t.is_empty());
        }
        "Notification" => {
            // idle_prompt 等类型不接；没带 notification_type（旧版本）时信任 settings 里的 matcher
            if let Some(t) = str_field(v, "notification_type") {
                if !NOTIFY_TYPES.contains(&t) {
                    return None;
                }
            }
            ev.state = "waiting".into();
            ev.summary = str_field(v, "message").map(|m| truncate_chars(m, 300));
        }
        "Stop" => {
            ev.state = "done".into();
            ev.summary = str_field(v, "last_assistant_message")
                .map(|m| truncate_chars(m.trim(), 300))
                .or_else(|| {
                    let path = str_field(v, "transcript_path")?;
                    last_assistant_text(&read_tail(Path::new(path))?)
                });
        }
        "SessionEnd" => ev.state = "ended".into(),
        _ => return None,
    }
    Some(ev)
}

// ---------- hook 安装 / 卸载 ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    pub installed: bool,
    pub script_exists: bool,
    pub settings_exists: bool,
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

pub fn default_settings_path() -> Result<PathBuf, String> {
    Ok(home_dir().ok_or("找不到用户目录")?.join(".claude").join("settings.json"))
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|a| a.iter().any(|h| h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(SCRIPT_NAME))))
        .unwrap_or(false)
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("settings.json 解析失败：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("读取 settings.json 失败：{e}")),
    }
}

fn write_settings(path: &Path, v: &Value) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| format!("写 settings.json 失败：{e}"))
}

/// 已安装过上报脚本时，启动时把它更新成本版本内置的内容（升级后不用重新点安装）
pub fn refresh_script(hooks_dir: &Path) {
    let path = hooks_dir.join(SCRIPT_NAME);
    let want = SCRIPT.replace("
", "
");
    if std::fs::read_to_string(&path).is_ok_and(|cur| cur != want) {
        let _ = std::fs::write(&path, want);
    }
}

/// 把上报脚本写到 hooks_dir，并向 settings 追加 hook（幂等）。返回是否改动了 settings
pub fn install_hooks(settings: &Path, hooks_dir: &Path) -> Result<bool, String> {
    std::fs::create_dir_all(hooks_dir).map_err(|e| format!("创建 hooks 目录失败：{e}"))?;
    // 用 LF 行尾写，避免 CRLF 让 bash 报错
    std::fs::write(hooks_dir.join(SCRIPT_NAME), SCRIPT.replace("\r\n", "\n")).map_err(|e| format!("写上报脚本失败：{e}"))?;

    let mut root = read_settings(settings)?;
    let obj = root.as_object_mut().ok_or("settings.json 顶层不是对象")?;
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("settings.json 的 hooks 不是对象")?;

    let mut changed = false;
    for ev in EVENTS {
        let arr = hooks.entry(ev).or_insert_with(|| Value::Array(vec![]));
        let arr = arr.as_array_mut().ok_or_else(|| format!("hooks.{ev} 不是数组"))?;
        if arr.iter().any(is_ours) {
            continue;
        }
        let mut group = Map::new();
        if ev == "Notification" {
            group.insert("matcher".into(), json!(NOTIFY_MATCHER));
        }
        group.insert(
            "hooks".into(),
            json!([{ "type": "command", "command": format!("bash ~/.claude/hooks/{SCRIPT_NAME}"), "timeout": 5 }]),
        );
        arr.push(Value::Object(group));
        changed = true;
    }
    if changed {
        if settings.exists() {
            let mut bak = settings.as_os_str().to_owned();
            bak.push(".agenthub-bak");
            std::fs::copy(settings, PathBuf::from(bak)).map_err(|e| format!("备份 settings.json 失败：{e}"))?;
        } else if let Some(dir) = settings.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        write_settings(settings, &root)?;
    }
    Ok(changed)
}

/// 只删本程序安装的条目；删完为空的组和事件键一并删掉。返回是否改动了 settings
pub fn uninstall_hooks(settings: &Path, hooks_dir: &Path) -> Result<bool, String> {
    let _ = std::fs::remove_file(hooks_dir.join(SCRIPT_NAME));
    if !settings.exists() {
        return Ok(false);
    }
    let mut root = read_settings(settings)?;
    let mut changed = false;
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let keys: Vec<String> = hooks.keys().cloned().collect();
        for k in keys {
            let Some(arr) = hooks.get_mut(&k).and_then(|a| a.as_array_mut()) else { continue };
            let before = arr.len();
            let mut touched = false;
            for g in arr.iter_mut() {
                if !is_ours(g) {
                    continue;
                }
                if let Some(list) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    list.retain(|h| !h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(SCRIPT_NAME)));
                    touched = true;
                }
            }
            if touched {
                arr.retain(|g| g.get("hooks").and_then(|h| h.as_array()).is_some_and(|l| !l.is_empty()));
                changed = true;
            }
            if touched && arr.is_empty() {
                hooks.shift_remove(&k);
            } else if arr.len() != before {
                changed = true;
            }
        }
    }
    if changed {
        write_settings(settings, &root)?;
    }
    Ok(changed)
}

pub fn hooks_status(settings: &Path, hooks_dir: &Path) -> HooksStatus {
    let root = read_settings(settings).unwrap_or(Value::Null);
    let installed = EVENTS.iter().all(|ev| {
        root.pointer(&format!("/hooks/{ev}"))
            .and_then(|a| a.as_array())
            .is_some_and(|a| a.iter().any(is_ours))
    });
    HooksStatus { installed, script_exists: hooks_dir.join(SCRIPT_NAME).exists(), settings_exists: settings.exists() }
}

pub fn default_hooks_dir() -> Result<PathBuf, String> {
    Ok(home_dir().ok_or("找不到用户目录")?.join(".claude").join("hooks"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn maps_five_hook_events() {
        let base = |name: &str, extra: &str| {
            parse(&format!(r#"{{"hook_event_name":"{name}","session_id":"s1","cwd":"D:\\Work2\\Demo"{extra}}}"#))
        };
        let e = hook_to_event(&base("SessionStart", ""), Some(42)).unwrap();
        assert_eq!((e.state.as_str(), e.pid, e.agent.as_str()), ("idle", Some(42), "claude"));

        let e = hook_to_event(&base("UserPromptSubmit", r#","prompt":"帮我\n  写个   测试""#), None).unwrap();
        assert_eq!(e.state, "running");
        assert_eq!(e.title.as_deref(), Some("帮我 写个 测试"));

        let long = "字".repeat(200);
        let e = hook_to_event(&base("UserPromptSubmit", &format!(r#","prompt":"{long}""#)), None).unwrap();
        assert_eq!(e.title.unwrap().chars().count(), 80);

        let e = hook_to_event(&base("Notification", r#","notification_type":"permission_prompt","message":"要运行 rm""#), None).unwrap();
        assert_eq!((e.state.as_str(), e.summary.as_deref()), ("waiting", Some("要运行 rm")));

        let e = hook_to_event(&base("Stop", r#","last_assistant_message":"做完了""#), None).unwrap();
        assert_eq!((e.state.as_str(), e.summary.as_deref()), ("done", Some("做完了")));

        let e = hook_to_event(&base("SessionEnd", ""), None).unwrap();
        assert_eq!(e.state, "ended");
        assert!(hook_to_event(&base("PreToolUse", ""), None).is_none());
        assert!(hook_to_event(&parse(r#"{"hook_event_name":"Stop"}"#), None).is_none());
    }

    #[test]
    fn idle_prompt_is_ignored() {
        let v = parse(r#"{"hook_event_name":"Notification","session_id":"s","notification_type":"idle_prompt","message":"x"}"#);
        assert!(hook_to_event(&v, None).is_none());
    }

    #[test]
    fn stop_reads_last_assistant_text_from_transcript() {
        let long = "长".repeat(400);
        let transcript = [
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"第一条"}]}}"#.to_string(),
            format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}},{{"type":"tool_use","name":"Bash","input":{{}}}}]}}}}"#),
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#.to_string(),
        ]
        .join("\n");
        let t = last_assistant_text(&transcript).unwrap();
        assert_eq!(t.chars().count(), 300);
        assert!(t.starts_with("长"));

        let dir = std::env::temp_dir().join(format!("agenthub-tr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, &transcript).unwrap();
        let v = json!({"hook_event_name":"Stop","session_id":"s","transcript_path":p.to_string_lossy()});
        let e = hook_to_event(&v, None).unwrap();
        assert_eq!(e.summary.unwrap().chars().count(), 300);
        let _ = std::fs::remove_dir_all(dir);
    }

    const ORIGINAL: &str = r#"{
  "model": "opus",
  "hooks": {
    "Notification": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/notify.sh" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/pre.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/mine.sh" } ] }
    ]
  },
  "other": [1, 2, 3]
}"#;

    #[test]
    fn install_twice_appends_once_and_uninstall_restores() {
        let dir = std::env::temp_dir().join(format!("agenthub-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let hooks_dir = dir.join("hooks");
        std::fs::write(&settings, ORIGINAL).unwrap();
        let original = parse(ORIGINAL);

        assert!(install_hooks(&settings, &hooks_dir).unwrap());
        assert!(!install_hooks(&settings, &hooks_dir).unwrap());
        let bak = dir.join("settings.json.agenthub-bak");
        assert_eq!(parse(&std::fs::read_to_string(&bak).unwrap()), original);
        let script = std::fs::read(hooks_dir.join(SCRIPT_NAME)).unwrap();
        assert!(!script.contains(&b'\r'));

        let after = parse(&std::fs::read_to_string(&settings).unwrap());
        for ev in EVENTS {
            let n = after["hooks"][ev].as_array().unwrap().iter().filter(|g| is_ours(g)).count();
            assert_eq!(n, 1, "{ev}");
        }
        // 其它 hooks 原样保留
        assert_eq!(after["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"]);
        assert_eq!(after["hooks"]["Notification"][0], original["hooks"]["Notification"][0]);
        assert_eq!(after["hooks"]["Notification"][1]["matcher"], NOTIFY_MATCHER);
        assert_eq!(after["other"], original["other"]);
        assert!(hooks_status(&settings, &hooks_dir).installed);

        assert!(uninstall_hooks(&settings, &hooks_dir).unwrap());
        let restored = parse(&std::fs::read_to_string(&settings).unwrap());
        assert_eq!(restored, original);
        assert!(!hooks_status(&settings, &hooks_dir).installed);
        assert!(!hooks_dir.join(SCRIPT_NAME).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn install_creates_missing_settings() {
        let dir = std::env::temp_dir().join(format!("agenthub-inst2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let settings = dir.join("sub").join("settings.json");
        assert!(install_hooks(&settings, &dir.join("hooks")).unwrap());
        assert!(hooks_status(&settings, &dir.join("hooks")).installed);
        let _ = std::fs::remove_dir_all(dir);
    }
}
