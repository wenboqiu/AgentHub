//! Preserve native message identity and completed branch boundaries in history.
use crate::runner::{truncate_history_text, valid_key};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub text: String,
    pub source_id: Option<String>,
    pub branch_point: Option<String>,
}

fn key(v: &Value) -> Option<String> { v.as_str().filter(|s| valid_key(s)).map(String::from) }
fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() { return s.to_owned(); }
    v.as_array().into_iter().flatten().filter(|p| matches!(p["type"].as_str(), Some("text" | "input_text" | "output_text")))
        .filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")
}

pub fn parse(agent: &str, data: &str, limit: usize) -> Vec<HistoryMessage> {
    let mut messages: Vec<HistoryMessage> = Vec::new();
    let mut turn: Option<String> = None;
    let mut final_index: Option<usize> = None;
    for line in data.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if agent == "codex" && v["type"] == "event_msg" {
            let p = &v["payload"];
            if p["type"] == "task_started" { turn = key(&p["turn_id"]); final_index = None; }
            if p["type"] == "task_complete" {
                if let (Some(index), Some(id)) = (final_index.take(), key(&p["turn_id"]).filter(|id| Some(id) == turn.as_ref())) {
                    messages[index].branch_point = Some(id);
                }
                turn = None;
            }
            if p["type"] == "turn_aborted" { final_index = None; turn = None; }
            continue;
        }
        let (role, content, source, branch) = if agent == "claude" {
            let agenthub_input = v["type"] == "user" && v["origin"]["kind"] == "peer" && v["origin"]["from"] == "AgentHub";
            if (v["isMeta"] == true && !agenthub_input) || v["parent_tool_use_id"].is_string() { continue; }
            let Some(role) = v["type"].as_str().filter(|r| matches!(*r,"user" | "assistant")) else { continue };
            let source = key(&v["uuid"]);
            let branch = if role == "assistant" && matches!(v["message"]["stop_reason"].as_str(), Some("end_turn" | "stop_sequence")) { source.clone() } else { None };
            (role, text(&v["message"]["content"]), source, branch)
        } else {
            if v["type"] != "response_item" || v["payload"]["type"] != "message" { continue; }
            let p = &v["payload"];
            let Some(role) = p["role"].as_str().filter(|r| matches!(*r,"user" | "assistant")) else { continue };
            (role, text(&p["content"]), key(&p["id"]), None)
        };
        if content.trim().is_empty() || (agent == "codex" && role == "user" && content.trim_start().starts_with('<')) { continue; }
        if agent == "codex" && role == "assistant" && v["payload"]["phase"] == "final_answer" && turn.is_some() {
            final_index = Some(messages.len());
        }
        messages.push(HistoryMessage { role: role.into(), text: truncate_history_text(&content), source_id: source, branch_point: branch });
    }
    let n = messages.len().saturating_sub(limit);
    messages.drain(..n);
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_keeps_agenthub_terminal_inputs_when_history_is_refreshed() {
        let data = r#"{"type":"user","uuid":"from-agenthub","isMeta":true,"origin":{"kind":"peer","from":"AgentHub"},"message":{"content":"continue"}}
{"type":"user","uuid":"internal","isMeta":true,"message":{"content":"internal notice"}}"#;
        let rows=parse("claude",data,50);
        assert_eq!(rows.len(),1);assert_eq!(rows[0].source_id.as_deref(),Some("from-agenthub"));assert_eq!(rows[0].text,"continue");
    }
    #[test]
    fn claude_preserves_ids_and_only_branches_at_complete_answers() {
        let data = r#"{"type":"assistant","uuid":"first","message":{"content":[{"type":"text","text":"first"}],"stop_reason":"tool_use"}}
{"type":"assistant","uuid":"second","message":{"content":[{"type":"text","text":"second"}],"stop_reason":"end_turn"}}"#;
        let messages = parse("claude",data,50);
        assert_eq!(messages[0].source_id.as_deref(),Some("first"));
        assert!(messages[0].branch_point.is_none());
        assert_eq!(messages[1].branch_point.as_deref(),Some("second"));
    }
    #[test]
    fn codex_requires_completed_turn_and_keeps_earlier_boundary() {
        let data = r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"type":"response_item","payload":{"type":"message","id":"m1","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"one"}]}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}
{"type":"response_item","payload":{"type":"message","id":"m2","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"two"}]}}"#;
        let messages = parse("codex",data,50);
        assert_eq!(messages[0].branch_point.as_deref(),Some("t1"));
        assert!(messages[1].branch_point.is_none());
        assert_eq!(parse("codex",data,1)[0].source_id.as_deref(),Some("m2"));
    }
}
