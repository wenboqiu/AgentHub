//! ChatGPT（桌面端 Chat / Work 模式）：对话正文与回复都在云端，本地唯一可读的是
//! `~/.codex/.codex-global-state.json` 里 `electron-persisted-atom-state.prompt-history`
//! 的 `"chatgpt-global"` 键——每个会话的用户提问 markdown。
//! 所以这里做的是「提问监听」：新提问 → running（随事件带 user 消息与活动桶），
//! 静默 5 分钟 → idle。拿不到回复内容与精确时间戳，事件时间一律用采集时刻。

use crate::activity::{buckets_of, capped};
use crate::claude::{home_dir, now_iso, truncate_chars};
use crate::forwarder::{Event, EventMessage, Forwarder};
use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_secs(5);
/// 提问后多久没有新提问就回到 idle：running 挂太久会一直占着「进行中」区
const QUIET_IDLE: Duration = Duration::from_secs(5 * 60);
/// 只监听这一个键：它是 ChatGPT（Chat 模式）面的提问历史。
/// 其余键要么是 Codex 线程自己的（rollout 链路已覆盖），要么是输入框草稿。
const HISTORY_KEY: &str = "chatgpt-global";
/// 会话 id 固定：ChatGPT 模式没有稳定的本地会话概念，全局一条流水
const SESSION_ID: &str = "chatgpt";
/// 内容级去重的容量上限：提问一般很短，512 条足够一整天的量
const SEEN_MAX: usize = 512;

/// 从 global-state.json 全文里抽出 chatgpt-global 的提问列表（按存储顺序，旧 → 新）。
/// 结构不符合预期（桌面端改版 / 文件半截写入）一律返回空，宁可不报。
pub fn parse_prompts(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(arr) = v
        .get("electron-persisted-atom-state")
        .and_then(|a| a.get("prompt-history"))
        .and_then(|h| h.get(HISTORY_KEY))
        .and_then(|p| p.as_array())
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|x| x.get("markdown")?.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[derive(Default)]
pub struct ChatState {
    /// 已上报过的提问正文（内容级去重；同一句话发两遍只记一次）
    seen: VecDeque<String>,
    /// 会话标题：第一条提问截 80 字，与 Codex 的口径一致
    title: Option<String>,
    /// 当前是否处于 running（有过未冷却的提问）
    running: bool,
    last_prompt: Option<Instant>,
}

impl ChatState {
    pub fn new() -> Self {
        ChatState::default()
    }

    /// 喂入当前提问列表。first=true（客户端刚启动的首次扫描）只记录不见报，
    /// 避免把历史提问一次性刷进时间线；之后每条新提问各出一条 running 事件。
    pub fn feed(&mut self, prompts: &[String], first: bool, now: &str) -> Vec<Event> {
        if first {
            for p in prompts {
                self.remember(p);
            }
            self.title = prompts.first().map(|p| truncate_chars(&p.split_whitespace().collect::<Vec<_>>().join(" "), 80));
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut fresh_ms: Vec<i64> = Vec::new();
        for p in prompts {
            if self.seen.contains(p) {
                continue;
            }
            self.remember(p);
            if self.title.is_none() {
                let flat = p.split_whitespace().collect::<Vec<_>>().join(" ");
                self.title = Some(truncate_chars(&flat, 80));
            }
            let ms = chrono::Utc::now().timestamp_millis();
            fresh_ms.push(ms);
            out.push(Event {
                agent: "chatgpt".into(),
                session_id: SESSION_ID.into(),
                machine: String::new(),
                cwd: String::new(),
                state: "running".into(),
                at: now.to_string(),
                title: self.title.clone(),
                summary: None,
                pid: None,
                quiet: false,
                bg_tasks: 0,
                buckets: capped(buckets_of(&[ms])),
                messages: vec![EventMessage { role: "user".into(), text: p.clone(), at: Some(now.to_string()) }],
            });
        }
        if out.is_empty() {
            // 没有新提问：冷却到点就把 running 收回 idle（只发一次）
            if self.running
                && self.last_prompt.is_some_and(|t| t.elapsed() >= QUIET_IDLE)
            {
                self.running = false;
                out.push(Event {
                    agent: "chatgpt".into(),
                    session_id: SESSION_ID.into(),
                    machine: String::new(),
                    cwd: String::new(),
                    state: "idle".into(),
                    at: now.to_string(),
                    title: self.title.clone(),
                    summary: None,
                    pid: None,
                    quiet: true,
                    bg_tasks: 0,
                    buckets: Vec::new(),
                    messages: Vec::new(),
                });
            }
        } else {
            self.running = true;
            self.last_prompt = Some(Instant::now());
        }
        out
    }

    fn remember(&mut self, p: &str) {
        self.seen.push_back(p.to_string());
        while self.seen.len() > SEEN_MAX {
            self.seen.pop_front();
        }
    }
}

/// 轮询 global-state.json。文件是桌面端整份重写的 JSON（约几百 KB），5 秒一轮足够轻。
pub fn spawn(fwd: Forwarder) {
    let Some(path) = home_dir().map(|h| h.join(".codex").join(".codex-global-state.json")) else { return };
    std::thread::spawn(move || {
        let mut st = ChatState::new();
        let mut first = true;
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let prompts = parse_prompts(&text);
                let now = now_iso();
                for ev in st.feed(&prompts, first, &now) {
                    fwd.push(ev);
                }
                first = false;
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(markdowns: &[&str]) -> String {
        let items: Vec<String> = markdowns
            .iter()
            .map(|m| serde_json::json!({"markdown": m, "document": {"type": "doc"}}).to_string())
            .collect();
        format!(
            r#"{{"electron-persisted-atom-state":{{"prompt-history":{{"chatgpt-global":[{}],"other-key":[{{"markdown":"x"}}]}}}}}}"#,
            items.join(",")
        )
    }

    #[test]
    fn parses_only_chatgpt_global_markdowns() {
        let text = state_with(&["  你好  ", "ssh 连一下 homelab", ""]);
        assert_eq!(parse_prompts(&text), vec!["你好".to_string(), "ssh 连一下 homelab".to_string()]);
        // 结构对不上（桌面端改版）时返回空，不报错
        assert!(parse_prompts("{}").is_empty());
        assert!(parse_prompts("not json").is_empty());
    }

    #[test]
    fn first_scan_is_silent_and_sets_title() {
        let mut st = ChatState::new();
        let evs = st.feed(&["帮我看个 bug".into(), "再聊聊架构".into()], true, "now");
        assert!(evs.is_empty());
        // 首扫只确定标题，不把历史刷出来；之后新提问才上报
        let evs = st.feed(&["帮我看个 bug".into(), "再聊聊架构".into(), "新问题".into()], false, "now");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].title.as_deref(), Some("帮我看个 bug"));
    }

    #[test]
    fn each_new_prompt_emits_running_with_message_and_bucket() {
        let mut st = ChatState::new();
        st.feed(&["第一个问题".into()], true, "now");
        let evs = st.feed(&["第一个问题".into(), "第二个问题".into()], false, "now");
        assert_eq!(evs.len(), 1);
        let e = &evs[0];
        assert_eq!((e.agent.as_str(), e.session_id.as_str(), e.state.as_str()), ("chatgpt", "chatgpt", "running"));
        assert_eq!(e.messages.len(), 1);
        assert_eq!(e.messages[0].role, "user");
        assert_eq!(e.messages[0].text, "第二个问题");
        assert_eq!(e.buckets.len(), 1);
        assert_eq!(e.buckets[0].count, 1);
        // 同一句话重复发送不重复上报
        let evs = st.feed(&["第一个问题".into(), "第二个问题".into()], false, "now");
        assert!(evs.is_empty());
    }

    #[test]
    fn goes_idle_after_quiet_period() {
        let mut st = ChatState::new();
        st.feed(&["问一句".into()], true, "now");
        // 首扫后没有新提问：不进 running，也就没有 idle 可收
        assert!(st.feed(&["问一句".into()], false, "now").is_empty());
        // 新提问 → running
        let evs = st.feed(&["问一句".into(), "再来一句".into()], false, "now");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].state, "running");
        // 提问后间隔时间不够长时不发 idle
        assert!(st.feed(&["再来一句".into()], false, "now").is_empty());
        // 把 last_prompt 拨回 6 分钟前，下一轮就该收 idle
        st.last_prompt = Some(Instant::now() - Duration::from_secs(6 * 60));
        let evs = st.feed(&["再来一句".into()], false, "now");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].state, "idle");
        assert!(evs[0].quiet);
        // idle 只发一次
        let evs = st.feed(&["再来一句".into()], false, "now");
        assert!(evs.is_empty());
    }
}
