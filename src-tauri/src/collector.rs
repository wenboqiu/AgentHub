//! 127.0.0.1:47821 本地 HTTP：接收 Claude hook 上报（POST /claude?pid=<winpid>）

use crate::claude;
use crate::forwarder::Forwarder;
use std::io::Read;
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 47821;
const BODY_MAX: u64 = 4 * 1024 * 1024;

/// 采集端口状态：None 表示正常，Some 为错误说明（设置页显示）
pub type CollectorStatus = Arc<Mutex<Option<String>>>;

pub fn parse_pid(url: &str) -> Option<u32> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("pid=")).and_then(|v| v.parse().ok()).filter(|p| *p > 0)
}

pub fn spawn(fwd: Forwarder, status: CollectorStatus) {
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
            if *req.method() != tiny_http::Method::Post || path != "/claude" {
                let _ = req.respond(tiny_http::Response::empty(404));
                continue;
            }
            let mut body = String::new();
            let read = req.as_reader().take(BODY_MAX).read_to_string(&mut body);
            // 先回 204，hook 不用等后面读 transcript
            let _ = req.respond(tiny_http::Response::empty(204));
            if read.is_err() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(ev) = claude::hook_to_event(&v, parse_pid(&url)) {
                    fwd.push(ev);
                }
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
