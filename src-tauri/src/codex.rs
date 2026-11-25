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
/// mtime 在这个窗口内的文件才算「还活着」：更早的视为已结束，重扫时跳过不读
const RECENT: Duration = Duration::from_secs(24 * 3600);
/// 每 N 轮做一次全量重扫（N×POLL）。日期目录按会话创建日归档，续聊只往老目录里的文件追加，
/// 轻扫只看最近几天的目录会漏掉还在用的老会话；重扫补上这块，新会话仍由轻扫即时发现。
const RESCAN_TICKS: u32 = 10;

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
            // Codex Desktop 的 fork/子会话里 session_id 指向父线程，payload.id 才是本线程 id：
            // 文件名、session_index.jsonl、state_5.sqlite 用的也都是 payload.id。
            // 早先优先取 session_id 会把同一父线程下的所有子会话折叠成一条，
            // 之后按这个 key 找 rollout、按这个 id 查显示名都会错位。
            session_id: p.get("id").or_else(|| p.get("session_id")).and_then(|s| s.as_str()).map(String::from),
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
            bg_tasks: 0,
            buckets: Vec::new(),
           messages: Vec::new(),
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

/// 最近 `days` 天的日期目录
fn session_dirs(root: &Path, days: u64) -> Vec<PathBuf> {
    let today = chrono::Local::now().date_naive();
    (0..days)
        .map(|d| today - chrono::Days::new(d))
        .map(|day| {
            use chrono::Datelike;
            root.join(format!("{:04}", day.year())).join(format!("{:02}", day.month())).join(format!("{:02}", day.day()))
        })
        .filter(|p| p.is_dir())
        .collect()
}

/// 全部日期目录：不按日期截断，老目录里的文件也可能还在被续聊
fn all_session_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(years) = std::fs::read_dir(root) else { return out };
    for y in years.flatten() {
        let Ok(months) = std::fs::read_dir(y.path()) else { continue };
        for m in months.flatten() {
            let Ok(days) = std::fs::read_dir(m.path()) else { continue };
            for d in days.flatten() {
                if d.path().is_dir() {
                    out.push(d.path());
                }
            }
        }
    }
    out
}

/// 目录集合里的 rollout 文件，只保留 RECENT 窗口内改过的
fn rollouts_in(dirs: &[PathBuf], now: SystemTime) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
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

/// 轻扫：最近三天的日期目录。新会话都落在这三个目录里，每轮都扫，保证即时发现
fn recent_rollouts(root: &Path) -> Vec<PathBuf> {
    rollouts_in(&session_dirs(root, 3), SystemTime::now())
}

/// 重扫：全部日期目录。老会话复活（续聊）时文件还在老目录里，只有走到这里才能被重新发现
fn all_rollouts(root: &Path) -> Vec<PathBuf> {
    rollouts_in(&all_session_dirs(root), SystemTime::now())
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
        let mut tick: u32 = 0;
        loop {
            tick = tick.wrapping_add(1);
            let names = root.parent().and_then(|p| std::fs::read_to_string(p.join("session_index.jsonl")).ok())
                .map(|s| crate::reconcile::titles(&s)).unwrap_or_default();
            // 重扫轮直接用全量结果替换轻扫结果（全量是轻扫的超集），已跟踪文件的 offset 在 map 里不会丢
            let paths = if tick == 1 || tick % RESCAN_TICKS == 0 {
                all_rollouts(&root)
            } else {
                recent_rollouts(&root)
            };
            for path in paths {
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

// ---------------------------------------------------------------- thread writer 锁

/// Codex 给每个活跃 thread 在 `~/.codex/thread-writer-locks/<threadId>.lock` 放一把 writer 锁，
/// 同一 thread 不允许两个客户端同时写入（第二个 resume 会报 "already has an active writer"）。
/// 发消息前探一下，能在 UI 上提前告诉用户「这个会话被别的 Codex 客户端占着」。
/// 返回："free"（没锁）/ "occupied"（有活进程握着）/ "stale"（残留锁，持有进程已退出）。
pub fn thread_writer_status(key: &str) -> &'static str {
    // thread id 是 UUID，只放行字母数字和连字符，防路径拼接意外
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return "free";
    }
    let Some(path) = home_dir().map(|h| h.join(".codex").join("thread-writer-locks").join(format!("{key}.lock"))) else {
        return "free";
    };
    // 探测方式：以「独占共享」打开锁文件。
    // 有活进程握着句柄（Codex 持有期间一直开着）→ 打不开 → occupied；
    // 只是进程退出没清理的残留文件 → 能打开 → stale（Codex 自己 resume 前也会清这种）。
    probe_lock(&path)
}

#[cfg(windows)]
fn probe_lock(path: &Path) -> &'static str {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(path) {
        Ok(_) => "stale",
        Err(_) => "occupied",
    }
}

#[cfg(unix)]
fn probe_lock(path: &Path) -> &'static str {
    use std::io::Write;
    use std::os::unix::io::AsRawFd;
    let mut f = match std::fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(_) => return "occupied",
    };
    // Unix 上 Codex 用 flock：能拿到排他锁说明没有别的进程握着
    let held = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0;
    if !held {
        let _ = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
        let _ = f.flush();
    }
    if held { "occupied" } else { "stale" }
}

#[cfg(not(any(windows, unix)))]
fn probe_lock(_path: &Path) -> &'static str {
    // 其他平台没有探测句柄的手段，退化为「有锁文件就当被占用」
    "occupied"
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
    fn forked_session_uses_thread_id_not_parent_session_id() {
        // Codex Desktop 0.169+：fork 出来的子线程里 session_id 是父线程 id，
        // payload.id / 文件名 / session_index.jsonl / state_5.sqlite 才是本线程 id。
        let fork = r#"{"timestamp":"2026-11-18T10:00:00.000Z","type":"session_meta","payload":{"id":"child-1","session_id":"parent-1","parent_thread_id":"parent-1","cwd":"D:/Work","originator":"Codex Desktop"}}"#;
        assert_eq!(parse_line(fork), Some(Line::Meta { session_id: Some("child-1".into()), cwd: "D:/Work".into() }));
        // 旧格式只有 session_id 时仍能登记
        assert_eq!(parse_line(META), Some(Line::Meta { session_id: Some("abc-123".into()), cwd: "D:\\Work2\\Demo".into() }));
        let mut st = FileState::new(Some("child-1".into()));
        let evs = st.feed(&[fork, DONE], true, "now");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].session_id, "child-1");
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
    fn rescan_reaches_active_rollouts_in_old_date_dirs() {
        // rollout 按创建日期归档，续聊只往老文件追加：老目录里 mtime 还热的文件
        // 轻扫看不见（这正是当初漏掉持续使用的老会话的洞），重扫必须捞回来
        let root = std::env::temp_dir().join(format!("agenthub-cx-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        use chrono::Datelike;
        let today = chrono::Local::now().date_naive();
        let new_dir = root.join(format!("{:04}", today.year())).join(format!("{:02}", today.month())).join(format!("{:02}", today.day()));
        let old = today - chrono::Months::new(12);
        let old_dir = root.join(format!("{:04}", old.year())).join(format!("{:02}", old.month())).join(format!("{:02}", old.day()));
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::create_dir_all(&old_dir).unwrap();
        let fresh_new = new_dir.join("rollout-new.jsonl");
        let fresh_old = old_dir.join("rollout-resumed.jsonl");
        let dead = old_dir.join("rollout-dead.jsonl");
        std::fs::write(&fresh_new, "").unwrap();
        std::fs::write(&fresh_old, "").unwrap();
        std::fs::write(&dead, "").unwrap();
        // dead 冷了三天：不该被任何一轮扫到
        let f = std::fs::File::options().write(true).open(&dead).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(3 * 86400)).unwrap();
        drop(f);

        let recent = recent_rollouts(&root);
        assert!(recent.contains(&fresh_new), "轻扫要看到新目录里的文件");
        assert!(!recent.contains(&fresh_old), "轻扫看不到老目录——轻扫本来就不负责这里");

        let all = all_rollouts(&root);
        assert!(all.contains(&fresh_new));
        assert!(all.contains(&fresh_old), "重扫必须捞回老目录里还在续聊的文件");
        assert!(!all.contains(&dead), "冷掉的老文件不该被重扫捞回来");

        let _ = std::fs::remove_dir_all(&root);
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
