//! 事件队列 + 后台线程批量上报服务端，失败指数退避

use crate::config::{SharedConfig, TokenBlock, AUTH_EXPIRED};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const QUEUE_MAX: usize = 1000;
const BATCH_MAX: usize = 100;
const BACKOFF_MAX: u64 = 60;

fn is_false(b: &bool) -> bool {
    !*b
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
    /// 只听不聊的 agent 顺路报活动桶，服务端落 session_activity 给日历画跨度
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buckets: Vec<Bucket>,
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
            let res = client
                .post(url)
                .bearer_auth(cfg.token.trim())
                .json(&serde_json::json!({ "events": batch }))
                .send();
            let outcome = match res {
                Ok(r) if r.status().is_success() => Ok(()),
                // 401：登录失效，重发也没用，丢弃这一批并停止发送
                Ok(r) if r.status().as_u16() == 401 => {
                    block.set(cfg.token.trim());
                    Err((AUTH_EXPIRED.to_string(), true))
                }
                // 400：事件格式有问题，重发也没用，丢弃避免卡死队列
                Ok(r) if r.status().as_u16() == 400 => Err((format!("服务端拒绝事件（400），已丢弃 {} 条", batch.len()), true)),
                Ok(r) => Err((format!("服务端返回 {}", r.status()), false)),
                Err(e) => Err((format!("连接服务端失败：{e}"), false)),
            };
            let mut g = m.lock().unwrap();
            match outcome {
                Ok(()) => {
                    g.last_error = None;
                    backoff = 0;
                }
                Err((msg, drop_batch)) => {
                    g.last_error = Some(msg);
                    if !drop_batch {
                        // 放回队首，保持顺序
                        for e in batch.into_iter().rev() {
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
            buckets: Vec::new(),
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
    }
}
