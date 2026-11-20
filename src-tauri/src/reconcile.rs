//! Read-only local evidence repairs missed hooks and synchronises Codex display names.
use crate::{claude, codex, config::SharedConfig, runner};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, time::Duration};

pub fn titles(text: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let (Some(id), Some(name)) = (v["id"].as_str(), v["thread_name"].as_str()) {
            if !name.trim().is_empty() {
                names.insert(id.to_owned(), claude::truncate_chars(name.trim(), 200));
            }
        }
    }
    names
}

/// None means insufficient evidence. Never expire a running task just because it is old.
fn local_state(home: &Path, s: &Value) -> Option<(String, Option<String>)> {
    let key = s["id"].as_str()?.split_once(':')?.1;
    if !runner::valid_key(key) || key.starts_with("pending-") { return None; }
    if s["agent"] == "codex" {
        let root = home.join(".codex");
        let path = runner::codex_rollout(home, key);
        if let Some(path) = path {
            let text = runner::read_tail(&path, 256 * 1024).ok()?;
            let lines: Vec<_> = text.lines().collect();
            let ev = codex::FileState::new(Some(key.to_owned())).feed(&lines, true, &claude::now_iso()).pop()?;
            // idle without a lifecycle event is not proof that a turn finished.
            let evidence_at = chrono::DateTime::parse_from_rfc3339(&ev.at).ok()?;
            let reported_at = chrono::DateTime::parse_from_rfc3339(s["eventAt"].as_str()?).ok()?;
            if evidence_at >= reported_at && matches!(ev.state.as_str(), "done" | "aborted") { return Some((ev.state, ev.summary)); }
        } else if std::fs::read_dir(root.join("sessions")).is_ok() && std::fs::read_dir(root.join("archived_sessions")).is_ok() {
            // Allow a new rollout time to appear. Missing evidence never means successful completion.
            let at = chrono::DateTime::parse_from_rfc3339(s["eventAt"].as_str()?).ok()?;
            if chrono::Utc::now().signed_duration_since(at).num_seconds() >= 300 {
                return Some(("unknown".into(), Some("未找到本机会话记录，无法确认当前运行状态".into())));
            }
        }
    } else if s["agent"] == "claude" {
        // Registry status comes from Claude itself, not filesystem age or window presence.
        for entry in std::fs::read_dir(home.join(".claude/sessions")).ok()?.flatten() {
            if entry.path().extension().is_none_or(|e| e != "json") { continue; }
            let Some(v) = std::fs::read_to_string(entry.path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
            if v["sessionId"] == key && matches!(v["status"].as_str(), Some("idle" | "shell")) {
                // Require the registry status to be at least as recent as the reported start.
                let at = chrono::DateTime::parse_from_rfc3339(s["eventAt"].as_str()?).ok()?.timestamp_millis();
                if v["statusUpdatedAt"].as_i64().is_some_and(|t| t >= at) {
                    return Some(("idle".into(), None));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(agent: &str) -> Value {
        json!({"id":format!("{agent}:abc-123"),"agent":agent,"state":"running","title":"old prompt",
            "eventAt":"2026-11-01T01:00:00Z","cwd":"D:/project","machine":"pc"})
    }
    #[test]
    fn names_use_latest_nonempty_display_name() {
        let names = titles("{\"id\":\"abc-123\",\"thread_name\":\"first\"}\ninvalid\n{\"id\":\"abc-123\",\"thread_name\":\"新名称\"}\n{\"id\":\"abc-123\",\"thread_name\":\"\"}");
        assert_eq!(names["abc-123"], "新名称");
        let dir = std::env::temp_dir().join("agenthub-no-evidence");
        let ev = correction(&dir, &session("codex"), &names).unwrap();
        assert_eq!(ev["state"], "running");
        assert_eq!(ev["title"], "新名称");
        assert_eq!(ev["expectedAt"], ev["at"]);
        assert_eq!(ev["quiet"], true);
        assert!(correction(&dir, &session("claude"), &names).is_none());
    }
    #[test]
    fn source_states_and_versions_are_respected() {
        let home = std::env::temp_dir().join(format!("agenthub-reconcile-{}",std::process::id()));
        let registry = home.join(".claude/sessions");
        std::fs::create_dir_all(&registry).unwrap();
        let write = |status: &str, at: i64| std::fs::write(registry.join("1.json"),json!({"sessionId":"abc-123","status":status,"statusUpdatedAt":at}).to_string()).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339("2026-11-01T01:00:00Z").unwrap().timestamp_millis();
        for status in ["idle", "shell"] {
            write(status,start+1000);
            assert_eq!(correction(&home,&session("claude"),&HashMap::new()).unwrap()["state"],"idle");
        }
        write("running",start+1000);
        assert!(correction(&home,&session("claude"),&HashMap::new()).is_none());
        write("idle",start-1000);
        assert!(correction(&home,&session("claude"),&HashMap::new()).is_none());
        let dir = home.join(".codex/sessions/2026/11/01");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-test-abc-123.jsonl");
        for (at, expected) in [("2026-11-01T00:00:00Z",false),("2026-11-01T01:01:00Z",true)] {
            std::fs::write(&path,json!({"type":"event_msg","timestamp":at,"payload":{"type":"task_complete","last_agent_message":"OK"}}).to_string()).unwrap();
            assert_eq!(correction(&home,&session("codex"),&HashMap::new()).is_some(),expected);
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir_all(home.join(".codex/archived_sessions")).unwrap();
        let mut s=session("codex");s["cwd"]=json!(home.join("removed-project"));
        assert_eq!(correction(&home,&s,&HashMap::new()).unwrap()["state"],"unknown");
        std::fs::create_dir_all(home.join("removed-project")).unwrap();
        assert_eq!(correction(&home,&s,&HashMap::new()).unwrap()["state"],"unknown");
        s["eventAt"]=json!(claude::now_iso());
        assert!(correction(&home,&s,&HashMap::new()).is_none());
        std::fs::remove_dir_all(home).unwrap();
    }
}

pub fn correction(home: &Path, s: &Value, names: &HashMap<String,String>) -> Option<Value> {
    let id = s["id"].as_str()?;
    let (agent, key) = id.split_once(':')?;
    let name = (agent == "codex").then(|| names.get(key)).flatten();
    let state = if s["state"] == "running" { local_state(home, s) } else { None };
    if state.is_none() && name.is_none_or(|n| s["title"].as_str() == Some(n.as_str())) { return None; }
    let mut ev = json!({"agent":agent,"sessionId":key,"machine":s["machine"],"cwd":s["cwd"],
        "state":state.as_ref().map(|v| v.0.as_str()).unwrap_or(s["state"].as_str()?),
        "at":s["eventAt"],"expectedAt":s["eventAt"],"quiet":true});
    if let Some(name) = name { ev["title"] = json!(name); }
    if let Some((_, Some(summary))) = state { ev["summary"] = json!(summary); }
    Some(ev)
}

pub fn spawn(config: SharedConfig) {
    std::thread::spawn(move || {
        let Some(home) = claude::home_dir() else { return };
        let Ok(client) = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build() else { return };
        let mut reads = crate::codex_read::ReadSync::default();
        let mut wb_reads = crate::workbuddy_read::ReadSync::default();
        let mut read_config = None;
        loop {
            let cfg = config.read().unwrap().clone();
            if read_config.as_ref() != Some(&cfg) {
                reads = crate::codex_read::ReadSync::default();
                wb_reads = crate::workbuddy_read::ReadSync::default();
                read_config = Some(cfg.clone());
            }
            if !cfg.server_url.trim().is_empty() && !cfg.token.trim().is_empty() {
                let base = cfg.server_url.trim().trim_end_matches('/');
                let result = client.get(format!("{base}/sessions?all=1")).bearer_auth(cfg.token.trim()).send()
                    .and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>());
                if let Ok(v) = result {
                    let names = std::fs::read_to_string(home.join(".codex/session_index.jsonl")).map(|s| titles(&s)).unwrap_or_default();
                    let sessions: Vec<_> = v["sessions"].as_array().into_iter().flatten()
                        .filter(|s| s["machine"] == cfg.machine)
                        .cloned().collect();
                    let mut events: Vec<_> = sessions.iter().filter_map(|s| correction(&home, s, &names)).collect();
                    events.extend(reads.events(&home,&sessions));
                    // WorkBuddy 在桌面端读完回复不算事件：靠它自己的已读标记补一条回执
                    events.extend(wb_reads.events(&home,&sessions));
                    for batch in events.chunks(100) {
                        // Credentials changed during the read: wait for the next pass.
                        if *config.read().unwrap() != cfg { break; }
                        let _ = client.post(format!("{base}/events")).bearer_auth(cfg.token.trim()).json(&json!({"events":batch})).send();
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}
