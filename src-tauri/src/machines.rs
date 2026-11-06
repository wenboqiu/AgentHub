//! 本机改名：服务端是按「机器名」归档会话、运行记录和项目目录的，
//! 所以本机名一改，旧名下的记录也得跟着改，否则界面上会多出一台「已经不存在的电脑」。
//!
//! 触发点有两个：一是老版本在 macOS 上把名字兜底成了 "my-pc"，升级后换回系统真名；
//! 二是用户在设置里手动改了「本机名称」。两种情况都在后台跑，失败只影响显示，不影响启动。

use std::time::Duration;

/// 后台把服务端记在 `from` 下的记录改到 `to`（并合并同名记录）。
/// 没登录、没配服务器、两个名字相同就直接跳过。
pub fn spawn_rename(server_url: &str, token: &str, from: &str, to: &str) {
    let url = server_url.trim().trim_end_matches('/').to_string();
    let token = token.trim().to_string();
    let from = from.trim().to_string();
    let to = to.trim().to_string();
    if from.is_empty() || to.is_empty() || from == to || url.is_empty() || token.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).build() else {
            return;
        };
        let _ = client
            .post(format!("{url}/machines/rename"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "from": from, "to": to }))
            .send();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_useless_calls() {
        // 这几种情况都不该起线程（也没法直接断言，只能保证不 panic）
        spawn_rename("", "t", "a", "b");
        spawn_rename("http://x", "", "a", "b");
        spawn_rename("http://x", "t", "a", "a");
        spawn_rename("http://x", "t", "  ", "b");
    }
}
