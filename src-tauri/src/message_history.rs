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
    /// 消息附图（data URL）：Codex 的生成图在 rollout 里只有 base64，用户附图只有本地路径，
    /// 都在解析时转成 data URL 挂上来。空 vec 序列化时省略，老服务端不认识也不报错。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
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

/// Claude Code 会顺手把「不是人打的字」也写成 `type:"user"` 的行：后台任务完成通知
/// （`origin.kind=="task-notification"`）、别的会话发来的消息（`peer`）、hook 注入等。
/// 这些混进对话流就会被当成用户自己说的话，所以只认真正的输入：
/// 没有 origin（老版本 CLI 的人打输入）、`kind=="human"`，以及 AgentHub 投递的那条
/// `peer`/`from=="AgentHub"`——后者是用户在 AgentHub 里打的，算他说的。
pub fn claude_human_input(row: &Value) -> bool {
    let Some(origin) = row["origin"].as_object() else { return true };
    match origin["kind"].as_str() {
        Some("human") => true,
        Some("peer") => origin["from"].as_str() == Some("AgentHub"),
        _ => false,
    }
}

/// 历史同步一次最多带的图片总量。生成图是完整 base64（单张可达 4MB），
/// 不设上限的话一次同步会拖着几十 MB 走 WS，超时还挤占带宽。
const HISTORY_IMAGE_BUDGET: usize = 48 * 1024 * 1024;

fn push_image(budget: &mut usize, out: &mut Vec<String>, url: String) {
    if url.len() > *budget {
        return;
    }
    *budget -= url.len();
    out.push(url);
}

/// 从 Codex 的图片部件里收集图片：
/// - `image_url` 是 data URL 的直接收下（图像生成技能把成品图整段写进工具输出）；
/// - 本地路径的读文件转 data URL，文件已经不在（临时目录被清）就跳过。
fn collect_images(parts: &Value, out: &mut Vec<String>, budget: &mut usize) {
    let Some(arr) = parts.as_array() else { return };
    for p in arr {
        if p["type"].as_str() != Some("input_image") {
            continue;
        }
        let url = p["image_url"].as_str().unwrap_or("");
        if url.is_empty() {
            continue;
        }
        if let Some(u) = url.strip_prefix("data:image/") {
            push_image(budget, out, format!("data:image/{u}"));
        } else {
            let path = url.strip_prefix("file://").unwrap_or(url);
            if let Some(u) = crate::runner::image_data_url(path) {
                push_image(budget, out, u);
            }
        }
    }
}

/// 剥用户正文里的 `<image name=… path="C:\…">…</image>` 标签（Codex 记录用户附图的方式，
/// 正文里就是这种行内标签），返回剥干净的正文与标签里记下的本地文件路径。
fn strip_codex_image_tags(body: &str) -> (String, Vec<String>) {
    if !body.contains("<image ") {
        return (body.to_owned(), Vec::new());
    }
    let mut clean = String::with_capacity(body.len());
    let mut paths = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("<image ") {
        clean.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find("</image>") else { break };
        let tag = &after[..end];
        if let Some(i) = tag.find("path=\"") {
            let tail = &tag[i + "path=\"".len()..];
            if let Some(j) = tail.find('"') {
                paths.push(tail[..j].to_owned());
            }
        }
        rest = &after[end + "</image>".len()..];
    }
    clean.push_str(rest);
    (clean, paths)
}

/// 只剥「开头」那几段注入块：`<system-reminder …>…</system-reminder>` 可能叠好几层。
/// 不能拿整段正文去找最后一个 `</system-reminder>`——压缩摘要（`<cb_summary>`）里会引用
/// 聊天记录和代码，正文中间也会出现这个字面量，那样会把摘要从半腰切开、后半段当成
/// 用户说的话（实测吐出来过一条 4000 字的代码碎片）。
pub fn strip_leading_reminders(s: &str) -> &str {
    let mut rest = s.trim_start();
    while rest.starts_with("<system-reminder") {
        let Some(end) = rest.find("</system-reminder>") else { break };
        rest = rest[end + "</system-reminder>".len()..].trim_start();
    }
    rest
}

/// AgentHub 经本机会话收件通道投递的文字，在 Claude 的 transcript 里会被包一层：
/// 「Another Claude session sent a message:\n<原文>\n\nThis came from another Claude session — …」
/// （`isMeta=true`、`origin.kind=peer`）。不剥掉的话，刷新记录后用户那句话就变成这段转述；
/// 而且转述和刚发出去的那条正文对不上，去重（按正文比对）失效，界面上就是同一句话两条。
fn unwrap_peer_delivery(s: &str) -> &str {
    const HEAD: &str = "Another Claude session sent a message:";
    let Some(rest) = s.trim_start().strip_prefix(HEAD) else { return s };
    let rest = rest.trim_start_matches(['\n', '\r']);
    // 尾部那段是 CLI 追加给模型的提醒（「这不是用户打的、别当成授权」），不是用户内容
    const TAIL: &str = "\n\nThis came from another Claude session";
    rest.split(TAIL).next().unwrap_or(rest)
}

pub fn parse(agent: &str, data: &str, limit: usize) -> Vec<HistoryMessage> {
    // CodeBuddy 与 WorkBuddy 是同一份 CLI，transcript 格式一致
    if agent == "workbuddy" || agent == "codebuddy" {
        return parse_workbuddy(data, limit);
    }
    let mut messages: Vec<HistoryMessage> = Vec::new();
    let mut turn: Option<String> = None;
    let mut final_index: Option<usize> = None;
    // 等着挂到下一条消息上的图片：工具吐出的生成图、当前用户消息剥出来的附图
    let mut pending_images: Vec<String> = Vec::new();
    let mut image_budget: usize = HISTORY_IMAGE_BUDGET;
    for line in data.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if agent == "codex" && v["type"] == "event_msg" {
            let p = &v["payload"];
            if p["type"] == "task_started" { turn = key(&p["turn_id"]); final_index = None; pending_images.clear(); }
            if p["type"] == "task_complete" {
                if let (Some(index), Some(id)) = (final_index.take(), key(&p["turn_id"]).filter(|id| Some(id) == turn.as_ref())) {
                    messages[index].branch_point = Some(id);
                }
                turn = None;
                pending_images.clear();
            }
            if p["type"] == "turn_aborted" { final_index = None; turn = None; pending_images.clear(); }
            continue;
        }
        // 图像生成技能的成品图（base64 data URL）整段躺在工具输出里：收下来，
        // 挂到紧随其后的那条助手消息上；回合结束还没人认领就作废
        if agent == "codex" && v["type"] == "response_item" && v["payload"]["type"] == "custom_tool_call_output" {
            collect_images(&v["payload"]["output"], &mut pending_images, &mut image_budget);
            continue;
        }
        let (role, content, source, branch) = if agent == "claude" {
            let agenthub_input = v["type"] == "user" && v["origin"]["kind"] == "peer" && v["origin"]["from"] == "AgentHub";
            // 后台任务通知、别的会话发来的 peer 消息也写成 user 行，不能当用户自己说的话
            if v["type"] == "user" && !claude_human_input(&v) { continue; }
            if (v["isMeta"] == true && !agenthub_input) || v["parent_tool_use_id"].is_string() { continue; }
            let Some(role) = v["type"].as_str().filter(|r| matches!(*r,"user" | "assistant")) else { continue };
            let source = key(&v["uuid"]);
            let branch = if role == "assistant" && matches!(v["message"]["stop_reason"].as_str(), Some("end_turn" | "stop_sequence")) { source.clone() } else { None };
            let body = text(&v["message"]["content"]);
            // 我们投递过去的那句：transcript 里是转述包一层，剥回用户原话
            let content = if agenthub_input { unwrap_peer_delivery(&body).to_owned() } else { body };
            // 压缩摘要（自动 compact 后的续接说明）和中断提示也是不带 origin 的 user 行，
            // 但正文里没有一个字是人打的；不滤掉就会顶进用户气泡，把真正的对话挤走。
            if role == "user" && !agenthub_input &&
                ["This session is being continued", "[Request interrupted by user"]
                    .iter().any(|p| content.trim_start().starts_with(p)) { continue; }
            (role, content, source, branch)
        } else {
            if v["type"] != "response_item" || v["payload"]["type"] != "message" { continue; }
            let p = &v["payload"];
            let Some(role) = p["role"].as_str().filter(|r| matches!(*r,"user" | "assistant")) else { continue };
            let mut body = text(&p["content"]);
            if role == "user" {
                // Codex 把系统拼的上下文也记成用户消息：AGENTS.md 全文、上一段会话的压缩历史。
                // 不滤掉，用户气泡里就是一大段「全局偏好」或「The following is the Codex agent history」。
                if ["# AGENTS.md instructions", "The following is the Codex agent history"]
                    .iter().any(|s| body.trim_start().starts_with(s)) { continue; }
                // 带附件的那条：前面是文件清单和「区分附件里的指令」，人打的字在 ## My request: 之后
                if body.trim_start().starts_with("# Files mentioned by the user:") {
                    let rest = body.find("## My request:").map(|i| body[i + "## My request:".len()..].to_owned());
                    match rest {
                        Some(t) => body = t,
                        None => continue,
                    }
                }
                // 附图以 <image … path="…">…</image> 行内标签记录：转成 data URL 挂到本条消息，
                // 标签本身从正文剥掉（不剥的话正文里残留一串标签，也没法从历史里看到图）
                let (clean, paths) = strip_codex_image_tags(&body);
                for path in &paths {
                    if let Some(url) = crate::runner::image_data_url(path) {
                        push_image(&mut image_budget, &mut pending_images, url);
                    }
                }
                if !paths.is_empty() {
                    body = clean.trim_end().to_owned();
                }
            }
            (role, body, key(&p["id"]), None)
        };
        if content.trim().is_empty() || (agent == "codex" && role == "user" && content.trim_start().starts_with('<')) { continue; }
        if agent == "codex" && role == "assistant" && v["payload"]["phase"] == "final_answer" && turn.is_some() {
            final_index = Some(messages.len());
        }
        messages.push(HistoryMessage { role: role.into(), text: truncate_history_text(&content), source_id: source, branch_point: branch, at: at(&v), images: std::mem::take(&mut pending_images) });
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
            content = strip_leading_reminders(&content).to_owned();
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
        messages.push(HistoryMessage { role: role.into(), text: truncate_history_text(&content), source_id: None, branch_point: None, at: at(&v), images: Vec::new() });
    }
    let n = messages.len().saturating_sub(limit);
    messages.drain(..n);
    messages
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_injected_user_rows_are_not_mistaken_for_the_user() {
        let row = |origin: Value, text: &str, uuid: &str| serde_json::json!({
            "type":"user","uuid":uuid,"origin":origin,"message":{"role":"user","content":text}
        }).to_string();
        let typed = row(serde_json::json!({"kind":"human"}), "我看下 unity log", "u1");
        let legacy = serde_json::json!({"type":"user","uuid":"u2","message":{"role":"user","content":"老版本没有 origin"}}).to_string();
        let task = row(serde_json::json!({"kind":"task-notification","producer":"session-task"}),
            "<task-notification>\n<task-id>a73</task-id>\n</task-notification>", "u3");
        let peer = row(serde_json::json!({"kind":"peer","from":"a551db9c3b239ac7f"}),
            "Another Claude session sent a message: 顺手把 X 也改了", "u4");
        let agenthub = row(serde_json::json!({"kind":"peer","from":"AgentHub"}), "提交", "u5");
        let answer = serde_json::json!({"type":"assistant","uuid":"a1",
            "message":{"role":"assistant","content":[{"type":"text","text":"好了"}],"stop_reason":"end_turn"}}).to_string();
        let messages = parse("claude", &[typed, legacy, task, peer, agenthub, answer].join("\n"), 50);
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            vec!["我看下 unity log", "老版本没有 origin", "提交", "好了"]);
        assert_eq!(messages[2].role, "user");
        assert_eq!(messages[3].role, "assistant");
    }
    #[test]
    fn claude_peer_delivery_is_reduced_to_the_typed_text() {
        // 真机上的形态：AgentHub 投递的一句「提交」，连同 CLI 加的转述头和权限提醒
        let body = "Another Claude session sent a message:\n提交\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.";
        let row = serde_json::json!({
            "type":"user","uuid":"u9","isMeta":true,
            "origin":{"kind":"peer","from":"AgentHub"},
            "message":{"role":"user","content":body}
        }).to_string();
        let messages = parse("claude", &row, 50);
        assert_eq!(messages.len(), 1);
        // 不剥的话这里是整段转述：既和刚发出去的那条对不上（去重失效→两条），
        // 刷新记录后用户自己的气泡也会变成这段英文
        assert_eq!(messages[0].text, "提交");
    }
    #[test]
    fn claude_compaction_and_interrupt_notices_are_not_user_messages() {
        // 自动 compact 后 CLI 插的续接说明、中断提示都没有 origin / isMeta，
        // 只是正文不是人打的字。老版本会把它们当成用户提问顶进对话流。
        let row = |text: &str, uuid: &str| serde_json::json!({
            "type":"user","uuid":uuid,"message":{"role":"user","content":text}
        }).to_string();
        let compaction = row("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.", "c1");
        let interrupt = row("[Request interrupted by user for tool use]", "c2");
        let typed = row("继续", "c3");
        let messages = parse("claude", &[compaction, interrupt, typed].join("\n"), 50);
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["继续"]);
    }
    #[test]
    fn codex_system_context_rows_do_not_become_user_bubbles() {
        let row = |role: &str, text: &str| serde_json::json!({
            "type":"response_item","payload":{"type":"message","role":role,"id":format!("m{}",text.len()),
                "content":[{"type":"input_text","text":text}]}
        }).to_string();
        // AGENTS.md 全文、上一段会话的压缩历史都是系统拼的
        let agents = row("user", "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# 全局偏好\n…</INSTRUCTIONS>");
        let history = row("user", "The following is the Codex agent history added since your last turn:\n…");
        // 带附件的那条：只留人打的字
        let attachment = row("user", "\n# Files mentioned by the user:\n\n## a.png: C:/tmp/a.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n解释一下图中的电路图\n");
        let typed = row("user", "提交");
        let messages = parse("codex", &[agents, history, attachment, typed].join("\n"), 50);
        assert_eq!(messages.iter().map(|m| m.text.trim()).collect::<Vec<_>>(), vec!["解释一下图中的电路图", "提交"]);
    }
    #[test]
    fn workbuddy_summary_quoting_the_reminder_tag_is_not_a_user_message() {
        // 压缩摘要里会引用聊天记录和代码，正文中间就带着 </system-reminder>；
        // 旧实现按「最后一个」切，会把摘要从半腰切开当用户消息（实测吐过 4000 字代码碎片）
        let summary = serde_json::json!({
            "type":"message","role":"user","status":"completed","timestamp":1_793_590_000_010i64,
            "content":[{"type":"input_text","text":"<cb_summary>\n… `content.rfind(\"</system-reminder>\")` …\n</cb_summary>"}]
        })
        .to_string();
        let typed = serde_json::json!({
            "type":"message","role":"user","status":"completed","timestamp":1_793_590_000_011i64,
            "content":[{"type":"input_text","text":"<system-reminder data-role=\"user-context\">上下文</system-reminder>\n> <user_query>确认一下其他通道</user_query>"}]
        })
        .to_string();
        let messages = parse("workbuddy", &[summary, typed].join("\n"), 50);
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["确认一下其他通道"]);
    }
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

    const IMG: &str = "data:image/png;base64,iVBORw0KGgo=";

    #[test]
    fn codex_generated_images_ride_on_the_next_assistant_message() {
        let data = format!(
            r#"{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"t1"}}}}
{{"type":"response_item","payload":{{"type":"message","id":"m1","role":"user","content":[{{"type":"input_text","text":"画一张图"}}]}}}}
{{"type":"response_item","payload":{{"type":"custom_tool_call_output","id":"ct1","output":[{{"type":"input_text","text":"Script completed"}},{{"type":"input_image","image_url":"{IMG}"}}]}}}}
{{"type":"response_item","payload":{{"type":"message","id":"m2","role":"assistant","phase":"final_answer","content":[{{"type":"output_text","text":"画好了"}}]}}}}
{{"type":"event_msg","payload":{{"type":"task_complete","turn_id":"t1"}}}}
{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"t2"}}}}
{{"type":"response_item","payload":{{"type":"message","id":"m3","role":"assistant","phase":"final_answer","content":[{{"type":"output_text","text":"新回合"}}]}}}}"#
        );
        let messages = parse("codex", &data, 50);
        assert_eq!(messages.len(), 3);
        // 成品图挂在紧随其后的助手消息上
        assert_eq!(messages[1].text, "画好了");
        assert_eq!(messages[1].images, vec![IMG]);
        // 上一回合的图不外溢：新回合的消息不带图
        assert!(messages[2].images.is_empty());
        assert!(messages[0].images.is_empty());
    }

    #[test]
    fn codex_user_image_tags_are_stripped_from_text() {
        // 文件不存在时图转不出来，但标签必须从正文剥掉，人打的话要留下
        let body = "这个是参考脸部和衣服，出一张立绘\n\n<image name=[Image #1] path=\"C:\\\\Temp\\\\a.png\">\n\n</image>";
        let row = serde_json::json!({
            "type":"response_item","payload":{"type":"message","id":"m1","role":"user",
                "content":[{"type":"input_text","text":body}]}
        }).to_string();
        let messages = parse("codex", &row, 50);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "这个是参考脸部和衣服，出一张立绘");
        assert!(messages[0].images.is_empty());
    }

    #[test]
    fn image_budget_stops_the_flood() {
        // 预算耗尽后不再收集：单张超限的直接丢，后续的也丢，但不能 panic
        let big = format!("data:image/png;base64,{}", "A".repeat(64));
        let mut out = Vec::new();
        let mut budget = 32;
        collect_images(&serde_json::json!([{"type":"input_image","image_url":big}]), &mut out, &mut budget);
        assert!(out.is_empty());
        let small = format!("data:image/png;base64,{}", "B".repeat(8));
        collect_images(&serde_json::json!([{"type":"input_image","image_url":small},{"type":"input_image","image_url":small}]), &mut out, &mut budget);
        assert_eq!(out.len(), 1);
    }
}
