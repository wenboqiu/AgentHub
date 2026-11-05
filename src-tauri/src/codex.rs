//! Codex：轮询 ~/.codex/sessions 下的 rollout 会话文件（不碰 config.toml）

use crate::activity::{buckets_of, capped, ms_of_iso, LOOKBACK_MS};
use crate::claude::{home_dir, truncate_chars};
use crate::forwarder::{Event, Forwarder};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const POLL: Duration = Duration::from_secs(2);
const RECENT: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug, PartialEq)]
pub enum Line {
    Meta { session_id: Option<String>, cwd: String },
    Status { state: &'static str, summary: Option<String>, at: String },
    UserText(String),
}

/// 解析一行 rollout；只关心几种类型，其它一律忽略
pub fn parse_line(line: &str) -> Option<Line> {
    // 大行很常见（response_item），先用子串粗筛，免得每行都完整解析
    let interesting = ["session_meta", "task_started", "task_complete", "turn_aborted", "response_item"];
    if !interesting.iter().any(|k| line.contains(k)) {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let at = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let p = v.get("payload")?;
    match v.get("type")?.as_str()? {
        "session_meta" => Some(Line::Meta {
            session_id: p.get("session_id").or_else(|| p.get("id")).and_then(|s| s.as_str()).map(String::from),
            cwd: p.get("cwd").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        }),
        "event_msg" => match p.get("type")?.as_str()? {
            "task_started" => Some(Line::Status { state: "running", summary: None, at }),
            "task_complete" => Some(Line::Status {
                state: "done",
                summary: p.get("last_agent_message").and_then(|s| s.as_str()).map(|s| truncate_chars(s.trim(), 300)),
                at,
            }),
            "turn_aborted" => Some(Line::Status { state: "aborted", summary: None, at }),
            _ => None,
        },
        "response_item" if p.get("role").and_then(|r| r.as_str()) == Some("user") => {
            let parts = p.get("content")?.as_array()?;
            parts.iter().find_map(|c| {
                let t = c.get("text")?.as_str()?.trim();
                // 跳过注入的环境上下文（<environment_context>）和 AGENTS.md 指令全文，取真正的提问
                (!t.is_empty() && !t.starts_with('<') && !t.starts_with("# AGENTS.md")).then(|| t.to_string())
            })
            .map(Line::UserText)
        }
        _ => None,
    }
}

/// buf 里「完整行」的字节数（到最后一个换行为止）；末尾不完整的行留到下次
pub fn complete_prefix_len(buf: &[u8]) -> usize {
    buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1)
}

#[derive(Default)]
pub struct FileState {
    offset: u64,
    session_id: Option<String>,
    cwd: String,
    title: Option<String>,
    /// 还没随事件上报的消息时间戳（ms）：时间轴的活动分段与对话跨度靠它
    pending: Vec<i64>,
}

impl FileState {
    pub fn new(fallback_id: Option<String>) -> Self {
        FileState { session_id: fallback_id, ..Default::default() }
    }

    /// 活动桶跟着状态事件一起走：Codex 没有 hook，不发这个日历上就没有跨度
    fn attach_buckets(&mut self, out: &mut [Event], now: &str) {
        let Some(last) = out.last_mut() else { return };
        if self.pending.is_empty() {
            return;
        }
        let cutoff = ms_of_iso(now).map(|n| n - LOOKBACK_MS).unwrap_or(0);
        let ms: Vec<i64> = self.pending.drain(..).filter(|m| *m >= cutoff).collect();
        if ms.is_empty() {
            return;
        }
        last.buckets = capped(buckets_of(&ms));
    }

    /// 喂入新增的完整行。首次（first）只上报最终状态一次且 quiet；之后每个状态变化都上报
    pub fn feed(&mut self, lines: &[&str], first: bool, now: &str) -> Vec<Event> {
        let mut out: Vec<Event> = Vec::new();
        let mut last_at = String::new();
        for l in lines {
            if let Some(ms) = activity_ms(l) {
                if self.pending.len() < 20_000 {
                    self.pending.push(ms);
                }
            }
            match parse_line(l) {
                Some(Line::Meta { session_id, cwd }) => {
                    if session_id.is_some() {
                        self.session_id = session_id;
                    }
                    if !cwd.is_empty() {
                        self.cwd = cwd;
                    }
                }
                Some(Line::UserText(t)) => {
                    if self.title.is_none() {
                        let flat = t.split_whitespace().collect::<Vec<_>>().join(" ");
                        self.title = Some(truncate_chars(&flat, 80));
                    }
                }
                Some(Line::Status { state, summary, at }) => {
                    last_at = at.clone();
                    out.push(self.event(state, summary, at, first, now));
                }
                None => {}
            }
        }
        if first {
            // 只保留最终状态；一个状态都没有就以 idle 登记会话
            let ev = match out.pop() {
                Some(mut e) => {
                    e.title = self.title.clone();
                    e.cwd = self.cwd.clone();
                    e
                }
                None => self.event("idle", None, if last_at.is_empty() { now.to_string() } else { last_at }, true, now),
            };
            let mut evs = if self.session_id.is_some() { vec![ev] } else { vec![] };
            self.attach_buckets(&mut evs, now);
            return evs;
        }
        self.attach_buckets(&mut out, now);
        out
    }

    fn event(&self, state: &str, summary: Option<String>, at: String, quiet: bool, now: &str) -> Event {
        Event {
            agent: "codex".into(),
            session_id: self.session_id.clone().unwrap_or_default(),
            machine: String::new(),
            cwd: self.cwd.clone(),
            state: state.into(),
            at: if at.is_empty() { now.to_string() } else { at },
            title: self.title.clone(),
            summary,
            pid: None,
            quiet,
            buckets: Vec::new(),
        }
    }
}

/// 消息行算活动（user / assistant），工具调用与元数据不算：日历画的是"有人在动"的节奏。
/// 整行解析一次即可，rollout 每条 response_item 本来就要过一遍 parse_line。
fn activity_ms(line: &str) -> Option<i64> {
    if !line.contains("\"response_item\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let role = v.get("payload")?.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    ms_of_iso(v.get("timestamp")?.as_str()?)
}

fn session_dirs(root: &Path) -> Vec<PathBuf> {
    let today = chrono::Local::now().date_naive();
    (0..3)
        .map(|d| today - chrono::Days::new(d))
        .map(|day| {
            use chrono::Datelike;
            root.join(format!("{:04}", day.year())).join(format!("{:02}", day.month())).join(format!("{:02}", day.day()))
        })
        .filter(|p| p.is_dir())
        .collect()
}

fn recent_rollouts(root: &Path) -> Vec<PathBuf> {
    let now = SystemTime::now();
    let mut files = Vec::new();
    for dir in session_dirs(root) {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                continue;
            }
            let fresh = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| now.duration_since(t).map(|d| d < RECENT).unwrap_or(true))
                .unwrap_or(false);
            if fresh {
                files.push(p);
            }
        }
    }
    files
}

/// 文件名 rollout-<时间>-<uuid>.jsonl 里取 uuid（后 36 个字符），仅在没读到 session_meta 时兜底
fn id_from_name(p: &Path) -> Option<String> {
    let stem = p.file_stem()?.to_string_lossy().into_owned();
    (stem.len() >= 36).then(|| stem[stem.len() - 36..].to_string())
}

/// 从 offset 读到文件尾，返回完整行与新偏移
fn read_new_lines(path: &Path, offset: u64) -> Option<(Vec<String>, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len <= offset {
        return Some((vec![], len.min(offset)));
    }
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut reader = BufReader::new(f);
    let mut lines = Vec::new();
    let mut consumed = 0u64;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).ok()?;
        if n == 0 || complete_prefix_len(&buf) != buf.len() {
            break; // 文件尾或不完整的行
        }
        consumed += n as u64;
        lines.push(String::from_utf8_lossy(&buf).trim_end().to_string());
    }
    Some((lines, offset + consumed))
}

pub fn spawn(fwd: Forwarder) {
    let Some(root) = home_dir().map(|h| h.join(".codex").join("sessions")) else { return };
    std::thread::spawn(move || {
        let mut files: HashMap<PathBuf, FileState> = HashMap::new();
        loop {
            let names = root.parent().and_then(|p| std::fs::read_to_string(p.join("session_index.jsonl")).ok())
                .map(|s| crate::reconcile::titles(&s)).unwrap_or_default();
            for path in recent_rollouts(&root) {
                let first = !files.contains_key(&path);
                let st = files.entry(path.clone()).or_insert_with(|| FileState::new(id_from_name(&path)));
                if let Some(name) = st.session_id.as_ref().and_then(|id| names.get(id)) {
                    st.title = Some(name.clone());
                }
                let Some((lines, new_off)) = read_new_lines(&path, st.offset) else { continue };
                st.offset = new_off;
                if lines.is_empty() && !first {
                    continue;
                }
                let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
                let now = crate::claude::now_iso();
                for ev in st.feed(&refs, first, &now) {
                    fwd.push(ev);
                }
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &str = r#"{"timestamp":"2026-10-31T01:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"abc-123","cwd":"D:\\Work2\\Demo","originator":"Codex Desktop"}}"#;
    const USER: &str = r#"{"timestamp":"2026-10-31T01:00:01.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"},{"type":"input_text","text":"帮我修个 bug"}]}}"#;
    const START: &str = r#"{"timestamp":"2026-10-31T01:00:02.000Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started"}}"#;
    const ITEM: &str = r#"{"timestamp":"2026-10-31T01:00:03.000Z","ordinal":3,"type":"event_msg","payload":{"type":"item_completed"}}"#;
    const DONE: &str = r#"{"timestamp":"2026-10-31T01:00:09.000Z","ordinal":4,"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"改好了"}}"#;
    const ABORT: &str = r#"{"timestamp":"2026-10-31T01:01:00.000Z","ordinal":5,"type":"event_msg","payload":{"type":"turn_aborted"}}"#;

    #[test]
    fn parses_known_lines_and_ignores_others() {
        assert_eq!(parse_line(META), Some(Line::Meta { session_id: Some("abc-123".into()), cwd: "D:\\Work2\\Demo".into() }));
        assert_eq!(parse_line(USER), Some(Line::UserText("帮我修个 bug".into())));
        // AGENTS.md 指令全文也是 response_item，但不能当标题
        let agents = r##"{"timestamp":"2026-10-31T01:00:01.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions <INSTRUCTIONS> # 全局偏好"},{"type":"input_text","text":"新建图标"}]}}"##;
        assert_eq!(parse_line(agents), Some(Line::UserText("新建图标".into())));
        assert!(matches!(parse_line(START), Some(Line::Status { state: "running", .. })));
        assert_eq!(parse_line(ITEM), None);
        match parse_line(DONE) {
            Some(Line::Status { state: "done", summary, .. }) => assert_eq!(summary.as_deref(), Some("改好了")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_line(ABORT), Some(Line::Status { state: "aborted", .. })));
        assert_eq!(parse_line(r#"{"type":"token_count","payload":{}}"#), None);
    }

    #[test]
    fn running_then_done_with_summary() {
        let mut st = FileState::new(None);
        // 首次不是第一次扫描时：逐条上报
        let evs = st.feed(&[META, USER, START, ITEM, DONE], false, "now");
        let states: Vec<_> = evs.iter().map(|e| e.state.as_str()).collect();
        assert_eq!(states, ["running", "done"]);
        assert_eq!(evs[1].summary.as_deref(), Some("改好了"));
        assert_eq!(evs[1].session_id, "abc-123");
        assert_eq!(evs[1].cwd, "D:\\Work2\\Demo");
        assert_eq!(evs[1].title.as_deref(), Some("帮我修个 bug"));
        assert!(!evs[0].quiet && !evs[1].quiet);
        assert_eq!(evs[1].agent, "codex");
    }

    #[test]
    fn first_scan_reports_only_final_state_quietly() {
        let mut st = FileState::new(None);
        let evs = st.feed(&[META, USER, START, ITEM, DONE, ABORT], true, "now");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].state, "aborted");
        assert!(evs[0].quiet);
        assert_eq!(evs[0].title.as_deref(), Some("帮我修个 bug"));
        assert_eq!(evs[0].at, "2026-10-31T01:01:00.000Z");

        // 没有任何状态行：以 idle 登记
        let mut st = FileState::new(None);
        let evs = st.feed(&[META], true, "now");
        assert_eq!((evs.len(), evs[0].state.as_str(), evs[0].quiet), (1, "idle", true));
    }

    #[test]
    fn activity_buckets_ride_on_the_status_event_once() {
        let mut st = FileState::new(None);
        let evs = st.feed(&[META, USER, START, DONE], false, "2026-10-31T01:05:00.000Z");
        // 只有最后一个状态事件带桶，避免同一批活动重复上报
        assert_eq!(evs.iter().filter(|e| !e.buckets.is_empty()).count(), 1);
        assert_eq!(evs.last().unwrap().buckets.iter().map(|b| b.count).sum::<u32>(), 1);
        // 上报后清空：状态没变时不会凭空再带一份
        let more = st.feed(&[START], false, "2026-10-31T01:06:00.000Z");
        assert!(more.iter().all(|e| e.buckets.is_empty()));
    }

    #[test]
    fn incomplete_trailing_line_is_left_for_next_time() {
        let text = format!("{START}\n{DONE}\n{{\"timestamp\":\"x\",\"type\":\"event_");
        let n = complete_prefix_len(text.as_bytes());
        assert_eq!(&text[..n], format!("{START}\n{DONE}\n"));
        assert_eq!(complete_prefix_len(b"no newline yet"), 0);

        // 实际读文件：偏移只前进到最后一个完整行
        let dir = std::env::temp_dir().join(format!("agenthub-cx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rollout-x.jsonl");
        std::fs::write(&p, &text).unwrap();
        let (lines, off) = read_new_lines(&p, 0).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(off as usize, n);
        let _ = std::fs::remove_dir_all(dir);
    }
}
