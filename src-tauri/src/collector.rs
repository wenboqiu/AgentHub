//! 127.0.0.1:47821 本地 HTTP：接收 Claude hook 上报（POST /claude?pid=<winpid>）

use crate::claude;
use crate::config::SharedConfig;
use crate::focus;
use crate::forwarder::Forwarder;
use crate::hook_approval::{self, SharedBridge};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PORT: u16 = 47821;
const BODY_MAX: u64 = 4 * 1024 * 1024;

/// 采集端口状态：None 表示正常，Some 为错误说明（设置页显示）
pub type CollectorStatus = Arc<Mutex<Option<String>>>;

pub fn parse_pid(url: &str) -> Option<u32> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("pid=")).and_then(|v| v.parse().ok()).filter(|p| *p > 0)
}

/// 把 hook JSON 转成事件上报（/claude 与 /claude-permission 共用）
fn push_event(fwd: &Forwarder, v: &serde_json::Value, pid: Option<u32>) {
    if let Some(mut ev) = claude::hook_to_event(v, pid) {
        // hook 本身只有状态：活动桶顺路从 transcript 取，日历才有跨度和分段
        if ev.buckets.is_empty() {
            ev.buckets = claude::activity_buckets(v);
        }
        fwd.push(ev);
    }
}

/// /claude-permission：上报 waiting 状态后（开了开关、连着服务端、不是提问）阻塞等客户端点拒绝 / 允许，
/// 响应体是 hook 的 stdout；没有决定时是空体，hook 什么都不输出，终端照常弹原生确认框
fn handle_permission(mut req: tiny_http::Request, pid: Option<u32>, fwd: Forwarder, bridge: SharedBridge, cfg: SharedConfig) {
    let mut body = String::new();
    if req.as_reader().take(BODY_MAX).read_to_string(&mut body).is_err() {
        let _ = req.respond(tiny_http::Response::empty(200));
        return;
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        push_event(&fwd, &v, pid);
        let (approve, allow) = {
            let c = cfg.read().unwrap();
            (c.hook_remote_approve, c.hook_remote_allow)
        };
        if approve && bridge.connected() {
            if let Some((sid, tool, detail)) = claude::permission_request(&v) {
                let wait = Duration::from_secs(claude::HOOK_WAIT_SECS);
                if let Some(d) = bridge.request(&sid, &tool, &detail, allow, wait) {
                    out = hook_approval::decision_json(&d);
                }
            }
        }
    }
    let _ = req.respond(tiny_http::Response::from_string(out));
}

pub fn spawn(fwd: Forwarder, status: CollectorStatus, bridge: SharedBridge, cfg: SharedConfig) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("采集端口 {PORT} 监听失败：{e}");
                *status.lock().unwrap() = Some(format!("采集端口 {PORT} 被占用（{e}）"));
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let path = url.split('?').next().unwrap_or("");
            if *req.method() != tiny_http::Method::Post || (path != "/claude" && path != "/claude-permission") {
                let _ = req.respond(tiny_http::Response::empty(404));
                continue;
            }
            if path == "/claude-permission" {
                // 阻塞式：必须在独立线程里处理，别卡住这个单线程循环（pid 同样要在回包前解析）
                let pid = parse_pid(&url).map(focus::stable_pid);
                let (fwd, bridge, cfg) = (fwd.clone(), bridge.clone(), cfg.clone());
                std::thread::spawn(move || handle_permission(req, pid, fwd, bridge, cfg));
                continue;
            }
            // 必须在回 204 之前解析：回完之后 hook 的 bash 很快退出，父进程链就断了
            let pid = parse_pid(&url).map(focus::stable_pid);
            let mut body = String::new();
            let read = req.as_reader().take(BODY_MAX).read_to_string(&mut body);
            // 先回 204，hook 不用等后面读 transcript
            let _ = req.respond(tiny_http::Response::empty(204));
            if read.is_err() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                push_event(&fwd, &v, pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_from_query() {
        assert_eq!(parse_pid("/claude?pid=123"), Some(123));
        assert_eq!(parse_pid("/claude?pid=0"), None);
        assert_eq!(parse_pid("/claude"), None);
        assert_eq!(parse_pid("/claude?a=1&pid=9"), Some(9));
    }
}
