//! Hub 任务队列 + 本地 HTTP API（127.0.0.1:47822）
//!
//! 分单模式：创建任务时指定 worker；worker 的定时自动化来拉单干活。
//! 状态机：
//!   Queued →（claim）→ Dispatched →（ack）→ Running →（report ok）→ Done
//!                                            └→（report !ok）→ Queued（重派）/ Failed（超上限）
//!   Dispatched 超过 ACK_TIMEOUT 未 ack → 回队或 Failed
//!   Running 超过 HEARTBEAT_TIMEOUT 未心跳 → 回队或 Failed
//! 回队 / 重派次数达到 MAX_DISPATCHES 即判 Failed，不再自动回队。
//!
//! 接口（均需 `Authorization: Bearer <hub_token>`，hub_token 为空时本机回环不鉴权）：
//!   POST /hub/tasks                       创建任务 {title, body, worker, workspace?}
//!   GET  /hub/claim?worker=X              拉单：队首一单标为 Dispatched 返回；无单返回 {empty:true}
//!   POST /hub/ack                         {taskId} Dispatched → Running
//!   POST /hub/heartbeat                   {taskId} Running 续约
//!   POST /hub/report                      {taskId, ok, summary, artifacts?, retry?}
//!   POST /hub/cancel                      {taskId}
//!   GET  /hub/tasks?state=queued          任务列表
//!   GET  /hub/ping?worker=X               worker 报到：{queued, running}（用于「忙时不拉」）
//!   GET  /hub/workers                     worker 及其负载一览

use crate::config::SharedConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 47822;
const BODY_MAX: u64 = 4 * 1024 * 1024;
/// Dispatched（已拉单未确认）的宽限期
pub const ACK_TIMEOUT_MS: i64 = 5 * 60_000;
/// Running 状态两次心跳的最大间隔
pub const HEARTBEAT_TIMEOUT_MS: i64 = 10 * 60_000;
/// 单个任务最多派发次数（claim 计数），超过判 Failed
pub const MAX_DISPATCHES: u32 = 3;

pub type SharedHub = Arc<Mutex<Hub>>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Queued,
    Dispatched,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Dispatched => "dispatched",
            TaskState::Running => "running",
            TaskState::Done => "done",
            TaskState::Failed => "failed",
            TaskState::Cancelled => "cancelled",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    /// 工单标题（一句话）
    pub title: String,
    /// 工单正文（自包含：背景 / 约束 / 验收标准 / 回报方式）
    pub body: String,
    /// 指定的执行方，如 "workbuddy" / "doubao" / "claude"
    pub worker: String,
    /// 工作区绝对路径（可空）
    pub workspace: String,
    pub state: TaskState,
    /// 已派发次数（claim 时 +1）
    pub dispatches: u32,
    /// 回报摘要 / 失败原因
    pub result: Option<String>,
    pub artifacts: Vec<String>,
    pub ok: Option<bool>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Dispatched / Running 的超时截止时刻（毫秒），其余状态为 None
    pub deadline: Option<i64>,
}

impl Default for Task {
    fn default() -> Self {
        Task {
            id: String::new(),
            title: String::new(),
            body: String::new(),
            worker: String::new(),
            workspace: String::new(),
            state: TaskState::Queued,
            dispatches: 0,
            result: None,
            artifacts: Vec::new(),
            ok: None,
            created_at: 0,
            updated_at: 0,
            deadline: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct WorkerInfo {
    name: String,
    last_seen: i64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    tasks: Vec<Task>,
    workers: Vec<WorkerInfo>,
}

pub struct Hub {
    store: Store,
    path: Option<PathBuf>,
    seq: u64,
}

impl Hub {
    pub fn new(path: Option<PathBuf>) -> Self {
        Hub { store: Store::default(), path, seq: 0 }
    }

    /// 从磁盘恢复；损坏 / 不存在则空表启动
    pub fn load(path: Option<PathBuf>) -> Self {
        let mut hub = Hub::new(path.clone());
        if let Some(p) = path {
            if let Ok(text) = std::fs::read_to_string(&p) {
                if let Ok(s) = serde_json::from_str::<Store>(&text) {
                    hub.store = s;
                }
            }
        }
        hub
    }

    fn save(&self) {
        let Some(p) = &self.path else { return };
        if let Ok(text) = serde_json::to_string_pretty(&self.store) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = p.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, p);
            }
        }
    }

    fn new_id(&mut self, now: i64) -> String {
        self.seq += 1;
        format!("T{:x}-{:04}", now, self.seq)
    }

    /// 超时回收：Dispatched 未 ack / Running 心跳断 → 回队或 Failed
    pub fn sweep(&mut self, now: i64) {
        for t in self.store.tasks.iter_mut() {
            let Some(dl) = t.deadline else { continue };
            if now <= dl {
                continue;
            }
            let timed_out = match t.state {
                TaskState::Dispatched => "拉单后未在时限内确认（ack）",
                TaskState::Running => "运行中心跳超时",
                _ => continue,
            };
            t.deadline = None;
            t.updated_at = now;
            if t.dispatches >= MAX_DISPATCHES {
                t.state = TaskState::Failed;
                t.ok = Some(false);
                t.result = Some(format!("{timed_out}，已重派 {} 次仍失败", t.dispatches));
            } else {
                t.state = TaskState::Queued;
                t.result = Some(format!("{timed_out}，已回队等待重派（第 {} 次派发）", t.dispatches));
            }
        }
    }

    pub fn create(&mut self, title: String, body: String, worker: String, workspace: String, now: i64) -> Task {
        let t = Task {
            id: self.new_id(now),
            title,
            body,
            worker,
            workspace,
            state: TaskState::Queued,
            created_at: now,
            updated_at: now,
            ..Task::default()
        };
        self.store.tasks.push(t.clone());
        self.save();
        t
    }

    /// 从该 worker 的队首取一单；原子：取到即 Dispatched
    pub fn claim(&mut self, worker: &str, now: i64) -> Option<Task> {
        self.sweep(now);
        let t = self
            .store
            .tasks
            .iter_mut()
            .find(|t| t.state == TaskState::Queued && t.worker.eq_ignore_ascii_case(worker))?;
        t.state = TaskState::Dispatched;
        t.dispatches += 1;
        t.deadline = Some(now + ACK_TIMEOUT_MS);
        t.updated_at = now;
        let t = t.clone();
        self.save();
        Some(t)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.store.tasks.iter_mut().find(|t| t.id == id)
    }

    pub fn ack(&mut self, id: &str, now: i64) -> Result<(), String> {
        let t = self.find_mut(id).ok_or_else(|| "任务不存在".to_string())?;
        match t.state {
            TaskState::Dispatched => {}
            TaskState::Running => return Ok(()), // 幂等：重复 ack 无害
            s => return Err(format!("当前状态 {} 不能 ack", s.as_str())),
        }
        t.state = TaskState::Running;
        t.deadline = Some(now + HEARTBEAT_TIMEOUT_MS);
        t.updated_at = now;
        self.save();
        Ok(())
    }

    pub fn heartbeat(&mut self, id: &str, now: i64) -> Result<(), String> {
        let t = self.find_mut(id).ok_or_else(|| "任务不存在".to_string())?;
        match t.state {
            TaskState::Running | TaskState::Dispatched => {}
            s => return Err(format!("当前状态 {} 无需心跳", s.as_str())),
        }
        t.deadline = Some(now + if t.state == TaskState::Running { HEARTBEAT_TIMEOUT_MS } else { ACK_TIMEOUT_MS });
        t.updated_at = now;
        self.save();
        Ok(())
    }

    /// 回报：ok → Done；!ok → 回队重派（retry=false 或超上限则 Failed）
    pub fn report(&mut self, id: &str, ok: bool, summary: String, artifacts: Vec<String>, retry: bool, now: i64) -> Result<Task, String> {
        let t = self.find_mut(id).ok_or_else(|| "任务不存在".to_string())?;
        match t.state {
            TaskState::Running | TaskState::Dispatched => {}
            s => return Err(format!("当前状态 {} 不能回报", s.as_str())),
        }
        t.deadline = None;
        t.updated_at = now;
        t.result = Some(summary);
        t.artifacts = artifacts;
        t.ok = Some(ok);
        if ok {
            t.state = TaskState::Done;
        } else if retry && t.dispatches < MAX_DISPATCHES {
            t.state = TaskState::Queued;
        } else {
            t.state = TaskState::Failed;
        }
        let t = t.clone();
        self.save();
        Ok(t)
    }

    pub fn cancel(&mut self, id: &str, now: i64) -> Result<(), String> {
        let t = self.find_mut(id).ok_or_else(|| "任务不存在".to_string())?;
        match t.state {
            TaskState::Queued | TaskState::Dispatched | TaskState::Running => {}
            s => return Err(format!("当前状态 {} 不能取消", s.as_str())),
        }
        t.state = TaskState::Cancelled;
        t.deadline = None;
        t.updated_at = now;
        self.save();
        Ok(())
    }

    pub fn list(&mut self, state: Option<TaskState>, now: i64) -> Vec<Task> {
        self.sweep(now);
        self.save();
        self.store
            .tasks
            .iter()
            .filter(|t| state.is_none_or(|s| t.state == s))
            .cloned()
            .collect()
    }

    // 后续 tauri command（UI 任务列表详情）会用到，先保留
    #[allow(dead_code)]
    pub fn get(&mut self, id: &str, now: i64) -> Option<Task> {
        self.sweep(now);
        self.store.tasks.iter().find(|t| t.id == id).cloned()
    }

    pub fn touch_worker(&mut self, name: &str, now: i64) {
        match self.store.workers.iter_mut().find(|w| w.name == name) {
            Some(w) => w.last_seen = now,
            None => self.store.workers.push(WorkerInfo { name: name.to_string(), last_seen: now }),
        }
        self.save();
    }

    /// 某 worker 的排队 / 运行中数量（ping 用，顺带回收超时单）
    pub fn worker_load(&mut self, name: &str, now: i64) -> (usize, usize) {
        self.sweep(now);
        self.save();
        let queued = self.store.tasks.iter().filter(|t| t.state == TaskState::Queued && t.worker.eq_ignore_ascii_case(name)).count();
        let running = self
            .store
            .tasks
            .iter()
            .filter(|t| matches!(t.state, TaskState::Dispatched | TaskState::Running) && t.worker.eq_ignore_ascii_case(name))
            .count();
        (queued, running)
    }

    pub fn workers(&mut self, now: i64) -> Vec<(String, i64, usize, usize)> {
        self.sweep(now);
        self.save();
        let names: Vec<String> = {
            let mut v: Vec<String> = self.store.workers.iter().map(|w| w.name.clone()).collect();
            for t in &self.store.tasks {
                if !v.iter().any(|n| n.eq_ignore_ascii_case(&t.worker)) {
                    v.push(t.worker.clone());
                }
            }
            v
        };
        names
            .into_iter()
            .map(|n| {
                let last_seen = self.store.workers.iter().find(|w| w.name == n).map(|w| w.last_seen).unwrap_or(0);
                let (queued, running) = self.worker_load(&n, now);
                (n, last_seen, queued, running)
            })
            .collect()
    }

    /// worker 一览的序列化视图（tauri command 用）
    pub fn workers_view(&mut self, now: i64) -> Vec<WorkerView> {
        self.workers(now)
            .into_iter()
            .map(|(name, last_seen, queued, running)| WorkerView { name, last_seen, queued, running })
            .collect()
    }
}

/// 供前端展示的 worker 汇总
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    pub name: String,
    pub last_seen: i64,
    pub queued: usize,
    pub running: usize,
}

// ---------- HTTP 层 ----------

fn query_get(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    let raw = q.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))?;
    // 简单 percent-decode（worker 名 / state 都是简单值，够了）
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

fn state_from_str(s: &str) -> Option<TaskState> {
    match s.to_ascii_lowercase().as_str() {
        "queued" => Some(TaskState::Queued),
        "dispatched" => Some(TaskState::Dispatched),
        "running" => Some(TaskState::Running),
        "done" => Some(TaskState::Done),
        "failed" => Some(TaskState::Failed),
        "cancelled" => Some(TaskState::Cancelled),
        _ => None,
    }
}

fn task_json(t: &Task) -> Value {
    json!({
        "id": t.id, "title": t.title, "body": t.body, "worker": t.worker, "workspace": t.workspace,
        "state": t.state.as_str(), "dispatches": t.dispatches, "result": t.result,
        "artifacts": t.artifacts, "ok": t.ok, "createdAt": t.created_at, "updatedAt": t.updated_at,
    })
}

/// 处理一个 /hub 请求，返回 (状态码, JSON 体)
fn handle(hub: &Mutex<Hub>, method: &tiny_http::Method, url: &str, body: &str) -> (u16, Value) {
    let path = url.split('?').next().unwrap_or("");
    let now = now_ms();
    let err = |code: u16, msg: &str| (code, json!({ "error": msg }));

    match (method, path) {
        (m, p) if *m == tiny_http::Method::Post && p == "/hub/tasks" => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return err(400, "请求体不是合法 JSON");
            };
            let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            let worker = v.get("worker").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if title.is_empty() || worker.is_empty() {
                return err(400, "title 和 worker 不能为空");
            }
            let t = hub.lock().unwrap().create(
                title,
                v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                worker,
                v.get("workspace").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                now,
            );
            (200, task_json(&t))
        }
        (m, p) if *m == tiny_http::Method::Get && p == "/hub/claim" => {
            let Some(worker) = query_get(url, "worker").filter(|w| !w.is_empty()) else {
                return err(400, "缺少 worker 参数");
            };
            let mut h = hub.lock().unwrap();
            h.touch_worker(&worker, now);
            match h.claim(&worker, now) {
                Some(t) => (200, task_json(&t)),
                None => (200, json!({ "empty": true })),
            }
        }
        (m, p) if *m == tiny_http::Method::Get && p == "/hub/ping" => {
            let Some(worker) = query_get(url, "worker").filter(|w| !w.is_empty()) else {
                return err(400, "缺少 worker 参数");
            };
            let mut h = hub.lock().unwrap();
            h.touch_worker(&worker, now);
            let (queued, running) = h.worker_load(&worker, now);
            (200, json!({ "queued": queued, "running": running }))
        }
        (m, p) if *m == tiny_http::Method::Get && p == "/hub/workers" => {
            let mut h = hub.lock().unwrap();
            let ws: Vec<Value> = h
                .workers(now)
                .into_iter()
                .map(|(name, last_seen, queued, running)| {
                    json!({ "name": name, "lastSeen": last_seen, "queued": queued, "running": running })
                })
                .collect();
            (200, json!({ "workers": ws }))
        }
        (m, p) if *m == tiny_http::Method::Get && p == "/hub/tasks" => {
            let state = query_get(url, "state").and_then(|s| state_from_str(&s));
            let ts = hub.lock().unwrap().list(state, now);
            (200, json!({ "tasks": ts.iter().map(task_json).collect::<Vec<_>>() }))
        }
        (m, _) if *m == tiny_http::Method::Post => {
            let Some(id) = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("taskId").and_then(|x| x.as_str()).map(|s| s.to_string())) else {
                return err(400, "缺少 taskId");
            };
            let mut h = hub.lock().unwrap();
            let res = match path {
                "/hub/ack" => h.ack(&id, now).map(|_| json!({ "ok": true })),
                "/hub/heartbeat" => h.heartbeat(&id, now).map(|_| json!({ "ok": true })),
                "/hub/cancel" => h.cancel(&id, now).map(|_| json!({ "ok": true })),
                "/hub/report" => {
                    let Ok(v) = serde_json::from_str::<Value>(body) else {
                        return err(400, "请求体不是合法 JSON");
                    };
                    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                    let summary = v.get("summary").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let artifacts: Vec<String> = v
                        .get("artifacts")
                        .and_then(|x| x.as_array())
                        .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    let retry = v.get("retry").and_then(|x| x.as_bool()).unwrap_or(true);
                    h.report(&id, ok, summary, artifacts, retry, now).map(|t| task_json(&t))
                }
                _ => return err(404, "未知路径"),
            };
            match res {
                Ok(v) => (200, v),
                Err(e) => err(409, &e),
            }
        }
        _ => err(404, "未知路径"),
    }
}

const HUB_PREFIX: &str = "/hub/";

fn serve_loop(server: tiny_http::Server, hub: Arc<Mutex<Hub>>, cfg: SharedConfig) {
    for mut req in server.incoming_requests() {
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("");
        if !path.starts_with(HUB_PREFIX) {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let (enabled, token) = {
            let c = cfg.read().unwrap();
            (c.hub_enabled, c.hub_token.clone())
        };
        if !enabled {
            let _ = req.respond(tiny_http::Response::from_string(json!({"error": "hub 未启用"}).to_string()).with_status_code(503));
            continue;
        }
        // 鉴权：token 为空时本机回环不鉴权
        if !token.is_empty() {
            let ok = req
                .headers()
                .iter()
                .any(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization") && h.value.as_str().strip_prefix("Bearer ") == Some(token.as_str()));
            if !ok {
                let _ = req.respond(
                    tiny_http::Response::from_string(json!({"error": "鉴权失败"}).to_string()).with_status_code(401),
                );
                continue;
            }
        }
        let mut body = String::new();
        let _ = req.as_reader().take(BODY_MAX).read_to_string(&mut body);
        let (code, v) = handle(&hub, req.method(), &url, &body);
        let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
        let _ = req.respond(tiny_http::Response::from_string(v.to_string()).with_status_code(code).with_header(ct));
    }
}

pub fn start(cfg: SharedConfig, hub: SharedHub) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Hub 端口 {PORT} 监听失败：{e}");
                return;
            }
        };
        serve_loop(server, hub, cfg);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::sync::RwLock;

    const T0: i64 = 1_000_000_000_000;

    fn hub() -> Hub {
        Hub::new(None)
    }

    fn mk(h: &mut Hub, worker: &str, now: i64) -> String {
        h.create("标题".into(), "正文".into(), worker.into(), "D:/Work2".into(), now).id
    }

    #[test]
    fn full_flow_claim_ack_report_done() {
        let mut h = hub();
        let id = mk(&mut h, "workbuddy", T0);
        let claimed = h.claim("workbuddy", T0 + 1000).unwrap();
        assert_eq!(claimed.id, id);
        // Dispatched（未 ack）也允许直接 report：快速完成的 worker 可以跳过 ack
        let t = h.report(&id, true, "完成".into(), vec!["D:/out.md".into()], true, T0 + 2000).unwrap();
        assert_eq!(t.state, TaskState::Done);
        assert_eq!(t.artifacts, vec!["D:/out.md".to_string()]);
        assert!(h.claim("workbuddy", T0 + 5000).is_none(), "完成后不应再拉到");
        // ack / 心跳对 Done 无效
        assert!(h.ack(&id, T0 + 6000).is_err());
        assert!(h.heartbeat(&id, T0 + 6000).is_err());
    }

    #[test]
    fn ack_heartbeat_then_report_done() {
        let mut h = hub();
        let id = mk(&mut h, "workbuddy", T0);
        h.claim("workbuddy", T0).unwrap();
        h.ack(&id, T0 + 1000).unwrap();
        // 幂等 ack
        h.ack(&id, T0 + 1000).unwrap();
        h.heartbeat(&id, T0 + 2000).unwrap();
        let t = h.report(&id, true, "完成".into(), vec![], true, T0 + 3000).unwrap();
        assert_eq!(t.state, TaskState::Done);
    }

    #[test]
    fn claim_empty_without_tasks() {
        let mut h = hub();
        assert!(h.claim("doubao", T0).is_none());
    }

    #[test]
    fn per_worker_isolation() {
        let mut h = hub();
        mk(&mut h, "doubao", T0);
        assert!(h.claim("workbuddy", T0).is_none(), "别家的单不能拉");
        assert!(h.claim("doubao", T0).is_some());
    }

    #[test]
    fn ack_timeout_requeues_then_fails() {
        let mut h = hub();
        let id = mk(&mut h, "workbuddy", T0);
        h.claim("workbuddy", T0).unwrap();
        // 超过 ACK_TIMEOUT 被 sweep 回队
        h.sweep(T0 + ACK_TIMEOUT_MS + 1);
        assert_eq!(h.get(&id, T0 + ACK_TIMEOUT_MS + 2).unwrap().state, TaskState::Queued);
        // 反复超时直到 MAX_DISPATCHES 判 Failed
        for _ in 1..MAX_DISPATCHES {
            h.claim("workbuddy", T0).unwrap();
            h.sweep(T0 + ACK_TIMEOUT_MS + 1);
        }
        let t = h.get(&id, T0).unwrap();
        assert_eq!(t.state, TaskState::Failed);
        assert_eq!(t.dispatches, MAX_DISPATCHES);
        assert!(h.claim("workbuddy", T0).is_none(), "Failed 后不再可拉");
    }

    #[test]
    fn heartbeat_extends_running_deadline() {
        let mut h = hub();
        let id = mk(&mut h, "workbuddy", T0);
        h.claim("workbuddy", T0).unwrap();
        h.ack(&id, T0).unwrap();
        // 心跳续命：远超单次 HEARTBEAT_TIMEOUT，但每次都续上就不超时
        let mut now = T0;
        for _ in 0..10 {
            now += HEARTBEAT_TIMEOUT_MS - 1000;
            h.heartbeat(&id, now).unwrap();
        }
        h.sweep(now + 1000);
        assert_eq!(h.get(&id, now).unwrap().state, TaskState::Running);
        // 停止心跳 → 超时回队
        h.sweep(now + HEARTBEAT_TIMEOUT_MS + 1);
        assert_eq!(h.get(&id, now).unwrap().state, TaskState::Queued);
    }

    #[test]
    fn report_failure_requeues_until_max() {
        let mut h = hub();
        let id = mk(&mut h, "doubao", T0);
        for round in 1..=MAX_DISPATCHES {
            h.claim("doubao", T0).unwrap();
            h.ack(&id, T0).unwrap();
            let t = h.report(&id, false, format!("第 {round} 次失败"), vec![], true, T0).unwrap();
            let expected = if round < MAX_DISPATCHES { TaskState::Queued } else { TaskState::Failed };
            assert_eq!(t.state, expected);
        }
    }

    #[test]
    fn report_failure_no_retry_fails_immediately() {
        let mut h = hub();
        let id = mk(&mut h, "doubao", T0);
        h.claim("doubao", T0).unwrap();
        h.ack(&id, T0).unwrap();
        let t = h.report(&id, false, "不重试".into(), vec![], false, T0).unwrap();
        assert_eq!(t.state, TaskState::Failed);
    }

    #[test]
    fn cancel_removes_from_queue() {
        let mut h = hub();
        let id = mk(&mut h, "doubao", T0);
        h.cancel(&id, T0).unwrap();
        assert!(h.claim("doubao", T0).is_none());
        assert!(h.cancel(&id, T0).is_err(), "已取消的不能再取消");
    }

    #[test]
    fn state_filter_list() {
        let mut h = hub();
        let a = mk(&mut h, "doubao", T0);
        mk(&mut h, "doubao", T0);
        h.claim("doubao", T0);
        let queued = h.list(Some(TaskState::Queued), T0);
        assert_eq!(queued.len(), 1);
        assert_ne!(queued[0].id, a);
        assert_eq!(h.list(Some(TaskState::Done), T0).len(), 0);
    }

    #[test]
    fn worker_load_and_ping() {
        let mut h = hub();
        mk(&mut h, "doubao", T0);
        mk(&mut h, "doubao", T0);
        let claimed = h.claim("doubao", T0).unwrap();
        h.ack(&claimed.id, T0).unwrap();
        assert_eq!(h.worker_load("doubao", T0), (1, 1));
        assert_eq!(h.worker_load("workbuddy", T0), (0, 0));
        h.touch_worker("doubao", T0 + 1);
        let ws = h.workers(T0 + 2);
        assert!(ws.iter().any(|(n, seen, q, r)| n == "doubao" && *seen == T0 + 1 && *q == 1 && *r == 1));
    }

    #[test]
    fn persist_roundtrip() {
        let dir = std::env::temp_dir().join(format!("agenthub-hub-{}", std::process::id()));
        let p = dir.join("hub.json");
        let id = {
            let mut h = Hub::new(Some(p.clone()));
            mk(&mut h, "doubao", T0)
        };
        {
            let mut h = Hub::load(Some(p.clone()));
            let t = h.get(&id, T0).expect("重启后任务还在");
            assert_eq!(t.worker, "doubao");
            h.claim("doubao", T0).unwrap();
        }
        {
            let h = Hub::load(Some(p.clone()));
            let t = h.store.tasks.iter().find(|t| t.id == id).unwrap();
            assert_eq!(t.state, TaskState::Dispatched);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---------- HTTP 集成测试 ----------

    fn start_server(token: &str) -> (String, Arc<Mutex<Hub>>) {
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let addr = format!("http://{}", server.server_addr());
        let hub = Arc::new(Mutex::new(hub()));
        let cfg: SharedConfig = Arc::new(RwLock::new(Config {
            hub_enabled: true,
            hub_token: token.into(),
            ..Config::default()
        }));
        {
            let (hub, cfg) = (hub.clone(), cfg.clone());
            std::thread::spawn(move || serve_loop(server, hub, cfg));
        }
        (addr, hub)
    }

    fn http_req(url: &str, method: &str, token: Option<&str>, body: &str) -> (u16, Value) {
        let mut req = reqwest::blocking::Client::new().request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url);
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let resp = req.body(body.to_string()).send().unwrap();
        let code = resp.status().as_u16();
        let v: Value = resp.json().unwrap();
        (code, v)
    }

    #[test]
    fn http_end_to_end() {
        let (addr, hub) = start_server("tok");
        // 未带 token → 401
        let (code, v) = http_req(&format!("{addr}/hub/tasks"), "POST", None, r#"{"title":"x","worker":"doubao"}"#);
        assert_eq!((code, v["error"].is_string()), (401, true));
        // 创建
        let (code, v) = http_req(
            &format!("{addr}/hub/tasks"),
            "POST",
            Some("tok"),
            r#"{"title":"修 bug","body":"正文","worker":"workbuddy","workspace":"D:/Work2/AgentHub"}"#,
        );
        assert_eq!(code, 200);
        let id = v["id"].as_str().unwrap().to_string();
        // ping：有 1 单排队
        let (code, v) = http_req(&format!("{addr}/hub/ping?worker=workbuddy"), "GET", Some("tok"), "");
        assert_eq!((code, v["queued"].as_i64().unwrap(), v["running"].as_i64().unwrap()), (200, 1, 0));
        // 拉单 → ack → report
        let (code, v) = http_req(&format!("{addr}/hub/claim?worker=workbuddy"), "GET", Some("tok"), "");
        assert_eq!((code, v["id"].as_str().unwrap()), (200, id.as_str()));
        let (code, _) = http_req(&format!("{addr}/hub/ack"), "POST", Some("tok"), &format!(r#"{{"taskId":"{id}"}}"#));
        assert_eq!(code, 200);
        let (code, v) = http_req(
            &format!("{addr}/hub/report"),
            "POST",
            Some("tok"),
            &format!(r#"{{"taskId":"{id}","ok":true,"summary":"搞定","artifacts":["D:/a.md"]}}"#),
        );
        assert_eq!((code, v["state"].as_str().unwrap()), (200, "done"));
        // 状态落回 Hub
        assert_eq!(hub.lock().unwrap().get(&id, now_ms()).unwrap().state, TaskState::Done);
        // 错误 token → 401；未知路径 → 404
        let (code, _) = http_req(&format!("{addr}/hub/tasks"), "GET", Some("bad"), "");
        assert_eq!(code, 401);
        let (code, _) = http_req(&format!("{addr}/hub/nope"), "GET", Some("tok"), "");
        assert_eq!(code, 404);
    }

    #[test]
    fn http_disabled_returns_503() {
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let addr = format!("http://{}", server.server_addr());
        let hub = Arc::new(Mutex::new(hub()));
        let cfg: SharedConfig = Arc::new(RwLock::new(Config { hub_enabled: false, ..Config::default() }));
        std::thread::spawn(move || serve_loop(server, hub, cfg));
        let (code, v) = http_req(&format!("{addr}/hub/tasks"), "GET", None, "");
        assert_eq!((code, v["error"].as_str().unwrap()), (503, "hub 未启用"));
    }
}
