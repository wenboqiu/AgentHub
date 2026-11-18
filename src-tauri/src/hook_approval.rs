//! Claude 终端会话的权限确认桥：collector 的 `/claude-permission` 请求在这里发 `hook.approval`
//! 给服务端并阻塞等人点「拒绝 / 允许」；remote.rs 把服务端回来的消息和连接状态交给它。
//! 任何异常（没连上、断线、超时、服务端不受理）都返回 None，hook 不输出，终端照常弹原生确认框。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq)]
enum Reply {
    Created(String),
    Decide(String),
    Gone,
}

#[derive(Default)]
struct Inner {
    /// 当前 WebSocket 连接的发送端；没连上为 None
    out: Option<Sender<Value>>,
    /// localId -> 等待者
    waiters: HashMap<u64, Sender<Reply>>,
    /// approvalId -> localId
    by_approval: HashMap<String, u64>,
}

#[derive(Default)]
pub struct HookBridge {
    next_id: AtomicU64,
    inner: Mutex<Inner>,
}

pub type SharedBridge = Arc<HookBridge>;

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Allow,
    Deny,
}

impl HookBridge {
    pub fn new() -> SharedBridge {
        Arc::new(HookBridge::default())
    }

    /// 连上时 Some(out)，断开时 None；断开会让所有等待者立即以「无决定」返回
    pub fn set_out(&self, out: Option<Sender<Value>>) {
        let mut g = self.inner.lock().unwrap();
        if out.is_none() {
            for (_, w) in g.waiters.drain() {
                let _ = w.send(Reply::Gone);
            }
            g.by_approval.clear();
        }
        g.out = out;
    }

    pub fn connected(&self) -> bool {
        self.inner.lock().unwrap().out.is_some()
    }

    /// 服务端 `hook.approval.created`
    pub fn on_created(&self, msg: &Value) {
        let Some(local_id) = msg.get("localId").and_then(Value::as_u64) else { return };
        let approval_id = msg.get("approvalId").and_then(Value::as_str).unwrap_or("").to_string();
        let mut g = self.inner.lock().unwrap();
        if !g.waiters.contains_key(&local_id) {
            return;
        }
        if !approval_id.is_empty() {
            g.by_approval.insert(approval_id.clone(), local_id);
        }
        if let Some(w) = g.waiters.get(&local_id) {
            let _ = w.send(Reply::Created(approval_id));
        }
    }

    /// 服务端 `hook.approval.decide`
    pub fn on_decide(&self, msg: &Value) {
        let approval_id = msg.get("approvalId").and_then(Value::as_str).unwrap_or("");
        let decision = msg.get("decision").and_then(Value::as_str).unwrap_or("").to_string();
        let g = self.inner.lock().unwrap();
        if let Some(w) = g.by_approval.get(approval_id).and_then(|id| g.waiters.get(id)) {
            let _ = w.send(Reply::Decide(decision));
        }
    }

    /// 发审批并阻塞等人处理，最多 `wait`。只有明确的 deny（或 `allow_ok` 时的 allow）才返回 Some；
    /// 其余（没连上、服务端不受理、超时、断线、allow 但不允许远程放行）都是 None，并通知服务端把审批置为过期。
    pub fn request(&self, session_key: &str, tool: &str, detail: &str, allow_ok: bool, wait: Duration) -> Option<Decision> {
        let (tx, rx) = mpsc::channel::<Reply>();
        let local_id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut g = self.inner.lock().unwrap();
            let out = g.out.clone()?;
            g.waiters.insert(local_id, tx);
            let msg = json!({"type":"hook.approval","localId":local_id,"sessionKey":session_key,"tool":tool,"detail":detail,"canAllow":allow_ok});
            if out.send(msg).is_err() {
                g.waiters.remove(&local_id);
                return None;
            }
        }
        let deadline = Instant::now() + wait;
        let mut approval_id = String::new();
        let mut result = None;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Reply::Created(id)) => {
                    if id.is_empty() {
                        break; // 服务端不受理：放弃，不用发 expired
                    }
                    approval_id = id;
                }
                Ok(Reply::Decide(d)) => {
                    result = match d.as_str() {
                        "deny" => Some(Decision::Deny),
                        "allow" if allow_ok => Some(Decision::Allow),
                        _ => None,
                    };
                    break;
                }
                Ok(Reply::Gone) | Err(_) => break,
            }
        }
        let mut g = self.inner.lock().unwrap();
        g.waiters.remove(&local_id);
        if !approval_id.is_empty() {
            g.by_approval.remove(&approval_id);
            if result.is_none() {
                if let Some(out) = &g.out {
                    let _ = out.send(json!({"type":"hook.approval.expired","approvalId":approval_id}));
                }
            }
        }
        result
    }
}

/// hook 的 stdout：只有 `behavior` 字段是文档确认过的，不加别的
pub fn decision_json(d: &Decision) -> String {
    let behavior = match d {
        Decision::Allow => "allow",
        Decision::Deny => "deny",
    };
    json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":behavior}}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::thread;

    const WAIT: Duration = Duration::from_secs(5);

    fn setup() -> (SharedBridge, Receiver<Value>) {
        let b = HookBridge::new();
        let (tx, rx) = mpsc::channel();
        b.set_out(Some(tx));
        (b, rx)
    }

    fn spawn_req(b: &SharedBridge, allow_ok: bool, wait: Duration) -> thread::JoinHandle<Option<Decision>> {
        let b = b.clone();
        thread::spawn(move || b.request("sess-1", "Bash", "rm -rf x", allow_ok, wait))
    }

    fn recv(rx: &Receiver<Value>) -> Value {
        rx.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn deny_returns_deny() {
        let (b, rx) = setup();
        let h = spawn_req(&b, false, WAIT);
        let m = recv(&rx);
        assert_eq!(m["type"], "hook.approval");
        assert_eq!((m["sessionKey"].as_str(), m["tool"].as_str(), m["canAllow"].as_bool()), (Some("sess-1"), Some("Bash"), Some(false)));
        let lid = m["localId"].as_u64().unwrap();
        b.on_created(&json!({"localId":lid,"approvalId":"a1"}));
        b.on_decide(&json!({"approvalId":"a1","decision":"deny"}));
        assert_eq!(h.join().unwrap(), Some(Decision::Deny));
        assert!(rx.try_recv().is_err(), "有决定就不发 expired");
    }

    #[test]
    fn allow_needs_switch() {
        let (b, rx) = setup();
        let h = spawn_req(&b, true, WAIT);
        let lid = recv(&rx)["localId"].as_u64().unwrap();
        b.on_created(&json!({"localId":lid,"approvalId":"a1"}));
        b.on_decide(&json!({"approvalId":"a1","decision":"allow"}));
        assert_eq!(h.join().unwrap(), Some(Decision::Allow));

        // 开关关着时收到 allow：无决定，并通知服务端过期
        let h = spawn_req(&b, false, WAIT);
        let lid = recv(&rx)["localId"].as_u64().unwrap();
        b.on_created(&json!({"localId":lid,"approvalId":"a2"}));
        b.on_decide(&json!({"approvalId":"a2","decision":"allow"}));
        assert_eq!(h.join().unwrap(), None);
        let m = recv(&rx);
        assert_eq!((m["type"].as_str(), m["approvalId"].as_str()), (Some("hook.approval.expired"), Some("a2")));
    }

    #[test]
    fn timeout_sends_expired() {
        let (b, rx) = setup();
        let h = spawn_req(&b, true, Duration::from_millis(300));
        let lid = recv(&rx)["localId"].as_u64().unwrap();
        b.on_created(&json!({"localId":lid,"approvalId":"a1"}));
        assert_eq!(h.join().unwrap(), None);
        let m = recv(&rx);
        assert_eq!((m["type"].as_str(), m["approvalId"].as_str()), (Some("hook.approval.expired"), Some("a1")));
        // 过期后迟到的决定被忽略，不 panic
        b.on_decide(&json!({"approvalId":"a1","decision":"deny"}));
    }

    #[test]
    fn server_refusal_gives_up_immediately() {
        let (b, rx) = setup();
        let h = spawn_req(&b, true, WAIT);
        let lid = recv(&rx)["localId"].as_u64().unwrap();
        let t = Instant::now();
        b.on_created(&json!({"localId":lid,"approvalId":""}));
        assert_eq!(h.join().unwrap(), None);
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn disconnect_releases_waiters() {
        let (b, rx) = setup();
        let h = spawn_req(&b, true, WAIT);
        let lid = recv(&rx)["localId"].as_u64().unwrap();
        b.on_created(&json!({"localId":lid,"approvalId":"a1"}));
        let t = Instant::now();
        b.set_out(None);
        assert_eq!(h.join().unwrap(), None);
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(!b.connected());
    }

    #[test]
    fn not_connected_returns_none_without_waiting() {
        let b = HookBridge::new();
        let t = Instant::now();
        assert_eq!(b.request("s", "Bash", "x", true, WAIT), None);
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn decision_json_only_has_behavior() {
        let v: Value = serde_json::from_str(&decision_json(&Decision::Deny)).unwrap();
        assert_eq!(v, json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}));
        assert!(decision_json(&Decision::Allow).contains("\"allow\""));
    }
}
