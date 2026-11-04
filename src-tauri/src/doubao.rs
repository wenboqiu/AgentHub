//! Read-only adapter for Doubao Desktop's structured lifecycle logs (2.32.6).
//! Never infers completion from silence or imports cookies / request URLs.
use crate::{
    claude::{home_dir, truncate_chars},
    forwarder::{Event, Forwarder},
};
use chrono::{Datelike, Local, NaiveDateTime, TimeZone};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

const INITIAL_BYTES: u64 = 8 * 1024 * 1024;
const READ_BYTES: u64 = 4 * 1024 * 1024;
const MARKER: &str = "[logifier-report]: ";

#[derive(Default)]
struct Sessions {
    latest: HashMap<String, Event>,
}

impl Sessions {
    fn feed(&mut self, line: &str, year: i32, quiet: bool) -> Option<Event> {
        let start = line.find(MARKER)? + MARKER.len();
        let end = line.rfind('}')? + 1;
        let v: Value = serde_json::from_str(line.get(start..end)?).ok()?;
        let m = v.get("meta")?;
        let id = m.get("conversation_id")?.as_str()?;
        // New chats have no server ID until sending finishes; never create a second local session.
        if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let stamp = line.split(':').nth(2)?;
        let date =
            NaiveDateTime::parse_from_str(&format!("{year}{stamp}"), "%Y%m%d/%H%M%S%.f").ok()?;
        let at = Local
            .from_local_datetime(&date)
            .single()?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
        let name = v.get("message")?.as_str()?;
        let old = self.latest.get(id);
        if old.is_some_and(|e| e.at > at) {
            return None;
        }
        let mut title = old.and_then(|e| e.title.clone());
        let metadata_only = name.starts_with("Cmd: Conversation");
        let state = match name {
            "on_message_sending_end" | "on_message_receiving_start" => "running",
            "on_message_session_end" => {
                if m.get("session_success").and_then(Value::as_str) == Some("0")
                    || m.get("cancel_source")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                {
                    "aborted"
                } else if m.get("session_success").and_then(Value::as_str) == Some("1") {
                    "done"
                } else {
                    "unknown"
                }
            }
            "Cmd: ConversationAdd" | "Cmd: ConversationUpdate" => {
                let info: Value =
                    serde_json::from_str(m.get("conversation_info")?.as_str()?).ok()?;
                title = info
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|s| truncate_chars(s, 200))
                    .or(title);
                old.map_or("unknown", |e| e.state.as_str())
            }
            _ => return None,
        };
        if old.is_some_and(|e| e.state == state && e.title == title) {
            return None;
        }
        let event = Event {
            agent: "doubao".into(),
            session_id: id.into(),
            machine: String::new(),
            cwd: String::new(),
            state: state.into(),
            at,
            title,
            summary: None,
            pid: None,
            quiet: quiet || metadata_only,
            buckets: Vec::new(),
        };
        self.latest.insert(id.into(), event.clone());
        Some(event)
    }
}

fn log_files(root: &Path) -> Vec<PathBuf> {
    let today = Local::now().date_naive();
    let mut files: Vec<_> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                (0..2).any(|d| {
                    n.starts_with(&format!(
                        "saman_{}.",
                        (today - chrono::Days::new(d)).format("%Y.%m%d")
                    ))
                }) && n.ends_with(".log")
            })
        })
        .collect();
    // Numeric rotation suffix: .10 comes after .9.
    files.sort_by_key(|p| {
        let n = p.file_stem().unwrap().to_string_lossy();
        (
            n.split('.').take(2).collect::<Vec<_>>().join("."),
            n.rsplit('.')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0),
        )
    });
    files
}

pub fn spawn(fwd: Forwarder) {
    std::thread::spawn(move || {
        let Some(home) = home_dir() else { return };
        let root = home.join("AppData/Local/Doubao/User Data/sdk_storage/log");
        let mut offsets = HashMap::<PathBuf, u64>::new();
        let mut sessions = Sessions::default();
        let mut initial = true;
        loop {
            let files = log_files(&root);
            offsets.retain(|p, _| files.contains(p));
            for path in files {
                let Ok(mut file) = std::fs::File::open(&path) else {
                    continue;
                };
                let Ok(meta) = file.metadata() else { continue };
                let len = meta.len();
                let offset = offsets.entry(path.clone()).or_insert_with(|| {
                    if initial {
                        len.saturating_sub(INITIAL_BYTES)
                    } else {
                        0
                    }
                });
                if *offset > len {
                    *offset = 0;
                }
                if file.seek(SeekFrom::Start(*offset)).is_err() {
                    continue;
                }
                let mut buf = Vec::new();
                if file
                    .take(if initial { INITIAL_BYTES } else { READ_BYTES })
                    .read_to_end(&mut buf)
                    .is_err()
                {
                    continue;
                }
                let complete = crate::codex::complete_prefix_len(&buf);
                let year = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.get(6..10))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(Local::now().year());
                for line in String::from_utf8_lossy(&buf[..complete]).lines() {
                    if let Some(event) = sessions.feed(line, year, initial) {
                        if !initial {
                            fwd.push(event);
                        }
                    }
                }
                *offset += complete as u64;
                // Skip a pathological oversized line; a normal partial line waits for its newline.
                if complete == 0 && buf.len() as u64 == READ_BYTES {
                    *offset += READ_BYTES;
                }
            }
            if initial {
                for event in sessions.latest.values_mut() {
                    if event.state == "running" {
                        event.state = "unknown".into();
                    }
                    fwd.push(event.clone());
                }
                initial = false;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn log(name: &str, meta: Value) -> String {
        format!(
            "[12:34:1101/161012.235:INFO:CONSOLE(0)] {MARKER}{}\", source: (0)",
            serde_json::json!({"message":name,"meta":meta})
        )
    }
    #[test]
    fn lifecycle_and_duplicate_logs() {
        let mut s = Sessions::default();
        let start = log(
            "on_message_sending_end",
            serde_json::json!({"conversation_id":"123"}),
        );
        let e = s.feed(&start, 2026, false).unwrap();
        assert_eq!(e.state, "running");
        assert!(e.at.contains("2026-11-01T16:10:12.235"));
        assert!(s.feed(&start, 2026, false).is_none());
        // Individual message end is not the end of an agent session.
        assert!(s
            .feed(
                &log(
                    "on_message_receiving_end",
                    serde_json::json!({"conversation_id":"123"})
                ),
                2026,
                false
            )
            .is_none());
        assert_eq!(
            s.feed(
                &log(
                    "on_message_session_end",
                    serde_json::json!({"conversation_id":"123","session_success":"1"})
                ),
                2026,
                false
            )
            .unwrap()
            .state,
            "done"
        );
    }
    #[test]
    fn title_does_not_reset_state_and_invalid_data_is_ignored() {
        let mut s = Sessions::default();
        s.feed(
            &log(
                "on_message_session_end",
                serde_json::json!({"conversation_id":"123","session_success":"0"}),
            ),
            2026,
            true,
        );
        let e=s.feed(&log("Cmd: ConversationUpdate",serde_json::json!({"conversation_id":"123","conversation_info":"{\"name\":\"测试\"}"})),2026,true).unwrap();
        assert_eq!(e.state, "aborted");
        assert_eq!(e.title.as_deref(), Some("测试"));
        assert!(e.quiet);
        assert!(s
            .feed(
                &log(
                    "on_message_sending_end",
                    serde_json::json!({"conversation_id":""})
                ),
                2026,
                false
            )
            .is_none());
        assert!(s.feed("not a log", 2026, false).is_none());
        let renamed=s.feed(&log("Cmd: ConversationUpdate",serde_json::json!({"conversation_id":"123","conversation_info":"{\"name\":\"改名\"}"})),2026,false).unwrap();
        assert!(
            renamed.quiet,
            "renaming a finished session must not alert again"
        );
        let cancelled=s.feed(&log("on_message_session_end",serde_json::json!({"conversation_id":"456","session_success":"1","cancel_source":"stop_button"})),2026,false).unwrap();
        assert_eq!(cancelled.state, "aborted");
    }

    #[test]
    #[ignore = "Read-only local compatibility check; set AGENTHUB_DOUBAO_LOG_TEST_ROOT"]
    fn installed_client_logs() {
        use std::io::{BufRead, BufReader};
        let root = PathBuf::from(
            std::env::var_os("AGENTHUB_DOUBAO_LOG_TEST_ROOT").expect("log directory required"),
        );
        let mut sessions = Sessions::default();
        let mut states = HashMap::<String, usize>::new();
        for path in log_files(&root) {
            let year = path.file_name().unwrap().to_str().unwrap()[6..10]
                .parse()
                .unwrap();
            for line in BufReader::new(std::fs::File::open(path).unwrap())
                .lines()
                .map_while(Result::ok)
            {
                if let Some(e) = sessions.feed(&line, year, true) {
                    *states.entry(e.state).or_default() += 1;
                }
            }
        }
        eprintln!(
            "Parsed {} sessions; transitions: {:?}",
            sessions.latest.len(),
            states
        );
        assert!(states.get("running").copied().unwrap_or(0) > 0);
        assert!(states.get("done").copied().unwrap_or(0) > 0);
    }
}
