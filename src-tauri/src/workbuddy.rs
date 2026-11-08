//! Read-only adapter for WorkBuddy / CodeBuddy session transcripts.
//!
//! 路径：`%USERPROFILE%\.workbuddy\projects\<工作区>\<sessionId>.jsonl`（CodeBuddy CLI 同一格式，
//! 落在 `~\.codebuddy\projects`），每行一个 JSON 事件
//! （`session-meta` / `message` / `function_call` / `function_call_result` / `ai-title` / `custom-title`）。
//!
//! 派活走 `runner.rs::run_workbuddy`（应用内置 CLI，stream-json 协议与 claude 同构）；
//! 本模块只负责 transcript 监听：
//! - 正文、标题、目录都能拿到（比豆包日志完整）；
//! - **没有会话结束事件**。完成判定同时要求「尾部是已完成回复或已归的工具结果」
//!   「没有未归的工具调用」「文件静默超过确认窗口」；静默只作确认窗口，不单独作为依据。
//!   未归调用按 callId 集合配对；注入的 user 行（system-reminder / task-notification 等）
//!   不清零未归调用，避免后台工具还在飞时被提前判完成；
//! - 因此本模块只做状态与消息监听；远程执行由 runner.rs 的 run_workbuddy 承担。

use crate::{
    activity::buckets_of,
    claude::{home_dir, now_iso, truncate_chars},
    codex::complete_prefix_len,
    forwarder::{Event, EventMessage, Forwarder},
};
use chrono::TimeZone;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
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
/// 工具结果之后还要留更长的窗口：模型可能正在思考，静默不代表结束。
/// 真实 transcript 回放显示「结果→下一行」的间隔有 ~1% 超过 60s、最长 900s
/// （下一行几乎都是 reasoning，思考期间文件完全静默）；60s 时「提前判完成」
/// 占所有完成判定的 ~31%，提到 3 分钟后降到 ~5%。
const TOOL_QUIET_MS: i64 = 180_000;
/// 结构给不出结论时的兜底窗口：尾部是用户消息 / 仍在 generating / 还有未归的调用，
/// 都可能是「进程已经不在了」，可静默又必须能收尾（否则会话永远停在 running）。
/// 跑很久的单次工具调用会在这条线上被先判死一次，但结果落盘后会自己回到 running，
/// 且兜底收尾是静默的（不补通知），代价只是一次状态回摆。与前端 sendBlock / 服务端 routes
/// 的 STALE_RUNNING_MS 保持同一口径：30 分钟没有新东西就不再当它还在跑。
const STALE_MS: i64 = 30 * 60_000;
/// 随手带上来的正文：单条文本上限（与服务端 cleanText 一致）
const MSG_TEXT_MAX: usize = 4000;
/// 一轮里最多带多少条正文（长回合别把事件撑爆，服务端也会裁剪）
const TURN_MSGS_MAX: usize = 30;
/// 启动登记时补的历史正文条数：老会话早先没同步过，库里是空的
const REGISTER_MSGS: usize = 24;

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
    /// 这份 transcript 属于哪个 agent（workbuddy / codebuddy）：两者格式一致，只是目录不同
    agent: &'static str,
    session_id: Option<String>,
    cwd: String,
    title: Option<String>,
    summary: Option<String>,
    state: String,
    last_ms: i64,
    last_at: String,
    tail: Tail,
    /// 未归的工具调用 callId：结果按 callId 配对归还，避免计数错乱
    open_ids: HashSet<String>,
    /// 没有 callId 的调用退化按计数配对
    open_unknown: usize,
    /// 最近一次上报的 (state, at)，避免重复上报
    emitted: Option<(String, String)>,
    /// 历史会话：不回填、不再上报
    skipped: bool,
    /// 本轮 feed 里出现了用户消息（状态没变也要把活动桶捎上去）
    user_turn: bool,
    /// 尚未随事件上报的活动时间戳（ms），发事件时聚合成 5 分钟桶带走
    pending: Vec<i64>,
    /// 还没随事件上报的正文：正文只在本机 transcript 里，拉历史又要走执行器通道，
    /// 所以顺路跟状态事件一起上送（服务端按 role+时间+正文去重）
    msgs: Vec<EventMessage>,
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

/// 用户消息剥掉注入块后剩下的可见文本；纯注入块（摘要 / 通知 / reminder）返回 None，不当标题
fn user_text(v: &Value) -> Option<String> {
    let raw = text_of(v, "input_text")?;
    let mut visible = match raw.rfind("</system-reminder>") {
        Some(i) => &raw[i + "</system-reminder>".len()..],
        None => raw.as_str(),
    };
    // `> ` 引用前缀和 <user_query> 包裹是派发格式残留
    visible = visible.trim_start_matches(['>', ' ', '\n', '\t']);
    if let Some(rest) = visible.strip_prefix("<user_query>") {
        if let Some(end) = rest.rfind("</user_query>") {
            visible = &rest[..end];
        }
    }
    let flat = one_line(visible);
    // 剩下的还是注入块（<cb_summary>、<task-notification> 等）就不当标题
    (!flat.is_empty() && !flat.starts_with('<')).then_some(flat)
}

impl FileState {
    /// 喂入新增的完整行，只在状态变化时上报；完成/中断由 confirm_quiet 确认
    pub fn feed(&mut self, lines: &[&str], _now_ms: i64) -> Vec<Event> {
        let before_state = self.state.clone();
        self.user_turn = false;
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
                "message" => {
                    self.track(&v);
                    self.feed_message(&v);
                }
                "function_call" => {
                    self.track(&v);
                    match v.get("callId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        Some(id) => {
                            self.open_ids.insert(id.to_string());
                        }
                        None => self.open_unknown += 1,
                    }
                    self.state = "running".into();
                    self.tail = Tail::None;
                }
                "function_call_result" => {
                    self.track(&v);
                    // callId 对不上多半是调用发生在窗口截断之前：忽略，不凭空抵消
                    match v.get("callId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        Some(id) => {
                            self.open_ids.remove(id);
                        }
                        None => self.open_unknown = self.open_unknown.saturating_sub(1),
                    }
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
        } else if self.user_turn && self.state == "running" && !self.pending.is_empty() {
            // 状态没变的后续轮次也把活动桶捎上去，日历的跨度才不会停在上一轮
            out.push(self.event("running", None, true));
        } else if title_changed && self.state != "running" {
            // 只改标题：静默同步，不重复提醒
            let st = self.state_or_unknown().to_string();
            out.push(self.event(&st, None, true));
        }
        out
    }

    /// 记录一条活动的发生时间，凑够一批后随事件上报
    fn track(&mut self, v: &Value) {
        if let Some(ms) = v.get("timestamp").and_then(Value::as_i64) {
            self.pending.push(ms);
            if self.pending.len() > 4096 {
                self.pending.drain(..1024);
            }
        }
    }

    fn feed_message(&mut self, v: &Value) {
        match v.get("role").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                // 纯注入块（system-reminder / task-notification / cb_summary）不是真的用户输入：
                // 不代表新一轮开始，更不能清掉仍在飞的未归工具调用，否则会提前误判完成
                let real_input = user_text(v);
                if self.title.is_none() {
                    if let Some(t) = &real_input {
                        self.title = Some(truncate_chars(t, 40));
                    }
                }
                if let Some(t) = &real_input {
                    self.open_ids.clear();
                    self.open_unknown = 0;
                    self.record("user", t, v);
                }
                self.user_turn = true;
                self.state = "running".into();
                self.tail = Tail::None;
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
                            self.record("assistant", &t, v);
                        }
                    }
                    "incomplete" => {
                        self.tail = Tail::Incomplete;
                        // 被用户中断：这批还在飞的调用不会有结果回来了。
                        // 留着会让「中断→aborted」也走不到（confirm_quiet 第一关就要求未归调用为 0），
                        // 状态就永远停在 running。
                        self.open_ids.clear();
                        self.open_unknown = 0;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// 收一条可见正文（注入块已被 user_text / text_of 过滤掉）；带上原生日志时间戳
    fn record(&mut self, role: &str, text: &str, v: &Value) {
        let t = text.trim();
        if t.is_empty() {
            return;
        }
        let at = v.get("timestamp").and_then(Value::as_i64).map(iso);
        self.msgs.push(EventMessage { role: role.into(), text: truncate_chars(t, MSG_TEXT_MAX), at });
        if self.msgs.len() > TURN_MSGS_MAX {
            let cut = self.msgs.len() - TURN_MSGS_MAX;
            self.msgs.drain(..cut);
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
            match (self.tail, self.open_calls()) {
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
        if self.skipped || self.session_id.is_none() || self.state != "running" {
            return None;
        }
        // 结构能定性就按结构判（这种结束有把握，照常提醒）；
        // 结构不能定性（尾部是用户消息 / 仍在 generating / 还有未归的调用）只能等「久到不可能还在动」，
        // 那种收尾是兜底推断，静默处理：别让一个半夜就死掉的会话在早上弹一条「已中断」。
        let (state, window, stale) = match (self.open_calls() == 0, self.tail) {
            (true, Tail::Reply) => ("done", QUIET_MS, false),
            (true, Tail::ToolResult) => ("done", TOOL_QUIET_MS, false),
            (true, Tail::Incomplete) => ("aborted", QUIET_MS, false),
            _ => ("aborted", STALE_MS, true),
        };
        if now_ms - self.last_ms < window {
            return None;
        }
        if self.emitted.as_ref().is_some_and(|(s, at)| s == state && *at == self.last_at) {
            return None;
        }
        self.state = state.to_string();
        if stale {
            // 这些调用已经判死：下一轮开始时不能再被它们挡住
            self.open_ids.clear();
            self.open_unknown = 0;
        }
        let summary = if state == "done" { self.summary.clone() } else { None };
        Some(self.event(state, summary, stale))
    }

    /// 未归的工具调用总数（按 callId 配对 + 无 callId 的计数兜底）
    fn open_calls(&self) -> usize {
        self.open_ids.len() + self.open_unknown
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
        let buckets = buckets_of(&self.pending);
        self.pending.clear();
        let messages = std::mem::take(&mut self.msgs);
        Event {
            agent: if self.agent.is_empty() { "workbuddy".into() } else { self.agent.into() },
            session_id: self.session_id.clone().unwrap_or_default(),
            machine: String::new(),
            cwd: self.cwd.clone(),
            state: state.into(),
            at: self.last_at.clone(),
            title: self.title.clone(),
            summary,
            pid: None,
            quiet,
            buckets,
            messages,
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
    new_state_for(path, "workbuddy")
}

fn new_state_for(path: &Path, agent: &'static str) -> FileState {
    // 没有 session-meta 时用文件名兜底（{sessionId}.jsonl）
    FileState {
        agent,
        session_id: path.file_stem().and_then(|n| n.to_str()).map(str::to_owned),
        ..Default::default()
    }
}

/// 新文件先读头部：ai-title / custom-title / session-meta 都写在文件开头，
/// 大文件只读尾部会漏掉，标题就会退化成尾部的注入块（cb_summary / 通知原文）。
/// 只取身份与标题，不碰状态机。
fn seed_head(path: &Path, st: &mut FileState) {
    const HEAD_BYTES: u64 = 256 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else { return };
    let mut buf = Vec::new();
    if file.by_ref().take(HEAD_BYTES).read_to_end(&mut buf).is_err() {
        return;
    }
    for l in String::from_utf8_lossy(&buf).lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "session-meta" => {
                if let Some(id) = v.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    st.session_id = Some(id.to_string());
                }
            }
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                    st.title = Some(truncate_chars(t.trim(), 200));
                }
            }
            "custom-title" => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                    st.title = Some(truncate_chars(t.trim(), 200));
                }
            }
            _ => {}
        }
    }
}

/// 全文件扫一遍活动时间戳：历史会话的对话跨度靠它，register 时随事件上报。
/// 只做子串查找不逐行解析 JSON，18MB 的 transcript 也在毫秒级。
fn scan_buckets(path: &Path, since_ms: i64) -> Vec<i64> {
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    const CHUNK: u64 = 4 * 1024 * 1024;
    let mut out = Vec::new();
    let mut carry = String::new();
    loop {
        let mut buf = Vec::with_capacity(CHUNK as usize);
        if file.by_ref().take(CHUNK).read_to_end(&mut buf).unwrap_or(0) == 0 {
            break;
        }
        let text = carry + String::from_utf8_lossy(&buf).as_ref();
        let mut lines = text.split('\n');
        carry = lines.next_back().unwrap_or("").to_string();
        for l in lines {
            // 只数消息与工具调用，meta / 标题不算活动
            if !(l.contains("\"type\":\"message\"") || l.contains("\"function_call")) {
                continue;
            }
            let Some(i) = l.find("\"timestamp\":") else { continue };
            let digits: String = l[i + 12..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(ms) = digits.parse::<i64>() {
                if ms >= since_ms {
                    out.push(ms);
                }
            }
        }
    }
    out
}

/// 启动登记时补一份历史正文：这些老会话早先没同步过（那台电脑没开远程执行，拉不到），
/// 服务端库里是空的；正文只在本机 transcript 里，只能趁这一刻顺路带上去。
/// 服务端按 (role, 时间, 正文) 去重，重复带上不会变成重复消息。
fn tail_messages(path: &Path, limit: usize, agent: &str) -> Vec<EventMessage> {
    let Ok(text) = crate::runner::read_tail(path, 512 * 1024) else { return Vec::new() };
    crate::message_history::parse(agent, &text, limit)
        .into_iter()
        .map(|m| EventMessage { role: m.role, text: truncate_chars(&m.text, MSG_TEXT_MAX), at: m.at })
        .collect()
}

/// WorkBuddy 桌面端与独立的 CodeBuddy CLI 是同一份 CLI，transcript 布局也一样
/// （`~\.<工具>\projects\<工作区>\<sessionId>.jsonl`），只是目录名不同：
/// 同一个监听器跑两遍，事件里带上各自的 agent 名。
pub fn spawn(fwd: Forwarder) {
    for (agent, dir) in [("workbuddy", ".workbuddy"), ("codebuddy", ".codebuddy")] {
        spawn_dir(fwd.clone(), agent, dir);
    }
}

fn spawn_dir(fwd: Forwarder, agent: &'static str, dir: &'static str) {
    std::thread::spawn(move || {
        let Some(root) = home_dir().map(|h| h.join(dir).join("projects")) else { return };
        let mut states = HashMap::<PathBuf, FileState>::new();
        let mut initial = true;
        loop {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let files = transcript_files(&root);
            states.retain(|p, _| files.contains(p));
            for path in files {
                let fresh = !states.contains_key(&path);
                let st = states.entry(path.clone()).or_insert_with(|| new_state_for(&path, agent));
                if fresh {
                    seed_head(&path, st);
                    if !initial {
                        // 中途新发现的文件：历史活动并进 pending，第一个事件就带着完整跨度
                        st.pending.extend(scan_buckets(&path, now_ms - BACKFILL_MS));
                    }
                }
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
                for (path, st) in states.iter_mut() {
                    // feed 阶段的事件被丢弃但 pending 已被清空：登记前重新补齐历史活动桶
                    st.pending.extend(scan_buckets(path, now_ms - BACKFILL_MS));
                    // 老会话的正文从没进过库：登记这一枪顺路带上最近几条，之后就能在详情页看到
                    st.msgs = tail_messages(path, REGISTER_MSGS, agent);
                    if let Some(ev) = st.register(now_ms) {
                        fwd.push(ev);
                    } else {
                        // 历史会话（跳过登记 / 没有会话 id）不推送，正文也别留着串到后面的事件里
                        st.msgs.clear();
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
        call_id(ts, "call_1")
    }

    fn call_id(ts: i64, id: &str) -> String {
        serde_json::json!({"type":"function_call","timestamp":ts,"name":"Read","callId":id}).to_string()
    }

    fn result(ts: i64) -> String {
        result_id(ts, "call_1")
    }

    fn result_id(ts: i64, id: &str) -> String {
        serde_json::json!({"type":"function_call_result","timestamp":ts,"callId":id}).to_string()
    }

    /// 纯注入的用户行（通知 / reminder），不是真实用户输入
    fn injected(ts: i64, tag: &str) -> String {
        serde_json::json!({
            "type": "message", "role": "user", "status": "completed", "timestamp": ts,
            "content": [{"type": "input_text", "text": format!("<{tag}>后台任务已完成</{tag}>")}]
        })
        .to_string()
    }

    fn live() -> FileState {
        let mut s = FileState::default();
        s.session_id = Some("abc".into());
        s
    }

    #[test]
    fn events_carry_visible_messages() {
        let mut s = live();
        // 用户提问的那一枪就带上用户消息（详情页不用等这一轮跑完才有内容）
        let started = s.feed(&[&msg("user", "completed", "把农场场景补完", T0)], T0);
        assert_eq!(started[0].messages.len(), 1);
        assert_eq!(started[0].messages[0].role, "user");
        assert_eq!(started[0].messages[0].text, "把农场场景补完");
        assert!(started[0].messages[0].at.as_deref().is_some_and(|t| t.starts_with("2026-")));
        // 回复完成时只更新摘要，正文攒着等下一条事件
        assert!(s.feed(&[&msg("assistant", "completed", "好的，先补麦田。", T0 + 5_000)], T0 + 5_000).is_empty());
        let done = s.confirm_quiet(T0 + 5_000 + QUIET_MS).unwrap();
        assert_eq!(done.messages.len(), 1);
        assert_eq!(done.messages[0].role, "assistant");
        assert_eq!(done.messages[0].text, "好的，先补麦田。");
        // 上报过的不再重复带
        assert!(s.msgs.is_empty());
    }

    #[test]
    fn events_carry_the_transcript_owner_agent() {
        // 同一套状态机也给 CodeBuddy 用：事件里的 agent 不能还写死成 workbuddy
        let mut s = new_state_for(Path::new("C:/x/.codebuddy/projects/ws/abc.jsonl"), "codebuddy");
        assert_eq!(s.session_id.as_deref(), Some("abc"));
        let evs = s.feed(&[&msg("user", "completed", "查目录", T0)], T0);
        assert_eq!(evs[0].agent, "codebuddy");
        // 没有显式指定时退回 workbuddy（老调用点 / 直接 Default 构造）
        let mut w = live();
        assert_eq!(w.feed(&[&msg("user", "completed", "查目录", T0)], T0)[0].agent, "workbuddy");
    }

    #[test]
    fn injected_blocks_are_not_reported_as_messages() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑后台任务", T0)], T0);
        let evs = s.feed(&[&injected(T0 + 1_000, "task-notification")], T0 + 1_000);
        // 注入行不代表新一轮，也不该变成消息
        assert!(evs.iter().all(|e| e.messages.is_empty()));
        assert!(s.msgs.is_empty());
    }

    #[test]
    fn message_text_and_count_are_capped() {
        let mut s = live();
        let long = "字".repeat(MSG_TEXT_MAX * 2);
        let evs = s.feed(&[&msg("user", "completed", &long, T0)], T0);
        assert_eq!(evs[0].messages[0].text.chars().count(), MSG_TEXT_MAX);
        for i in 0..(TURN_MSGS_MAX + 5) {
            s.record("assistant", &format!("第 {i} 条"), &serde_json::json!({"timestamp": T0 + i as i64}));
        }
        assert_eq!(s.msgs.len(), TURN_MSGS_MAX);
        // 留的是最近的
        assert!(s.msgs.last().unwrap().text.ends_with(&format!("第 {} 条", TURN_MSGS_MAX + 4)));
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
    fn injected_user_messages_do_not_clear_open_calls() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑后台任务", T0)], T0);
        // 两个工具先后起飞，后台任务先返回（task-notification 注入行夹在中间）
        s.feed(&[&call_id(T0 + 1_000, "call_a"), &call_id(T0 + 1_001, "call_b")], T0 + 1_001);
        s.feed(&[&result_id(T0 + 2_000, "call_a")], T0 + 2_000);
        // 注入块到达：不能把还在飞的 call_b 清掉
        s.feed(&[&injected(T0 + 2_100, "task-notification"), &injected(T0 + 2_200, "system-reminder")], T0 + 2_200);
        // call_b 的结果落盘：60 秒静默窗口内不能判结束
        s.feed(&[&result_id(T0 + 3_000, "call_b")], T0 + 3_000);
        assert!(s.confirm_quiet(T0 + 3_000 + QUIET_MS).is_none());
        assert_eq!(s.confirm_quiet(T0 + 3_000 + TOOL_QUIET_MS).unwrap().state, "done");
    }

    #[test]
    fn real_user_input_resets_open_calls() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "第一轮", T0)], T0);
        s.feed(&[&call_id(T0 + 1_000, "call_a")], T0 + 1_000);
        // 用户打断并重新提问：新一轮开始，旧调用不再阻塞完成判定
        s.feed(&[&msg("user", "completed", "换个话题", T0 + 2_000)], T0 + 2_000);
        s.feed(&[&msg("assistant", "completed", "好的", T0 + 3_000)], T0 + 3_000);
        assert_eq!(s.confirm_quiet(T0 + 3_000 + QUIET_MS).unwrap().state, "done");
    }

    #[test]
    fn unpaired_call_ids_do_not_block_completion() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "查一下", T0)], T0);
        // 结果的 callId 是窗口截断之前起飞的调用：不凭空抵消，但也不能让新调用被错误归零
        s.feed(
            &[&call_id(T0 + 1_000, "call_x"), &result_id(T0 + 2_000, "call_before_window"), &call_id(T0 + 2_100, "call_y")],
            T0 + 2_100,
        );
        assert!(s.confirm_quiet(T0 + 2_100 + 4 * TOOL_QUIET_MS).is_none(), "call_y 仍在飞，不能判结束");
        s.feed(&[&result_id(T0 + 3_000, "call_x")], T0 + 3_000);
        assert!(s.confirm_quiet(T0 + 3_000 + 4 * TOOL_QUIET_MS).is_none(), "call_y 仍未归还");
        s.feed(&[&result_id(T0 + 4_000, "call_y")], T0 + 4_000);
        assert_eq!(s.confirm_quiet(T0 + 4_000 + TOOL_QUIET_MS).unwrap().state, "done");
    }

    #[test]
    fn calls_without_call_id_fall_back_to_counting() {
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑", T0)], T0);
        let no_id_call = serde_json::json!({"type":"function_call","timestamp":T0+1_000,"name":"Read"}).to_string();
        let no_id_result = serde_json::json!({"type":"function_call_result","timestamp":T0+2_000}).to_string();
        s.feed(&[&no_id_call], T0 + 1_000);
        assert!(s.confirm_quiet(T0 + 1_000 + 4 * TOOL_QUIET_MS).is_none());
        s.feed(&[&no_id_result], T0 + 2_000);
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
    fn interrupted_round_releases_open_calls() {
        // 用户在工具还在飞的时候按了中断：这批调用不会有结果回来了，
        // 不能拿它们把这一轮永久钉在 running（线上就是卡了 15 小时那种）
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑起来", T0)], T0);
        s.feed(&[&call_id(T0 + 1_000, "call_a"), &call_id(T0 + 1_001, "call_b")], T0 + 1_001);
        s.feed(&[&msg("assistant", "incomplete", "Interrupted by user", T0 + 2_000)], T0 + 2_000);
        assert_eq!(s.open_calls(), 0, "中断即放弃在飞的调用");
        // 中断是明确的结构，按 REPLY 的静默窗口收尾，照常提醒
        let ev = s.confirm_quiet(T0 + 2_000 + QUIET_MS).unwrap();
        assert_eq!(ev.state, "aborted");
        assert!(!ev.quiet);
    }

    #[test]
    fn generating_tail_closes_only_when_stale() {
        // 停在 generating（进程没了）没有结构可依据：只有久到不可能还在动才收尾
        let mut s = live();
        s.feed(&[&msg("user", "completed", "写长文", T0)], T0);
        s.feed(&[&msg("assistant", "generating", "", T0 + 1_000)], T0 + 1_000);
        assert!(s.confirm_quiet(T0 + 1_000 + STALE_MS - 1).is_none());
        let ev = s.confirm_quiet(T0 + 1_000 + STALE_MS).unwrap();
        assert_eq!(ev.state, "aborted");
        assert!(ev.quiet, "兜底收尾不补通知");
    }

    #[test]
    fn stale_running_without_structure_is_closed() {
        // 用户消息之后进程就没了：尾部只剩用户消息，同样只能靠兜底收尾
        let mut s = live();
        s.feed(&[&msg("user", "completed", "开工", T0)], T0);
        assert!(s.confirm_quiet(T0 + STALE_MS - 1).is_none());
        let ev = s.confirm_quiet(T0 + STALE_MS).unwrap();
        assert_eq!(ev.state, "aborted");
        assert!(ev.quiet);
        // 收过一次就不再重复
        assert!(s.confirm_quiet(T0 + 10 * STALE_MS).is_none());
    }

    #[test]
    fn long_tool_call_survives_short_noise_but_not_stale() {
        // 单次工具跑 20 分钟还在飞：不能提前判死
        let mut s = live();
        s.feed(&[&msg("user", "completed", "跑个长构建", T0)], T0);
        s.feed(&[&call_id(T0 + 1_000, "call_long")], T0 + 1_000);
        assert!(s.confirm_quiet(T0 + 1_000 + 20 * 60_000).is_none());
        let ev = s.confirm_quiet(T0 + 1_000 + STALE_MS).unwrap();
        assert_eq!(ev.state, "aborted");
        assert_eq!(s.open_calls(), 0, "判死的调用要清掉，别挡住下一轮");
        // 结果后来还是落盘了：下一轮照常从 running 起算
        let again = s.feed(&[&msg("user", "completed", "继续", T0 + 2 * STALE_MS)], T0 + 2 * STALE_MS);
        assert_eq!(again[0].state, "running");
    }

    #[test]
    fn running_is_reported_once_per_turn() {
        let mut s = live();
        s.feed(&[&meta("abc", T0)], T0);
        let first = s.feed(&[&msg("user", "completed", "一", T0)], T0);
        assert_eq!(first[0].state, "running");
        // 同一轮里再来一条用户消息：状态不重复提醒，但活动桶静默捎上（跨度跟着对话走）
        let second = s.feed(&[&msg("user", "completed", "二", T0 + 1_000)], T0 + 1_000);
        assert_eq!(second.len(), 1);
        assert!(second[0].quiet);
        assert_eq!(second[0].state, "running");
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
    fn injected_only_user_messages_do_not_become_titles() {
        let mut s = live();
        let cb = serde_json::json!({
            "type": "message", "role": "user", "status": "completed", "timestamp": T0,
            "content": [{"type": "input_text", "text": "<cb_summary> Summary of the conversation"}]
        })
        .to_string();
        let notified = serde_json::json!({
            "type": "message", "role": "user", "status": "completed", "timestamp": T0 + 1,
            "content": [{"type": "input_text", "text": "<task-notification> <task-id>NDuwWi</task-id> 已完成"}]
        })
        .to_string();
        let wrapped = serde_json::json!({
            "type": "message", "role": "user", "status": "completed", "timestamp": T0 + 2,
            "content": [{"type": "input_text", "text": "<system-reminder data-role=\"user-context\">注入</system-reminder>\n> <user_query>真正的提问</user_query>"}]
        })
        .to_string();
        s.feed(&[&cb, &notified, &wrapped], T0 + 2);
        assert_eq!(s.title.as_deref(), Some("真正的提问"));
    }

    #[test]
    fn activity_buckets_flow_with_events() {
        let mut s = live();
        let first = s.feed(&[&msg("user", "completed", "一", T0)], T0);
        assert_eq!(first[0].buckets.len(), 1);
        assert_eq!(first[0].buckets[0].count, 1);
        // 状态没变的后续轮次也要把桶捎上去（静默），跨度才不会停在上一轮
        let again = s.feed(&[&msg("user", "completed", "二", T0 + 60_000)], T0 + 60_000);
        assert_eq!(again.len(), 1);
        assert!(again[0].quiet);
        assert_eq!(again[0].buckets.len(), 1);
        assert_eq!(again[0].buckets[0].count, 1);
        // 桶已带走，纯助手回复不再上报
        assert!(s.feed(&[&msg("assistant", "completed", "答", T0 + 120_000)], T0 + 120_000).is_empty());
        let done = s.confirm_quiet(T0 + 120_000 + QUIET_MS).unwrap();
        assert_eq!(done.buckets.len(), 1);
    }

    #[test]
    fn scan_buckets_reads_message_timestamps() {
        let dir = std::env::temp_dir().join(format!("wb-scan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("scan.jsonl");
        std::fs::write(
            &p,
            format!(
                "{}\n{}\n{}\n{}\n",
                meta("scan", T0),
                msg("user", "completed", "问", T0 + 1000),
                titled("标题", T0 + 2000),
                msg("assistant", "completed", "答", T0 + 3000),
            ),
        )
        .unwrap();
        let ms = scan_buckets(&p, T0 - BACKFILL_MS);
        assert_eq!(ms, vec![T0 + 1000, T0 + 3000], "meta / 标题不算活动");
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn head_seeding_picks_up_title() {
        let dir = std::env::temp_dir().join(format!("wb-head-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("headabc.jsonl");
        std::fs::write(
            &p,
            format!("{}\n{}\n{}\n", meta("headabc", T0), titled("文件头标题", T0 + 10), msg("user", "completed", "问", T0 + 20)),
        )
        .unwrap();
        let mut st = new_state(&p);
        assert_eq!(st.session_id.as_deref(), Some("headabc"));
        seed_head(&p, &mut st);
        assert_eq!(st.title.as_deref(), Some("文件头标题"));
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_dir(&dir);
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

