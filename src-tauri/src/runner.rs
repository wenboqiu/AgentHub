//! 执行器：在电脑上接着跑 Claude Code / Codex 会话，把输出和授权请求交给 remote.rs 发给服务端。
//!
//! - Claude：`claude -p --resume <sid> --input-format stream-json --output-format stream-json
//!   --verbose --permission-prompt-tool stdio --permission-mode default`
//! - Codex：Desktop 自带 codex.exe 的 `app-server`，走 JSON-RPC（stdio）
//!
//! 纯函数（解析、目录黑名单、路径查找）都单独写出来并有单测；进程管理在 `Runner` 里。

use crate::claude::{home_dir, truncate_chars};
use crate::config::SharedConfig;
use base64::Engine as _;
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
const HISTORY_COUNT: usize = 50;
const TEXT_MAX: usize = 4000;
/// request_user_input 的消息图片太大就放弃附带（base64 后约 5.3MB，WS 和移动端都能承受）
const IMAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// Codex 的用户输入请求（request_user_input 工具）：不是审批，是带选项的提问
const USER_INPUT_METHOD: &str = "item/tool/requestUserInput";

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

/// 规范化后的黑名单（去掉空项）
fn clean_roots(roots: &[String]) -> Vec<String> {
    roots.iter().map(|r| norm_path(r)).filter(|r| !r.is_empty()).collect()
}

/// cwd 检查失败的原因。分成几种报，手机上才能一眼看出是「配置问题」还是「路径写错」
#[derive(Debug, PartialEq)]
pub enum CwdIssue {
    /// 没填目录
    Empty,
    /// 路径里有 `..`：前缀匹配没意义，统一拒绝
    DotDot,
    /// cwd 命中黑名单（等于或落在某一项之下）；附上当前黑名单
    Denied(Vec<String>),
}

/// cwd 检查：`..` 一律拒绝；**黑名单为空 = 不限制**（只做基本合法性检查）；
/// 黑名单非空时 cwd 不能等于或落在其中任一项之下，前缀按目录边界判断。
pub fn check_cwd(cwd: &str, denied: &[String]) -> Result<(), CwdIssue> {
    let c = norm_path(cwd);
    if c.is_empty() {
        return Err(CwdIssue::Empty);
    }
    if c.split('\\').any(|seg| seg == "..") {
        return Err(CwdIssue::DotDot);
    }
    let list = clean_roots(denied);
    if list.is_empty() {
        return Ok(()); // 没配黑名单：不限制目录
    }
    if list.iter().any(|r| c == *r || c.starts_with(&format!("{r}\\"))) {
        // 报错里给用户填的原文，不是规范化后的小写
        let shown = denied.iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
        Err(CwdIssue::Denied(shown))
    } else {
        Ok(())
    }
}

/// 只给单测用的布尔包装：生产路径走 `check_cwd`，需要知道具体是哪种失败
#[cfg(test)]
pub fn cwd_allowed(cwd: &str, denied: &[String]) -> bool {
    check_cwd(cwd, denied).is_ok()
}

/// 目录必须真实存在：盘符/名字写错时给一条能看懂的错误，而不是让子进程起不来
pub fn cwd_exists(cwd: &str) -> Result<(), String> {
    if Path::new(cwd.trim()).is_dir() {
        Ok(())
    } else {
        Err(format!("项目目录不存在：{cwd}（检查盘符和路径是否写错）"))
    }
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

    /// Resume 检查原会话是否仍在终端打开：打开时走本机收件通道，关闭时恢复会话。
    pub fn checks_open(self) -> bool {
        self == Mode::Resume
    }
}

/// 前置检查（不含「会话还开着」，那个要跑外部命令）
pub fn precheck(mode: Mode, key: &str, cwd: &str, denied: &[String]) -> Result<(), String> {
    if mode.needs_key() && !valid_key(key) {
        return Err("会话 id 格式不对".into());
    }
    match check_cwd(cwd, denied) {
        Ok(()) => Ok(()),
        Err(CwdIssue::Empty) => Err("项目目录为空：先在任务或会话里填一个项目目录".into()),
        Err(CwdIssue::DotDot) => Err(format!("项目目录不能包含 ..：{cwd}（请填写完整路径）")),
        Err(CwdIssue::Denied(list)) => Err(format!(
            "项目目录在禁止列表里：{cwd}（禁止：{}；从电脑端「禁止执行的目录」里删掉对应那一行即可放行）",
            list.join("; ")
        )),
    }
}

/// 角色带来的模型与上下文：空字符串表示「不覆盖执行端默认」。
/// claude 有真正的系统提示钩子，直接追加到命令行；上下文不会混进用户消息里。
pub fn claude_role_args(args: &mut Vec<String>, model: &str, instructions: &str) {
    if !model.is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    if !instructions.is_empty() {
        args.push("--append-system-prompt".into());
        args.push(instructions.into());
    }
}

/// Codex 没有等价的系统提示钩子：上下文放在首条消息前面，用分隔线隔开。
pub fn codex_role_text(text: &str, instructions: &str) -> String {
    if instructions.is_empty() { text.to_string() } else { format!("{instructions}\n\n---\n\n{text}") }
}

/// Codex 的模型是进程级配置：`codex -c model="xxx" app-server`（每个 run 一个进程，互不影响）
pub fn codex_model_args(model: &str) -> Vec<String> {
    if model.is_empty() { vec![] } else { vec!["-c".into(), format!("model=\"{model}\"")] }
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
pub fn claude_branch_args(mode: Mode, key: &str, point: &str) -> Vec<String> {
    let mut args = claude_args(mode, key);
    if mode == Mode::Fork && !point.is_empty() { args.extend(["--resume-session-at".into(), point.into()]); }
    args
}

pub fn codex_branch_request(id: i64, mode: Mode, key: &str, cwd: &str, point: &str) -> String {
    if mode == Mode::Fork && !point.is_empty() {
        rpc_request(id,"thread/fork",json!({"threadId":key,"lastTurnId":point}))
    } else { codex_thread_request(id, mode, key, cwd) }
}

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

pub fn truncate_history_text(s: &str) -> String {
    clip(s)
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

/// 用户附图统一走 data URL（`data:image/png;base64,...`），拆成 (media_type, base64)
pub fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media = meta.strip_suffix(";base64")?;
    if !matches!(media, "image/png" | "image/jpeg" | "image/webp" | "image/gif") || data.is_empty() {
        return None;
    }
    Some((media, data))
}

/// Claude 的 stream-json 用户消息：纯文字走字符串 content，带图时改成 content block 数组
pub fn claude_user_line(text: &str, images: &[String]) -> String {
    let parts: Vec<Value> = images
        .iter()
        .filter_map(|u| split_data_url(u))
        .map(|(media, data)| json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}}))
        .collect();
    if parts.is_empty() {
        return json!({"type":"user","message":{"role":"user","content":text}}).to_string();
    }
    let mut content = Vec::with_capacity(parts.len() + 1);
    if !text.is_empty() {
        content.push(json!({"type":"text","text":text}));
    }
    content.extend(parts);
    json!({"type":"user","message":{"role":"user","content":content}}).to_string()
}

/// data URL 落成本地临时文件，返回 Codex 能吃的 localImage 输入项 + 待清理的路径。
/// Codex 的 image 输入有两种：`url`（远程）和 `localImage`（本地路径），后者对本地文件最稳。
pub fn codex_image_inputs(images: &[String], dir: &Path, tag: &str) -> (Vec<Value>, Vec<PathBuf>) {
    let mut items = Vec::new();
    let mut files = Vec::new();
    for (i, url) in images.iter().enumerate() {
        let Some((media, data)) = split_data_url(url) else { continue };
        let ext = match media {
            "image/png" => "png",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "jpg",
        };
        let Some(bytes) = base64_decode(data) else { continue };
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(format!("{tag}-{i}.{ext}"));
        if std::fs::write(&path, bytes).is_err() {
            continue;
        }
        items.push(json!({"type":"localImage","path":path.to_string_lossy()}));
        files.push(path);
    }
    (items, files)
}

/// 临时附图文件：运行结束（含各种提前 return）时自动删除
struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 标准 base64 解码（只认 padding 结尾的常规字母表，够 data URL 用）
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let body = s.trim_end_matches('=');
    let pad = s.len() - body.len();
    if pad > 2 || s.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in body.bytes() {
        let v = lut[c as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
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
    /// 生成/展示的图片落在了本机（imageGeneration 的 savedPath / imageView 的 path）
    Image(String),
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
                // 生成失败（没有 savedPath / 带 failure）不算图片事件
                "imageGeneration" => item.get("savedPath").and_then(|p| p.as_str()).filter(|_| item.get("failure").is_none()).map(|p| CodexEvent::Image(p.to_string())),
                "imageView" => item.get("path").and_then(|p| p.as_str()).map(|p| CodexEvent::Image(p.to_string())),
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

/// 用户输入请求（item/tool/requestUserInput）→ 提取 questions 数组；不是这类请求返回 None。
/// params 里还有 isBlocking / threadId / turnId，服务端暂时用不到，先不转发。
pub fn codex_user_input<'a>(method: &str, params: &'a Value) -> Option<&'a Value> {
    if method != USER_INPUT_METHOD {
        return None;
    }
    params.get("questions").filter(|q| q.is_array())
}

/// 把 UI 提交的 {"问题id": ["选项", ...]} 转成协议要求的 {"answers": {"问题id": {"answers": [...]}}}；
/// 空/非法输入按「全部跳过」回空对象，Codex 会走自己的默认处理。
pub fn codex_input_response(answers: &Value) -> Value {
    let mut wrapped = serde_json::Map::new();
    if let Some(o) = answers.as_object() {
        for (k, v) in o {
            if v.is_array() {
                wrapped.insert(k.clone(), json!({ "answers": v }));
            }
        }
    }
    json!({ "answers": wrapped })
}

/// 图片文件转 data URL：读不到、超过大小上限或不是常见图片格式时返回 None
pub fn image_data_url(path: &str) -> Option<String> {
    let mime = match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > IMAGE_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
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

pub fn read_history(agent: &str, key: &str, cwd: &str) -> Result<Vec<crate::message_history::HistoryMessage>, String> {
    let home = home_dir().ok_or("找不到用户目录")?;
    match agent {
        "claude" => {
            let p = find_claude_transcript(&home.join(".claude").join("projects"), cwd, key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 512 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("claude", &text, HISTORY_COUNT))
        }
        "codex" => {
            let p = find_codex_rollout(&home.join(".codex").join("sessions"), key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 4 * 1024 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("codex", &text, HISTORY_COUNT))
        }
        "zcode" => crate::zcode_exec::history(key, HISTORY_COUNT).ok_or("没找到这个会话的本地记录".into()),
        // WorkBuddy 只读不聊，但 transcript 里正文齐全：按 sessionId 在各工作区目录下找 {key}.jsonl
        "workbuddy" => {
            let p = find_workbuddy_transcript(&home.join(".workbuddy").join("projects"), key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 4 * 1024 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("workbuddy", &text, HISTORY_COUNT))
        }
        _ => Err("不认识的 agent".into()),
    }
}

/// WorkBuddy 的 transcript 按 `projects\<工作区>\<sessionId>.jsonl` 存放，工作区名不可控，
/// 只能逐个目录找文件名；key 先过 valid_key 防路径注入（与 claude 同一规则）
fn find_workbuddy_transcript(projects: &Path, key: &str) -> Option<PathBuf> {
    if !valid_key(key) {
        return None;
    }
    let file = format!("{key}.jsonl");
    for ws in std::fs::read_dir(projects).ok()?.flatten() {
        let p = ws.path().join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
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
    if std::env::var_os("AGENTHUB_ZCODE_DEBUG").is_some() {
        eprintln!("-> {}", line.chars().take(600).collect::<String>());
    }
    let Some(w) = stdin.as_mut() else { return false };
    w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n")).and_then(|_| w.flush()).is_ok()
}

// ---------------------------------------------------------------- 运行

pub enum RunMsg {
    Stop,
    /// 连接断开：静默结束进程，不再上报
    Shutdown,
    Decide { approval_id: String, allow: bool },
    /// 用户输入请求的答案（request_user_input）；answers 形如 {"问题id": ["选项"]}
    Answer { approval_id: String, answers: Value },
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

    /// 用户输入请求：detail 放 questions 的 JSON（服务端原样存进 approvals.detail，UI 解析渲染）
    fn add_input(&mut self, out: &Sender<Value>, run_id: &str, questions: &Value, key: Value) {
        self.add(out, run_id, "userInput", &questions.to_string(), key, USER_INPUT_METHOD, Value::Null);
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

    /// 用户输入请求的答案。UI 只能看到 approval.created 之后的 approvalId，所以不需要 early 暂存
    fn answer(&mut self, approval_id: &str, answers: &Value) -> Option<Pending> {
        let local = self.by_local.iter().find(|(_, p)| p.approval_id.as_deref() == Some(approval_id) && p.method == USER_INPUT_METHOD).map(|(k, _)| *k);
        local.and_then(|l| self.by_local.remove(&l)).map(|mut p| {
            p.input = answers.clone();
            p
        })
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

    /// 带图片的消息（Codex 生成的图片，data URL 形式）
    fn message_images(&self, text: &str, images: Vec<String>) {
        let _ = self.out.send(json!({"type":"run.message","runId":self.run_id,"role":"assistant","text":clip(text),"images":images}));
    }

    fn message_at(&self, text: &str, source: Option<&str>, point: Option<&str>) {
        let _ = self.out.send(json!({"type":"run.message","runId":self.run_id,"role":"assistant","text":clip(text),"sourceId":source,"branchPoint":point}));
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

fn run_claude(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str) {
    let mut cmd = Command::new("claude");
    let mut args = claude_branch_args(mode, key, branch_point);
    claude_role_args(&mut args, model, instructions);
    cmd.args(args)
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
    if !write_line(&mut stdin, &claude_user_line(text, images)) {
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
                            finish = Some(Finish::Failed("分叉没有生成新会话，已停止".into()));
                            drop(stdin.take());
                            kill_tree(&mut child);
                            continue;
                        }
                        ClaudeInit::NotInit => {}
                    }
                }
                let parsed = parse_claude_line(&l);
                let texts: Vec<_> = parsed.iter().filter_map(|m| if let ClaudeMsg::Text(t) = m { Some(t.as_str()) } else { None }).collect();
                if !texts.is_empty() {
                    let v: Value = serde_json::from_str(&l).unwrap_or(Value::Null);
                    let source = v["uuid"].as_str().filter(|s| valid_key(s));
                    let point = if matches!(v["message"]["stop_reason"].as_str(), Some("end_turn" | "stop_sequence")) { source } else { None };
                    run.message_at(&texts.join("\n"), source, point);
                }
                for m in parsed {
                    match m {
                        ClaudeMsg::Text(_) => {},
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
            // Claude 没有用户输入请求；答案只会派给 Codex 运行
            Ok(RunMsg::Answer { .. }) => {}
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

/// The terminal owns this process. We only deliver and observe; stop/disconnect never kills it.
fn run_claude_terminal(run: &Run, key: &str, cwd: &str, text: &str) {
    let prepare = || -> Result<_,String> {
        let endpoint=crate::claude_live::discover(key,cwd)?;
        let path=crate::claude_live::transcript(key,cwd)?;
        let offset=std::fs::metadata(&path).map_err(|_|"无法读取原终端记录")?.len();
        Ok((endpoint,path,offset))
    };
    let (endpoint,path,mut offset)=match prepare(){Ok(v)=>v,Err(e)=>return run.fail(&e)};
    match run.rx.try_recv() {
        Ok(RunMsg::Stop)=>{run.status("stopped","");return;},
        Ok(RunMsg::Shutdown)=>return,
        _=>{}
    }
    if let Err(e)=crate::claude_live::send(&endpoint,key,&run.run_id,text){return run.fail(&e);}
    run.message("system","已连接原终端，消息已投递；等待终端接收。授权和中断请在原终端处理。");
    let start=Instant::now();let mut turn=crate::claude_live::ObservedTurn::new(&run.run_id);
    loop {
        if !turn.delivered && start.elapsed()>Duration::from_secs(5*60) {
            return run.fail("尚未确认原终端接收消息，可能正在等待终端批准。请先检查终端，避免重复发送");
        }
        if start.elapsed()>RUN_TIMEOUT {return run.fail("原终端回复跟踪已超时，请在终端查看运行结果");}
        match run.rx.recv_timeout(Duration::from_millis(500)) {
            Ok(RunMsg::Stop)=>{run.message("system","已停止跟踪，原终端会话仍由终端控制。");run.status("stopped","");return;},
            Ok(RunMsg::Shutdown)|Err(RecvTimeoutError::Disconnected)=>return,
            _=>{}
        }
        let rows=match crate::claude_live::read_rows(&path,&mut offset){Ok(v)=>v,Err(e)=>return run.fail(&e)};
        for row in rows {
            for event in turn.consume(&row) {
                match event {
                    crate::claude_live::Observed::Delivered=>run.status("running",""),
                    crate::claude_live::Observed::Reply{source,text,finished}=>{
                        run.message_at(&text,source.as_deref(),if finished{source.as_deref()}else{None});
                        if finished {run.status("done","");return;}
                    },
                    crate::claude_live::Observed::OtherInput=>return run.fail("原终端已收到另一条输入，已结束本条消息的回复跟踪，请刷新对话记录"),
                }
            }
        }
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

fn run_codex(run: &Run, mode: Mode, exe: &Path, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str) {
    // 附图先落到临时文件（Codex 用 localImage 输入读本地路径），函数退出时统一清理
    let (image_items, image_files) = codex_image_inputs(images, &std::env::temp_dir().join("agenthub-images"), &run.run_id);
    let _image_cleanup = TempFiles(image_files);
    let body = codex_role_text(text, instructions);
    let mut input = Vec::with_capacity(image_items.len() + 1);
    input.push(json!({"type":"text","text":body,"text_elements":[]}));
    input.extend(image_items);
    let mut cmd = Command::new(exe);
    cmd.args(codex_model_args(model)).arg("app-server").current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
                                write_line(&mut stdin, &codex_branch_request(ID_RESUME, mode, key, cwd, branch_point));
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
                                        json!({"threadId":thread_id,"input":input.clone(),"approvalPolicy":"on-request"}),
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
                    Some(CodexEvent::Agent(t)) => {
                        let source = params["item"]["id"].as_str().filter(|s| valid_key(s));
                        let point = if params["item"]["phase"] == "final_answer" { turn_id.as_deref() } else { None };
                        run.message_at(&t, source, point);
                    },
                    Some(CodexEvent::Command(c)) => run.message("tool", &format!("命令：{c}")),
                    Some(CodexEvent::Image(path)) => {
                        let name = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("图片").to_string();
                        match image_data_url(&path) {
                            Some(url) => run.message_images(&format!("图片：{name}"), vec![url]),
                            None => run.message("system", &format!("生成了图片但无法读取：{path}")),
                        }
                    }
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
                CodexIn::Request { id, method, params } => {
                    if let Some(questions) = codex_user_input(&method, &params) {
                        approvals.add_input(&run.out, &run.run_id, questions, id);
                    } else if let Some((tool, detail)) = codex_approval(&method, &params) {
                        approvals.add(&run.out, &run.run_id, &tool, &detail, id, &method, Value::Null);
                    } else {
                        run.message("system", &format!("不支持的请求：{method}"));
                        write_line(&mut stdin, &rpc_response(&id, json!({"decision":"decline"})));
                    }
                }
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
            Ok(RunMsg::Answer { approval_id, answers }) => {
                if let Some(p) = approvals.answer(&approval_id, &answers) {
                    write_line(&mut stdin, &rpc_response(&p.key, codex_input_response(&answers)));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => finish = Some(Finish::Silent),
        }
        if finish.is_none() && interrupt_deadline.is_some_and(|d| Instant::now() >= d) {
            finish = Some(Finish::Stopped);
        }
        for p in approvals.expired(Instant::now(), &run.out, &run.run_id) {
            if p.method == USER_INPUT_METHOD {
                run.message("system", "提问等待超时，已跳过");
                write_line(&mut stdin, &rpc_response(&p.key, codex_input_response(&Value::Null)));
            } else {
                run.message("system", "授权等待超时，已拒绝");
                answer_codex(&mut stdin, &p, false);
            }
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
    // 用户输入请求不吃 decision：allow/deny 都按「空答案」回（Codex 会走自己的默认处理）
    if p.method == USER_INPUT_METHOD {
        write_line(stdin, &rpc_response(&p.key, codex_input_response(&Value::Null)));
        return;
    }
    write_line(stdin, &rpc_response(&p.key, codex_decision(&p.method, allow)));
}

// ---------------------------------------------------------------- zcode

const ZCODE_PERMISSION: &str = "interaction/requestPermission";
const ZCODE_USER_INPUT: &str = "interaction/requestUserInput";
/// create 首次要等约 20s（官方 MCP 鉴权 + workspace 初始化），给足预算
const ZCODE_CREATE_TIMEOUT: Duration = Duration::from_secs(150);
/// stop 之后等终止态的时间
const ZCODE_STOP_GRACE: Duration = Duration::from_secs(15);


/// ZCode 的帧是 strict schema：多一个键（比如 Codex 需要的 jsonrpc）整帧被拒
fn zcode_response(id: &Value, result: Value) -> String {
    json!({"id": id, "result": result}).to_string()
}

fn zcode_prefs() -> Value {
    json!({
        "nativeSearchEnhancementsEnabled": false,
        "toolSearchMode": "off",
        "memoryEnabled": false,
        "askUserQuestionAutoResolutionEnabled": true,
        "modelContextBudgetStrategy": "preflight-v1"
    })
}

/// zcode 的授权应答只有 allow / deny 两个决定
fn zcode_decision(allow: bool) -> Value {
    json!({"decision": if allow { "allow" } else { "deny" }})
}

fn run_zcode(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, model: &str, instructions: &str) {
    if mode == Mode::Fork {
        return run.fail("ZCode 暂不支持按回复分叉：可以同目录新开会话，或直接在会话里继续聊");
    }
    let Some(install) = crate::zcode_exec::find_install() else {
        return run.fail("没找到 ZCode 安装目录（默认 C:\\Program Files\\ZCode）");
    };
    let log_dir = std::env::temp_dir().join("agenthub-zcode").join(&run.run_id);
    let mut cmd = match crate::zcode_exec::runtime(&install) {
        crate::zcode_exec::Runtime::Electron(exe) => {
            let mut c = Command::new(exe);
            // ZCode 自带 Electron：以 node 身份跑 CLI，不依赖用户装没装 Node
            c.env("ELECTRON_RUN_AS_NODE", "1").arg(&install.cjs);
            c
        }
        crate::zcode_exec::Runtime::Node(exe) => {
            let mut c = Command::new(exe);
            c.arg(&install.cjs);
            c
        }
    };
    cmd.args(["app-server", "--stdio", "--surface", "desktop"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::zcode_exec::prepare_command(&mut cmd, &install, &log_dir);
    let mut child = match no_window(&mut cmd).spawn() {
        Ok(c) => c,
        Err(e) => return run.fail(&format!("启动 ZCode 失败：{e}")),
    };
    let mut stdin = child.stdin.take();
    let tail = spawn_readers(&mut child, &run.tx);
    run.status("running", "");

    const ID_CREATE: i64 = 1;
    const ID_RESUME: i64 = 2;
    const ID_REFRESH: i64 = 3;
    const ID_ACCOUNT: i64 = 4;
    const ID_SUB: i64 = 5;
    const ID_SEND: i64 = 6;
    const ID_STOP: i64 = 7;

    let (provider_id, model_id) = crate::zcode_exec::model_selection(model);
    let body = codex_role_text(text, instructions);
    // 与桌面端一致：create 只带 workspace，其它字段走默认；spawn 后等存储就绪再发
    let create = json!({"workspace": {"workspacePath": cwd, "workspaceKey": cwd}});
    let resume = json!({"sessionId": key});
    let mut create_sent = false;
    let mut boot_deadline = Instant::now() + Duration::from_secs(3);

    let start = Instant::now();
    let debug = std::env::var("AGENTHUB_ZCODE_DEBUG").is_ok();
    let mut create_deadline = Instant::now() + ZCODE_CREATE_TIMEOUT;
    let mut approvals = Approvals::default();
    let mut session_id = key.to_string();
    let mut created = false;
    let mut stop_deadline: Option<Instant> = None;
    let mut finish: Option<Finish> = None;
    let mut project_token: Option<(String, String)> = None;
    let mut reply = String::new();
    while finish.is_none() {
        if !create_sent && Instant::now() >= boot_deadline {
            create_sent = true;
            create_deadline = Instant::now() + ZCODE_CREATE_TIMEOUT;
            let msg = if mode == Mode::Resume {
                json!({"id": ID_RESUME, "method": "session/resume", "params": resume})
            } else {
                json!({"id": ID_CREATE, "method": "session/create", "params": create})
            };
            write_line(&mut stdin, &msg.to_string());
        }
        if start.elapsed() > RUN_TIMEOUT {
            run.message("system", "运行超过 2 小时，已强制停止");
            finish = Some(Finish::Stopped);
            break;
        }
        if !created && Instant::now() > create_deadline {
            finish = Some(Finish::Failed("ZCode 初始化超时（会话还没准备好），请稍后重试".into()));
            break;
        }
        match run.rx.recv_timeout(Duration::from_millis(300)) {
            Ok(RunMsg::Line(l)) => {
                if debug {
                    eprintln!("<- {}", l.chars().take(600).collect::<String>());
                }
                let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
                let Some(id) = v.get("id").cloned() else {
                    // 通知：会话事件 / 生命周期
                    match v.get("method").and_then(Value::as_str).unwrap_or("") {
                        "session/event" => {
                            let p = &v["params"];
                            match p.get("type").and_then(Value::as_str).unwrap_or("") {
                                "turn.started" => {}
                                "model.streaming" => {
                                    // 这一版 CLI 不发 turn.completed 的正文，回复只在流式增量里
                                    if p.pointer("/payload/kind").and_then(Value::as_str) == Some("text_delta") {
                                        if let Some(d) = p.pointer("/payload/delta").and_then(Value::as_str) {
                                            reply.push_str(d);
                                        }
                                    }
                                }
                                "tool.updated" => {
                                    if let Some(name) = p
                                        .pointer("/payload/toolName")
                                        .or_else(|| p.pointer("/payload/name"))
                                        .and_then(Value::as_str)
                                    {
                                        let status = p.pointer("/payload/status").and_then(Value::as_str).unwrap_or("");
                                        if !status.is_empty() {
                                            run.message("tool", &format!("{name}（{status}）"));
                                        }
                                    }
                                }
                                "turn.completed" => {
                                    let content = p
                                        .pointer("/payload/content")
                                        .and_then(Value::as_str)
                                        .filter(|s| !s.trim().is_empty())
                                        .map(str::to_string)
                                        .unwrap_or_else(|| reply.clone());
                                    if !content.trim().is_empty() {
                                        let source = p.get("turnId").and_then(Value::as_str).filter(|s| valid_key(s));
                                        run.message_at(&content, source, None);
                                    }
                                    finish = Some(Finish::Done);
                                }
                                "turn.failed" => {
                                    let msg = p
                                        .pointer("/payload/error/message")
                                        .and_then(Value::as_str)
                                        .or_else(|| p.pointer("/payload/error/code").and_then(Value::as_str))
                                        .unwrap_or("未知错误");
                                    let phase = p
                                        .pointer("/payload/error/attribution/errorPhase")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    finish = Some(Finish::Failed(if phase.is_empty() {
                                        format!("ZCode 运行失败：{msg}")
                                    } else {
                                        format!("ZCode 运行失败（{phase}）：{msg}")
                                    }));
                                }
                                _ => {}
                            }
                        }
                        "session/lifecycle/changed" => {
                            if v.pointer("/params/state").and_then(Value::as_str) == Some("failed") {
                                let msg = v
                                    .pointer("/params/lastError/message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("会话启动失败");
                                finish = Some(Finish::Failed(format!("ZCode 会话启动失败：{msg}")));
                            }
                        }
                        // 存储就绪就可以发 create，不必等满 3 秒
                        "startup/storageState" => {
                            if v.pointer("/params/phase").and_then(Value::as_str) == Some("ready") && !create_sent {
                                boot_deadline = Instant::now();
                            }
                        }
                        // 终止态的另一条流：computer-use 的 turn-completed / v4 遥测的 turn.terminal
                        "computer-use/operation-event" => {
                            if v.pointer("/params/kind").and_then(Value::as_str) == Some("turn-completed") {
                                if !reply.trim().is_empty() {
                                    run.message("assistant", &reply);
                                }
                                finish = Some(Finish::Done);
                            }
                        }
                        "v4/telemetry/event" => {
                            if v.pointer("/params/kind").and_then(Value::as_str) == Some("turn.terminal") {
                                let status = v.pointer("/params/status").and_then(Value::as_str).unwrap_or("");
                                if !reply.trim().is_empty() {
                                    run.message("assistant", &reply);
                                }
                                finish = Some(if status == "success" { Finish::Done } else { Finish::Failed(format!("ZCode 运行结束：{status}")) });
                            }
                        }
                        _ => {}
                    }
                    continue;
                };
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(Value::as_str).unwrap_or("未知错误");
                    let req = id.as_i64().unwrap_or(0);
                    // 账号权益下发失败不致命：后面 send 会给出更具体的原因
                    if req == ID_REFRESH || req == ID_ACCOUNT {
                        run.message("system", &format!("ZCode 模型配置下发失败：{msg}"));
                    } else if req != ID_STOP {
                        finish = Some(Finish::Failed(format!("ZCode 返回错误：{msg}")));
                    }
                    continue;
                }
                // 服务端反向请求（有 id 也有 method）
                if v.get("method").is_some() {
                    let method = v["method"].as_str().unwrap_or("");
                    match method {
                        "session/requestRuntimePreferences" => {
                            write_line(&mut stdin, &zcode_response(&id, zcode_prefs()));
                        }
                        "interaction/requestOfficialMcpAuthHeaders" => {
                            write_line(&mut stdin, &zcode_response(&id, json!({})));
                        }
                        "interaction/requestProviderRuntimeHeaders" => {
                            if project_token.is_none() {
                                project_token = crate::zcode_exec::project_token();
                            }
                            let result = match &project_token {
                                Some((api_key, _)) => json!({"headersApplied": true, "requestAuth": {"apiKey": api_key}}),
                                None => json!({"headersApplied": false}),
                            };
                            write_line(&mut stdin, &zcode_response(&id, result));
                        }
                        ZCODE_PERMISSION => {
                            let tool = v.pointer("/params/toolName").and_then(Value::as_str).unwrap_or("工具").to_string();
                            let detail = v
                                .pointer("/params/input")
                                .map(|i| clip(&i.to_string()))
                                .filter(|s| !s.is_empty())
                                .or_else(|| v.pointer("/params/reason").and_then(Value::as_str).map(str::to_string))
                                .unwrap_or_default();
                            approvals.add(&run.out, &run.run_id, &tool, &detail, id, ZCODE_PERMISSION, Value::Null);
                        }
                        ZCODE_USER_INPUT => {
                            // 提问卡片暂不支持在 AgentHub 作答：直接取消，避免整轮挂住
                            run.message("system", "ZCode 的提问暂不支持在 AgentHub 回答，已自动跳过");
                            write_line(&mut stdin, &zcode_response(&id, json!({"value": "", "cancelled": true})));
                        }
                        _ => {
                            run.message("system", &format!("不支持的请求：{method}"));
                            write_line(&mut stdin, &zcode_response(&id, json!({})));
                        }
                    }
                    continue;
                }
                // 我们自己请求的应答
                match id.as_i64().unwrap_or(0) {
                    ID_CREATE | ID_RESUME => {
                        match v.pointer("/result/session/sessionId").and_then(Value::as_str) {
                            Some(sid) => {
                                session_id = sid.to_string();
                                created = true;
                                if mode != Mode::Resume {
                                    run.session(sid);
                                }
                            }
                            None => {
                                finish = Some(Finish::Failed("ZCode 没有返回会话 id".into()));
                                continue;
                            }
                        }
                        // provider 权益下发：不下发 registry 就是空的，send 会报「先选模型」
                        let mut account = json!({
                            "revision": format!("agenthub-{}", run.run_id),
                            "providers": { provider_id.clone(): {"access": {"type": "zhipu-account", "entitled": true}} },
                            "states": { provider_id.clone(): {"availability": "available", "entitled": true, "current": true} }
                        });
                        if let Some(rev) = crate::zcode_exec::builtin_revision(&log_dir) {
                            account["basedOnZCodeBuiltinRevision"] = json!(rev);
                        }
                        write_line(&mut stdin, &json!({"id": ID_REFRESH, "method": "provider/refreshRegistry", "params": {"reason": "run"}}).to_string());
                        write_line(&mut stdin, &json!({"id": ID_ACCOUNT, "method": "provider/updateAccountConfig", "params": account}).to_string());
                        write_line(
                            &mut stdin,
                            &json!({"id": ID_SUB, "method": "session/subscribe", "params": {"sessionId": session_id, "deliveryKind": "desktop-continuous"}}).to_string(),
                        );
                    }
                    ID_SUB => {
                        write_line(
                            &mut stdin,
                            &json!({"id": ID_SEND, "method": "session/send", "params": {
                                "sessionId": session_id,
                                "content": body,
                                "modelSelection": {"providerId": provider_id, "modelId": model_id, "options": {"reasoningLevel": "high"}}
                            }})
                            .to_string(),
                        );
                    }
                    _ => {}
                }
            }
            Ok(RunMsg::Eof) => {
                let code = child.wait().ok().and_then(|s| s.code());
                finish = Some(Finish::Failed(format!(
                    "ZCode 进程异常退出（{}）：{}",
                    code.map_or("未知".into(), |c| c.to_string()),
                    stderr_tail(&tail)
                )));
            }
            Ok(RunMsg::Stop) => {
                write_line(&mut stdin, &json!({"id": ID_STOP, "method": "session/stop", "params": {"sessionId": session_id}}).to_string());
                stop_deadline = Some(Instant::now() + ZCODE_STOP_GRACE);
            }
            Ok(RunMsg::Shutdown) => finish = Some(Finish::Silent),
            Ok(RunMsg::Created { local_id, approval_id }) => {
                if let Some((p, allow)) = approvals.created(local_id, approval_id, &run.out, &run.run_id) {
                    write_line(&mut stdin, &zcode_response(&p.key, zcode_decision(allow)));
                }
            }
            Ok(RunMsg::Decide { approval_id, allow }) => {
                if let Some((p, allow)) = approvals.decide(&approval_id, allow) {
                    write_line(&mut stdin, &zcode_response(&p.key, zcode_decision(allow)));
                }
            }
            Ok(RunMsg::Answer { approval_id, answers }) => {
                if let Some(p) = approvals.answer(&approval_id, &answers) {
                    write_line(&mut stdin, &zcode_response(&p.key, answers.clone()));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => finish = Some(Finish::Silent),
        }
        if let Some(d) = stop_deadline {
            if finish.is_none() && Instant::now() >= d {
                finish = Some(Finish::Stopped);
            }
        }
        for p in approvals.expired(Instant::now(), &run.out, &run.run_id) {
            run.message("system", "授权等待超时，已拒绝");
            write_line(&mut stdin, &zcode_response(&p.key, zcode_decision(false)));
        }
    }
    let f = finish.unwrap();
    let exited = matches!(&f, Finish::Failed(m) if m.starts_with("ZCode 进程异常退出"));
    drop(stdin);
    if !exited {
        kill_tree(&mut child);
    }
    let _ = std::fs::remove_dir_all(&log_dir);
    report(run, f);
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
            Some("run.start") => {
                let images = msg
                    .get("images")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
                    .unwrap_or_default();
                // 角色带来的模型与上下文：老服务端不发这两个字段，空串就是「用执行端默认」
                self.start(s("runId"), s("sessionId"), s("agent"), s("sessionKey"), s("cwd"), s("text"), images, s("mode"), s("branchPoint"), s("model"), s("instructions"));
            }
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
                match msg.get("answers").filter(|a| a.is_object()) {
                    Some(answers) => self.to_all(|| RunMsg::Answer { approval_id: approval_id.clone(), answers: answers.clone() }),
                    None => {
                        let allow = s("decision") == "allow";
                        self.to_all(|| RunMsg::Decide { approval_id: approval_id.clone(), allow });
                    }
                }
            }
            Some("history.request") => {
                let (out, request_id, agent, key, cwd) = (self.out.clone(), s("requestId"), s("agent"), s("sessionKey"), s("cwd"));
                std::thread::spawn(move || {
                    let m = match read_history(&agent, &key, &cwd) {
                        Ok(list) => json!({"type":"history.result","requestId":request_id,"messages":list}),
                        Err(e) => json!({"type":"history.result","requestId":request_id,"messages":[],"error":e}),
                    };
                    let _ = out.send(m);
                });
            }
            _ => {}
        }
    }

    fn start(&self, run_id: String, session_id: String, agent: String, key: String, cwd: String, text: String, images: Vec<String>, mode: String, branch_point: String, model: String, instructions: String) {
        let (tx, rx) = mpsc::channel();
        let run = Run { out: self.out.clone(), run_id: run_id.clone(), rx, tx: tx.clone() };
        // 空 cwd = 用 AgentHub 自己的默认工作目录（<文档>/AgentHub，重装也还在）。
        // 先建目录再占会话槽：建不出来就直接失败，别留下一个永远卡住的运行。
        let cwd = if cwd.trim().is_empty() {
            match crate::workdir::ensure_default() {
                Ok(dir) => dir,
                Err(e) => return run.fail(&e),
            }
        } else {
            cwd
        };
        {
            // 同一会话同时只允许一个运行（服务端已经挡了，这里再挡一次）
            let mut g = self.runs.lock().unwrap();
            if run_id.is_empty() || g.values().any(|e| e.session_id == session_id) {
                drop(g);
                return run.fail("这个会话已经有一个运行在进行");
            }
            g.insert(run_id.clone(), Entry { session_id, tx });
        }
        let denied = self.config.read().unwrap().denied_roots.clone();
        let runs = self.runs.clone();
        std::thread::spawn(move || {
            execute(&run, &denied, &agent, &mode, &key, &cwd, &text, &images, &branch_point, &model, &instructions);
            runs.lock().unwrap().remove(&run.run_id);
        });
    }
}

/// 前置检查 + 按 agent 分派
fn execute(run: &Run, denied: &[String], agent: &str, mode: &str, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str) {
    let Some(mode) = Mode::parse(mode) else {
        return run.fail(&format!("不支持的模式：{mode}"));
    };
    if let Err(e) = precheck(mode, key, cwd, denied) {
        return run.fail(&e);
    }
    if let Err(e) = cwd_exists(cwd) {
        return run.fail(&e);
    }
    if !branch_point.is_empty() {
        if mode != Mode::Fork || !valid_key(branch_point) {
            return run.fail("分支节点格式或运行模式不正确");
        }
        match read_history(agent, key, cwd) {
            Ok(items) if items.iter().any(|m| m.role == "assistant" && m.branch_point.as_deref() == Some(branch_point)) => {},
            _ => return run.fail("无法在原会话中确认该回复的分支节点，请刷新记录后重试"),
        }
    }
    match agent {
        "claude" if !mode.checks_open() => run_claude(run, mode, key, cwd, text, images, branch_point, model, instructions),
        "claude" => match claude_open_sessions() {
            Ok(open) if open.iter().any(|s| s == key) => {
                // 终端里开着的会话只能投递文字，图片没有通道，明确报错而不是悄悄丢掉
                if !images.is_empty() {
                    return run.fail("这个会话开在终端里，没法附带图片；请在终端关掉它，或换成文字发送");
                }
                run_claude_terminal(run, key, cwd, text)
            }
            Ok(_) => run_claude(run, mode, key, cwd, text, images, branch_point, model, instructions),
            Err(e) => run.fail(&format!("无法确认这个会话是否还开在终端里（claude agents --json：{e}）")),
        },
        "codex" => match default_codex_bin_dir().and_then(|d| find_codex_exe(&d)) {
            Some(exe) => run_codex(run, mode, &exe, key, cwd, text, images, branch_point, model, instructions),
            None => run.fail("没找到 Codex Desktop 自带的 codex.exe"),
        },
        "zcode" => {
            // session/send 的附件格式还没对上，图片先明确拒绝，不悄悄丢
            if !images.is_empty() {
                return run.fail("ZCode 暂不支持在派活时附带图片");
            }
            run_zcode(run, mode, key, cwd, text, model, instructions)
        }
        other => run.fail(&format!("不认识的 agent：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机端到端：起一次 ZCode 派活，确认能拿到会话 id 与助手回复。
    /// 会消耗一次真实模型配额（约 24k input tokens），默认 ignore。
    #[test]
    #[ignore = "真实调用 ZCode 模型，设置 AGENTHUB_ZCODE_E2E=1 才跑"]
    fn zcode_dispatch_end_to_end() {
        if std::env::var("AGENTHUB_ZCODE_E2E").as_deref() != Ok("1") {
            return;
        }
        let cwd = std::env::temp_dir().join(format!("agenthub-zcode-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let (out_tx, out_rx) = mpsc::channel::<Value>();
        let (tx, rx) = mpsc::channel::<RunMsg>();
        let run = Run { out: out_tx, run_id: "e2e".into(), rx, tx };
        run_zcode(&run, Mode::Fresh, "", cwd.to_str().unwrap(), "只回复 OK1", "", "");
        let mut got_reply = false;
        let mut finished = String::new();
        while let Ok(msg) = out_rx.recv_timeout(Duration::from_secs(5)) {
            match msg.get("type").and_then(Value::as_str).unwrap_or("") {
                "run.message" => {
                    let text = msg.get("text").and_then(Value::as_str).unwrap_or("");
                    eprintln!("[msg] {text}");
                    if text.contains("OK1") {
                        got_reply = true;
                    }
                }
                "run.status" => {
                    let status = msg.get("status").and_then(Value::as_str).unwrap_or("");
                    eprintln!("[status] {status} {}", msg.get("error").and_then(Value::as_str).unwrap_or(""));
                    if status == "done" || status == "failed" {
                        finished = format!("{status}: {}", msg.get("error").and_then(Value::as_str).unwrap_or(""));
                        break;
                    }
                }
                other => eprintln!("[{other}] {msg}"),
            }
        }
        let _ = std::fs::remove_dir_all(&cwd);
        assert!(got_reply, "没有收到模型回复");
        assert!(finished.starts_with("done"), "运行没有正常结束：{finished}");
    }

    fn roots(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn selected_reply_branch_uses_native_boundary() {
        let args=claude_branch_args(Mode::Fork,"original","reply-uuid");
        assert!(args.windows(2).any(|p|p==["--resume-session-at","reply-uuid"]));
        assert!(args.iter().any(|p|p=="--fork-session"));
        let request:Value=serde_json::from_str(&codex_branch_request(2,Mode::Fork,"original","cwd","turn-one")).unwrap();
        assert_eq!(request["params"]["threadId"],"original");
        assert_eq!(request["params"]["lastTurnId"],"turn-one");
        let latest:Value=serde_json::from_str(&codex_branch_request(2,Mode::Fork,"original","cwd","")).unwrap();
        assert!(latest["params"].get("lastTurnId").is_none());
    }

    #[test]
    fn cwd_blacklist() {
        let r = roots(&["D:\\Work2"]);
        assert!(!cwd_allowed("D:\\Work2", &r), "禁止目录本身也不能跑");
        assert!(!cwd_allowed("D:\\Work2\\AgentHub", &r));
        assert!(!cwd_allowed("d:/work2/agenthub/", &r), "大小写和斜杠不敏感");
        assert!(!cwd_allowed("D:\\Work2\\x", &roots(&["d:/WORK2/"])));
        assert!(!cwd_allowed("\\\\?\\D:\\Work2\\a", &r), "长路径前缀同样命中");
        assert!(!cwd_allowed("D:\\a", &roots(&["D:\\"])), "整盘禁止时该盘都不能跑");
        assert!(!cwd_allowed("D:\\Work2\\..\\Secret", &r), ".. 拒绝");
        assert!(!cwd_allowed("", &r));
        assert!(cwd_allowed("D:\\Work2Other", &r), "前缀不能误判：隔壁目录不在禁止之列");
        assert!(cwd_allowed("D:\\Work2Other\\a", &r));
        assert!(cwd_allowed("D:\\Play", &r));
        assert!(cwd_allowed("E:\\any", &roots(&["D:\\"])));
        // 空名单 = 不限制（只挡空路径和 ..）
        assert!(cwd_allowed("D:\\Work2", &[]), "没配黑名单不限制目录");
        assert!(cwd_allowed("E:\\any\\where", &[]));
        assert!(cwd_allowed("D:\\Work2", &roots(&["", "  "])), "全空项等同没配");
        assert!(!cwd_allowed("D:\\a\\..\\b", &[]), "没配黑名单时 .. 仍然拒绝");
        assert!(!cwd_allowed("", &[]));
    }

    #[test]
    fn cwd_must_exist() {
        let dir = std::env::temp_dir().join(format!("agenthub-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(cwd_exists(dir.to_str().unwrap()).is_ok());
        assert!(cwd_exists(&format!("{}\\no-such-sub-dir", dir.display())).is_err());
        let missing = format!("{}\\nope", dir.display());
        let e = cwd_exists(&missing).unwrap_err();
        assert!(e.starts_with(&format!("项目目录不存在：{missing}")), "{e}");
        assert!(e.contains("检查盘符"), "给出可操作的提示：{e}");
        let _ = std::fs::remove_dir_all(dir);
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
        let r = roots(&["D:\\Play"]);
        assert!(precheck(Mode::Fresh, "", "D:\\Work2\\a", &r).is_ok(), "Fresh 不要求 key");
        assert!(precheck(Mode::Fresh, "bad key", "D:\\Work2\\a", &r).is_ok());
        assert!(precheck(Mode::Resume, "", "D:\\Work2\\a", &r).is_err());
        assert!(precheck(Mode::Fork, "a b", "D:\\Work2\\a", &r).is_err());
        assert!(precheck(Mode::Fork, "abc-1", "D:\\Work2\\a", &r).is_ok());
        for m in [Mode::Resume, Mode::Fork, Mode::Fresh] {
            let e = precheck(m, "abc", "D:\\Play\\x", &r).unwrap_err();
            assert!(e.starts_with("项目目录在禁止列表里"), "{e}");
            assert!(e.contains("D:\\Play"), "报错带上黑名单原文：{e}");
        }
    }

    #[test]
    fn precheck_tells_apart_why_cwd_is_bad() {
        // 三种失败各说各的，手机上能直接判断该改配置还是改路径
        let r = roots(&["D:\\Play"]);
        let empty = precheck(Mode::Fresh, "", "  ", &r).unwrap_err();
        assert!(empty.starts_with("项目目录为空"), "{empty}");

        let dotdot = precheck(Mode::Fresh, "", "D:\\Work2\\..\\Secret", &r).unwrap_err();
        assert!(dotdot.starts_with("项目目录不能包含 .."), "{dotdot}");

        let denied = precheck(Mode::Fresh, "", "D:\\Play\\demo", &r).unwrap_err();
        assert!(denied.starts_with("项目目录在禁止列表里"), "{denied}");
        assert!(denied.contains("D:\\Play\\demo") && denied.contains("禁止：D:\\Play"), "{denied}");
        assert!(denied.contains("删掉"), "给出解法：{denied}");

        // 没配黑名单时只有「空」和「..」两种失败
        assert!(precheck(Mode::Fresh, "", "D:\\Play", &[]).is_ok());
        assert!(check_cwd("E:\\Play", &[]).is_ok());
        assert_eq!(check_cwd("", &[]).unwrap_err(), CwdIssue::Empty);
        assert_eq!(check_cwd("E:\\a\\..\\b", &[]).unwrap_err(), CwdIssue::DotDot);
        assert_eq!(check_cwd("D:\\Play", &roots(&["D:\\Play"])).unwrap_err(), CwdIssue::Denied(roots(&["D:\\Play"])));
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
    fn role_args_ride_along_with_the_rest() {
        // 空角色不改变任何命令行：行为和没有角色时完全一致
        let mut none = claude_args(Mode::Fresh, "k1");
        let before = none.clone();
        claude_role_args(&mut none, "", "");
        assert_eq!(none, before);

        // 有角色：模型和系统提示追加在末尾，原有参数一个不少
        let mut with = claude_args(Mode::Fresh, "k1");
        claude_role_args(&mut with, "opus", "只改测试，不动实现");
        let tail = &with[with.len() - 4..];
        assert_eq!(tail, ["--model", "opus", "--append-system-prompt", "只改测试，不动实现"]);
        assert_eq!(&with[..before.len()], &before[..]);
    }

    #[test]
    fn codex_role_channel() {
        // 模型走进程级配置覆盖；上下文走首条消息，空上下文时一个字都不多加
        assert_eq!(codex_model_args(""), Vec::<String>::new());
        assert_eq!(codex_model_args("gpt-5-codex"), vec!["-c".to_string(), "model=\"gpt-5-codex\"".to_string()]);
        assert_eq!(codex_role_text("修一个 bug", ""), "修一个 bug");
        assert_eq!(codex_role_text("修一个 bug", "先写测试"), "先写测试\n\n---\n\n修一个 bug");
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
        let u: Value = serde_json::from_str(&claude_user_line("你好", &[])).unwrap();
        assert_eq!(u["message"]["content"], "你好");
        assert!(!claude_user_line("a\nb", &[]).contains('\n'), "单行 JSON");
    }

    #[test]
    fn claude_user_line_with_images() {
        let img = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let u: Value = serde_json::from_str(&claude_user_line("看图", &[img.clone()])).unwrap();
        let content = u["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2, "文字 + 一张图");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "iVBORw0KGgo=");
        // 只有图没有文字时不塞空 text block（Claude 会把它当成一条空消息）
        let only: Value = serde_json::from_str(&claude_user_line("", &[img.clone()])).unwrap();
        assert_eq!(only["message"]["content"].as_array().unwrap().len(), 1);
        // 不认识的格式直接忽略，退回纯文字
        let bad: Value = serde_json::from_str(&claude_user_line("x", &["data:text/plain;base64,QQ==".into()])).unwrap();
        assert_eq!(bad["message"]["content"], "x");
    }

    #[test]
    fn data_url_and_base64() {
        assert_eq!(split_data_url("data:image/jpeg;base64,/9j/"), Some(("image/jpeg", "/9j/")));
        assert_eq!(split_data_url("https://x/a.png"), None);
        assert_eq!(split_data_url("data:image/png,abc"), None, "没有 base64 标记");
        assert_eq!(split_data_url("data:image/svg+xml;base64,PHN2Zz4="), None, "只认四种位图格式");
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert!(base64_decode("aGk").is_none(), "长度不是 4 的倍数");
        assert!(base64_decode("a$k=").is_none(), "非法字符");
        // 1x1 PNG 真图能解出来
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        assert_eq!(base64_decode(png).unwrap().len(), 70);
    }

    #[test]
    fn codex_image_inputs_writes_files() {
        let dir = std::env::temp_dir().join("agenthub-images-test");
        let _ = std::fs::remove_dir_all(&dir);
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".to_string();
        let (items, files) = codex_image_inputs(&[png, "data:image/png;base64,@@@".into()], &dir, "r1");
        assert_eq!(items.len(), 1, "非法 base64 丢掉，不 panic");
        assert_eq!(items[0]["type"], "localImage");
        assert_eq!(files.len(), 1);
        let path = files[0].to_str().unwrap().to_string();
        assert!(path.ends_with("r1-0.png"), "{path}");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 70);
        drop(TempFiles(files));
        assert!(std::fs::metadata(&path).is_err(), "TempFiles 析构时删掉");
        let _ = std::fs::remove_dir_all(&dir);
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
    fn codex_user_input_questions() {
        let p = json!({"isBlocking":true,"itemId":"i1","threadId":"t1","turnId":"u1","questions":[{"header":"图标","id":"q1","question":"你想新建哪种图标？","options":[{"label":"应用图标","description":"桌面图标"}]}]});
        assert_eq!(codex_user_input("item/tool/requestUserInput", &p), Some(&p["questions"]));
        assert_eq!(codex_user_input("item/tool/requestUserInput", &json!({"questions":"x"})), None);
        assert_eq!(codex_user_input("item/commandExecution/requestApproval", &p), None);
    }

    #[test]
    fn codex_input_response_wraps_answers() {
        let a = json!({"q1": ["应用图标"], "bad": "not-array"});
        assert_eq!(codex_input_response(&a), json!({"answers":{"q1":{"answers":["应用图标"]}}}));
        assert_eq!(codex_input_response(&Value::Null), json!({"answers":{}}));
    }

    #[test]
    fn image_data_url_reads_local_files() {
        let d = tmpdir("img");
        let f = d.join("pic.png");
        std::fs::write(&f, [0x89, b'P', b'N', b'G']).unwrap();
        let url = image_data_url(f.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        assert!(image_data_url(d.join("nope.png").to_str().unwrap()).is_none());
        assert!(image_data_url(d.join("pic.txt").to_str().unwrap()).is_none(), "不认识的扩展名不读");
        let big = d.join("big.png");
        std::fs::write(&big, vec![0u8; (IMAGE_MAX_BYTES + 1) as usize]).unwrap();
        assert!(image_data_url(big.to_str().unwrap()).is_none(), "超过大小上限不读");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn codex_events_image_items() {
        let p = json!({"item":{"type":"imageGeneration","id":"i1","status":"completed","savedPath":"C:\\x\\a.png"}});
        assert_eq!(codex_event("item/completed", &p), Some(CodexEvent::Image("C:\\x\\a.png".into())));
        let failed = json!({"item":{"type":"imageGeneration","id":"i1","status":"failed","failure":{"type":"usageLimitExceeded","limitId":"l"}}});
        assert_eq!(codex_event("item/completed", &failed), None, "失败不报图片");
        let view = json!({"item":{"type":"imageView","id":"i2","path":"C:\\x\\b.png"}});
        assert_eq!(codex_event("item/completed", &view), Some(CodexEvent::Image("C:\\x\\b.png".into())));
    }

    #[test]
    fn user_input_answer_flow() {
        let (tx, rx) = mpsc::channel();
        let mut a = Approvals::default();
        a.add_input(&tx, "run", &json!([{"id":"q1","question":"哪种图标？"}]), json!(7));
        let sent = rx.try_recv().unwrap();
        assert_eq!(sent["tool"], "userInput");
        assert_eq!(sent["detail"], r#"[{"id":"q1","question":"哪种图标？"}]"#);
        let local = sent["localId"].as_u64().unwrap();
        a.created(local, "ap1".into(), &tx, "run");
        let p = a.answer("ap1", &json!({"q1":["应用图标"]})).unwrap();
        assert_eq!(p.key, json!(7));
        assert_eq!(p.method, USER_INPUT_METHOD);
        assert_eq!(codex_input_response(&p.input), json!({"answers":{"q1":{"answers":["应用图标"]}}}));
        // 答案找不到对应的 pending（已超时/已处理）：静默忽略
        assert!(a.answer("ap1", &json!({})).is_none());
        // decide 只作用于普通授权，不会误答提问
        a.add_input(&tx, "run", &json!([]), json!(8));
        let local = rx.try_recv().unwrap()["localId"].as_u64().unwrap();
        a.created(local, "ap2".into(), &tx, "run");
        assert!(a.decide("ap2", true).is_some(), "decide 仍按 allow 提交（服务端不会对 userInput 发纯 decide，这里只验证不 panic）");
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
        // WorkBuddy：projects 下逐个工作区找 {sessionId}.jsonl；key 不可信时直接拒绝
        let wb = d.join("wb-projects");
        std::fs::create_dir_all(wb.join("workspace-a")).unwrap();
        std::fs::write(wb.join("workspace-a").join("sess-1.jsonl"), "w").unwrap();
        assert!(find_workbuddy_transcript(&wb, "sess-1").unwrap().ends_with("sess-1.jsonl"));
        assert!(find_workbuddy_transcript(&wb, "missing").is_none());
        assert!(find_workbuddy_transcript(&wb, "..\\evil").is_none());
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
