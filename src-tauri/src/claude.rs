//! Claude Code：hook JSON -> 事件，transcript 末尾取摘要，hook 安装/卸载

use crate::activity::{buckets_of, capped, tail_timestamps};
use crate::forwarder::{Bucket, Event};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// PermissionRequest hook 在客户端上等人点「拒绝 / 允许」的最长时间（秒）
pub const HOOK_WAIT_SECS: u64 = 25;
/// settings.json 里 PermissionRequest 组的 hook 超时：比等待时间多 15 秒；其它事件仍是 5 秒
const PERMISSION_HOOK_TIMEOUT: u64 = HOOK_WAIT_SECS + 15;
const DEFAULT_HOOK_TIMEOUT: u64 = 5;
/// Claude 随后发的 permission_prompt 通知只有这句通用话，会把「工具：命令」摘要覆盖掉
const GENERIC_PERMISSION_MSG: &str = "Claude needs your permission";
const PERMISSION_SUMMARY_TTL: Duration = Duration::from_secs(120);

pub const SCRIPT_NAME: &str = "agenthub-report.sh";
const SCRIPT: &str = include_str!("../resources/agenthub-report.sh");
const NOTIFY_MATCHER: &str = "permission_prompt|agent_needs_input|elicitation_dialog";
const NOTIFY_TYPES: [&str; 3] = ["permission_prompt", "agent_needs_input", "elicitation_dialog"];
const EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"];
const TAIL_BYTES: u64 = 256 * 1024;
/// 活动桶回看窗口：hook 每次触发都重扫一遍，服务端对同一桶取 GREATEST，重复上报幂等
const ACTIVITY_WINDOW_MS: i64 = 90 * 60_000;
const ACTIVITY_BYTES: u64 = 2 * 1024 * 1024;

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

/// 启动超过这个时间还没收到完成通知的后台子代理当作遗留（会话被杀、通知丢了），不再拦着「完成」
const BG_AGENT_STALE_MS: i64 = 2 * 3_600_000;

fn tag_value<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let rest = &block[block.find(&open)? + open.len()..];
    Some(rest[..rest.find(&format!("</{tag}>"))?].trim())
}

/// transcript 尾部里还有几个没回报的后台子代理。
/// 启动 = user 行的 `toolUseResult` 带 `agentId` 且 `background` / `isAsync` 为真（forked skill、异步 Agent 都是这个形状）；
/// 完成 = 后续 user 行里 `<task-notification>` 的 `<task-id>` + 终态 `<status>`。
fn count_pending_background_agents(tail: &str) -> usize {
    let now = chrono::Utc::now().timestamp_millis();
    let mut pending = std::collections::HashSet::<String>::new();
    for line in tail.lines() {
        if line.contains("<task-notification>") {
            for block in line.split("<task-notification>").skip(1) {
                let final_status = tag_value(block, "status")
                    .is_some_and(|s| matches!(s.to_lowercase().as_str(), "completed" | "failed" | "stopped" | "killed"));
                if let (true, Some(id)) = (final_status, tag_value(block, "task-id")) {
                    pending.remove(id);
                }
            }
        }
        if !line.contains("\"agentId\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(r) = v.get("toolUseResult") else { continue };
        let Some(id) = r.get("agentId").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        let bg = r.get("background").and_then(Value::as_bool) == Some(true)
            || r.get("isAsync").and_then(Value::as_bool) == Some(true)
            || r.get("status").and_then(Value::as_str) == Some("async_launched");
        let fresh = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_none_or(|t| now - t.timestamp_millis() < BG_AGENT_STALE_MS);
        if bg && fresh {
            pending.insert(id.to_string());
        }
    }
    pending.len()
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

/// 「Bash：git commit …」这样的一句话：工具名 + 命令 / 文件 / 提问
fn permission_summary(v: &Value) -> Option<String> {
    let tool = str_field(v, "tool_name")?;
    let input = v.get("tool_input");
    let detail = ["command", "file_path", "url", "pattern"]
        .iter()
        .find_map(|k| input.and_then(|i| i.get(*k)).and_then(Value::as_str))
        .or_else(|| input.and_then(|i| i.pointer("/questions/0/question")).and_then(Value::as_str));
    let text = match detail {
        Some(d) => format!("{tool}：{}", one_line(d, 200)),
        None => format!("{tool} 需要确认"),
    };
    Some(truncate_chars(&text, 300))
}

/// session_id -> (记录时间, 最近一次 PermissionRequest 的摘要)
fn recent_permissions() -> &'static Mutex<std::collections::HashMap<String, (Instant, String)>> {
    static M: OnceLock<Mutex<std::collections::HashMap<String, (Instant, String)>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn remember_permission(session_id: &str, summary: &str) {
    let mut m = recent_permissions().lock().unwrap();
    m.retain(|_, (t, _)| t.elapsed() < PERMISSION_SUMMARY_TTL);
    m.insert(session_id.to_string(), (Instant::now(), summary.to_string()));
}

fn recent_permission_summary(session_id: &str) -> Option<String> {
    let m = recent_permissions().lock().unwrap();
    m.get(session_id).filter(|(t, _)| t.elapsed() < PERMISSION_SUMMARY_TTL).map(|(_, s)| s.clone())
}

/// 可以交给客户端远程处理的权限请求：(session_id, 工具名, 详情)。
/// 提问类（AskUserQuestion、tool_input 里有 questions 数组）hook 只能回 allow/deny，答案回不去，一律不处理
pub fn permission_request(v: &Value) -> Option<(String, String, String)> {
    if str_field(v, "hook_event_name")? != "PermissionRequest" {
        return None;
    }
    let session_id = str_field(v, "session_id")?.to_string();
    let tool = str_field(v, "tool_name")?;
    let input = v.get("tool_input");
    if tool == "AskUserQuestion" || input.and_then(|i| i.get("questions")).is_some_and(Value::is_array) {
        return None;
    }
    let detail = ["command", "file_path", "url", "pattern"]
        .iter()
        .find_map(|k| input.and_then(|i| i.get(*k)).and_then(Value::as_str))
        .map(|d| one_line(d, 200))
        .or_else(|| input.filter(|i| !i.is_null()).map(|i| truncate_chars(&i.to_string(), 200)))
        .unwrap_or_default();
    Some((session_id, tool.to_string(), detail))
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
        bg_tasks: 0,
        buckets: Vec::new(),
       messages: Vec::new(),
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
            // 通用句「Claude needs your permission」不如刚才 PermissionRequest 的「工具：命令」有用
            if str_field(v, "notification_type") == Some("permission_prompt")
                && ev.summary.as_deref().is_some_and(|m| m.trim().eq_ignore_ascii_case(GENERIC_PERMISSION_MSG))
            {
                if let Some(s) = recent_permission_summary(&ev.session_id) {
                    ev.summary = Some(s);
                }
            }
        }
        // PreToolUse 的 ask、AskUserQuestion 等弹窗不一定触发 Notification，权限对话框出现时由这里接
        "PermissionRequest" => {
            ev.state = "waiting".into();
            ev.summary = permission_summary(v);
            if let Some(s) = &ev.summary {
                remember_permission(&ev.session_id, s);
            }
        }
        "Stop" => {
            let tail = str_field(v, "transcript_path").and_then(|p| read_tail(Path::new(p)));
            // 主会话这一轮结束不等于活干完了：后台子代理还没回报时仍算运行中，别标成「完成待确认」
            // （子代理完成后 CLI 会自己开下一轮，那一轮结束会再来一次 Stop）
            let pending = tail.as_deref().map_or(0, count_pending_background_agents);
            if pending > 0 {
                ev.state = "running".into();
                ev.bg_tasks = pending as u32;
            } else {
                ev.state = "done".into();
                ev.summary = str_field(v, "last_assistant_message")
                    .map(|m| truncate_chars(m.trim(), 300))
                    .or_else(|| last_assistant_text(tail.as_deref()?));
            }
        }
        "SessionEnd" => ev.state = "ended".into(),
        _ => return None,
    }
    Some(ev)
}

// ---------- hook 安装 / 卸载 ----------

/// 消息行算活动：Claude 的 transcript 里 user / assistant 行都带 timestamp
fn is_activity_line(line: &str) -> bool {
    (line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"")) && line.contains("\"timestamp\":\"")
}

/// hook 只带状态，日历要的"活动分段"得从 transcript 里取。
/// 每次 hook 触发时扫一遍文件尾部（最近 90 分钟），聚成 5 分钟桶随事件上报。
pub fn activity_buckets(v: &Value) -> Vec<Bucket> {
    let Some(path) = str_field(v, "transcript_path").filter(|p| !p.is_empty()) else { return Vec::new() };
    let since = chrono::Utc::now().timestamp_millis() - ACTIVITY_WINDOW_MS;
    let ms = tail_timestamps(Path::new(&path), ACTIVITY_BYTES, since, is_activity_line);
    capped(buckets_of(&ms))
}

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
        let want_timeout = if ev == "PermissionRequest" { PERMISSION_HOOK_TIMEOUT } else { DEFAULT_HOOK_TIMEOUT };
        if arr.iter().any(is_ours) {
            // 老版本装的 PermissionRequest 组 timeout 是 5，阻塞等人时会被提前杀掉：升级时改大（别的事件不动）
            if ev == "PermissionRequest" {
                for g in arr.iter_mut().filter(|g| is_ours(g)) {
                    let Some(list) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) else { continue };
                    for h in list.iter_mut() {
                        let ours = h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(SCRIPT_NAME));
                        if ours && h.get("timeout").and_then(Value::as_u64) != Some(want_timeout) {
                            h["timeout"] = json!(want_timeout);
                            changed = true;
                        }
                    }
                }
            }
            continue;
        }
        let mut group = Map::new();
        if ev == "Notification" {
            group.insert("matcher".into(), json!(NOTIFY_MATCHER));
        }
        group.insert(
            "hooks".into(),
            json!([{ "type": "command", "command": format!("bash ~/.claude/hooks/{SCRIPT_NAME}"), "timeout": want_timeout }]),
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

        let e = hook_to_event(&base("PermissionRequest", r#","tool_name":"Bash","tool_input":{"command":"git commit -m x"}"#), None).unwrap();
        assert_eq!((e.state.as_str(), e.summary.as_deref()), ("waiting", Some("Bash：git commit -m x")));

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

    #[test]
    fn hook_carries_recent_activity_from_transcript() {
        let now = chrono::Utc::now();
        let ts = |mins: i64| (now - chrono::Duration::minutes(mins)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let dir = std::env::temp_dir().join(format!("agenthub-act-hook-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let body = [
            format!(r#"{{"type":"user","timestamp":"{}","message":{{"content":"旧问题"}}}}"#, ts(180)),
            format!(r#"{{"type":"assistant","timestamp":"{}","message":{{"content":[{{"type":"text","text":"答"}}]}}}}"#, ts(3)),
            format!(r#"{{"type":"user","timestamp":"{}","message":{{"content":"追问"}}}}"#, ts(1)),
        ]
        .join("\n");
        std::fs::write(&p, body).unwrap();
        let v = json!({"hook_event_name":"UserPromptSubmit","session_id":"s","transcript_path":p.to_string_lossy()});
        // 90 分钟窗口外的活动不算，窗口内的两条落进桶里
        assert_eq!(activity_buckets(&v).iter().map(|b| b.count).sum::<u32>(), 2);
        // 没有 transcript_path 时不报错，也不上报
        assert!(activity_buckets(&json!({"hook_event_name":"UserPromptSubmit"})).is_empty());
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
    fn install_upgrades_permission_request_timeout_only() {
        let dir = std::env::temp_dir().join(format!("agenthub-inst3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let hooks_dir = dir.join("hooks");
        std::fs::write(&settings, ORIGINAL).unwrap();
        let original = parse(ORIGINAL);
        assert!(install_hooks(&settings, &hooks_dir).unwrap());
        let fresh = parse(&std::fs::read_to_string(&settings).unwrap());
        assert_eq!(fresh["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], PERMISSION_HOOK_TIMEOUT);
        assert_eq!(fresh["hooks"]["Stop"][1]["hooks"][0]["timeout"], 5);

        // 模拟老版本：PermissionRequest 的 timeout 还是 5
        let mut old = fresh.clone();
        old["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] = json!(5);
        std::fs::write(&settings, serde_json::to_string_pretty(&old).unwrap()).unwrap();
        assert!(install_hooks(&settings, &hooks_dir).unwrap(), "timeout 升级算改动");
        let after = parse(&std::fs::read_to_string(&settings).unwrap());
        assert_eq!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], PERMISSION_HOOK_TIMEOUT);
        assert_eq!(after, fresh, "只改了 PermissionRequest 的 timeout，其它原样");
        assert_eq!(after["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"]);
        assert_eq!(after["hooks"]["Notification"][0], original["hooks"]["Notification"][0]);
        assert!(!install_hooks(&settings, &hooks_dir).unwrap(), "再装一次不再改动");

        assert!(uninstall_hooks(&settings, &hooks_dir).unwrap());
        assert_eq!(parse(&std::fs::read_to_string(&settings).unwrap()), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn permission_notification_keeps_specific_summary() {
        let req = parse(r#"{"hook_event_name":"PermissionRequest","session_id":"sum-1","tool_name":"Bash","tool_input":{"command":"rm -rf x"}}"#);
        let note = |sid: &str, msg: &str| {
            parse(&format!(r#"{{"hook_event_name":"Notification","session_id":"{sid}","notification_type":"permission_prompt","message":"{msg}"}}"#))
        };
        assert!(hook_to_event(&req, None).is_some());
        let e = hook_to_event(&note("sum-1", "claude needs your permission"), None).unwrap();
        assert_eq!(e.summary.as_deref(), Some("Bash：rm -rf x"), "通用句被最近的 PermissionRequest 摘要代替");
        let e = hook_to_event(&note("sum-1", "要运行 rm"), None).unwrap();
        assert_eq!(e.summary.as_deref(), Some("要运行 rm"), "具体的 message 不动");
        let e = hook_to_event(&note("sum-other", "Claude needs your permission"), None).unwrap();
        assert_eq!(e.summary.as_deref(), Some("Claude needs your permission"), "没有记录就保留原 message");
    }

    #[test]
    fn permission_request_skips_questions() {
        let p = |s: &str| permission_request(&parse(s));
        let (sid, tool, detail) = p(r#"{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"Bash","tool_input":{"command":"git  push"}}"#).unwrap();
        assert_eq!((sid.as_str(), tool.as_str(), detail.as_str()), ("s1", "Bash", "git push"));
        assert!(p(r#"{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"a"}]}}"#).is_none());
        assert!(p(r#"{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"Other","tool_input":{"questions":[]}}"#).is_none());
        assert!(p(r#"{"hook_event_name":"Stop","session_id":"s1"}"#).is_none());
        assert!(p(r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#).is_none());
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

    fn launch_line(ts: &str, id: &str) -> String {
        format!(r#"{{"type":"user","timestamp":"{ts}","message":{{"content":[{{"type":"tool_result","content":"launched"}}]}},"toolUseResult":{{"status":"forked","background":true,"agentId":"{id}"}}}}"#)
    }

    fn notice_line(id: &str, status: &str) -> String {
        format!(r#"{{"type":"user","message":{{"content":"<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n</task-notification>"}}}}"#)
    }

    #[test]
    fn stop_with_running_background_agent_stays_running() {
        let now = chrono::Utc::now();
        let ts = |mins: i64| (now - chrono::Duration::minutes(mins)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let tail = |lines: &[String]| lines.join("\n");
        // 刚放出去、还没回报
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(1), "a1")])), 1);
        // 回报了 -> 不再算
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(5), "a1"), notice_line("a1", "completed")])), 0);
        // 两个任务只回报一个
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(5), "a1"), launch_line(&ts(4), "a2"), notice_line("a1", "completed")])), 1);
        // 两个都没回报
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(5), "a1"), launch_line(&ts(4), "a2")])), 2);
        // 非终态通知不算回报
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(5), "a1"), notice_line("a1", "running")])), 1);
        // 前台工具结果（没有 background）不算
        assert_eq!(count_pending_background_agents(r#"{"type":"user","toolUseResult":{"agentId":"x","status":"completed"}}"#), 0);
        // 遗留的老任务不拦着完成
        assert_eq!(count_pending_background_agents(&tail(&[launch_line(&ts(300), "old")])), 0);

        let dir = std::env::temp_dir().join(format!("agenthub-bg-stop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let assistant = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"已交给子代理"}]}}"#.to_string();
        let hook = |p: &Path| json!({"hook_event_name":"Stop","session_id":"s","transcript_path":p.to_string_lossy()});

        std::fs::write(&p, tail(&[launch_line(&ts(1), "a1"), assistant.clone()])).unwrap();
        let e = hook_to_event(&hook(&p), None).unwrap();
        assert_eq!(e.state, "running");
        assert_eq!(e.bg_tasks, 1);
        assert!(e.summary.is_none());

        std::fs::write(&p, tail(&[launch_line(&ts(2), "a1"), launch_line(&ts(1), "a2"), assistant.clone()])).unwrap();
        let e = hook_to_event(&hook(&p), None).unwrap();
        assert_eq!((e.state.as_str(), e.bg_tasks), ("running", 2));

        std::fs::write(&p, tail(&[launch_line(&ts(3), "a1"), notice_line("a1", "completed"), assistant])).unwrap();
        let e = hook_to_event(&hook(&p), None).unwrap();
        assert_eq!(e.state, "done");
        assert_eq!(e.bg_tasks, 0);
        assert_eq!(e.summary.as_deref(), Some("已交给子代理"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
