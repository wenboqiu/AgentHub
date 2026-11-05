//! Read-only adapter for ZCode (Z.ai)'s local session files.
//!
//! Path: `%USERPROFILE%\.zcode\v2\sessions\<workspace hash>\sess_<uuid>.json`, one complete JSON per session:
//! `meta`（taskId / title / workspacePath / createdAt / updatedAt / status）+ `messages`（role / content / timestamp）。
//!
//! ZCode has no hook, nor a callable CLI/IPC, so we can only read the session files:
//! - `meta.status` is maintained by ZCode itself and is the authoritative state, unlike WorkBuddy, no silent-window inference needed;
//! - State mapping: running→running, completed→done, error→aborted;
//! - Therefore this module only does state and message metadata listening, and does not participate in remote execution.

use crate::{
    activity::buckets_of,
    claude::{home_dir, now_iso, truncate_chars},
    forwarder::{Event, Forwarder},
};
use chrono::TimeZone;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// 只跟踪最近改过的文件（更早的会话不再登记）
const RECENT: Duration = Duration::from_secs(3 * 86400);
/// 最后更新早于这个窗口的会话不回填（旧历史）
const BACKFILL_MS: i64 = 7 * 86400 * 1000;

/// meta.status mapped to AgentHub state
fn map_status(s: &str) -> &'static str {
    match s {
        "running" => "running",
        "completed" => "done",
        "error" => "aborted",
        _ => "unknown",
    }
}

fn iso(ms: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, false))
        .unwrap_or_else(now_iso)
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Default)]
struct SessionState {
    session_id: String,
    cwd: String,
    title: Option<String>,
    summary: Option<String>,
    state: String,
    last_ms: i64,
    last_at: String,
    /// 最近一次上报的 (state, updatedAt)，避免重复上报
    emitted: Option<(String, i64)>,
    /// 历史会话：不回填、不再上报（文件再有动静才恢复跟踪）
    skipped: bool,
    /// 是否已完成首次登记
    registered: bool,
    /// 活动桶已随事件上报的消息条数
    sent_msgs: usize,
    /// 尚未随事件上报的活动时间戳（ms），发事件时聚合成 5 分钟桶带走
    pending: Vec<i64>,
    /// (File length, modification time) at last parse; skip if unchanged
    stamp: Option<(u64, SystemTime)>,
}

impl SessionState {
    /// 解析整份会话 JSON，需要上报时才返回事件
    fn observe(&mut self, text: &str, now_ms: i64) -> Option<Event> {
        let v: Value = serde_json::from_str(text).ok()?;
        let meta = v.get("meta")?;
        let id = meta.get("taskId").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            return None;
        }
        self.session_id = id.to_string();
        if let Some(p) = meta.get("workspacePath").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            self.cwd = p.to_string();
        }
        let before_title = self.title.clone();
        if let Some(t) = meta
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.title = Some(truncate_chars(t, 200));
        }
        let updated = meta.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        if updated <= 0 {
            return None;
        }
        self.last_ms = updated;
        self.last_at = iso(updated);
        let state = map_status(meta.get("status").and_then(Value::as_str).unwrap_or("")).to_string();

        // messages: newly appeared portions count as activity; the last assistant reply serves as the summary; the first user message serves as the fallback title
        if let Some(msgs) = v.get("messages").and_then(Value::as_array) {
            if msgs.len() < self.sent_msgs {
                // 文件被重写（分叉/迁移）：活动重新计数
                self.sent_msgs = 0;
                self.pending.clear();
            }
            for m in msgs.iter().skip(self.sent_msgs) {
                if let Some(ts) = m.get("timestamp").and_then(Value::as_i64) {
                    self.pending.push(ts);
                }
            }
            self.sent_msgs = msgs.len();
            if self.title.is_none() {
                let first_user = msgs
                    .iter()
                    .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
                    .and_then(|m| m.get("content").and_then(Value::as_str))
                    .map(one_line)
                    .filter(|s| !s.is_empty());
                self.title = first_user.map(|t| truncate_chars(&t, 40));
            }
            let last_reply = msgs
                .iter()
                .rev()
                .find(|m| {
                    m.get("role").and_then(Value::as_str) == Some("assistant")
                        && m.get("content")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty())
                })
                .and_then(|m| m.get("content").and_then(Value::as_str));
            if let Some(t) = last_reply {
                self.summary = Some(truncate_chars(&one_line(t), 200));
            }
        }

        let title_changed = self.title != before_title;

        // 首次登记：历史会话只回填最终状态，不触发提醒
        if !self.registered {
            if now_ms - self.last_ms > BACKFILL_MS {
                self.skipped = true;
                return None;
            }
            self.registered = true;
            self.state = state.clone();
            let summary = if state == "done" { self.summary.clone() } else { None };
            return Some(self.event(&state, summary, true));
        }
        if self.skipped {
            // 跳过的历史会话又有动静：恢复跟踪
            self.skipped = false;
        }

        // 同一状态同一 updatedAt 不重复上报
        if self.emitted.as_ref().is_some_and(|(s, at)| *s == state && *at == self.last_ms) {
            return None;
        }
        let out = if state != self.state {
            // 状态变化正常上报，触发提醒
            Some(self.event(&state, if state == "done" { self.summary.clone() } else { None }, false))
        } else if !self.pending.is_empty() {
            // 状态没变的后续轮次也把活动桶捎上去（含终态下文件被重写 / 补活动），日历的跨度才不会停在上一轮
            Some(self.event(&state, None, true))
        } else if title_changed && state != "running" {
            // 只改标题：静默同步，不重复提醒
            Some(self.event(&state, None, true))
        } else {
            None
        };
        self.state = state;
        out
    }

    fn event(&mut self, state: &str, summary: Option<String>, quiet: bool) -> Event {
        self.emitted = Some((state.to_string(), self.last_ms));
        let buckets = buckets_of(&self.pending);
        self.pending.clear();
        Event {
            agent: "zcode".into(),
            session_id: self.session_id.clone(),
            machine: String::new(),
            cwd: self.cwd.clone(),
            state: state.into(),
            at: self.last_at.clone(),
            title: self.title.clone(),
            summary,
            pid: None,
            quiet,
            buckets,
        }
    }
}

fn session_files(root: &Path) -> Vec<PathBuf> {
    let now = SystemTime::now();
    let mut out = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(root) else { return out };
    for ws in workspaces.flatten() {
        let Ok(entries) = std::fs::read_dir(ws.path()) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("sess_") && name.ends_with(".json")) {
                continue;
            }
            let fresh = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| now.duration_since(t).map(|d| d < RECENT).unwrap_or(true))
                .unwrap_or(false);
            if fresh {
                out.push(e.path());
            }
        }
    }
    out
}

pub fn spawn(fwd: Forwarder) {
    std::thread::spawn(move || {
        let Some(root) = home_dir().map(|h| h.join(".zcode").join("v2").join("sessions")) else { return };
        let mut states = HashMap::<PathBuf, SessionState>::new();
        loop {
            let files = session_files(&root);
            states.retain(|p, _| files.contains(p));
            for path in files {
                let st = states.entry(path.clone()).or_default();
                // 长度和修改时间都没变的文件不解析
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let stamp = (meta.len(), mtime);
                if st.stamp == Some(stamp) {
                    continue;
                }
                st.stamp = Some(stamp);
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                let now_ms = chrono::Utc::now().timestamp_millis();
                if let Some(ev) = st.observe(&text, now_ms) {
                    fwd.push(ev);
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_793_590_000_000;

    /// 写一份完整的会话文件
    fn session_json(status: &str, updated: i64, title: &str, msgs: &[Value]) -> String {
        serde_json::json!({
            "meta": {
                "taskId": "sess_2cc0dddc-7c2f-4110-b956-3813c1324f81",
                "traceId": "bd905250-b4f4-48f6-9801-58f37f3af78b",
                "title": title,
                "workspacePath": "D:\\Work2\\AgentHub",
                "createdAt": msgs.first().and_then(|m| m.get("timestamp")).and_then(Value::as_i64).unwrap_or(updated),
                "updatedAt": updated,
                "migrationSource": "claudeCode",
                "status": status
            },
            "messages": msgs
        })
        .to_string()
    }

    fn user_msg(text: &str, ts: i64) -> Value {
        serde_json::json!({"role": "user", "content": text, "timestamp": ts, "turnIndex": 0})
    }

    fn assistant_msg(text: &str, ts: i64) -> Value {
        serde_json::json!({"role": "assistant", "content": text, "timestamp": ts, "turnIndex": 0})
    }

    #[test]
    fn status_mapping_and_first_registration() {
        let mut s = SessionState::default();
        let text = session_json(
            "completed",
            T0,
            "如何开启本机的修仙图鉴网站",
            &[user_msg("如何开启本机的修仙图鉴网站", T0 - 600_000), assistant_msg("运行 serve 脚本", T0)],
        );
        let ev = s.observe(&text, T0 + 1_000).unwrap();
        assert_eq!(ev.agent, "zcode");
        assert_eq!(ev.session_id, "sess_2cc0dddc-7c2f-4110-b956-3813c1324f81");
        assert_eq!(ev.state, "done");
        assert_eq!(ev.cwd, "D:\\Work2\\AgentHub");
        assert_eq!(ev.title.as_deref(), Some("如何开启本机的修仙图鉴网站"));
        assert_eq!(ev.summary.as_deref(), Some("运行 serve 脚本"));
        assert!(ev.quiet, "历史登记不能触发提醒");
        assert!(ev.at.starts_with("2026-"));
        // 登记时历史活动桶一次性带走
        assert_eq!(ev.buckets.len(), 2);
        // 状态没变化就不再上报
        assert!(s.observe(&text, T0 + 2_000).is_none());
    }

    #[test]
    fn running_then_completed_notifies() {
        let mut s = SessionState::default();
        let running = session_json("running", T0, "跑测试", &[user_msg("跑测试", T0)]);
        let ev = s.observe(&running, T0 + 1_000).unwrap();
        assert_eq!(ev.state, "running");
        assert!(ev.quiet, "The running state at startup is only registered");
        // 出现了助手回复但仍在运行：只静默捎活动桶
        let more = session_json(
            "running",
            T0 + 10_000,
            "跑测试",
            &[user_msg("跑测试", T0), assistant_msg("开始跑", T0 + 9_000)],
        );
        let ev = s.observe(&more, T0 + 11_000).unwrap();
        assert_eq!(ev.state, "running");
        assert!(ev.quiet);
        assert_eq!(ev.buckets.len(), 1);
        // completed → done, normal report triggering a reminder
        let done = session_json(
            "completed",
            T0 + 60_000,
            "跑测试",
            &[user_msg("跑测试", T0), assistant_msg("全部通过", T0 + 59_000)],
        );
        let ev = s.observe(&done, T0 + 61_000).unwrap();
        assert_eq!(ev.state, "done");
        assert!(!ev.quiet);
        assert_eq!(ev.summary.as_deref(), Some("全部通过"));
        // 同一次完成不重复上报
        assert!(s.observe(&done, T0 + 62_000).is_none());
    }

    #[test]
    fn error_maps_to_aborted() {
        let mut s = SessionState::default();
        let running = session_json("running", T0, "重构", &[user_msg("重构", T0)]);
        s.observe(&running, T0 + 1_000).unwrap();
        let err = session_json("error", T0 + 30_000, "重构", &[user_msg("重构", T0)]);
        let ev = s.observe(&err, T0 + 31_000).unwrap();
        assert_eq!(ev.state, "aborted");
        assert!(!ev.quiet);
    }

    #[test]
    fn fallback_title_from_first_user_message() {
        let mut s = SessionState::default();
        let text = session_json("completed", T0, "", &[user_msg("  这是一条\n很长的提问吗  ", T0 - 1_000)]);
        let ev = s.observe(&text, T0).unwrap();
        assert_eq!(ev.title.as_deref(), Some("这是一条 很长的提问吗"));
    }

    #[test]
    fn old_sessions_are_skipped_then_resumed() {
        let mut s = SessionState::default();
        let old = T0 - BACKFILL_MS - 60_000;
        let text = session_json("completed", old, "很久以前", &[user_msg("问", old - 1_000), assistant_msg("答", old)]);
        assert!(s.observe(&text, T0).is_none());
        assert!(s.skipped);
        // 跳过的会话没变化不会上报（文件变了才会再解析）
        // 文件有了新活动：恢复跟踪
        let resumed = session_json(
            "running",
            T0,
            "很久以前",
            &[user_msg("问", old - 1_000), assistant_msg("答", old), user_msg("继续", T0)],
        );
        let ev = s.observe(&resumed, T0 + 1_000).unwrap();
        assert_eq!(ev.state, "running");
        assert_eq!(ev.buckets.len(), 2, "恢复时活动跨度带着全部历史");
    }

    #[test]
    fn rewritten_file_resets_activity_count() {
        let mut s = SessionState::default();
        let text = session_json("completed", T0, "问", &[user_msg("问", T0 - 1_000), assistant_msg("答", T0)]);
        assert!(s.observe(&text, T0 + 1_000).is_some());
        // 文件变短（重写）：活动重新计数
        let short = session_json("completed", T0 + 60_000, "问", &[user_msg("问", T0 + 59_000)]);
        let ev = s.observe(&short, T0 + 61_000).unwrap();
        assert_eq!(ev.state, "done");
        assert_eq!(ev.buckets.len(), 1);
    }

    #[test]
    fn malformed_input_is_ignored() {
        let mut s = SessionState::default();
        assert!(s.observe("not json", T0).is_none());
        assert!(s.observe("{}", T0).is_none());
        assert!(s.observe(r#"{"meta":{"taskId":""}}"#, T0).is_none());
        assert!(s.observe(r#"{"meta":{"taskId":"sess_x","status":"completed"}}"#, T0).is_none(), "无 updatedAt 不上报");
    }

    #[test]
    fn session_files_only_picks_sess_json() {
        let dir = std::env::temp_dir().join(format!("zc-files-{}", std::process::id()));
        let ws = dir.join("026c7935e153");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("sess_abc.json"), "{}").unwrap();
        std::fs::write(ws.join("other.json"), "{}").unwrap();
        std::fs::write(ws.join("sess_def.txt"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        let files = session_files(&dir);
        assert_eq!(files.len(), 1);
        assert!(files[0].file_name().unwrap() == "sess_abc.json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "只读本机真实会话文件的兼容性检查；设置 AGENTHUB_ZCODE_TEST_ROOT"]
    fn installed_sessions() {
        let root = PathBuf::from(std::env::var_os("AGENTHUB_ZCODE_TEST_ROOT").expect("需要会话文件根目录"));
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut parsed = 0usize;
        let mut counts = HashMap::<String, usize>::new();
        for path in session_files(&root) {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let mut st = SessionState::default();
            if let Some(ev) = st.observe(&text, now_ms) {
                assert!(!ev.session_id.is_empty(), "session id 不能为空：{path:?}");
                assert!(!ev.at.is_empty());
                *counts.entry(ev.state.clone()).or_default() += 1;
                parsed += 1;
            }
        }
        eprintln!("Parsed {parsed} sessions; states: {counts:?}");
        assert!(parsed > 0, "没有解析到任何近期会话");
    }
}
