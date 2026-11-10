//! 事件队列 + 后台线程批量上报服务端，失败指数退避

use crate::config::{SharedConfig, TokenBlock, AUTH_EXPIRED};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const QUEUE_MAX: usize = 1000;
const BATCH_MAX: usize = 100;
const BACKOFF_MAX: u64 = 60;
/// 服务端单次请求体上限 1 MiB：100 条事件里再带上正文就会超，
/// 拼好的一批还要按序列化后的字节数再切一刀，命中 413 会让整批重试卡死队列
const BATCH_BYTES: usize = 512 * 1024;

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    /// 桶起点（对齐到 5 分钟）
    pub at: String,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventMessage {
    /// user / assistant（tool 之类的中间过程不进会话记录）
    pub role: String,
    pub text: String,
    /// 原生日志里的真实时间（ISO）；服务端按它落库排序，也用它去重
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub agent: String,
    pub session_id: String,
    /// 空串表示由 forwarder 发送时按当前配置填
    #[serde(default)]
    pub machine: String,
    pub cwd: String,
    pub state: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub quiet: bool,
    /// 主对话这一轮结束但还有 N 个后台子代理没回报（只对 running 有意义，0 不上报）
    #[serde(default, skip_serializing_if = "is_zero")]
    pub bg_tasks: u32,
    /// 只听不聊的 agent 顺路报活动桶，服务端落 session_activity 给日历画跨度
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buckets: Vec<Bucket>,
    /// 只读监听类（WorkBuddy）顺路把正文随事件上报：正文只存在那台电脑的 transcript 里，
    /// 而拉历史要走执行器通道——没开「允许手机远程执行」的电脑永远拉不到记录。
    /// 随事件上来就与通道无关，服务端按 (role, at, text) 去重后落库。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<EventMessage>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub queued: usize,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Event>,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct Forwarder {
    inner: Arc<(Mutex<Inner>, Condvar)>,
}

/// 队列满了丢最旧的
/// Postgres 的 text 不能含 NUL：带 NUL 的事件会让服务端整批 500，队列一直重试卡住
fn strip_nul(e: &mut Event) {
    for s in [&mut e.session_id, &mut e.cwd].into_iter().chain(e.title.as_mut()).chain(e.summary.as_mut()) {
        if s.contains('\0') {
            *s = s.replace('\0', "");
        }
    }
    for m in &mut e.messages {
        if m.text.contains('\0') {
            m.text = m.text.replace('\0', "");
        }
    }
}

/// 按序列化后的字节数把一批事件再切开（服务端 bodyLimit 1 MiB）
fn split_by_bytes(batch: Vec<Event>) -> Vec<Vec<Event>> {
    let mut out: Vec<Vec<Event>> = Vec::new();
    let mut cur: Vec<Event> = Vec::new();
    let mut bytes = 0usize;
    for ev in batch {
        let size = serde_json::to_vec(&ev).map(|v| v.len()).unwrap_or(0) + 2;
        if !cur.is_empty() && bytes + size > BATCH_BYTES {
            out.push(std::mem::take(&mut cur));
            bytes = 0;
        }
        bytes += size;
        cur.push(ev);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn push_trim(q: &mut VecDeque<Event>, ev: Event) {
    q.push_back(ev);
    while q.len() > QUEUE_MAX {
        q.pop_front();
    }
}

impl Forwarder {
    pub fn new() -> Self {
        Forwarder { inner: Arc::new((Mutex::new(Inner::default()), Condvar::new())) }
    }

    pub fn push(&self, ev: Event) {
        let (m, cv) = &*self.inner;
        push_trim(&mut m.lock().unwrap().queue, ev);
        cv.notify_all();
    }

    pub fn status(&self) -> ForwardStatus {
        let g = self.inner.0.lock().unwrap();
        ForwardStatus { queued: g.queue.len(), last_error: g.last_error.clone() }
    }

    pub fn spawn(&self, config: SharedConfig) {
        let this = self.clone();
        std::thread::spawn(move || this.run(config));
    }

    fn run(&self, config: SharedConfig) {
        let client = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build() {
            Ok(c) => c,
            Err(e) => {
                self.inner.0.lock().unwrap().last_error = Some(format!("HTTP 客户端初始化失败：{e}"));
                return;
            }
        };
        let (m, cv) = &*self.inner;
        let mut backoff = 0u64;
        // 401 之后只排队不发，直到 token 变化（重新登录）
        let mut block = TokenBlock::default();
        loop {
            // 等到有事件；没配置时只排队不发，隔几秒再看
            let cfg = config.read().unwrap().clone();
            let mut g = m.lock().unwrap();
            let was_blocked = block.is_set();
            let blocked = block.blocked(cfg.token.trim());
            if was_blocked && !blocked {
                g.last_error = None;
                backoff = 0;
            }
            if blocked || g.queue.is_empty() || cfg.server_url.trim().is_empty() || cfg.token.trim().is_empty() {
                let _ = cv.wait_timeout(g, Duration::from_secs(2)).unwrap();
                continue;
            }
            let n = g.queue.len().min(BATCH_MAX);
            let mut batch: Vec<Event> = g.queue.drain(..n).collect();
            drop(g);
            for e in &mut batch {
                if e.machine.is_empty() {
                    e.machine = cfg.machine.clone();
                }
                strip_nul(e);
            }
            let url = format!("{}/events", cfg.server_url.trim().trim_end_matches('/'));
            // 一批可能还是太大（带正文的事件）：按字节再切成几块分别发
            let mut pending: Vec<Vec<Event>> = split_by_bytes(batch);
            let mut outcome: Result<(), String> = Ok(());
            // 不可丢弃的失败要把没发出去的事件按原顺序放回队首
            let mut retry: Option<Vec<Event>> = None;
            while !pending.is_empty() {
                let chunk = pending.remove(0);
                let sent = chunk.len();
                let res = client
                    .post(&url)
                    .bearer_auth(cfg.token.trim())
                    .json(&serde_json::json!({ "events": chunk }))
                    .send();
                match res {
                    Ok(r) if r.status().is_success() => {}
                    // 401：登录失效，重发也没用，丢弃并停止发送
                    Ok(r) if r.status().as_u16() == 401 => {
                        block.set(cfg.token.trim());
                        outcome = Err(AUTH_EXPIRED.to_string());
                        pending.clear();
                        break;
                    }
                    // 400：这一块事件格式有问题，丢掉它继续发后面的，别把整队卡死
                    Ok(r) if r.status().as_u16() == 400 => {
                        outcome = Err(format!("服务端拒绝事件（400），已丢弃 {sent} 条"));
                    }
                    Ok(r) => {
                        let mut rest = chunk;
                        rest.extend(pending.drain(..).flatten());
                        retry = Some(rest);
                        outcome = Err(format!("服务端返回 {}", r.status()));
                        break;
                    }
                    Err(e) => {
                        let mut rest = chunk;
                        rest.extend(pending.drain(..).flatten());
                        retry = Some(rest);
                        outcome = Err(format!("连接服务端失败：{e}"));
                        break;
                    }
                }
            }
            let mut g = m.lock().unwrap();
            match outcome {
                Ok(()) => {
                    g.last_error = None;
                    backoff = 0;
                }
                Err(msg) => {
                    g.last_error = Some(msg);
                    if let Some(rest) = retry {
                        // 放回队首，保持顺序
                        for e in rest.into_iter().rev() {
                            g.queue.push_front(e);
                        }
                        while g.queue.len() > QUEUE_MAX {
                            g.queue.pop_front();
                        }
                    }
                    backoff = if backoff == 0 { 1 } else { (backoff * 2).min(BACKOFF_MAX) };
                    let _ = cv.wait_timeout(g, Duration::from_secs(backoff)).unwrap();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(n: usize) -> Event {
        Event {
            agent: "claude".into(),
            session_id: n.to_string(),
            machine: String::new(),
            cwd: String::new(),
            state: "idle".into(),
            at: "2026-01-01T00:00:00Z".into(),
            title: None,
            summary: None,
            pid: None,
            quiet: false,
            bg_tasks: 0,
            buckets: Vec::new(),
            messages: Vec::new(),
        }
    }

    #[test]
    fn strips_nul_chars() {
        let mut e = ev(1);
        e.summary = Some("a\0b".into());
        e.cwd = "x\0".into();
        strip_nul(&mut e);
        assert_eq!((e.summary.as_deref(), e.cwd.as_str()), (Some("ab"), "x"));
    }

    #[test]
    fn queue_drops_oldest_when_full() {
        let mut q = VecDeque::new();
        for i in 0..(QUEUE_MAX + 5) {
            push_trim(&mut q, ev(i));
        }
        assert_eq!(q.len(), QUEUE_MAX);
        assert_eq!(q.front().unwrap().session_id, "5");
    }

    #[test]
    fn serializes_camel_case_and_skips_empty() {
        let v = serde_json::to_value(ev(1)).unwrap();
        assert_eq!(v["sessionId"], "1");
        assert!(v.get("title").is_none());
        assert!(v.get("quiet").is_none());
        // 没带正文的事件不该多一个空数组把每个事件都撑大
        assert!(v.get("messages").is_none());
    }

    #[test]
    fn message_text_is_serialized_and_sanitized() {
        let mut e = ev(1);
        e.messages = vec![EventMessage { role: "user".into(), text: "a\0b".into(), at: Some("2026-11-07T01:00:00.000+08:00".into()) }];
        strip_nul(&mut e);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["text"], "ab");
        assert_eq!(v["messages"][0]["at"], "2026-11-07T01:00:00.000+08:00");
    }

    #[test]
    fn batch_is_split_by_payload_bytes() {
        // 每条 ~64 KiB：512 KiB 预算下一批最多 8 条，不能整批塞进一个 1 MiB 的请求体
        let big = "x".repeat(64 * 1024);
        let batch: Vec<Event> = (0..20)
            .map(|i| {
                let mut e = ev(i);
                e.messages = vec![EventMessage { role: "assistant".into(), text: big.clone(), at: None }];
                e
            })
            .collect();
        let chunks = split_by_bytes(batch);
        assert!(chunks.len() >= 3, "20 条 64 KiB 事件应被切成多块，实际 {}", chunks.len());
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 20);
        for c in chunks {
            let bytes = serde_json::to_vec(&serde_json::json!({ "events": c })).unwrap().len();
            assert!(bytes <= BATCH_BYTES + 256 * 1024, "单块序列化后不应远超预算：{bytes}");
        }
    }
}
