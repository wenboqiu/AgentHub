//! WorkBuddy 已读同步：只读 `~/.workbuddy/workbuddy.db` 的 `sessions.unread`。
//!
//! 问题和 Codex 一样：AgentHub 的 `acked` 只由自己的「已处理」按钮或新一轮运行更新，
//! 在 WorkBuddy 里看完回复不会产生任何事件，待处理提醒就一直挂着。
//!
//! 证据来源：WorkBuddy 桌面端把「这条会话还有没看过的新内容」记在 sqlite 的
//! `sessions.unread`（0 = 已读，1 = 未读）。只读打开，不写它的库。
//!
//! 只敢确认同时满足下面几条的那一轮：
//! - 这一轮是 `done` / `aborted`（待授权要人拍板，不在此列），且服务端还没确认；
//! - 库里那条会话 `unread = 0`；
//! - 库里最后一次活动时间不晚于这一轮的完成时间（晚于说明后面又动过，已读指的是新内容）；
//! - 库文件的保存时间不早于完成时间（早于说明清未读的那次写入在完成之前，不算数）；
//! - 连续两次核对（间隔 ≥ 15 秒）结论一致：WorkBuddy 处理完一轮时未读标记会有一小段还是 0，
//!   只看一眼就上报会误清。
//!
//! 任何一步读不到（库不在、表变了、文件被锁）都按「没有证据」处理，保持原状。

use crate::runner;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Duration,
};

/// 同一个结论要连续两次核对一致才上报
const STABLE: Duration = Duration::from_secs(15);
/// db 的活动时间与 transcript 末条时间戳有毫秒级先后，留一点余量
const SLACK_MS: i64 = 5_000;
/// 只读打开别死等：WorkBuddy 正在写库时最多等半秒
const BUSY_MS: u64 = 500;

struct Snapshot {
    /// 已读（unread = 0）的会话：id → 最后一次活动时间（ms）
    read: HashMap<String, i64>,
    /// 库文件的保存时间：作为「这次已读发生在什么时候」的证据
    persisted_at: DateTime<Utc>,
}

impl Snapshot {
    /// 库文件（含 `-wal`）的保存时间：WAL 模式下写入先落 `-wal`，主库要到 checkpoint 才更新，
    /// 只看主库会把「刚读过」误判成「库还没动过」
    fn persisted_at(path: &Path) -> Option<DateTime<Utc>> {
        let mut latest = std::fs::metadata(path).ok()?.modified().ok()?;
        if let Some(wal) = std::fs::metadata(path.with_extension("db-wal")).ok().and_then(|m| m.modified().ok()) {
            latest = latest.max(wal);
        }
        Some(latest.into())
    }

    fn load(home: &Path) -> Option<Self> {
        let path = home.join(".workbuddy").join("workbuddy.db");
        let persisted_at = Self::persisted_at(&path)?;
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        conn.busy_timeout(Duration::from_millis(BUSY_MS)).ok()?;
        let mut st = conn.prepare("SELECT id, last_activity_at FROM sessions WHERE unread = 0").ok()?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))
            .ok()?;
        let read = rows
            .filter_map(Result::ok)
            .filter_map(|(id, activity)| activity.map(|ms| (id, ms)))
            .collect();
        Some(Self { read, persisted_at })
    }
}

#[derive(Default)]
pub struct ReadSync {
    /// 候选：会话 id → (完成时间, 第一次核对的时刻)
    candidates: HashMap<String, (String, DateTime<Utc>)>,
}

impl ReadSync {
    fn receipt(&mut self, snapshot: &Snapshot, s: &Value, now: DateTime<Utc>) -> Option<Value> {
        let id = s["id"].as_str()?;
        let key = id.strip_prefix("workbuddy:")?;
        let at = s["eventAt"].as_str()?;
        let event_at = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc);
        let eligible = runner::valid_key(key)
            && snapshot
                .read
                .get(key)
                .is_some_and(|ms| *ms <= event_at.timestamp_millis() + SLACK_MS)
            && snapshot.persisted_at >= event_at;
        if !eligible {
            self.candidates.remove(id);
            return None;
        }
        let first = match self.candidates.get(id) {
            Some((candidate_at, first)) if candidate_at == at => *first,
            _ => {
                self.candidates.insert(id.to_owned(), (at.to_owned(), now));
                return None;
            }
        };
        if now.signed_duration_since(first).num_seconds() < STABLE.as_secs() as i64 {
            return None;
        }
        Some(json!({"agent":"workbuddy","sessionId":key,"machine":s["machine"],"cwd":s["cwd"],
            "state":s["state"],"at":at,"expectedAt":at,"readAt":snapshot.persisted_at.to_rfc3339(),"quiet":true}))
    }

    fn events_at(&mut self, home: &Path, sessions: &[Value], now: DateTime<Utc>) -> Vec<Value> {
        let Some(snapshot) = Snapshot::load(home) else {
            self.candidates.clear();
            return vec![];
        };
        let known: HashSet<&str> = sessions.iter().filter_map(|s| s["id"].as_str()).collect();
        self.candidates.retain(|id, _| known.contains(id.as_str()));
        let mut events = vec![];
        for s in sessions {
            let Some(id) = s["id"].as_str() else { continue };
            if !id.starts_with("workbuddy:") {
                continue;
            }
            if s["acked"] != false || !matches!(s["state"].as_str(), Some("done" | "aborted")) {
                // 已处理 / 还在跑 / 等授权：没有可确认的完成提醒
                self.candidates.remove(id);
                continue;
            }
            if let Some(ev) = self.receipt(&snapshot, s, now) {
                events.push(ev);
            }
        }
        events
    }

    pub fn events(&mut self, home: &Path, sessions: &[Value]) -> Vec<Value> {
        self.events_at(home, sessions, Utc::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const T0: i64 = 1_793_590_000_000;

    fn iso(ms: i64) -> String {
        DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339()
    }

    /// 至少隔一次轮询（15 秒）的下一拍
    fn next(now: DateTime<Utc>) -> DateTime<Utc> {
        now + chrono::Duration::seconds(15)
    }

    /// 造一个临时 home，里面放一张只有 id / unread / last_activity_at 的 sessions 表
    fn home(rows: &[(&str, i64, Option<i64>)]) -> std::path::PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "wb-read-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".workbuddy")).unwrap();
        let conn = Connection::open(dir.join(".workbuddy/workbuddy.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, unread INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER);",
        )
        .unwrap();
        for (id, unread, activity) in rows {
            conn.execute(
                "INSERT INTO sessions (id, unread, last_activity_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, unread, activity],
            )
            .unwrap();
        }
        dir
    }

    fn session(key: &str, state: &str, acked: bool, at: i64) -> Value {
        json!({"id":format!("workbuddy:{key}"),"agent":"workbuddy","machine":"pc",
            "cwd":"/w","state":state,"acked":acked,"eventAt":iso(at)})
    }

    #[test]
    fn unread_cleared_reply_is_acknowledged_after_two_consistent_checks() {
        let dir = home(&[("abc", 0, Some(T0))]);
        let mut sync = ReadSync::default();
        let s = session("abc", "done", false, T0);
        let t = Utc::now();
        assert!(sync.events_at(&dir, &[s.clone()], t).is_empty(), "第一次只记候选");
        // 还是同一轮、仍未读=0：才发回执
        let ev = sync.events_at(&dir, &[s], next(t)).pop().unwrap();
        assert_eq!(ev["agent"], "workbuddy");
        assert_eq!(ev["sessionId"], "abc");
        assert_eq!(ev["expectedAt"], iso(T0));
        assert_eq!(ev["quiet"], true);
        assert!(ev["readAt"].as_str().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unread_sessions_keep_the_reminder() {
        let dir = home(&[("abc", 1, Some(T0))]);
        let mut sync = ReadSync::default();
        let s = session("abc", "done", false, T0);
        let t = Utc::now();
        assert!(sync.events_at(&dir, &[s.clone()], t).is_empty());
        assert!(sync.events_at(&dir, &[s], next(t)).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn later_activity_or_unknown_session_is_not_evidence() {
        // 库里最后一次活动晚于这一轮完成：已读指的是后面的新内容
        let dir = home(&[("abc", 0, Some(T0 + 60_000))]);
        let mut sync = ReadSync::default();
        let s = session("abc", "done", false, T0);
        let t = Utc::now();
        assert!(sync.events_at(&dir, &[s.clone()], t).is_empty());
        assert!(sync.events_at(&dir, &[s], next(t)).is_empty());
        // 库里根本没有这条会话（可能已被删）：不当证据
        let dir2 = home(&[("other", 0, Some(T0))]);
        let mut sync = ReadSync::default();
        let s = session("abc", "done", false, T0);
        assert!(sync.events_at(&dir2, &[s.clone()], t).is_empty());
        assert!(sync.events_at(&dir2, &[s], next(t)).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn approvals_and_running_sessions_are_never_acknowledged() {
        let dir = home(&[("abc", 0, Some(T0))]);
        let mut sync = ReadSync::default();
        let t = Utc::now();
        for s in [
            session("abc", "waiting", false, T0),
            session("abc", "running", false, T0),
            session("abc", "done", true, T0),
        ] {
            assert!(sync.events_at(&dir, &[s.clone()], t).is_empty());
            assert!(sync.events_at(&dir, &[s], next(t)).is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn older_snapshot_than_the_completion_is_ignored() {
        // 完成时间在未来 = 库文件还没保存过这次已读：不算证据
        let dir = home(&[("abc", 0, Some(T0))]);
        let mut sync = ReadSync::default();
        let future = Utc::now().timestamp_millis() + 3_600_000;
        let s = session("abc", "done", false, future);
        let t = Utc::now();
        assert!(sync.events_at(&dir, &[s.clone()], t).is_empty());
        assert!(sync.events_at(&dir, &[s], next(t)).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn candidate_is_dropped_when_the_session_goes_unread_again() {
        let dir = home(&[("abc", 0, Some(T0))]);
        let db = dir.join(".workbuddy/workbuddy.db");
        let mut sync = ReadSync::default();
        let s = session("abc", "done", false, T0);
        let t = Utc::now();
        assert!(sync.events_at(&dir, &[s.clone()], t).is_empty());
        // 中途回到未读：候选作废
        Connection::open(&db).unwrap().execute("UPDATE sessions SET unread = 1", []).unwrap();
        assert!(sync.events_at(&dir, &[s.clone()], next(t)).is_empty());
        // 再读回来也要重新攒两拍，不能接着上一拍直接确认
        Connection::open(&db).unwrap().execute("UPDATE sessions SET unread = 0", []).unwrap();
        assert!(sync.events_at(&dir, &[s], next(next(t))).is_empty(), "重新攒第一拍");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "只读本机真实 workbuddy.db 的兼容性检查；设置 AGENTHUB_WORKBUDDY_HOME"]
    fn installed_read_state() {
        let home = std::path::PathBuf::from(
            std::env::var_os("AGENTHUB_WORKBUDDY_HOME").expect("需要 home 目录（含 .workbuddy/workbuddy.db）"),
        );
        let snapshot = Snapshot::load(&home).expect("读不到已读标记：库不在、被锁或表结构变了");
        assert!(!snapshot.read.is_empty(), "一条已读会话都没有，表结构可能变了");
        eprintln!("已读会话 {} 条，库保存于 {}", snapshot.read.len(), snapshot.persisted_at);
    }
}
