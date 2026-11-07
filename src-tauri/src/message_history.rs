//! Preserve native message identity and completed branch boundaries in history.
use crate::runner::{truncate_history_text, valid_key};
use chrono::TimeZone;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub text: String,
    pub source_id: Option<String>,
    pub branch_point: Option<String>,
    /// 原生日志里的真实时间（Claude/Codex 的 transcript 每行都带 timestamp）。
    /// 没有它，整段历史会被挤到同一瞬间，日历里每个会话的时长就都变成 5 分钟。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

fn key(v: &Value) -> Option<String> { v.as_str().filter(|s| valid_key(s)).map(String::from) }
fn at(v: &Value) -> Option<String> {
    if let Some(s) = v["timestamp"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(s.to_owned());
    }
    // WorkBuddy transcript 的 timestamp 是毫秒数字（Claude/Codex 是 ISO 字符串）
    let ms = v["timestamp"].as_i64()?;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, false))
}
fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() { return s.to_owned(); }
    v.as_array().into_iter().flatten().filter(|p| matches!(p["type"].as_str(), Some("text" | "input_text" | "output_text")))
        .filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")
}

pub fn parse(agent: &str, data: &str, limit: usize) -> Vec<HistoryMessage> {
    // CodeBuddy 与 WorkBuddy 是同一份 CLI，transcript 格式一致
    if agent == "workbuddy" || agent == "codebuddy" {
        return parse_workbuddy(data, limit);
    }
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
        messages.push(HistoryMessage { role: role.into(), text: truncate_history_text(&content), source_id: source, branch_point: branch, at: at(&v) });
    }
    let n = messages.len().saturating_sub(limit);
    messages.drain(..n);
    messages
}

/// WorkBuddy transcript（`~\.workbuddy\projects\…\<sessionId>.jsonl`）：
/// 每行 `{"type":"message","role":"user"|"assistant","status":…,"timestamp":毫秒,"content":[{type:"input_text"|"output_text",…}]}`
/// 正文齐全但没有消息 id，分支能力用不上（workbuddy 本就只读），source/branch 留空。
/// 注入块处理与 workbuddy.rs 的 user_text 同规则：剥 system-reminder / user_query 包裹，纯注入消息跳过。
fn parse_workbuddy(data: &str, limit: usize) -> Vec<HistoryMessage> {
    let mut messages: Vec<HistoryMessage> = Vec::new();
    for line in data.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "message" { continue; }
        let Some(role) = v["role"].as_str().filter(|r| matches!(*r, "user" | "assistant")) else { continue };
        let mut content = text(&v["content"]);
        if role == "user" {
            if let Some(i) = content.rfind("</system-reminder>") {
                content = content[i + "</system-reminder>".len()..].to_owned();
            }
            content = content.trim_start_matches(['>', ' ', '\n', '\t']).to_owned();
            if let Some(rest) = content.strip_prefix("<user_query>") {
                if let Some(end) = rest.rfind("</user_query>") {
                    content = rest[..end].to_owned();
                }
            }
            // 剩下的还是注入块（cb_summary / task-notification 等），不当用户消息
            if content.trim_start().starts_with('<') { continue; }
        }
        if content.trim().is_empty() { continue; }
        messages.push(HistoryMessage { role: role.into(), text: truncate_history_text(&content), source_id: None, branch_point: None, at: at(&v) });
    }
    let n = messages.len().saturating_sub(limit);
    messages.drain(..n);
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workbuddy_keeps_visible_text_and_drops_injections() {
        let wrapped = serde_json::json!({
            "type":"message","role":"user","status":"completed","timestamp":1_793_590_000_000i64,
            "content":[{"type":"input_text","text":"<system-reminder data-role=\"user-context\">注入</system-reminder>\n> <user_query>真正的提问</user_query>"}]
        })
        .to_string();
        let injected = serde_json::json!({
            "type":"message","role":"user","status":"completed","timestamp":1_793_590_000_001i64,
            "content":[{"type":"input_text","text":"<cb_summary> Summary of the conversation"}]
        })
        .to_string();
        let answer = serde_json::json!({
            "type":"message","role":"assistant","status":"completed","timestamp":1_793_590_000_002i64,
            "content":[{"type":"output_text","text":"好的"}]
        })
        .to_string();
        let meta = serde_json::json!({"type":"session-meta","sessionId":"abc","timestamp":1}).to_string();
        let generating = serde_json::json!({
            "type":"message","role":"assistant","status":"generating","timestamp":1_793_590_000_003i64,
            "content":[{"type":"output_text","text":""}]
        })
        .to_string();
        let messages = parse("workbuddy", &format!("{wrapped}\n{injected}\n{answer}\n{meta}\n{generating}"), 50);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text, "真正的提问");
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].source_id, None);
        assert_eq!(messages[0].branch_point, None);
        assert_eq!(messages[1].text, "好的");
        // 毫秒时间戳转成 ISO，且保留原始先后顺序
        assert!(messages[0].at.as_deref().is_some_and(|s| s.starts_with("2026-")));
        assert!(messages[1].at.as_deref().is_some_and(|s| s.starts_with("2026-")));
        // limit 生效
        assert_eq!(parse("workbuddy", &format!("{wrapped}\n{answer}"), 1).len(), 1);
    }

    #[test]
    fn claude_timestamps_stay_strings() {
        let data = r#"{"type":"user","uuid":"u1","timestamp":"2026-11-02T01:10:00.000Z","message":{"content":"hi"}}"#;
        assert_eq!(parse("claude", data, 50)[0].at.as_deref(), Some("2026-11-02T01:10:00.000Z"));
    }

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
    fn keeps_native_timestamps() {
        let data = r#"{"type":"user","uuid":"u1","timestamp":"2026-11-02T01:10:00.000Z","message":{"content":"hi"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-11-02T01:12:30.000Z","message":{"content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}}"#;
        let messages = parse("claude", data, 50);
        assert_eq!(messages[0].at.as_deref(), Some("2026-11-02T01:10:00.000Z"));
        assert_eq!(messages[1].at.as_deref(), Some("2026-11-02T01:12:30.000Z"));
        let codex = r#"{"timestamp":"2026-11-02T02:00:00.000Z","type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#;
        assert_eq!(parse("codex", codex, 50)[0].at.as_deref(), Some("2026-11-02T02:00:00.000Z"));
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
