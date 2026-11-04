//! 执行器 WS 客户端：连服务端 `/ws?role=agent`，把服务端的指令交给 runner，把 runner 的事件发回服务端。
//! 只有「允许手机远程执行」开着、且已登录（token 非空）时才连；配置变化后重连；断线 1s→60s 退避。
//! 登录失效（握手 401 / 关闭码 4401）后不再重连，直到 token 变化。
//! 用同步 tungstenite：socket 设短读超时，同一个循环里交替读和发。

use crate::config::{SharedConfig, TokenBlock, AUTH_EXPIRED};
use crate::runner::Runner;
use serde::Serialize;
use serde_json::Value;
use std::net::TcpStream;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WsError, Message, WebSocket};

const READ_TICK: Duration = Duration::from_millis(200);
const PING_EVERY: Duration = Duration::from_secs(30);
const BACKOFF_MAX: u64 = 60;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub last_error: Option<String>,
}

pub type RemoteStatus = Arc<Mutex<Status>>;

/// 影响连接的配置；变了就重连
#[derive(Clone, PartialEq, Debug)]
struct Snapshot {
    server_url: String,
    token: String,
    machine: String,
}

fn snapshot(cfg: &SharedConfig) -> Option<Snapshot> {
    let c = cfg.read().unwrap();
    if !c.remote_enabled || c.server_url.trim().is_empty() || c.token.trim().is_empty() {
        return None;
    }
    Some(Snapshot { server_url: c.server_url.trim().to_string(), token: c.token.clone(), machine: c.machine.clone() })
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn build_url(s: &Snapshot) -> Result<String, String> {
    let base = s.server_url.trim_end_matches('/');
    let ws = if let Some(r) = base.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = base.strip_prefix("http://") {
        format!("ws://{r}")
    } else {
        return Err("服务端地址必须以 http:// 或 https:// 开头".into());
    };
    Ok(format!("{ws}/ws?token={}&role=agent&machine={}&capabilities=reply-branch-v1,role-v1", urlencode(&s.token), urlencode(&s.machine)))
}

fn set_read_timeout(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, d: Duration) {
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(d));
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.get_ref().set_read_timeout(Some(d));
        }
        _ => {}
    }
}

fn close_reason(code: u16, reason: &str) -> String {
    match code {
        4000 => "被同一台电脑的新连接顶掉了".into(),
        _ => format!("服务端关闭了连接（{code}）{reason}"),
    }
}

/// 连接结束的原因
enum Fail {
    /// 登录失效：不要再重连
    Auth,
    Other(String),
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail::Other(s)
    }
}

/// 一次连接的完整生命周期；返回值是结束原因（Ok = 配置变化主动断开）
fn session(cfg: &SharedConfig, snap: &Snapshot, status: &RemoteStatus) -> Result<(), Fail> {
    let url = build_url(snap)?;
    let (mut ws, _) = tungstenite::connect(url.as_str()).map_err(|e| match &e {
        WsError::Http(resp) if resp.status().as_u16() == 401 => Fail::Auth,
        _ => Fail::Other(format!("连接失败：{e}")),
    })?;
    set_read_timeout(&mut ws, READ_TICK);
    let (out_tx, out_rx) = mpsc::channel::<Value>();
    let runner = Runner::new(out_tx, cfg.clone());
    {
        let mut s = status.lock().unwrap();
        s.connected = true;
        s.last_error = None;
    }
    let mut last_ping = Instant::now();
    let result: Result<(), Fail> = loop {
        if snapshot(cfg).as_ref() != Some(snap) {
            break Ok(());
        }
        let mut send_err = None;
        while let Ok(m) = out_rx.try_recv() {
            if let Err(e) = ws.send(Message::text(m.to_string())) {
                send_err = Some(Fail::Other(format!("发送失败：{e}")));
                break;
            }
        }
        if let Some(e) = send_err {
            break Err(e);
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                    runner.handle(&v);
                }
            }
            Ok(Message::Close(frame)) => {
                break Err(match frame {
                    Some(f) if u16::from(f.code) == 4401 => Fail::Auth,
                    Some(f) => Fail::Other(close_reason(u16::from(f.code), f.reason.as_str())),
                    None => Fail::Other("服务端关闭了连接".into()),
                })
            }
            Ok(_) => {}
            Err(WsError::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => break Err(Fail::Other("连接已关闭".into())),
            Err(e) => break Err(Fail::Other(format!("连接中断：{e}"))),
        }
        if last_ping.elapsed() >= PING_EVERY {
            last_ping = Instant::now();
            if let Err(e) = ws.send(Message::Ping(Vec::new().into())) {
                break Err(Fail::Other(format!("发送失败：{e}")));
            }
        }
    };
    // 断线：结束所有运行（服务端会把它们标成 failed）
    runner.shutdown();
    let _ = ws.close(None);
    let _ = ws.flush();
    result
}

pub fn spawn(cfg: SharedConfig) -> RemoteStatus {
    let status: RemoteStatus = Arc::new(Mutex::new(Status::default()));
    let st = status.clone();
    std::thread::spawn(move || {
        let mut backoff = 1u64;
        let mut block = TokenBlock::default();
        loop {
            let Some(snap) = snapshot(&cfg) else {
                *st.lock().unwrap() = Status::default();
                backoff = 1;
                std::thread::sleep(Duration::from_secs(1));
                continue;
            };
            // 登录已失效：token 没变就不重连
            if block.blocked(&snap.token) {
                *st.lock().unwrap() = Status { connected: false, last_error: Some(AUTH_EXPIRED.into()) };
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let was_connected;
            let res = session(&cfg, &snap, &st);
            {
                let mut s = st.lock().unwrap();
                was_connected = s.connected;
                s.connected = false;
                match &res {
                    Err(Fail::Auth) => {
                        s.last_error = Some(AUTH_EXPIRED.into());
                        block.set(&snap.token);
                    }
                    Err(Fail::Other(e)) => s.last_error = Some(e.clone()),
                    Ok(()) => {}
                }
            }
            if was_connected {
                backoff = 1;
            }
            if res.is_ok() || matches!(res, Err(Fail::Auth)) {
                continue; // 配置变了（或登录失效，上面会拦住），马上按新配置来
            }
            // 退避等待；期间配置变了就提前结束
            let end = Instant::now() + Duration::from_secs(backoff);
            while Instant::now() < end && snapshot(&cfg).as_ref() == Some(&snap) {
                std::thread::sleep(Duration::from_millis(200));
            }
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    });
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::sync::RwLock;

    fn snap(url: &str) -> Snapshot {
        Snapshot { server_url: url.into(), token: "t k".into(), machine: "PC-1".into() }
    }

    #[test]
    fn builds_ws_url() {
        assert_eq!(build_url(&snap("https://x.example.com/")).unwrap(), "wss://x.example.com/ws?token=t%20k&role=agent&machine=PC-1&capabilities=reply-branch-v1,role-v1");
        assert!(!build_url(&snap("https://x")).unwrap().contains("control"));
        assert_eq!(build_url(&snap("http://127.0.0.1:3000")).unwrap(), "ws://127.0.0.1:3000/ws?token=t%20k&role=agent&machine=PC-1&capabilities=reply-branch-v1,role-v1");
        assert!(build_url(&snap("ftp://x")).is_err());
        assert_eq!(urlencode("中a"), "%E4%B8%ADa");
    }

    #[test]
    fn only_connects_when_enabled() {
        let cfg: SharedConfig = Arc::new(RwLock::new(Config {
            server_url: "http://x".into(),
            token: "t".into(),
            machine: "m".into(),
            remote_enabled: false,
            ..Config::default()
        }));
        assert!(snapshot(&cfg).is_none(), "开关没开不连");
        cfg.write().unwrap().remote_enabled = true;
        assert!(snapshot(&cfg).is_some());
        cfg.write().unwrap().token = "  ".into();
        assert!(snapshot(&cfg).is_none(), "没登录（token 为空）不连");
        cfg.write().unwrap().token = "t".into();
        cfg.write().unwrap().server_url = "".into();
        assert!(snapshot(&cfg).is_none(), "没有服务器地址不连");
    }
}
