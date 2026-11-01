//! 执行器：在电脑上接着跑 Claude Code / Codex 会话，把输出和授权请求交给 remote.rs 发给服务端。
//!
//! - Claude：`claude -p --resume <sid> --input-format stream-json --output-format stream-json
//!   --verbose --permission-prompt-tool stdio --permission-mode default`
//! - Codex：Desktop 自带 codex.exe 的 `app-server`，走 JSON-RPC（stdio）
//!
//! 纯函数（解析、白名单、路径查找）都单独写出来并有单测；进程管理在 `Runner` 里。

use crate::claude::{home_dir, truncate_chars};
use crate::config::SharedConfig;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RUN_TIMEOUT: Duration = Duration::from_secs(2 * 3600);
const CODEX_INTERRUPT_GRACE: Duration = Duration::from_secs(3);
const HISTORY_COUNT: usize = 30;
const TEXT_MAX: usize = 4000;

// ---------------------------------------------------------------- 纯函数

/// 路径规范化：统一反斜杠、去掉 `\\?\` 前缀和末尾斜杠、转小写
pub fn norm_path(p: &str) -> String {
    let mut s = p.trim().replace('/', "\\");
    if let Some(r) = s.strip_prefix("\\\\?\\") {
        s = r.to_string();
    }
    while s.len() > 1 && s.ends_with('\\') {
        s.pop();
    }
    s.to_lowercase()
}

/// cwd 必须在 roots 某一项之下（或等于）；`..` 一律拒绝；前缀按目录边界判断
pub fn cwd_allowed(cwd: &str, roots: &[String]) -> bool {
    let c = norm_path(cwd);
    if c.is_empty() || c.split('\\').any(|seg| seg == "..") {
        return false;
    }
    roots.iter().any(|r| {
        let r = norm_path(r);
        !r.is_empty() && (c == r || c.starts_with(&format!("{r}\\")))
    })
}

/// sessionKey 会拼进命令行和文件名，只允许字母数字和 `-` `_`
pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 100 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `claude agents --json` 的输出里取所有 sessionId
pub fn parse_claude_agents(text: &str) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| format!("解析失败：{e}"))?;
    let arr = v.as_array().ok_or("输出不是数组")?;
    Ok(arr.iter().filter_map(|a| a.get("sessionId").and_then(|s| s.as_str()).map(String::from)).collect())
}

/// 运行模式：Resume = 接着原会话聊；Fork = 复制原会话上下文另起新会话；Fresh = 同目录从零开始
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    Resume,
    Fork,
    Fresh,
}

impl Mode {
    /// 空串按 Resume（兼容旧服务端）；未知值返回 None
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "" | "resume" => Some(Mode::Resume),
            "fork" => Some(Mode::Fork),
            "fresh" => Some(Mode::Fresh),
            _ => None,
        }
    }

    /// Resume / Fork 需要原会话 id；Fresh 不需要
    pub fn needs_key(self) -> bool {
        self != Mode::Fresh
    }

    /// 只有 Resume 会写原会话，才需要确认它没在终端里开着
    pub fn checks_open(self) -> bool {
        self == Mode::Resume
    }
}

/// 前置检查（不含「会话还开着」，那个要跑外部命令）
pub fn precheck(mode: Mode, key: &str, cwd: &str, roots: &[String]) -> Result<(), String> {
    if mode.needs_key() && !valid_key(key) {
        return Err("会话 id 格式不对".into());
    }
    if !cwd_allowed(cwd, roots) {
        return Err(format!("项目目录不在允许列表里：{cwd}"));
    }
    Ok(())
}

/// claude 命令行参数
pub fn claude_args(mode: Mode, key: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-p".into()];
    if mode != Mode::Fresh {
        a.push("--resume".into());
        a.push(key.into());
        if mode == Mode::Fork {
            a.push("--fork-session".into());
        }
    }
    for s in ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--permission-mode", "default"] {
        a.push(s.into());
    }
    a
}

#[derive(Debug, PartialEq)]
pub enum ClaudeInit {
    /// 不是 init 行（或没有 session_id）
    NotInit,
    /// 新会话 id
    NewId(String),
    /// Fork 时 id 没变：分叉没有生效
    Unchanged,
}

/// 解析 `{"type":"system","subtype":"init","session_id":...}`；Fork 时 id 等于原 id 视为异常
pub fn claude_init_session(line: &str, mode: Mode, key: &str) -> ClaudeInit {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return ClaudeInit::NotInit };
    if v.get("type").and_then(|t| t.as_str()) != Some("system") || v.get("subtype").and_then(|t| t.as_str()) != Some("init") {
        return ClaudeInit::NotInit;
    }
    match v.get("session_id").and_then(|s| s.as_str()) {
        Some(id) if !id.is_empty() => {
            if mode == Mode::Fork && id == key {
                ClaudeInit::Unchanged
            } else {
                ClaudeInit::NewId(id.to_string())
            }
        }
        _ => ClaudeInit::NotInit,
    }
}

/// Codex 初始化之后的第一个请求：Resume 恢复、Fork 分叉、Fresh 新建线程
pub fn codex_thread_request(id: i64, mode: Mode, key: &str, cwd: &str) -> String {
    match mode {
        Mode::Resume => rpc_request(id, "thread/resume", json!({"threadId":key})),
        Mode::Fork => rpc_request(id, "thread/fork", json!({"threadId":key})),
        Mode::Fresh => rpc_request(id, "thread/start", json!({"cwd":cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"})),
    }
}

/// 从 thread/fork、thread/start 的响应里取新线程 id
pub fn codex_thread_id(result: &Value) -> Option<String> {
    result.pointer("/thread/id").and_then(|i| i.as_str()).filter(|s| !s.is_empty()).map(String::from)
}

/// `claude agents --json` 的输出里取 (sessionId, pid)
pub fn parse_claude_agent_entries(text: &str) -> Result<Vec<(String, Option<u32>)>, String> {
    let v: Value = serde_json::from_str(text.trim()).map_err(|e| format!("解析失败：{e}"))?;
    let arr = v.as_array().ok_or("输出不是数组")?;
    Ok(arr
        .iter()
        .filter_map(|a| {
            let id = a.get("sessionId").and_then(|s| s.as_str())?;
            Some((id.to_string(), a.get("pid").and_then(|p| p.as_u64()).and_then(|p| u32::try_from(p).ok())))
        })
        .collect())
}

fn clip(s: &str) -> String {
    truncate_chars(s, TEXT_MAX)
}

/// 给人看的工具调用说明：Bash 取 command，Write/Edit 取 file_path + 内容前 200 字，其它取 JSON 前 300 字
pub fn claude_detail(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str());
    let d = match tool {
        "Bash" => s("command").map(String::from),
        "Write" | "Edit" => s("file_path").map(|p| {
            let body = s("content").or_else(|| s("new_string")).unwrap_or("");
            if body.is_empty() {
                p.to_string()
            } else {
                format!("{p}\n{}", truncate_chars(body, 200))
            }
        }),
        _ => None,
    };
    d.unwrap_or_else(|| truncate_chars(&input.to_string(), 300))
}

#[derive(Debug, PartialEq)]
pub enum ClaudeMsg {
    Text(String),
    Tool { name: String, summary: String },
    Approval { request_id: String, tool: String, detail: String, input: Value },
    Result { subtype: String },
}

/// 解析 claude stream-json 的一行；不关心的类型返回空
pub fn parse_claude_line(line: &str) -> Vec<ClaudeMsg> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
    let mut out = Vec::new();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => {
            if let Some(items) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for it in items {
                    match it.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let t = it.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push(ClaudeMsg::Text(t.to_string()));
                            }
                        }
                        Some("tool_use") => {
                            let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                            let input = it.get("input").cloned().unwrap_or(Value::Null);
                            let summary = truncate_chars(&claude_detail(&name, &input), 200);
                            out.push(ClaudeMsg::Tool { name, summary });
                        }
                        _ => {}
                    }
                }
            }
        }
        Some("control_request") => {
            let req = v.get("request");
            if req.and_then(|r| r.get("subtype")).and_then(|s| s.as_str()) == Some("can_use_tool") {
                let request_id = v.get("request_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let tool = req.and_then(|r| r.get("tool_name")).and_then(|s| s.as_str()).unwrap_or("tool").to_string();
                let input = req.and_then(|r| r.get("input")).cloned().unwrap_or(Value::Null);
                if !request_id.is_empty() {
                    let detail = claude_detail(&tool, &input);
                    out.push(ClaudeMsg::Approval { request_id, tool, detail, input });
                }
            }
        }
        Some("result") => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("unknown").to_string();
            out.push(ClaudeMsg::Result { subtype });
        }
        _ => {}
    }
    out
}

pub fn claude_user_line(text: &str) -> String {
    json!({"type":"user","message":{"role":"user","content":text}}).to_string()
}

pub fn claude_control_response(request_id: &str, allow: bool, input: &Value) -> String {
    let inner = if allow {
        json!({"behavior":"allow","updatedInput":input})
    } else {
        json!({"behavior":"deny","message":"用户在 AgentHub 里拒绝了这次操作"})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":inner}}).to_string()
}

#[derive(Debug, PartialEq)]
pub enum CodexIn {
    Response { id: i64, error: Option<String>, result: Value },
    Notification { method: String, params: Value },
    /// 服务端发给客户端的请求；id 可能是 0，所以判断「有没有 id」而不是 id 的真假
    Request { id: Value, method: String, params: Value },
    Other,
}

pub fn parse_codex_line(line: &str) -> CodexIn {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return CodexIn::Other };
    let method = v.get("method").and_then(|m| m.as_str()).map(String::from);
    let id = v.get("id").cloned();
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match (method, id) {
        (Some(method), Some(id)) if !id.is_null() => CodexIn::Request { id, method, params },
        (Some(method), _) => CodexIn::Notification { method, params },
        (None, Some(id)) => match id.as_i64() {
            Some(id) => CodexIn::Response {
                id,
                error: v.get("error").map(|e| e.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| e.to_string())),
                result: v.get("result").cloned().unwrap_or(Value::Null),
            },
            None => CodexIn::Other,
        },
        _ => CodexIn::Other,
    }
}

#[derive(Debug, PartialEq)]
pub enum CodexEvent {
    Agent(String),
    Command(String),
    TurnStarted(String),
    TurnDone { status: String },
}

pub fn codex_event(method: &str, params: &Value) -> Option<CodexEvent> {
    match method {
        "item/completed" => {
            let item = params.get("item")?;
            match item.get("type").and_then(|t| t.as_str())? {
                "agentMessage" => {
                    let t = item.get("text").and_then(|t| t.as_str())?;
                    (!t.trim().is_empty()).then(|| CodexEvent::Agent(t.to_string()))
                }
                "commandExecution" => item.get("command").and_then(|c| c.as_str()).map(|c| CodexEvent::Command(c.to_string())),
                _ => None,
            }
        }
        "turn/started" => params.pointer("/turn/id").and_then(|i| i.as_str()).map(|i| CodexEvent::TurnStarted(i.to_string())),
        "turn/completed" => {
            Some(CodexEvent::TurnDone { status: params.pointer("/turn/status").and_then(|s| s.as_str()).unwrap_or("unknown").to_string() })
        }
        _ => None,
    }
}

fn command_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => Some(a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
}

/// 授权类请求 → (tool, detail)；不是授权请求返回 None
pub fn codex_approval(method: &str, params: &Value) -> Option<(String, String)> {
    match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            let cmd = params.get("command").and_then(command_text).or_else(|| params.get("reason").and_then(|r| r.as_str()).map(String::from));
            Some(("command".into(), cmd.unwrap_or_else(|| truncate_chars(&params.to_string(), 300))))
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => {
            let files = params.get("fileChanges").and_then(|f| f.as_object()).map(|o| o.keys().cloned().collect::<Vec<_>>().join("\n"));
            let detail = files
                .filter(|s| !s.is_empty())
                .or_else(|| params.get("reason").and_then(|r| r.as_str()).map(String::from))
                .or_else(|| params.get("grantRoot").and_then(|r| r.as_str()).map(String::from))
                .unwrap_or_else(|| truncate_chars(&params.to_string(), 300));
            Some(("fileChange".into(), detail))
        }
        _ => None,
    }
}

/// 回复授权请求的 result：新协议用 accept/decline，老的 execCommandApproval / applyPatchApproval 用 ReviewDecision（approved/denied）
pub fn codex_decision(method: &str, allow: bool) -> Value {
    let legacy = matches!(method, "execCommandApproval" | "applyPatchApproval");
    let d = match (legacy, allow) {
        (false, true) => "accept",
        (false, false) => "decline",
        (true, true) => "approved",
        (true, false) => "denied",
    };
    json!({ "decision": d })
}

fn rpc_request(id: i64, method: &str, params: Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string()
}

fn rpc_notify(method: &str) -> String {
    json!({"jsonrpc":"2.0","method":method}).to_string()
}

fn rpc_response(id: &Value, result: Value) -> String {
    json!({"jsonrpc":"2.0","id":id,"result":result}).to_string()
}

// ---- 历史记录

/// Claude 的项目目录名：`:` `\` `/` 都换成 `-`（D:\Play → D--Play）
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if matches!(c, ':' | '\\' | '/') { '-' } else { c }).collect()
}

pub fn find_claude_transcript(projects: &Path, cwd: &str, key: &str) -> Option<PathBuf> {
    if !valid_key(key) {
        return None;
    }
    let file = format!("{key}.jsonl");
    let direct = projects.join(claude_project_dir_name(cwd)).join(&file);
    if direct.is_file() {
        return Some(direct);
    }
    for d in std::fs::read_dir(projects).ok()?.flatten() {
        let p = d.path().join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn find_codex_rollout(sessions: &Path, key: &str) -> Option<PathBuf> {
    if !valid_key(key) {
        return None;
    }
    let suffix = format!("-{key}.jsonl");
    let mut stack = vec![sessions.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix)) {
                return Some(p);
            }
        }
    }
    None
}

/// 读文件末尾 max_bytes；不是从头读时丢掉第一行（可能被截断）
pub fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        return Ok(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default());
    }
    Ok(text)
}

fn last_n(mut v: Vec<(String, String)>, n: usize) -> Vec<(String, String)> {
    if v.len() > n {
        v.drain(..v.len() - n);
    }
    v
}

fn text_parts(content: &Value, kinds: &[&str]) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()).is_some_and(|t| kinds.contains(&t)))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Claude transcript：user（字符串或 text 段，跳过 tool_result）和 assistant（text 段拼接），取最后 n 条
pub fn parse_claude_transcript(text: &str, n: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
            continue;
        }
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let Some(content) = v.pointer("/message/content") else { continue };
        let t = text_parts(content, &["text"]);
        if !t.trim().is_empty() {
            out.push((role.to_string(), clip(&t)));
        }
    }
    last_n(out, n)
}

/// Codex rollout：response_item 里 payload.type == message 的 user/assistant；跳过以 `<` 开头的 user 文本（注入的环境上下文）
pub fn parse_codex_rollout(text: &str, n: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.contains("response_item") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let role = match p.get("role").and_then(|r| r.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let t = text_parts(p.get("content").unwrap_or(&Value::Null), &["input_text", "output_text"]);
        if t.trim().is_empty() || (role == "user" && t.trim_start().starts_with('<')) {
            continue;
        }
        out.push((role.to_string(), clip(&t)));
    }
    last_n(out, n)
}

/// Desktop 自带 codex.exe：bin 下所有子目录里最新修改的 codex.exe
pub fn find_codex_exe(bin_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for d in std::fs::read_dir(bin_dir).ok()?.flatten() {
        let exe = d.path().join("codex.exe");
        let Ok(m) = std::fs::metadata(&exe) else { continue };
        if !m.is_file() {
            continue;
        }
        let t = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(bt, _)| t > *bt) {
            best = Some((t, exe));
        }
    }
    best.map(|(_, p)| p)
}

fn default_codex_bin_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("OpenAI").join("Codex").join("bin"))
}

pub fn read_history(agent: &str, key: &str, cwd: &str) -> Result<Vec<(String, String)>, String> {
    let home = home_dir().ok_or("找不到用户目录")?;
    match agent {
        "claude" => {
            let p = find_claude_transcript(&home.join(".claude").join("projects"), cwd, key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 512 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(parse_claude_transcript(&text, HISTORY_COUNT))
        }
        "codex" => {
            let p = find_codex_rollout(&home.join(".codex").join("sessions"), key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 4 * 1024 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(parse_codex_rollout(&text, HISTORY_COUNT))
        }
        _ => Err("不认识的 agent".into()),
    }
}

// ---------------------------------------------------------------- 进程辅助

fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// 结束进程树（Windows 用 taskkill /T /F，其它平台直接 kill）
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &child.id().to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let _ = no_window(&mut c).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_with_timeout(cmd: &mut Command, dur: Duration) -> Result<String, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = no_window(cmd).spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("没有 stdout")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let end = Instant::now() + dur;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let s = reader.join().unwrap_or_default();
                return if st.success() { Ok(s) } else { Err(format!("退出码 {}", st.code().unwrap_or(-1))) };
            }
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                kill_tree(&mut child);
                return Err("超时".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// 终端里开着的 Claude 会话：(sessionId, pid)
pub fn claude_open_entries() -> Result<Vec<(String, Option<u32>)>, String> {
    let mut c = Command::new("claude");
    c.args(["agents", "--json"]);
    let text = run_with_timeout(&mut c, Duration::from_secs(10))?;
    parse_claude_agent_entries(&text)
}

fn claude_open_sessions() -> Result<Vec<String>, String> {
    let mut c = Command::new("claude");
    c.args(["agents", "--json"]);
    let text = run_with_timeout(&mut c, Duration::from_secs(10))?;
    parse_claude_agents(&text)
}

/// 每行读一条交给 f；非 UTF-8 字节按替换字符处理；读完或 f 返回 false 时结束
fn read_lines<R: Read>(r: R, mut f: impl FnMut(String) -> bool) {
    let mut br = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match br.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                if !line.is_empty() && !f(line) {
                    return;
                }
            }
        }
    }
}

fn write_line(stdin: &mut Option<ChildStdin>, line: &str) -> bool {
    let Some(w) = stdin.as_mut() else { return false };
    w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n")).and_then(|_| w.flush()).is_ok()
}

// ---------------------------------------------------------------- 运行

pub enum RunMsg {
    Stop,
    /// 连接断开：静默结束进程，不再上报
    Shutdown,
    Decide { approval_id: String, allow: bool },
    Created { local_id: u64, approval_id: String },
    Line(String),
    Eof,
}

static LOCAL_ID: AtomicU64 = AtomicU64::new(0);

struct Pending {
    /// Claude：request_id（字符串）；Codex：JSON-RPC 的 id
    key: Value,
    method: String,
    input: Value,
    deadline: Instant,
    approval_id: Option<String>,
}

#[derive(Default)]
struct Approvals {
    by_local: HashMap<u64, Pending>,
    /// 决定比 approval.created 先到时暂存
    early: HashMap<String, bool>,
    // 超时可能早于服务端确认创建；收到迟到的 id 后仍须上报过期。
    expired_local: HashSet<u64>,
}

impl Approvals {
    fn add(&mut self, out: &Sender<Value>, run_id: &str, tool: &str, detail: &str, key: Value, method: &str, input: Value) {
        let local_id = LOCAL_ID.fetch_add(1, Ordering::SeqCst);
        self.by_local.insert(local_id, Pending { key, method: method.into(), input, deadline: Instant::now() + APPROVAL_TIMEOUT, approval_id: None });
        let _ = out.send(json!({"type":"run.approval","runId":run_id,"localId":local_id,"tool":tool,"detail":detail}));
    }

    fn created(&mut self, local_id: u64, approval_id: String, out: &Sender<Value>, run_id: &str) -> Option<(Pending, bool)> {
        if self.expired_local.remove(&local_id) {
            self.early.remove(&approval_id);
            Self::report_expired(out, run_id, &approval_id);
            return None;
        }
        let p = self.by_local.get_mut(&local_id)?;
        if let Some(allow) = self.early.remove(&approval_id) {
            return self.by_local.remove(&local_id).map(|p| (p, allow));
        }
        p.approval_id = Some(approval_id);
        None
    }

    fn decide(&mut self, approval_id: &str, allow: bool) -> Option<(Pending, bool)> {
        let local = self.by_local.iter().find(|(_, p)| p.approval_id.as_deref() == Some(approval_id)).map(|(k, _)| *k);
        if let Some(l) = local {
            return self.by_local.remove(&l).map(|p| (p, allow));
        }
        if self.by_local.values().any(|p| p.approval_id.is_none()) && self.early.len() < 50 {
            self.early.insert(approval_id.to_string(), allow);
        }
        None
    }

    fn report_expired(out: &Sender<Value>, run_id: &str, approval_id: &str) {
        let _ = out.send(json!({"type":"run.approvalExpired","runId":run_id,"approvalId":approval_id}));
    }

    fn expired(&mut self, now: Instant, out: &Sender<Value>, run_id: &str) -> Vec<Pending> {
        let ids: Vec<u64> = self.by_local.iter().filter(|(_, p)| p.deadline <= now).map(|(k, _)| *k).collect();
        ids.into_iter().filter_map(|i| {
            let p = self.by_local.remove(&i)?;
            if let Some(id) = &p.approval_id {
                Self::report_expired(out, run_id, id);
            } else {
                self.expired_local.insert(i);
            }
            Some(p)
        }).collect()
    }
}

struct Run {
    out: Sender<Value>,
    run_id: String,
    rx: mpsc::Receiver<RunMsg>,
    tx: Sender<RunMsg>,
}

impl Run {
    fn status(&self, status: &str, error: &str) {
        let mut m = json!({"type":"run.status","runId":self.run_id,"status":status});
        if !error.is_empty() {
            m["error"] = json!(error);
        }
        let _ = self.out.send(m);
    }

    fn message(&self, role: &str, text: &str) {
        let _ = self.out.send(json!({"type":"run.message","runId":self.run_id,"role":role,"text":clip(text)}));
    }

    fn fail(&self, error: &str) {
        self.status("failed", error);
    }

    /// Fork / Fresh：告诉服务端新会话的真实 id
    fn session(&self, key: &str) {
        let _ = self.out.send(json!({"type":"run.session","runId":self.run_id,"sessionKey":key}));
    }
}

fn stderr_tail(buf: &Arc<Mutex<String>>) -> String {
    let s = buf.lock().unwrap().clone();
    let n = s.chars().count();
    let tail: String = s.chars().skip(n.saturating_sub(500)).collect();
    tail.trim().to_string()
}

fn spawn_readers(child: &mut Child, tx: &Sender<RunMsg>) -> Arc<Mutex<String>> {
    let tail = Arc::new(Mutex::new(String::new()));
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            read_lines(out, |l| tx.send(RunMsg::Line(l)).is_ok());
            let _ = tx.send(RunMsg::Eof);
        });
    }
    if let Some(err) = child.stderr.take() {
        let tail = tail.clone();
        std::thread::spawn(move || {
            read_lines(err, |l| {
                let mut t = tail.lock().unwrap();
                t.push_str(&l);
                t.push('\n');
                if t.len() > 4000 {
                    let cut = t.len() - 2000;
                    let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                    t.drain(..cut);
                }
                true
            });
        });
    }
    tail
}

enum Finish {
    Done,
    Failed(String),
    Stopped,
    /// 连接断开，不上报
    Silent,
}

fn report(run: &Run, f: Finish) {
    match f {
        Finish::Done => run.status("done", ""),
        Finish::Failed(e) => run.fail(&e),
        Finish::Stopped => run.status("stopped", ""),
        Finish::Silent => {}
    }
}

fn run_claude(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str) {
    let mut cmd = Command::new("claude");
    cmd.args(claude_args(mode, key))
    .current_dir(cwd)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = match no_window(&mut cmd).spawn() {
        Ok(c) => c,
        Err(e) => return run.fail(&format!("启动 claude 失败：{e}")),
    };
    let mut stdin = child.stdin.take();
    let tail = spawn_readers(&mut child, &run.tx);
    run.status("running", "");
    if !write_line(&mut stdin, &claude_user_line(text)) {
        kill_tree(&mut child);
        return run.fail("写入消息失败");
    }

    let start = Instant::now();
    let mut approvals = Approvals::default();
    let mut finish: Option<Finish> = None;
    let mut session_reported = mode == Mode::Resume;
    while finish.is_none() {
        if start.elapsed() > RUN_TIMEOUT {
            run.message("system", "运行超过 2 小时，已强制停止");
            finish = Some(Finish::Stopped);
            break;
        }
        match run.rx.recv_timeout(Duration::from_millis(500)) {
            Ok(RunMsg::Line(l)) => {
                if !session_reported {
                    match claude_init_session(&l, mode, key) {
                        ClaudeInit::NewId(id) => {
                            session_reported = true;
                            run.session(&id);
                        }
                        ClaudeInit::Unchanged => {
                            session_reported = true;
                            run.message("system", "分叉没有生成新会话");
                        }
                        ClaudeInit::NotInit => {}
                    }
                }
                for m in parse_claude_line(&l) {
                    match m {
                        ClaudeMsg::Text(t) => run.message("assistant", &t),
                        ClaudeMsg::Tool { name, summary } => run.message("tool", &format!("{name} {summary}")),
                        ClaudeMsg::Approval { request_id, tool, detail, input } => {
                            approvals.add(&run.out, &run.run_id, &tool, &detail, json!(request_id), "", input)
                        }
                        ClaudeMsg::Result { subtype } => {
                            stdin = None; // 关闭 stdin，进程自己退出
                            finish = Some(if subtype == "success" { Finish::Done } else { Finish::Failed(format!("运行结束：{subtype}")) });
                        }
                    }
                }
            }
            Ok(RunMsg::Eof) => {
                let code = child.wait().ok().and_then(|s| s.code());
                finish = Some(Finish::Failed(format!("claude 进程异常退出（{}）：{}", code.map_or("未知".into(), |c| c.to_string()), stderr_tail(&tail))));
            }
            Ok(RunMsg::Stop) => finish = Some(Finish::Stopped),
            Ok(RunMsg::Shutdown) => finish = Some(Finish::Silent),
            Ok(RunMsg::Created { local_id, approval_id }) => {
                if let Some((p, allow)) = approvals.created(local_id, approval_id, &run.out, &run.run_id) {
                    answer_claude(&mut stdin, &p, allow);
                }
            }
            Ok(RunMsg::Decide { approval_id, allow }) => {
                if let Some((p, allow)) = approvals.decide(&approval_id, allow) {
                    answer_claude(&mut stdin, &p, allow);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => finish = Some(Finish::Silent),
        }
        for p in approvals.expired(Instant::now(), &run.out, &run.run_id) {
            run.message("system", "授权等待超时，已拒绝");
            answer_claude(&mut stdin, &p, false);
        }
    }
    let f = finish.unwrap();
    let exited = matches!(&f, Finish::Failed(m) if m.starts_with("claude 进程异常退出"));
    let kill_now = matches!(f, Finish::Stopped | Finish::Silent);
    if kill_now {
        drop(stdin.take());
        kill_tree(&mut child);
        report(run, f);
        return;
    }
    // 正常结束：先上报，再等进程自己退出（stdin 已关）
    report(run, f);
    drop(stdin);
    if !exited {
        reap(&mut child, Duration::from_secs(5));
    }
}

fn answer_claude(stdin: &mut Option<ChildStdin>, p: &Pending, allow: bool) {
    let id = p.key.as_str().unwrap_or("");
    write_line(stdin, &claude_control_response(id, allow, &p.input));
}

/// 等进程自己退出；超时就杀
fn reap(child: &mut Child, wait: Duration) {
    let end = Instant::now() + wait;
    while Instant::now() < end {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_tree(child);
}

fn run_codex(run: &Run, mode: Mode, exe: &Path, key: &str, cwd: &str, text: &str) {
    let mut cmd = Command::new(exe);
    cmd.arg("app-server").current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match no_window(&mut cmd).spawn() {
        Ok(c) => c,
        Err(e) => return run.fail(&format!("启动 codex 失败：{e}")),
    };
    let mut stdin = child.stdin.take();
    let tail = spawn_readers(&mut child, &run.tx);
    run.status("running", "");
    write_line(
        &mut stdin,
        &rpc_request(1, "initialize", json!({"clientInfo":{"name":"agenthub","version":env!("CARGO_PKG_VERSION")}})),
    );

    const ID_INIT: i64 = 1;
    const ID_RESUME: i64 = 2;
    const ID_TURN: i64 = 3;
    const ID_INTERRUPT: i64 = 4;
    let start = Instant::now();
    let mut approvals = Approvals::default();
    let mut turn_id: Option<String> = None;
    // Resume 用原线程；Fork / Fresh 在响应里拿到新线程 id 后替换
    let mut thread_id = key.to_string();
    let mut interrupt_deadline: Option<Instant> = None;
    let mut finish: Option<Finish> = None;
    while finish.is_none() {
        if start.elapsed() > RUN_TIMEOUT {
            run.message("system", "运行超过 2 小时，已强制停止");
            finish = Some(Finish::Stopped);
            break;
        }
        match run.rx.recv_timeout(Duration::from_millis(300)) {
            Ok(RunMsg::Line(l)) => match parse_codex_line(&l) {
                CodexIn::Response { id, error, result } => {
                    if let Some(e) = error {
                        if id != ID_INTERRUPT {
                            finish = Some(Finish::Failed(format!("Codex 返回错误：{e}")));
                        }
                    } else {
                        match id {
                            ID_INIT => {
                                write_line(&mut stdin, &rpc_notify("initialized"));
                                write_line(&mut stdin, &codex_thread_request(ID_RESUME, mode, key, cwd));
                            }
                            ID_RESUME => {
                                if mode != Mode::Resume {
                                    match codex_thread_id(&result) {
                                        Some(t) => {
                                            run.session(&t);
                                            thread_id = t;
                                        }
                                        None => {
                                            finish = Some(Finish::Failed("Codex 没有返回新线程 id".into()));
                                            continue;
                                        }
                                    }
                                }
                                write_line(
                                    &mut stdin,
                                    &rpc_request(
                                        ID_TURN,
                                        "turn/start",
                                        json!({"threadId":thread_id,"input":[{"type":"text","text":text,"text_elements":[]}],"approvalPolicy":"on-request"}),
                                    ),
                                );
                            }
                            ID_TURN => {
                                if turn_id.is_none() {
                                    turn_id = result.pointer("/turn/id").and_then(|i| i.as_str()).map(String::from);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                CodexIn::Notification { method, params } => match codex_event(&method, &params) {
                    Some(CodexEvent::Agent(t)) => run.message("assistant", &t),
                    Some(CodexEvent::Command(c)) => run.message("tool", &format!("命令：{c}")),
                    Some(CodexEvent::TurnStarted(id)) => turn_id = Some(id),
                    Some(CodexEvent::TurnDone { status }) => {
                        finish = Some(match status.as_str() {
                            "completed" => Finish::Done,
                            "interrupted" if interrupt_deadline.is_some() => Finish::Stopped,
                            s => Finish::Failed(format!("运行结束：{s}")),
                        })
                    }
                    None => {}
                },
                CodexIn::Request { id, method, params } => match codex_approval(&method, &params) {
                    Some((tool, detail)) => approvals.add(&run.out, &run.run_id, &tool, &detail, id, &method, Value::Null),
                    None => {
                        run.message("system", &format!("不支持的请求：{method}"));
                        write_line(&mut stdin, &rpc_response(&id, json!({"decision":"decline"})));
                    }
                },
                CodexIn::Other => {}
            },
            Ok(RunMsg::Eof) => {
                let code = child.wait().ok().and_then(|s| s.code());
                finish = Some(Finish::Failed(format!("codex 进程异常退出（{}）：{}", code.map_or("未知".into(), |c| c.to_string()), stderr_tail(&tail))));
            }
            Ok(RunMsg::Stop) => match &turn_id {
                Some(t) => {
                    write_line(&mut stdin, &rpc_request(ID_INTERRUPT, "turn/interrupt", json!({"threadId":thread_id,"turnId":t})));
                    interrupt_deadline = Some(Instant::now() + CODEX_INTERRUPT_GRACE);
                }
                None => finish = Some(Finish::Stopped),
            },
            Ok(RunMsg::Shutdown) => finish = Some(Finish::Silent),
            Ok(RunMsg::Created { local_id, approval_id }) => {
                if let Some((p, allow)) = approvals.created(local_id, approval_id, &run.out, &run.run_id) {
                    answer_codex(&mut stdin, &p, allow);
                }
            }
            Ok(RunMsg::Decide { approval_id, allow }) => {
                if let Some((p, allow)) = approvals.decide(&approval_id, allow) {
                    answer_codex(&mut stdin, &p, allow);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => finish = Some(Finish::Silent),
        }
        if finish.is_none() && interrupt_deadline.is_some_and(|d| Instant::now() >= d) {
            finish = Some(Finish::Stopped);
        }
        for p in approvals.expired(Instant::now(), &run.out, &run.run_id) {
            run.message("system", "授权等待超时，已拒绝");
            answer_codex(&mut stdin, &p, false);
        }
    }
    let f = finish.unwrap();
    let exited = matches!(&f, Finish::Failed(m) if m.starts_with("codex 进程异常退出"));
    drop(stdin);
    // turn/completed 之后进程没有别的事要做，直接结束；停止/断开也一样
    if !exited {
        kill_tree(&mut child);
    }
    report(run, f);
}

fn answer_codex(stdin: &mut Option<ChildStdin>, p: &Pending, allow: bool) {
    write_line(stdin, &rpc_response(&p.key, codex_decision(&p.method, allow)));
}

// ---------------------------------------------------------------- 入口

struct Entry {
    session_id: String,
    tx: Sender<RunMsg>,
}

/// 管理所有进行中的运行；remote.rs 把服务端消息交给 handle()，事件通过 out 发回
#[derive(Clone)]
pub struct Runner {
    out: Sender<Value>,
    runs: Arc<Mutex<HashMap<String, Entry>>>,
    config: SharedConfig,
}

impl Runner {
    pub fn new(out: Sender<Value>, config: SharedConfig) -> Self {
        Runner { out, runs: Arc::new(Mutex::new(HashMap::new())), config }
    }

    fn to_all(&self, f: impl Fn() -> RunMsg) {
        for e in self.runs.lock().unwrap().values() {
            let _ = e.tx.send(f());
        }
    }

    /// 连接断开：结束所有运行（服务端那边会把它们标成 failed）
    pub fn shutdown(&self) {
        self.to_all(|| RunMsg::Shutdown);
    }

    pub fn handle(&self, msg: &Value) {
        let s = |k: &str| msg.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        match msg.get("type").and_then(|t| t.as_str()) {
            Some("run.start") => self.start(s("runId"), s("sessionId"), s("agent"), s("sessionKey"), s("cwd"), s("text"), s("mode")),
            Some("run.stop") => {
                if let Some(e) = self.runs.lock().unwrap().get(&s("runId")) {
                    let _ = e.tx.send(RunMsg::Stop);
                }
            }
            Some("approval.created") => {
                if let Some(local_id) = msg.get("localId").and_then(|v| v.as_u64()) {
                    let approval_id = s("approvalId");
                    self.to_all(|| RunMsg::Created { local_id, approval_id: approval_id.clone() });
                }
            }
            Some("approval.decide") => {
                let approval_id = s("approvalId");
                let allow = s("decision") == "allow";
                self.to_all(|| RunMsg::Decide { approval_id: approval_id.clone(), allow });
            }
            Some("history.request") => {
                let (out, request_id, agent, key, cwd) = (self.out.clone(), s("requestId"), s("agent"), s("sessionKey"), s("cwd"));
                std::thread::spawn(move || {
                    let m = match read_history(&agent, &key, &cwd) {
                        Ok(list) => json!({"type":"history.result","requestId":request_id,"messages":list.iter().map(|(r,t)| json!({"role":r,"text":t})).collect::<Vec<_>>()}),
                        Err(e) => json!({"type":"history.result","requestId":request_id,"messages":[],"error":e}),
                    };
                    let _ = out.send(m);
                });
            }
            _ => {}
        }
    }

    fn start(&self, run_id: String, session_id: String, agent: String, key: String, cwd: String, text: String, mode: String) {
        let (tx, rx) = mpsc::channel();
        let run = Run { out: self.out.clone(), run_id: run_id.clone(), rx, tx: tx.clone() };
        {
            // 同一会话同时只允许一个运行（服务端已经挡了，这里再挡一次）
            let mut g = self.runs.lock().unwrap();
            if run_id.is_empty() || g.values().any(|e| e.session_id == session_id) {
                drop(g);
                return run.fail("这个会话已经有一个运行在进行");
            }
            g.insert(run_id.clone(), Entry { session_id, tx });
        }
        let roots = self.config.read().unwrap().allowed_roots.clone();
        let runs = self.runs.clone();
        std::thread::spawn(move || {
            execute(&run, &roots, &agent, &mode, &key, &cwd, &text);
            runs.lock().unwrap().remove(&run.run_id);
        });
    }
}

/// 前置检查 + 按 agent 分派
fn execute(run: &Run, roots: &[String], agent: &str, mode: &str, key: &str, cwd: &str, text: &str) {
    let Some(mode) = Mode::parse(mode) else {
        return run.fail(&format!("不支持的模式：{mode}"));
    };
    if let Err(e) = precheck(mode, key, cwd, roots) {
        return run.fail(&e);
    }
    match agent {
        "claude" if !mode.checks_open() => run_claude(run, mode, key, cwd, text),
        "claude" => match claude_open_sessions() {
            Ok(open) if open.iter().any(|s| s == key) => {
                run.fail("这个会话在终端里还开着，请先关掉它或直接在终端里继续")
            }
            Ok(_) => run_claude(run, mode, key, cwd, text),
            Err(e) => run.fail(&format!("无法确认这个会话是否还开在终端里（claude agents --json：{e}）")),
        },
        "codex" => match default_codex_bin_dir().and_then(|d| find_codex_exe(&d)) {
            Some(exe) => run_codex(run, mode, &exe, key, cwd, text),
            None => run.fail("没找到 Codex Desktop 自带的 codex.exe"),
        },
        other => run.fail(&format!("不认识的 agent：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cwd_whitelist() {
        let r = roots(&["D:\\Work2"]);
        assert!(cwd_allowed("D:\\Work2", &r));
        assert!(cwd_allowed("D:\\Work2\\AgentHub", &r));
        assert!(cwd_allowed("d:/work2/agenthub/", &r), "大小写和斜杠不敏感");
        assert!(cwd_allowed("D:\\Work2\\x", &roots(&["d:/WORK2/"])));
        assert!(!cwd_allowed("D:\\Work2Other", &r), "前缀不能误判");
        assert!(!cwd_allowed("D:\\Work2Other\\a", &r));
        assert!(!cwd_allowed("D:\\Work2\\..\\Secret", &r), ".. 拒绝");
        assert!(!cwd_allowed("D:\\Play", &r));
        assert!(!cwd_allowed("", &r));
        assert!(!cwd_allowed("D:\\Work2", &[]), "空名单全部拒绝");
        assert!(!cwd_allowed("D:\\Work2", &roots(&[""])));
        assert!(cwd_allowed("\\\\?\\D:\\Work2\\a", &r));
        assert!(cwd_allowed("D:\\a", &roots(&["D:\\"])));
    }

    #[test]
    fn mode_parse_and_rules() {
        assert_eq!(Mode::parse(""), Some(Mode::Resume));
        assert_eq!(Mode::parse("resume"), Some(Mode::Resume));
        assert_eq!(Mode::parse("fork"), Some(Mode::Fork));
        assert_eq!(Mode::parse("fresh"), Some(Mode::Fresh));
        assert_eq!(Mode::parse("Fork"), None);
        assert_eq!(Mode::parse("xx"), None);
        assert!(Mode::Resume.needs_key() && Mode::Fork.needs_key() && !Mode::Fresh.needs_key());
        assert!(Mode::Resume.checks_open() && !Mode::Fork.checks_open() && !Mode::Fresh.checks_open());
    }

    #[test]
    fn precheck_by_mode() {
        let r = roots(&["D:\\Work2"]);
        assert!(precheck(Mode::Fresh, "", "D:\\Work2\\a", &r).is_ok(), "Fresh 不要求 key");
        assert!(precheck(Mode::Fresh, "bad key", "D:\\Work2\\a", &r).is_ok());
        assert!(precheck(Mode::Resume, "", "D:\\Work2\\a", &r).is_err());
        assert!(precheck(Mode::Fork, "a b", "D:\\Work2\\a", &r).is_err());
        assert!(precheck(Mode::Fork, "abc-1", "D:\\Work2\\a", &r).is_ok());
        for m in [Mode::Resume, Mode::Fork, Mode::Fresh] {
            let e = precheck(m, "abc", "D:\\Play", &r).unwrap_err();
            assert!(e.starts_with("项目目录不在允许列表里"), "{e}");
        }
    }

    #[test]
    fn claude_args_by_mode() {
        let tail = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--permission-mode", "default"];
        let mut resume = vec!["-p", "--resume", "k1"];
        resume.extend(tail);
        assert_eq!(claude_args(Mode::Resume, "k1"), resume);
        let mut fork = vec!["-p", "--resume", "k1", "--fork-session"];
        fork.extend(tail);
        assert_eq!(claude_args(Mode::Fork, "k1"), fork);
        let mut fresh = vec!["-p"];
        fresh.extend(tail);
        assert_eq!(claude_args(Mode::Fresh, "k1"), fresh);
    }

    #[test]
    fn claude_init_line() {
        let l = r#"{"type":"system","subtype":"init","session_id":"new-1","cwd":"x"}"#;
        assert_eq!(claude_init_session(l, Mode::Fork, "old"), ClaudeInit::NewId("new-1".into()));
        assert_eq!(claude_init_session(l, Mode::Fresh, ""), ClaudeInit::NewId("new-1".into()));
        assert_eq!(claude_init_session(r#"{"type":"system","subtype":"init","session_id":"old"}"#, Mode::Fork, "old"), ClaudeInit::Unchanged);
        assert_eq!(claude_init_session(r#"{"type":"system","subtype":"hook_started","session_id":"x"}"#, Mode::Fork, "old"), ClaudeInit::NotInit);
        assert_eq!(claude_init_session(r#"{"type":"system","subtype":"init"}"#, Mode::Fork, "old"), ClaudeInit::NotInit);
        assert_eq!(claude_init_session(r#"{"type":"assistant"}"#, Mode::Fork, "old"), ClaudeInit::NotInit);
        assert_eq!(claude_init_session("junk", Mode::Fork, "old"), ClaudeInit::NotInit);
    }

    #[test]
    fn codex_thread_requests() {
        let v = |s: String| serde_json::from_str::<Value>(&s).unwrap();
        let r = v(codex_thread_request(2, Mode::Resume, "t1", "D:\\x"));
        assert_eq!((r["id"].clone(), r["method"].as_str()), (json!(2), Some("thread/resume")));
        assert_eq!(r["params"], json!({"threadId":"t1"}));
        let r = v(codex_thread_request(2, Mode::Fork, "t1", "D:\\x"));
        assert_eq!(r["method"], "thread/fork");
        assert_eq!(r["params"], json!({"threadId":"t1"}));
        let r = v(codex_thread_request(2, Mode::Fresh, "t1", "D:\\x"));
        assert_eq!(r["method"], "thread/start");
        assert_eq!(r["params"], json!({"cwd":"D:\\x","approvalPolicy":"on-request","sandbox":"workspace-write"}));
        assert_eq!(codex_thread_id(&json!({"thread":{"id":"n1"},"cwd":"x"})), Some("n1".into()));
        assert_eq!(codex_thread_id(&json!({"thread":{"id":""}})), None);
        assert_eq!(codex_thread_id(&json!({})), None);
        assert_eq!(codex_thread_id(&Value::Null), None);
    }

    #[test]
    fn agent_entries_with_pid() {
        let t = r#"[{"pid":17868,"sessionId":"a-1","cwd":"x"},{"sessionId":"b-2"},{"pid":5}]"#;
        assert_eq!(parse_claude_agent_entries(t).unwrap(), vec![("a-1".to_string(), Some(17868)), ("b-2".to_string(), None)]);
        assert!(parse_claude_agent_entries("{}").is_err());
    }

    #[test]
    fn keys() {
        assert!(valid_key("5259-abc_1"));
        assert!(!valid_key(""));
        assert!(!valid_key("a b"));
        assert!(!valid_key("..\\x"));
        assert!(!valid_key("a\"b"));
    }

    #[test]
    fn claude_assistant_and_tool_lines() {
        let l = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"OK2"},{"type":"tool_use","name":"Write","input":{"file_path":"x.txt","content":"hi"}},{"type":"tool_use","name":"Bash","input":{"command":"echo hi"}},{"type":"text","text":"  "}]}}"#;
        assert_eq!(
            parse_claude_line(l),
            vec![
                ClaudeMsg::Text("OK2".into()),
                ClaudeMsg::Tool { name: "Write".into(), summary: "x.txt\nhi".into() },
                ClaudeMsg::Tool { name: "Bash".into(), summary: "echo hi".into() },
            ]
        );
        assert!(parse_claude_line(r#"{"type":"system","subtype":"init"}"#).is_empty());
        assert!(parse_claude_line("not json").is_empty());
    }

    #[test]
    fn claude_control_request_and_result() {
        let l = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"x.txt","content":"hello"}}}"#;
        match &parse_claude_line(l)[..] {
            [ClaudeMsg::Approval { request_id, tool, detail, input }] => {
                assert_eq!(request_id, "r1");
                assert_eq!(tool, "Write");
                assert_eq!(detail, "x.txt\nhello");
                assert_eq!(input["content"], "hello");
            }
            other => panic!("{other:?}"),
        }
        let other = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"interrupt"}}"#;
        assert!(parse_claude_line(other).is_empty());
        let other = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"Glob","input":{"pattern":"*.rs"}}}"#;
        match &parse_claude_line(other)[..] {
            [ClaudeMsg::Approval { detail, .. }] => assert_eq!(detail, r#"{"pattern":"*.rs"}"#),
            o => panic!("{o:?}"),
        }
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"success","session_id":"s"}"#), vec![ClaudeMsg::Result { subtype: "success".into() }]);
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"error_max_turns"}"#), vec![ClaudeMsg::Result { subtype: "error_max_turns".into() }]);
    }

    #[test]
    fn claude_detail_truncates() {
        let long = "x".repeat(500);
        let d = claude_detail("Write", &json!({"file_path":"a","content":long}));
        assert_eq!(d.chars().count(), "a\n".len() + 200);
        let d = claude_detail("Edit", &json!({"file_path":"a","new_string":"n"}));
        assert_eq!(d, "a\nn");
        let d = claude_detail("Other", &json!({"k": "y".repeat(500)}));
        assert_eq!(d.chars().count(), 300);
    }

    #[test]
    fn claude_response_lines() {
        let allow: Value = serde_json::from_str(&claude_control_response("r1", true, &json!({"a":1}))).unwrap();
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["request_id"], "r1");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(allow["response"]["response"]["updatedInput"]["a"], 1);
        let deny: Value = serde_json::from_str(&claude_control_response("r1", false, &json!({}))).unwrap();
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
        assert!(deny["response"]["response"]["message"].as_str().unwrap().len() > 0);
        let u: Value = serde_json::from_str(&claude_user_line("你好")).unwrap();
        assert_eq!(u["message"]["content"], "你好");
        assert!(!claude_user_line("a\nb").contains('\n'), "单行 JSON");
    }

    #[test]
    fn claude_agents_json() {
        let t = r#"[{"pid":1,"cwd":"D:\\a","kind":"interactive","sessionId":"abc","name":"n","status":"idle"},{"pid":2,"kind":"bg","sessionId":"def"},{"pid":3}]"#;
        assert_eq!(parse_claude_agents(t).unwrap(), vec!["abc", "def"]);
        assert_eq!(parse_claude_agents("[]").unwrap(), Vec::<String>::new());
        assert!(parse_claude_agents("oops").is_err());
        assert!(parse_claude_agents("{}").is_err());
    }

    #[test]
    fn codex_lines() {
        assert_eq!(
            parse_codex_line(r#"{"jsonrpc":"2.0","id":2,"result":{"turn":{"id":"t1"}}}"#),
            CodexIn::Response { id: 2, error: None, result: json!({"turn":{"id":"t1"}}) }
        );
        match parse_codex_line(r#"{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"boom"}}"#) {
            CodexIn::Response { id: 3, error: Some(e), .. } => assert_eq!(e, "boom"),
            o => panic!("{o:?}"),
        }
        // 服务端请求，id 为 0
        match parse_codex_line(r#"{"jsonrpc":"2.0","id":0,"method":"item/commandExecution/requestApproval","params":{"command":"echo hi > a.txt"}}"#) {
            CodexIn::Request { id, method, params } => {
                assert_eq!(id, json!(0));
                assert_eq!(method, "item/commandExecution/requestApproval");
                assert_eq!(codex_approval(&method, &params), Some(("command".into(), "echo hi > a.txt".into())));
            }
            o => panic!("{o:?}"),
        }
        assert!(matches!(parse_codex_line(r#"{"jsonrpc":"2.0","method":"turn/started","params":{}}"#), CodexIn::Notification { .. }));
        assert_eq!(parse_codex_line("garbage"), CodexIn::Other);
    }

    #[test]
    fn codex_events() {
        let p = json!({"item":{"type":"agentMessage","text":"OK2"}});
        assert_eq!(codex_event("item/completed", &p), Some(CodexEvent::Agent("OK2".into())));
        let p = json!({"item":{"type":"commandExecution","command":"ls"}});
        assert_eq!(codex_event("item/completed", &p), Some(CodexEvent::Command("ls".into())));
        assert_eq!(codex_event("item/completed", &json!({"item":{"type":"reasoning"}})), None);
        assert_eq!(codex_event("turn/started", &json!({"turn":{"id":"t9"}})), Some(CodexEvent::TurnStarted("t9".into())));
        assert_eq!(codex_event("turn/completed", &json!({"turn":{"id":"t9","status":"completed"}})), Some(CodexEvent::TurnDone { status: "completed".into() }));
        assert_eq!(codex_event("turn/completed", &json!({"turn":{"status":"interrupted"}})), Some(CodexEvent::TurnDone { status: "interrupted".into() }));
        assert_eq!(codex_event("thread/started", &json!({})), None);
    }

    #[test]
    fn codex_approvals_and_decisions() {
        assert_eq!(codex_approval("execCommandApproval", &json!({"command":["git","status"]})), Some(("command".into(), "git status".into())));
        assert_eq!(
            codex_approval("applyPatchApproval", &json!({"fileChanges":{"a.txt":{},"b.txt":{}}})),
            Some(("fileChange".into(), "a.txt\nb.txt".into()))
        );
        assert_eq!(codex_approval("item/fileChange/requestApproval", &json!({"reason":"写文件"})), Some(("fileChange".into(), "写文件".into())));
        assert_eq!(codex_approval("item/tool/call", &json!({})), None);
        assert_eq!(codex_decision("item/commandExecution/requestApproval", true), json!({"decision":"accept"}));
        assert_eq!(codex_decision("item/fileChange/requestApproval", false), json!({"decision":"decline"}));
        assert_eq!(codex_decision("execCommandApproval", true), json!({"decision":"approved"}));
        assert_eq!(codex_decision("applyPatchApproval", false), json!({"decision":"denied"}));
    }

    #[test]
    fn early_decision_before_created() {
        let (tx, rx) = mpsc::channel();
        let mut a = Approvals::default();
        a.add(&tx, "run", "Write", "x", json!("r1"), "", Value::Null);
        let sent = rx.try_recv().unwrap();
        let local = sent["localId"].as_u64().unwrap();
        // 决定先到
        assert!(a.decide("ap1", true).is_none());
        let (p, allow) = a.created(local, "ap1".into(), &tx, "run").unwrap();
        assert!(allow);
        assert_eq!(p.key, json!("r1"));
        // 正常顺序
        a.add(&tx, "run", "Write", "x", json!("r2"), "", Value::Null);
        let local = rx.try_recv().unwrap()["localId"].as_u64().unwrap();
        assert!(a.created(local, "ap2".into(), &tx, "run").is_none());
        let (p, allow) = a.decide("ap2", false).unwrap();
        assert!(!allow);
        assert_eq!(p.key, json!("r2"));
        // 没有等待 created 的授权时，陌生 id 不暂存
        assert!(a.decide("zzz", true).is_none());
        assert!(a.early.is_empty());
    }

    #[test]
    fn approval_timeout_reports_once_and_handles_late_created() {
        let (tx, rx) = mpsc::channel();
        let mut a = Approvals::default();
        a.add(&tx, "run", "Write", "x", json!("r1"), "", Value::Null);
        let local = rx.try_recv().unwrap()["localId"].as_u64().unwrap();
        a.created(local, "ap1".into(), &tx, "run");
        assert!(a.expired(Instant::now(), &tx, "run").is_empty());
        assert_eq!(a.expired(Instant::now() + APPROVAL_TIMEOUT, &tx, "run").len(), 1);
        assert_eq!(rx.try_recv().unwrap(), json!({"type":"run.approvalExpired","runId":"run","approvalId":"ap1"}));
        assert!(a.expired(Instant::now() + APPROVAL_TIMEOUT, &tx, "run").is_empty());
        assert!(rx.try_recv().is_err());
        assert!(a.decide("ap1", true).is_none());

        a.add(&tx, "run", "Write", "x", json!("r2"), "", Value::Null);
        let local = rx.try_recv().unwrap()["localId"].as_u64().unwrap();
        assert_eq!(a.expired(Instant::now() + APPROVAL_TIMEOUT, &tx, "run").len(), 1);
        assert!(rx.try_recv().is_err());
        assert!(a.created(local, "ap2".into(), &tx, "run").is_none());
        assert_eq!(rx.try_recv().unwrap()["approvalId"], "ap2");
        assert!(a.expired_local.is_empty());
        assert!(a.created(local, "ap2".into(), &tx, "run").is_none());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn claude_transcript_history() {
        let t = [
            r#"{"type":"queue-operation"}"#,
            r#"{"type":"user","message":{"role":"user","content":"第一句"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"回答A"},{"type":"tool_use","name":"Bash","input":{}},{"type":"text","text":"回答B"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"out"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"第二句"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"caveat"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}"#,
            "broken line",
        ]
        .join("\n");
        let h = parse_claude_transcript(&t, 30);
        assert_eq!(
            h,
            vec![
                ("user".to_string(), "第一句".to_string()),
                ("assistant".to_string(), "回答A\n回答B".to_string()),
                ("user".to_string(), "第二句".to_string()),
            ]
        );
        assert_eq!(parse_claude_transcript(&t, 2).len(), 2);
        assert_eq!(parse_claude_transcript(&t, 2)[0].1, "回答A\n回答B");
    }

    #[test]
    fn codex_rollout_history() {
        let t = [
            r#"{"type":"session_meta","payload":{"id":"x"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"只回复 OK1"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK1"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"sys"}]}}"#,
        ]
        .join("\n");
        assert_eq!(
            parse_codex_rollout(&t, 30),
            vec![("user".to_string(), "只回复 OK1".to_string()), ("assistant".to_string(), "OK1".to_string())]
        );
        let many: String = (0..40)
            .map(|i| format!(r#"{{"type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"m{i}"}}]}}}}"#))
            .collect::<Vec<_>>()
            .join("\n");
        let h = parse_codex_rollout(&many, 30);
        assert_eq!(h.len(), 30);
        assert_eq!(h[0].1, "m10");
        assert_eq!(h[29].1, "m39");
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agenthub-runner-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn history_file_lookup_and_tail() {
        let d = tmpdir("hist");
        // Claude：按规则找 + 回退搜索
        let projects = d.join("projects");
        std::fs::create_dir_all(projects.join("D--Play")).unwrap();
        std::fs::create_dir_all(projects.join("other")).unwrap();
        std::fs::write(projects.join("D--Play").join("abc-1.jsonl"), "x").unwrap();
        std::fs::write(projects.join("other").join("def-2.jsonl"), "y").unwrap();
        assert_eq!(claude_project_dir_name("D:\\Play"), "D--Play");
        assert_eq!(claude_project_dir_name("D:/Work2/AgentHub"), "D--Work2-AgentHub");
        assert!(find_claude_transcript(&projects, "D:\\Play", "abc-1").unwrap().ends_with("D--Play\\abc-1.jsonl") || find_claude_transcript(&projects, "D:\\Play", "abc-1").unwrap().ends_with("D--Play/abc-1.jsonl"));
        assert!(find_claude_transcript(&projects, "D:\\Play", "def-2").unwrap().ends_with("def-2.jsonl"));
        assert!(find_claude_transcript(&projects, "D:\\Play", "nope").is_none());
        assert!(find_claude_transcript(&projects, "D:\\Play", "..\\x").is_none());
        // Codex：多级目录里按文件名结尾找
        let day = d.join("sessions").join("2026").join("10").join("31");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-10-31T10-00-00-aaaa-bbbb.jsonl"), "z").unwrap();
        assert!(find_codex_rollout(&d.join("sessions"), "aaaa-bbbb").is_some());
        assert!(find_codex_rollout(&d.join("sessions"), "cccc").is_none());
        // 读末尾：丢掉被截断的第一行
        let f = d.join("t.jsonl");
        std::fs::write(&f, "line1\nline2\nline3\n").unwrap();
        assert_eq!(read_tail(&f, 1000).unwrap(), "line1\nline2\nline3\n");
        assert_eq!(read_tail(&f, 8).unwrap(), "line3\n");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn finds_newest_codex_exe() {
        let d = tmpdir("codex");
        assert!(find_codex_exe(&d).is_none());
        let old = d.join("aaaa");
        let new = d.join("bbbb");
        let empty = d.join("cccc");
        for p in [&old, &new, &empty] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(old.join("codex.exe"), "old").unwrap();
        std::fs::write(new.join("codex.exe"), "new").unwrap();
        let f = std::fs::File::options().write(true).open(old.join("codex.exe")).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        drop(f);
        assert_eq!(find_codex_exe(&d).unwrap(), new.join("codex.exe"));
        // 反过来：目录名排在后面的反而更旧
        let f = std::fs::File::options().write(true).open(new.join("codex.exe")).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(7200)).unwrap();
        drop(f);
        assert_eq!(find_codex_exe(&d).unwrap(), old.join("codex.exe"));
        let _ = std::fs::remove_dir_all(d);
    }
}
