//! Read-only adapter for WorkBuddy Desktop session transcripts.
//!
//! 路径：`%USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl`，每行一个 JSON 事件
//! （`session-meta` / `message` / `function_call` / `function_call_result` / `ai-title` / `custom-title`）。
//!
//! WorkBuddy 不提供 hook，也没有可调用的 CLI/IPC，因此只能读 transcript：
//! - 正文、标题、目录都能拿到（比豆包日志完整）；
//! - **没有会话结束事件**。完成判定同时要求「尾部是已完成回复或已归的工具结果」
//!   「没有未归的工具调用」「文件静默超过确认窗口」；静默只作确认窗口，不单独作为依据；
//! - 因此本模块只做状态与消息监听，不参与远程执行。

use crate::{
    claude::{home_dir, now_iso, truncate_chars},
    codex::complete_prefix_len,
    forwarder::{Event, Forwarder},
};
use chrono::TimeZone;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// 首次见到大文件时只读末尾这么多字节，避免把历史全会话重放一遍
const INITIAL_BYTES: u64 = 8 * 1024 * 1024;
const READ_BYTES: u64 = 4 * 1024 * 1024;
/// 只跟踪最近改过的文件（更早的会话不再新建）
const RECENT: Duration = Duration::from_secs(3 * 86400);
/// transcript 内部最后时间戳早于这个窗口的会话不回填（旧格式历史）
const BACKFILL_MS: i64 = 7 * 86400 * 1000;
/// 末条助手回复完成后，静默多久确认一轮结束
const QUIET_MS: i64 = 20_000;
/// 工具结果之后还要留更长的窗口：模型可能正在思考，静默不代表结束
const TOOL_QUIET_MS: i64 = 60_000;

/// transcript 尾部结构：决定「安静下来」是否可以判定结束
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Tail {
    #[default]
    None,
    /// 助手回复 completed
    Reply,
    /// 工具结果，且没有未归的工具调用
    ToolResult,
    /// 助手回复 incomplete（被中断）
    Incomplete,
    /// 助手仍在生成
    Generating,
}

#[derive(Default)]
pub struct FileState {
    pub offset: u64,
    session_id: Option<String>,
    cwd: String,
    title: Option<String>,
    summary: Option<String>,
    state: String,
    last_ms: i64,
    last_at: String,
    tail: Tail,
    open_calls: usize,
    /// 最近一次上报的 (state, at)，避免重复上报
    emitted: Option<(String, String)>,
    /// 历史会话：不回填、不再上报
    skipped: bool,
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

fn text_of(v: &Value, kind: &str) -> Option<String> {
    let parts: Vec<&str> = v
        .get("content")?
        .as_array()?
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some(kind))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// 用户消息前面会拼 system-reminder 注入块，标题只取注入块之后的内容
fn user_text(v: &Value) -> Option<String> {
    let raw = text_of(v, "input_text")?;
    let visible = match raw.rfind("</system-reminder>") {
        Some(i) => &raw[i + "</system-reminder>".len()..],
        None => raw.as_str(),
    };
    let flat = one_line(visible);
    (!flat.is_empty()).then_some(flat)
}

impl FileState {
    /// 喂入新增的完整行，只在状态变化时上报；完成/中断由 confirm_quiet 确认
    pub fn feed(&mut self, lines: &[&str], _now_ms: i64) -> Vec<Event> {
        let before_state = self.state.clone();
        let mut title_changed = false;
        for l in lines {
            let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
            if let Some(ms) = v.get("timestamp").and_then(Value::as_i64) {
                if ms > self.last_ms {
                    self.last_ms = ms;
                }
            }
            if let Some(cwd) = v.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                self.cwd = cwd.to_string();
            }
            let before_title = self.title.clone();
            match v.get("type").and_then(Value::as_str).unwrap_or("") {
                "session-meta" => {
                    if let Some(id) = v.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        self.session_id = Some(id.to_string());
                    }
                }
                "ai-title" => {
                    if let Some(t) = v.get("aiTitle").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        self.title = Some(truncate_chars(t.trim(), 200));
                    }
                }
                "custom-title" => {
                    if let Some(t) = v.get("customTitle").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        self.title = Some(truncate_chars(t.trim(), 200));
                    }
                }
                "message" => self.feed_message(&v),
                "function_call" => {
                    self.open_calls += 1;
                    self.state = "running".into();
                    self.tail = Tail::None;
                }
                "function_call_result" => {
                    self.open_calls = self.open_calls.saturating_sub(1);
                    self.tail = Tail::ToolResult;
                }
                _ => {}
            }
            if self.title != before_title {
                title_changed = true;
            }
        }
        if self.last_ms > 0 {
            self.last_at = iso(self.last_ms);
        }
        if self.skipped || self.session_id.is_none() || self.last_at.is_empty() {
            return vec![];
        }
        let mut out = Vec::new();
        if self.state == "running" && before_state != "running" {
            out.push(self.event("running", None, false));
        } else if title_changed && self.state != "running" {
            // 只改标题：静默同步，不重复提醒
            let st = self.state_or_unknown().to_string();
            out.push(self.event(&st, None, true));
        }
        out
    }

    fn feed_message(&mut self, v: &Value) {
        match v.get("role").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                if self.title.is_none() {
                    if let Some(t) = user_text(v) {
                        self.title = Some(truncate_chars(&t, 40));
                    }
                }
                self.state = "running".into();
                self.tail = Tail::None;
                self.open_calls = 0;
            }
            "assistant" => {
                self.state = "running".into();
                match v.get("status").and_then(Value::as_str).unwrap_or("") {
                    "generating" | "in_progress" => self.tail = Tail::Generating,
                    "completed" => {
                        self.tail = Tail::Reply;
                        if let Some(t) = text_of(v, "output_text") {
                            let flat = one_line(&t);
                            if !flat.is_empty() {
                                self.summary = Some(truncate_chars(&flat, 200));
                            }
                        }
                    }
                    "incomplete" => self.tail = Tail::Incomplete,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// 启动首轮登记：历史会话只回填最终状态，不假装仍在跑，也不触发提醒
    pub fn register(&mut self, now_ms: i64) -> Option<Event> {
        if self.last_ms == 0 || self.session_id.is_none() {
            return None;
        }
        if now_ms - self.last_ms > BACKFILL_MS {
            self.skipped = true;
            return None;
        }
        let state = if self.state == "running" {
            // 已安静下来的历史会话按尾部结构给出结论；仍在生成/有未归调用则记 unknown
            match (self.tail, self.open_calls) {
                (Tail::Reply, 0) | (Tail::ToolResult, 0) => "done",
                (Tail::Incomplete, _) => "aborted",
                _ => "unknown",
            }
        } else {
            self.state_or_unknown()
        }
        .to_string();
        let summary = if state == "done" { self.summary.clone() } else { None };
        self.state = state.clone();
        Some(self.event(&state, summary, true))
    }

    /// 文件安静下来后确认本轮是否结束；不满足条件返回 None
    pub fn confirm_quiet(&mut self, now_ms: i64) -> Option<Event> {
        if self.skipped || self.session_id.is_none() || self.state != "running" || self.open_calls > 0 {
            return None;
        }
        let (state, window) = match self.tail {
            Tail::Reply => ("done", QUIET_MS),
            Tail::ToolResult => ("done", TOOL_QUIET_MS),
            Tail::Incomplete => ("aborted", QUIET_MS),
            _ => return None,
        };
        if now_ms - self.last_ms < window {
            return None;
        }
        if self.emitted.as_ref().is_some_and(|(s, at)| s == state && *at == self.last_at) {
            return None;
        }
        self.state = state.to_string();
        let summary = if state == "done" { self.summary.clone() } else { None };
        Some(self.event(state, summary, false))
    }

    fn state_or_unknown(&self) -> &str {
        if self.state.is_empty() {
            "unknown"
        } else {
            &self.state
        }
    }

    fn event(&mut self, state: &str, summary: Option<String>, quiet: bool) -> Event {
        self.emitted = Some((state.to_string(), self.last_at.clone()));
        Event {
            agent: "workbuddy".into(),
            session_id: self.session_id.clone().unwrap_or_default(),
            machine: String::new(),
            cwd: self.cwd.clone(),
            state: state.into(),
            at: self.last_at.clone(),
            title: self.title.clone(),
            summary,
            pid: None,
            quiet,
        }
    }
}

fn transcript_files(root: &Path) -> Vec<PathBuf> {
    let now = SystemTime::now();
    let mut out = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(root) else { return out };
    for ws in workspaces.flatten() {
        let Ok(entries) = std::fs::read_dir(ws.path()) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".jsonl") || name.ends_with(".file-rollback.ndjson") {
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

fn new_state(path: &Path) -> FileState {
    // 没有 session-meta 时用文件名兜底（{sessionId}.jsonl）
    FileState {
        session_id: path.file_stem().and_then(|n| n.to_str()).map(str::to_owned),
        ..Default::default()
    }
}

pub fn spawn(fwd: Forwarder) {
    std::thread::spawn(move || {
        let Some(root) = home_dir().map(|h| h.join(".workbuddy").join("projects")) else { return };
        let mut states = HashMap::<PathBuf, FileState>::new();
        let mut initial = true;
        loop {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let files = transcript_files(&root);
            states.retain(|p, _| files.contains(p));
            for path in files {
                let fresh = !states.contains_key(&path);
                let st = states.entry(path.clone()).or_insert_with(|| new_state(&path));
                let Ok(mut file) = std::fs::File::open(&path) else { continue };
                let Ok(len) = file.metadata().map(|m| m.len()) else { continue };
                if st.offset > len {
                    st.offset = 0;
                }
                // 首轮只读末尾，避免重放整份历史
                if fresh && initial {
                    st.offset = len.saturating_sub(INITIAL_BYTES);
                }
                // 历史文件跳过之后又被追加（会话被继续）：重新跟踪
                if st.skipped && len == st.offset {
                    continue;
                }
                if file.seek(SeekFrom::Start(st.offset)).is_err() {
                    continue;
                }
                let mut buf = Vec::new();
                if file.take(READ_BYTES).read_to_end(&mut buf).is_err() {
                    continue;
                }
                let complete = complete_prefix_len(&buf);
                if complete == 0 {
                    continue;
                }
                let text = String::from_utf8_lossy(&buf[..complete]).into_owned();
                let lines: Vec<&str> = text.lines().collect();
                for ev in st.feed(&lines, now_ms) {
                    // 首轮是历史回填，只登记不推送（避免一整屏补报提醒）
                    if !initial {
                        fwd.push(ev);
                    }
                }
                st.offset += complete as u64;
            }
            if initial {
                for st in states.values_mut() {
                    if let Some(ev) = st.register(now_ms) {
                        fwd.push(ev);
                    }
                }
                initial = false;
            }
            for st in states.values_mut() {
                if let Some(ev) = st.confirm_quiet(now_ms) {
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

    fn msg(role: &str, status: &str, text: &str, ts: i64) -> String {
        let kind = if role == "user" { "input_text" } else { "output_text" };
        serde_json::json!({
            "type": "message", "role": role, "status": status, "timestamp": ts,
            "cwd": "D:\\Work2\\AgentHub",
            "content": [{"type": kind, "text": text}]
        })
        .to_string()
    }

    fn meta(id: &str, ts: i64) -> String {
        serde_json::json!({"type":"session-meta","sessionId":id,"timestamp":ts}).to_string()
    }

    fn titled(title: &str, ts: i64) -> String {
        serde_json::json!({"type":"ai-title","aiTitle":title,"timestamp":ts}).to_string()
    }

    fn call(ts: i64) -> String {
        serde_json::json!({"type":"function_call","timestamp":ts,"name":"Read"}).to_string()
    }

    fn result(ts: i64) -> String {
        serde_json::json!({"type":"function_call_result","timestamp":ts}).to_string()
    }

    fn live() -> FileState {
        let mut s = FileState::default();
        s.session_id = Some("abc".into());
        s
    }

    #[test]
    fn completion_needs_structure_and_quiet_window() {
        let mut s = live();
        let started = s.feed(&[&msg("user", "completed", "帮我看看", T0)], T0);
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].state, "running");
        assert_eq!(started[0].cwd, "D:\\Work2\\AgentHub");
        assert_eq!(started[0].title.as_deref(), Some("帮我看看"));
        // 助手回复完成只更新摘要，不立刻判结束
        assert!(s.feed(&[&msg("assistant", "completed", "好的，我看下", T0 + 5_000)], T0 + 5_000).is_empty());
        // 回复刚完成，不能立刻判定结束
        assert!(s.confirm_quiet(T0 + 6_000).is_none());
        let done = s.confirm_quiet(T0 + 5_000 + QUIET_MS).unwrap();
        assert_eq!(done.state, "done");
        assert_eq!(done.summary.as_deref(), Some("好的，我看下"));
        assert!(done.at.starts_with("2026-"));
        // 同一个结束状态不重复上报
        assert!(s.confirm_quiet(T0 + 120_000).is_none());
    }

    #[test]
    fn pending_tool_call_blocks_completion() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑测试", T0)], T0);
        s.feed(&[&msg("assistant", "completed", "开始", T0 + 1_000), &call(T0 + 1_001)], T0 + 1_001);
        assert!(s.confirm_quiet(T0 + 10 * QUIET_MS).is_none(), "工具还没返回，不能判结束");
        s.feed(&[&result(T0 + 2_000)], T0 + 2_000);
        // 工具结果后要给模型留更长的时间继续生成
        assert!(s.confirm_quiet(T0 + 2_000 + QUIET_MS).is_none());
        assert_eq!(s.confirm_quiet(T0 + 2_000 + TOOL_QUIET_MS).unwrap().state, "done");
    }

    #[test]
    fn interrupted_reply_is_aborted() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "继续", T0)], T0);
        s.feed(&[&msg("assistant", "incomplete", "写到一半", T0 + 1_000)], T0 + 1_000);
        assert_eq!(s.confirm_quiet(T0 + 1_000 + QUIET_MS).unwrap().state, "aborted");
    }

    #[test]
    fn generating_tail_never_finishes() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "写长文", T0)], T0);
        s.feed(&[&msg("assistant", "generating", "", T0 + 1_000)], T0 + 1_000);
        assert!(s.confirm_quiet(T0 + 10 * QUIET_MS).is_none());
    }

    #[test]
    fn running_is_reported_once_per_turn() {
        let mut s = live();
        s.feed(&[&meta("abc", T0)], T0);
        let first = s.feed(&[&msg("user", "completed", "一", T0)], T0);
        assert_eq!(first[0].state, "running");
        // 同一轮里再来一条用户消息不再重复上报
        assert!(s.feed(&[&msg("user", "completed", "二", T0 + 1_000)], T0 + 1_000).is_empty());
        s.feed(&[&msg("assistant", "completed", "答", T0 + 2_000)], T0 + 2_000);
        s.confirm_quiet(T0 + 2_000 + QUIET_MS).unwrap();
        // 下一轮重新开始
        let again = s.feed(&[&msg("user", "completed", "三", T0 + 90_000)], T0 + 90_000);
        assert_eq!(again[0].state, "running");
    }

    #[test]
    fn titles_and_history_registration() {
        let mut s = FileState::default();
        s.session_id = Some("abc".into());
        s.feed(
            &[&meta("abc", T0), &titled("检查目标时间", T0 + 10), &msg("user", "completed", "问题", T0 + 20)],
            T0 + 30,
        );
        let ev = s.register(T0 + 30).unwrap();
        assert!(ev.quiet, "历史登记不能触发提醒");
        assert_eq!(ev.title.as_deref(), Some("检查目标时间"));
        assert_eq!(ev.state, "unknown");
        // 自定义标题覆盖 AI 标题，且静默同步
        let renamed_line =
            serde_json::json!({"type":"custom-title","customTitle":"我的标题","timestamp":T0+40}).to_string();
        let renamed = s.feed(&[&renamed_line], T0 + 40);
        assert_eq!(s.title.as_deref(), Some("我的标题"));
        assert!(renamed.iter().all(|e| e.quiet));
    }

    #[test]
    fn quiet_history_is_skipped() {
        let mut s = live();
        let old = T0 - BACKFILL_MS - 1_000;
        s.feed(&[&msg("user", "completed", "很久以前", old)], T0);
        assert!(s.register(T0).is_none());
        assert!(s.skipped);
        // 跳过之后不参与安静确认
        assert!(s.confirm_quiet(T0 + 10 * QUIET_MS).is_none());
    }

    #[test]
    fn completed_history_is_registered_as_done() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "问", T0 - 60_000), &msg("assistant", "completed", "答", T0)], T0);
        let ev = s.register(T0).unwrap();
        assert_eq!(ev.state, "done");
        assert!(ev.quiet);
    }

    #[test]
    fn malformed_lines_are_ignored() {
        let mut s = live();
        assert!(s.feed(&["not json", "{}"], T0).is_empty());
        assert!(s.register(T0).is_none());
    }

    #[test]
    #[ignore = "只读本机真实 transcript 的兼容性检查；设置 AGENTHUB_WORKBUDDY_TEST_ROOT"]
    fn installed_transcripts() {
        let root = PathBuf::from(std::env::var_os("AGENTHUB_WORKBUDDY_TEST_ROOT").expect("需要 transcript 根目录"));
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut parsed = 0usize;
        let mut counts = HashMap::<String, usize>::new();
        for path in transcript_files(&root) {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let mut st = new_state(&path);
            let lines: Vec<&str> = text.lines().collect();
            st.feed(&lines, now_ms);
            if let Some(ev) = st.register(now_ms) {
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
