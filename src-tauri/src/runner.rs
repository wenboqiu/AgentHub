//! 执行器：在电脑上接着跑 Claude Code / Codex 会话，把输出和授权请求交给 remote.rs 发给服务端。
//!
//! - Claude：`claude -p --resume <sid> --input-format stream-json --output-format stream-json
//!   --verbose --permission-prompt-tool stdio --permission-mode default`
//! - CodeBuddy / WorkBuddy：同上但**不带** `--permission-prompt-tool`（同源 CLI 2.x 不认该参数）
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
/// 等后台任务时，超过这么久没有任何新输出就按原行为结束
const BG_WAIT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CODEX_INTERRUPT_GRACE: Duration = Duration::from_secs(3);
const HISTORY_COUNT: usize = 50;
/// Codex rollout 整读的上限。图像生成技能会把成品图以 base64 整段写进行里（一行可达数 MB），
/// 按字节截尾会把几乎全部对话截掉、只余最后一条回复，所以这里必须整读而不是 4MB 窗口。
const CODEX_ROLLOUT_MAX: u64 = 512 * 1024 * 1024;
const TEXT_MAX: usize = 16000;
/// 「正在做什么」那行只显示尾巴：思考原文截到 200 字，也不往 WS 上传大段文字
const ACTIVITY_MAX: usize = 200;
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

/// 服务端随 `run.start` 下发的授权范围（能力 mandate-v1）。只有 `mandate.mode == "auto"` 才生效；
/// 没有这个字段、或不是 auto，行为与旧版完全一致（CLI 逐动作审批照旧）。
///
/// 目录声明不是安全隔离：真正的约束是 CLI 工具白名单与 Codex sandbox。
/// 这里绝不据此打开 `bypassPermissions` / `danger-full-access`，也不把 Codex 的 approvalPolicy 设成 never——
/// 白名单之外的动作仍会走审批，由服务端按冻结范围判定：范围内自动放行，范围外 / danger / unknown 交给人。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Mandate {
    /// 允许改的相对目录；空 = 整个工作目录
    pub paths: Vec<String>,
    pub net: bool,
    pub push: bool,
    pub scripts: bool,
    /// 允许的命令类（read / test / build / write）；空 = 全部
    pub commands: Vec<String>,
    /// 服务端显式给的工具白名单；非空时原样使用
    pub allowed_tools: Vec<String>,
}

impl Mandate {
    pub fn from_msg(msg: &Value) -> Option<Mandate> {
        let m = msg.get("mandate").filter(|m| m.is_object())?;
        if m.get("mode").and_then(|v| v.as_str()) != Some("auto") {
            return None;
        }
        let scope = m.get("scope").filter(|s| s.is_object())?;
        let flag = |k: &str| scope.get(k).and_then(|v| v.as_bool()) == Some(true);
        let list = |k: &str| -> Vec<String> {
            scope
                .get(k)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
                .unwrap_or_default()
        };
        Some(Mandate { paths: list("paths"), net: flag("net"), push: flag("push"), scripts: flag("scripts"), commands: list("commands"), allowed_tools: list("allowedTools") })
    }

    fn has_command(&self, class: &str) -> bool {
        self.commands.is_empty() || self.commands.iter().any(|c| c == class)
    }
}

/// 按范围生成 Claude 的 `--allowedTools` 白名单。故意保守：只放只读 / 测试 / 构建这类确定无害的，
/// 联网装包、跑脚本、推远端不进白名单——它们仍会走审批，由服务端按范围判（force push 之类 danger 照样交人）。
pub fn mandate_allowed_tools(m: &Mandate) -> Vec<String> {
    if !m.allowed_tools.is_empty() {
        return m.allowed_tools.clone();
    }
    let mut t: Vec<String> = Vec::new();
    let mut add = |items: &[&str]| t.extend(items.iter().map(|s| s.to_string()));
    if m.has_command("read") {
        add(&["Read", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"]);
    }
    if m.has_command("write") {
        // 声明了目录就只放行目录内的写：目录外的写仍会弹审批（服务端判越界）
        if m.paths.is_empty() {
            add(&["Edit", "Write", "MultiEdit", "NotebookEdit"]);
        } else {
            for p in &m.paths {
                for tool in ["Edit", "Write", "MultiEdit"] {
                    t.push(format!("{tool}({p}/**)"));
                }
            }
        }
    }
    let mut add = |items: &[&str]| t.extend(items.iter().map(|s| s.to_string()));
    if m.has_command("test") {
        add(&["Bash(npm test:*)", "Bash(npm run test:*)", "Bash(cargo test:*)", "Bash(go test:*)", "Bash(pytest:*)", "Bash(npx tsc --noEmit:*)"]);
    }
    if m.has_command("build") {
        add(&["Bash(npm run build:*)", "Bash(cargo build:*)", "Bash(cargo check:*)", "Bash(go build:*)"]);
    }
    if m.net {
        add(&["WebFetch", "WebSearch"]);
    }
    t
}

/// auto 档下收紧 Claude 的命令行：白名单内的动作 CLI 自己放行，不再逐条问。
/// 全目录可写时用 `acceptEdits`；声明了目录就保持 `default`，让目录外的写仍然走审批（acceptEdits 会放行整个工作目录）。
/// 永远不会产生 `bypassPermissions`。
pub fn claude_mandate_args(args: &mut Vec<String>, m: &Mandate) {
    if m.paths.is_empty() {
        if let Some(i) = args.iter().position(|a| a == "--permission-mode") {
            if args.get(i + 1).map(String::as_str) == Some("default") {
                args[i + 1] = "acceptEdits".into();
            }
        }
    }
    let tools = mandate_allowed_tools(m);
    if !tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(tools.join(","));
    }
}

/// Codex 的 turn/start 参数：无 mandate 时与旧版逐字一致（approvalPolicy 仍是 on-request）；
/// auto 档额外钉死 workspace-write 沙箱，`net` 对应 networkAccess。approvalPolicy 不用 never。
pub fn codex_turn_params(thread_id: &str, input: &[Value], mandate: Option<&Mandate>) -> Value {
    let mut p = json!({"threadId":thread_id,"input":input,"approvalPolicy":"on-request"});
    if let Some(m) = mandate {
        p["sandboxPolicy"] = json!({"type":"workspaceWrite","networkAccess":m.net});
    }
    p
}

/// claude 命令行参数。`permission_tool`：是否带 `--permission-prompt-tool stdio`——
/// 只有 Claude Code 支持该参数；CodeBuddy / WorkBuddy（同源 CLI）2.x 没有它，
/// 传了会直接 `error: unknown option` 退出（codebuddy 进程异常退出(1) 的根因）。
pub fn claude_args(mode: Mode, key: &str, permission_tool: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-p".into()];
    if mode != Mode::Fresh {
        a.push("--resume".into());
        a.push(key.into());
        if mode == Mode::Fork {
            a.push("--fork-session".into());
        }
    }
    let tail: &[&str] = if permission_tool {
        &[
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-prompt-tool", "stdio", "--permission-mode", "default",
        ]
    } else {
        &[
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "default",
        ]
    };
    a.extend(tail.iter().map(|s| s.to_string()));
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
pub fn claude_branch_args(mode: Mode, key: &str, point: &str, permission_tool: bool) -> Vec<String> {
    let mut args = claude_args(mode, key, permission_tool);
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

/// 一次运行消耗的 token：Claude 在 result.usage 里给，Codex 在 token_count 通知里给，
/// 两家字段名不同（snake_case / camelCase 都有），统一成这一份再发给服务端。
#[derive(Debug, Default, PartialEq, Clone)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    /// 命中缓存的输入（Claude 的 cache_read_input_tokens / Codex 的 cached_input_tokens）
    pub cached: u64,
    /// 思考过程产生的输出（Codex 的 reasoning_output_tokens）
    pub reasoning: u64,
    pub total: u64,
    /// 只有 Claude 给美元成本
    pub cost_usd: f64,
    /// 积分用量（ZCode / CodeBuddy 系）：事件里带了才填，没有就是 0
    pub credits: f64,
    /// 实测模型 id（Claude 的 result 事件自带 model；ZCode 从 state 变更捕获）——
    /// 随用量事件一起上报，比「角色配的模型」更真
    pub model: String,
}

impl Usage {
    pub fn to_json(&self) -> Value {
        let mut m = json!({"input": self.input, "output": self.output, "total": self.total});
        if self.cached > 0 {
            m["cached"] = json!(self.cached);
        }
        if self.reasoning > 0 {
            m["reasoning"] = json!(self.reasoning);
        }
        if self.cost_usd > 0.0 {
            m["costUsd"] = json!(self.cost_usd);
        }
        if self.credits > 0.0 {
            m["credits"] = json!(self.credits);
        }
        if !self.model.is_empty() {
            m["model"] = json!(self.model);
        }
        m
    }
}

fn number(v: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|k| v.get(*k))
        .and_then(|x| x.as_u64().or_else(|| x.as_f64().filter(|f| *f > 0.0).map(|f| f as u64)))
        .unwrap_or(0)
}

/// 积分用量：数值字段或字符串（"12.5"）都认；对不上就是 0
fn credits_of(v: &Value) -> f64 {
    ["credits", "creditsUsed", "creditUsage", "pointsUsed", "points"]
        .iter()
        .find_map(|k| v.get(*k))
        .and_then(|x| match x {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        })
        .filter(|f| *f > 0.0)
        .unwrap_or(0.0)
}

/// 认一份用量对象；连 input/output 都没有就当「不是用量」（有些事件的 usage 是空壳），
/// 但只有积分也算——积分制计费的通道可能不给 token 数。
fn usage_of(v: &Value) -> Option<Usage> {
    let input = number(v, &["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]);
    let output = number(v, &["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]);
    let credits = credits_of(v);
    if input == 0 && output == 0 && credits == 0.0 {
        return None;
    }
    let cached = number(v, &["cache_read_input_tokens", "cacheReadInputTokens", "cached_input_tokens", "cachedInputTokens", "cached"]);
    let reasoning = number(v, &["reasoning_output_tokens", "reasoningOutputTokens", "reasoning"]);
    let total = match number(v, &["total_tokens", "totalTokens", "total"]) {
        0 => input + output + cached,
        n => n,
    };
    Some(Usage { input, output, cached, reasoning, total, cost_usd: 0.0, credits, model: String::new() })
}

/// 从任意事件里找用量：先按已知协议位置逐个试，再在浅层里兜底搜一个像用量的对象。
pub fn usage_from(v: &Value) -> Option<Usage> {
    const PATHS: &[&[&str]] = &[
        &["usage"],
        &["total_token_usage"],
        &["totalTokenUsage"],
        &["tokenUsage"],
        &["token_usage"],
        &["info", "total_token_usage"],
        &["info", "totalTokenUsage"],
        &["lastTokenUsage"],
        &["info", "last_token_usage"],
        &["turn", "usage"],
        &["payload", "usage"],
        &["result", "usage"],
    ];
    let mut u = PATHS
        .iter()
        .find_map(|p| p.iter().try_fold(v, |acc, k| acc.get(*k)).and_then(usage_of))
        .or_else(|| deep_usage(v, 3))?;
    u.cost_usd = ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"]
        .iter()
        .find_map(|k| v.get(*k))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    Some(u)
}

fn deep_usage(v: &Value, depth: usize) -> Option<Usage> {
    if depth == 0 {
        return None;
    }
    match v {
        Value::Array(a) => a.iter().find_map(|x| deep_usage(x, depth - 1)),
        Value::Object(o) => usage_of(v).or_else(|| o.values().find_map(|x| deep_usage(x, depth - 1))),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
pub enum ClaudeMsg {
    Text(String),
    /// 模型自己的思考内容（extended thinking）：不进对话流，只当「正在做什么」的实时提示
    Thinking(String),
    Tool { name: String, summary: String },
    Approval { request_id: String, tool: String, detail: String, input: Value },
    Result { subtype: String, usage: Option<Usage>, model: String },
    /// 后台任务（异步 Agent / 后台 Bash）已启动，带任务 id
    BgStarted(String),
    /// 后台任务进入终态（completed/failed/stopped/killed），带任务 id
    BgDone(String),
    /// `system/background_tasks_changed`：当前仍在跑的后台任务全集（以它为准覆盖本地集合）
    BgSet(Vec<String>),
    /// result 行的 `queued_turn_count` > 0：CLI 还排着下一轮（比如后台通知），紧跟在 Result 前发出
    QueuedTurns,
}

/// user 行里的所有文本：message.content 是字符串、text 块、或 tool_result 的 content（字符串 / text 块数组）
fn user_line_texts(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match v.pointer("/message/content") {
        Some(Value::String(s)) => out.push(s.clone()),
        Some(Value::Array(items)) => {
            for it in items {
                match it.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                            out.push(t.to_string());
                        }
                    }
                    Some("tool_result") => match it.get("content") {
                        Some(Value::String(s)) => out.push(s.clone()),
                        Some(Value::Array(parts)) => {
                            for p in parts {
                                if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                                    out.push(t.to_string());
                                }
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// 取 `marker` 之后的一个 token（字母数字、`_`、`-`）
fn token_after(text: &str, marker: &str) -> Option<String> {
    let rest = text[text.find(marker)? + marker.len()..].trim_start();
    let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if id.is_empty() { None } else { Some(id) }
}

/// 一段文本里所有 `<tag>…</tag>` 的内容
fn tag_values<'a>(text: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(after[..j].trim());
        rest = &after[j + close.len()..];
    }
    out
}

fn bg_status_final(s: &str) -> bool {
    matches!(s.trim().to_lowercase().as_str(), "completed" | "failed" | "stopped" | "killed")
}

/// 从一行 user 消息里识别后台任务的启动 / 完成：
/// 启动 = 工具结果里的 `Async agent launched`（`agentId: xxx`）或 `running in background with ID: xxx`（`tool_use_result.agentId` / `backgroundTaskId` 也认）；
/// 完成 = `<task-notification>` 里 `<task-id>` + 终态 `<status>`（一条通知可带多个任务）。
fn parse_bg_user_line(v: &Value) -> Vec<ClaudeMsg> {
    let mut out = Vec::new();
    for text in user_line_texts(v) {
        if text.contains("<task-notification>") {
            // 按 <task-notification> 块拆开，每块各自取 task-id 与 status
            for block in text.split("<task-notification>").skip(1) {
                let block = block.split("</task-notification>").next().unwrap_or(block);
                let final_status = tag_values(block, "status").iter().any(|s| bg_status_final(s));
                if final_status {
                    for id in tag_values(block, "task-id") {
                        if !id.is_empty() {
                            out.push(ClaudeMsg::BgDone(id.to_string()));
                        }
                    }
                }
            }
        } else if text.starts_with("Async agent launched") {
            if let Some(id) = token_after(&text, "agentId:") {
                out.push(ClaudeMsg::BgStarted(id));
            }
        } else if let Some(id) = token_after(&text, "running in background with ID:") {
            out.push(ClaudeMsg::BgStarted(id));
        }
    }
    if out.is_empty() {
        // 结构化结果兜底（stdout 上是 tool_use_result，transcript 里是 toolUseResult）
        let r = v.get("tool_use_result").or_else(|| v.get("toolUseResult"));
        if let Some(r) = r {
            let async_agent = r.get("isAsync").and_then(|b| b.as_bool()) == Some(true) || r.get("status").and_then(|s| s.as_str()) == Some("async_launched");
            if async_agent {
                if let Some(id) = r.get("agentId").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                    out.push(ClaudeMsg::BgStarted(id.to_string()));
                }
            } else if let Some(id) = r.get("backgroundTaskId").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                out.push(ClaudeMsg::BgStarted(id.to_string()));
            }
        }
    }
    out
}

/// 后台任务集合是否允许结束本次运行（空 = 可以结束）
pub fn should_finish(pending: &std::collections::HashSet<String>) -> bool {
    pending.is_empty()
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
                        Some("thinking") => {
                            let t = it.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push(ClaudeMsg::Thinking(t.to_string()));
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
            // result 事件自带实测模型 id（比角色配的更真），随用量一起上报
            let model = v.get("model").and_then(Value::as_str).unwrap_or("").to_string();
            if v.get("queued_turn_count").and_then(Value::as_u64).unwrap_or(0) > 0 {
                out.push(ClaudeMsg::QueuedTurns);
            }
            out.push(ClaudeMsg::Result { subtype, usage: usage_from(&v), model });
        }
        Some("user") => out.extend(parse_bg_user_line(&v)),
        // 实测（Claude Code，2026-11）：后台任务的生命周期以 system 行输出——
        // task_started{task_id,is_backgrounded} → task_notification{task_id,status} → background_tasks_changed{tasks:[…]}；
        // 后台全部完成后 CLI 会自己开下一轮（result.origin.kind = "task-notification"），不需要我们补消息
        Some("system") => {
            let sub = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let id = v.get("task_id").and_then(|s| s.as_str()).unwrap_or("");
            match sub {
                "task_started" if !id.is_empty() && v.get("is_backgrounded").and_then(Value::as_bool) != Some(false) => {
                    out.push(ClaudeMsg::BgStarted(id.to_string()));
                }
                "background_tasks_changed" => {
                    let ids = v.get("tasks").and_then(|t| t.as_array()).map(|a| a.iter()
                        .filter_map(|t| t.get("task_id").and_then(|s| s.as_str()).map(str::to_string)).collect()).unwrap_or_default();
                    out.push(ClaudeMsg::BgSet(ids));
                }
                s if s.contains("task_notification") => {
                    let st = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    if !id.is_empty() && bg_status_final(st) {
                        out.push(ClaudeMsg::BgDone(id.to_string()));
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
    out
}

const PREVIEW_MAX: usize = 512 * 1024;
const PREVIEW_SKIP_DIRS: [&str; 4] = ["node_modules", ".git", "target", "dist"];

#[derive(Debug, PartialEq)]
pub struct Preview {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub truncated: bool,
}

/// 在 cwd 下递归找同名文件（跳过 node_modules / .git / target / dist），最多找 6 个就停
fn find_by_name(root: &Path, name: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        if out.len() > 5 {
            return;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            let n = e.file_name().to_string_lossy().to_string();
            if !PREVIEW_SKIP_DIRS.contains(&n.as_str()) {
                find_by_name(&p, name, out);
            }
        } else if ft.is_file() && e.file_name().to_string_lossy() == name {
            out.push(p);
        }
    }
}

/// 末尾这几个字节是不是一个被截断的多字节字符的前缀
fn utf8_incomplete_tail(tail: &[u8]) -> bool {
    match std::str::from_utf8(tail) {
        Ok(_) => false,
        Err(e) => e.error_len().is_none() && e.valid_up_to() == 0,
    }
}

/// 预览项目目录内的一个文本文件：路径必须落在 cwd 内，≤512KB，必须是 UTF-8
pub fn read_preview(cwd: &str, path: &str, denied: &[String]) -> Result<Preview, String> {
    let cwd = if cwd.trim().is_empty() { crate::workdir::ensure_default()? } else { cwd.to_string() };
    check_cwd(&cwd, denied).map_err(|_| "这个目录不允许预览".to_string())?;
    let path = path.trim();
    if path.is_empty() || path.contains('\0') {
        return Err("路径无效".into());
    }
    let root = std::fs::canonicalize(&cwd).map_err(|_| format!("项目目录不存在：{cwd}"))?;
    let given = Path::new(path);
    let mut target = if given.is_absolute() { given.to_path_buf() } else { Path::new(&cwd).join(given) };
    if !target.exists() && !path.contains('/') && !path.contains('\\') {
        let mut found = Vec::new();
        find_by_name(&root, path, &mut found);
        match found.len() {
            0 => return Err("找不到文件".into()),
            1 => target = found.remove(0),
            _ => {
                let names: Vec<String> = found
                    .iter()
                    .take(5)
                    .map(|p| p.strip_prefix(&root).unwrap_or(p).to_string_lossy().replace('\\', "/"))
                    .collect();
                return Err(format!("有多个同名文件：{}", names.join(", ")));
            }
        }
    }
    let real = std::fs::canonicalize(&target).map_err(|_| "找不到文件".to_string())?;
    if !real.starts_with(&root) {
        return Err("只能预览项目目录内的文件".into());
    }
    if !real.is_file() {
        return Err("不是普通文件".into());
    }
    let size = std::fs::metadata(&real).map_err(|e| format!("读取失败：{e}"))?.len();
    let mut buf = Vec::new();
    {
        use std::io::Read;
        let f = std::fs::File::open(&real).map_err(|e| format!("读取失败：{e}"))?;
        f.take(PREVIEW_MAX as u64).read_to_end(&mut buf).map_err(|e| format!("读取失败：{e}"))?;
    }
    let truncated = size > PREVIEW_MAX as u64;
    let text = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            // 截断可能切在多字节字符中间：回退到字符边界；真正的坏字节才算非文本
            let valid = e.utf8_error().valid_up_to();
            let bytes = e.into_bytes();
            if !(truncated && utf8_incomplete_tail(&bytes[valid..])) {
                return Err("不是文本文件".into());
            }
            String::from_utf8(bytes[..valid].to_vec()).map_err(|_| "不是文本文件".to_string())?
        }
    };
    if text.contains('\0') {
        return Err("不是文本文件".into());
    }
    let rel = real.strip_prefix(&root).unwrap_or(&real).to_string_lossy().replace('\\', "/");
    Ok(Preview { path: rel, text, size, truncated })
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

/// CodeBuddy / WorkBuddy（2.x）的 stream-json 权限回包。
///
/// 它们的 SDK 客户端只读 `response.allowed`（布尔）+ `updatedInput`：
/// 缺了 `allowed` 就按 `undefined ?? false` 处理，于是工具被拒、报错恰好是
/// `Permission denied by SDK`——和用户在 AgentHub 里点没点「允许」无关。
/// 这条回包格式和 Claude 的 `{"behavior":"allow"}` 不通用，别混用。
pub fn sdk_control_response(request_id: &str, allow: bool, input: &Value) -> String {
    let inner = if allow {
        json!({"allowed":true,"updatedInput":input})
    } else {
        json!({"allowed":false,"reason":"用户在 AgentHub 里拒绝了这次操作"})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":inner}}).to_string()
}

/// 按 CLI 家族挑回包格式：真 Claude 用 `behavior`，CodeBuddy 系用 `allowed`
pub fn permission_response(request_id: &str, allow: bool, input: &Value, sdk_style: bool) -> String {
    if sdk_style {
        sdk_control_response(request_id, allow, input)
    } else {
        claude_control_response(request_id, allow, input)
    }
}

/// 提问工具（Claude Code / CodeBuddy 同源）：也走 `can_use_tool`，但光 allow 不算数——
/// CLI 校验 `updatedInput.answers` 非空，缺了直接判错("allowed AskUserQuestion without answers")。
pub const ASK_TOOL: &str = "AskUserQuestion";

/// 工具入参里的 questions → 服务端和界面认的数组（id 用 `q_0`/`q_1`，和 CLI 自己的编号一致）
pub fn ask_questions(input: &Value) -> Value {
    let items = input.get("questions").and_then(|q| q.as_array()).cloned().unwrap_or_default();
    let out: Vec<Value> = items
        .iter()
        .enumerate()
        .filter_map(|(i, q)| {
            let question = q.get("question").and_then(|v| v.as_str())?.trim().to_string();
            if question.is_empty() {
                return None;
            }
            Some(json!({
                "id": format!("q_{i}"),
                "question": question,
                "header": q.get("header").and_then(|v| v.as_str()).unwrap_or(""),
                "options": q.get("options").cloned().unwrap_or_else(|| json!([])),
                "multiSelect": q.get("multiSelect").and_then(|v| v.as_bool()).unwrap_or(false),
            }))
        })
        .collect();
    Value::Array(out)
}

/// 界面选回来的 `{"q_0": ["A","B"]}` → CLI 要的 `{"题目原文": "A, B"}`。
/// 键必须换成题目原文，值必须是字符串（CLI 用 `requireAnswers` 卡：值不是字符串就抛错）；
/// 多选按英文逗号拼，一条都没选返回 None——空 answers 送过去照样被 CLI 判错。
pub fn ask_answers(input: &Value, answers: &Value) -> Option<Value> {
    let items = input.get("questions").and_then(|q| q.as_array())?;
    let picked = answers.as_object()?;
    let mut out = serde_json::Map::new();
    for (i, q) in items.iter().enumerate() {
        let question = q.get("question").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if question.is_empty() {
            continue;
        }
        let labels: Vec<String> = picked
            .get(&format!("q_{i}"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        if labels.is_empty() {
            continue;
        }
        out.insert(question, Value::String(labels.join(", ")));
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// 带答案的 allow：原工具入参 + answers，两种格式各自包装
pub fn ask_response(request_id: &str, input: &Value, answers: &Value, sdk_style: bool) -> String {
    let mut merged = input.clone();
    if let Value::Object(o) = &mut merged {
        o.insert("answers".into(), answers.clone());
    }
    if sdk_style {
        sdk_control_response(request_id, true, &merged)
    } else {
        claude_control_response(request_id, true, &merged)
    }
}

/// 拒绝 / 没选答案：带上能看懂的理由（CLI 会把 reason/message 原样当 tool_result 给模型）
pub fn ask_deny(request_id: &str, reason: &str, sdk_style: bool) -> String {
    let inner = if sdk_style {
        json!({"allowed":false,"reason":reason})
    } else {
        json!({"behavior":"deny","message":reason})
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
                // 新版 Codex 把扩展工具（图像生成等）都归到 type:"Extension"，按 kind 区分；
                // image_gen.generation 完成后 savedPath 是本机文件路径
                "Extension" => match item.get("kind").and_then(|k| k.as_str()) {
                    Some("image_gen.generation") => item.get("savedPath").and_then(|p| p.as_str()).filter(|_| item.get("failure").is_none()).map(|p| CodexEvent::Image(p.to_string())),
                    _ => None,
                },
                // 老版协议的图片事件，留着兼容旧 codex.exe
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

/// 运行中的一句话状态。Codex / ZCode 都是流式增量，片段拼起来后只把尾巴交给界面。
#[derive(Default)]
struct Live {
    kind: &'static str,
    buf: String,
}

impl Live {
    /// 追加一段增量，返回 (kind, 累积后的尾巴)
    fn push(&mut self, kind: &'static str, delta: &str) -> (&'static str, String) {
        if kind != self.kind {
            self.switch(kind);
        }
        self.buf.push_str(delta);
        if self.buf.chars().count() > ACTIVITY_MAX * 2 {
            self.buf = tail_chars(&self.buf, ACTIVITY_MAX);
        }
        (self.kind, tail_chars(&self.buf, ACTIVITY_MAX))
    }

    /// 换了种活动（开始调工具 / 开始写回复）就把累积清掉
    fn switch(&mut self, kind: &'static str) {
        self.kind = kind;
        self.buf.clear();
    }
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

/// Codex 的 item/started：告诉界面它开始了什么（命令、改文件、调 MCP、思考、写回复）。
/// 文字直接取协议的字段，不做改写。
pub fn codex_activity_started(params: &Value) -> Option<(&'static str, String)> {
    let item = params.get("item")?;
    Some(match item.get("type").and_then(|t| t.as_str())? {
        "commandExecution" => ("tool", item.get("command").and_then(command_text).unwrap_or_else(|| "命令".into())),
        "fileChange" => ("tool", "改文件".into()),
        "mcpToolCall" => {
            let server = item.get("server").and_then(|s| s.as_str()).unwrap_or("");
            let tool = item.get("tool").and_then(|t| t.as_str()).unwrap_or("MCP");
            ("tool", if server.is_empty() { tool.to_string() } else { format!("{server}/{tool}") })
        }
        "webSearch" => ("tool", "联网搜索".into()),
        "reasoning" => ("thinking", String::new()),
        "agentMessage" => ("text", String::new()),
        _ => return None,
    })
}

/// Codex 的流式增量：agentMessage 是正文，reasoning 的几种 delta 是思考内容
pub fn codex_activity_delta<'a>(method: &str, params: &'a Value) -> Option<(&'static str, &'a str)> {
    // 协议的流式通知有 `/delta` 也有 `summaryTextDelta` 这种写法
    if !method.to_ascii_lowercase().ends_with("delta") {
        return None;
    }
    if !method.contains("agentMessage") && !method.contains("reasoning") {
        return None;
    }
    let delta = params.get("delta").or_else(|| params.get("text"))?.as_str()?;
    Some((if method.contains("reasoning") { "thinking" } else { "text" }, delta))
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
            let text = read_tail(&p, CODEX_ROLLOUT_MAX).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("codex", &text, HISTORY_COUNT))
        }
        "zcode" => crate::zcode_exec::history(key, HISTORY_COUNT).ok_or("没找到这个会话的本地记录".into()),
        // WorkBuddy 只读不聊，但 transcript 里正文齐全：按 sessionId 在各工作区目录下找 {key}.jsonl
        "workbuddy" => {
            let p = find_workbuddy_transcript(&home.join(".workbuddy").join("projects"), key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 4 * 1024 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("workbuddy", &text, HISTORY_COUNT))
        }
        // CodeBuddy 是同族 CLI，transcript 格式一样，只是落在自己的 .codebuddy 目录
        "codebuddy" => {
            let p = find_workbuddy_transcript(&home.join(".codebuddy").join("projects"), key).ok_or("没找到这个会话的本地记录")?;
            let text = read_tail(&p, 4 * 1024 * 1024).map_err(|e| format!("读取失败：{e}"))?;
            Ok(crate::message_history::parse("codebuddy", &text, HISTORY_COUNT))
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

    /// 提问（Claude / CodeBuddy 的 AskUserQuestion）：和 Codex 的提问共用一张卡片，
    /// 但**保留原始工具入参**——答完要把它连 answers 一起回给 CLI，缺了就被判错。
    fn add_ask(&mut self, out: &Sender<Value>, run_id: &str, input: &Value, key: Value) {
        let questions = ask_questions(input);
        self.add(out, run_id, "userInput", &questions.to_string(), key, USER_INPUT_METHOD, input.clone());
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

    /// 取走待答的提问，**不动 `input`**：调用方要拿原始工具入参拼 updatedInput
    fn take_answer(&mut self, approval_id: &str) -> Option<Pending> {
        let local = self.by_local.iter().find(|(_, p)| p.approval_id.as_deref() == Some(approval_id) && p.method == USER_INPUT_METHOD).map(|(k, _)| *k);
        local.and_then(|l| self.by_local.remove(&l))
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
    /// 上一次上报的「正在做什么」：时间是节流用的，文字用来跳过重复内容
    activity: Mutex<(Instant, String)>,
    /// 服务端下发的授权范围（仅 auto 档）；None = 与旧版一致
    mandate: Option<Mandate>,
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

    /// 这次的 token 用量：界面在对话流末尾显示「输入 / 输出 / 缓存 / 花费」
    fn usage(&self, u: &Usage) {
        self.usage_model(u, "");
    }

    /// 带实测模型 id 的用量上报：模型为空时和 usage 等价
    fn usage_model(&self, u: &Usage, model: &str) {
        let mut v = u.to_json();
        if !model.is_empty() {
            v["model"] = json!(model);
        }
        let _ = self.out.send(json!({"type":"run.usage","runId":self.run_id,"usage":v}));
    }

    /// 运行中的一句话状态，文字全部来自 agent 自己（思考原文 / 工具调用），不在这里编。
    /// kind: thinking | tool | text；kind 为 idle 表示「这轮没有在说的话了」，界面回到中性提示。
    /// thinking 会高频更新，所以节流：200ms 内、或内容完全没变就跳过。
    fn activity(&self, kind: &str, text: &str) {
        let text: String = text.trim().chars().rev().take(ACTIVITY_MAX).collect::<Vec<_>>().into_iter().rev().collect();
        let text = text.trim().to_string();
        let key = format!("{kind}\u{1}{text}");
        let now = Instant::now();
        {
            let mut last = self.activity.lock().unwrap();
            if last.1 == key {
                return;
            }
            if kind != "tool" && kind != "idle" && now.duration_since(last.0) < Duration::from_millis(200) {
                return;
            }
            *last = (now, key);
        }
        let _ = self.out.send(json!({"type":"run.activity","runId":self.run_id,"kind":kind,"text":text}));
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

/// 与 claude 同协议（stream-json）的执行端：claude 直接跑 `claude`；
/// WorkBuddy 是应用自带 Electron 以 node 模式跑内置 CLI 脚本
pub struct ClaudeLikeCli {
    program: PathBuf,
    /// 插在真正参数前面的（如 CLI 脚本路径）
    prefix: Vec<String>,
    envs: Vec<(String, String)>,
    /// 是否带 `--permission-prompt-tool stdio`：真 Claude 才认，codebuddy 系传了就崩
    permission_prompt_tool: bool,
}

/// WorkBuddy CLI 定位。优先级：env `WORKBUDDY_CLI` 覆盖 > npm 完整版（`@tencent-ai/codebuddy-code`）>
/// 应用内置 lite-wb。优先 npm 完整版的原因：应用内置包结构性剔除 TUI，无法独立 `/login`，
/// 而 CLI 独立运行时用不了桌面端的加密凭据（解密密钥只走 sidecar socket 通道），必须有登录态。
pub fn workbuddy_cli() -> Option<ClaudeLikeCli> {
    // 1) 显式覆盖：指向任意 codebuddy CLI 入口（应用内置或 npm 版均可）
    if let Some(p) = std::env::var_os("WORKBUDDY_CLI") {
        let script = PathBuf::from(p);
        if script.is_file() {
            let mut envs = vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())];
            if needs_lite_bundle(&script) {
                // 应用内置只打包 lite-wb 一份 bundle，不设这个会去 require 不存在的 dist/codebuddy
                envs.push(("CODEBUDDY_FORCE_LITE_WB_BUNDLE".to_string(), "1".to_string()));
            }
            return Some(ClaudeLikeCli {
                program: workbuddy_electron(&script)?,
                prefix: vec![script.to_string_lossy().into_owned()],
                envs,
                permission_prompt_tool: false,
            });
        }
    }
    // 2) npm 完整版：有 TUI、可独立登录，宿主 Electron 当 node 跑（GUI 环境 PATH 无 node）
    if let Some(cli) = npm_codebuddy_cli() {
        return Some(cli);
    }
    // 3) 应用内置 lite-wb
    let script = workbuddy_script_default()?;
    Some(ClaudeLikeCli {
        program: workbuddy_electron(&script)?,
        prefix: vec![script.to_string_lossy().into_owned()],
        envs: vec![
            ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
            ("CODEBUDDY_FORCE_LITE_WB_BUNDLE".to_string(), "1".to_string()),
        ],
        permission_prompt_tool: false,
    })
}

/// 应用内置包只带 lite-wb bundle，需要强制；npm 完整版不用
fn needs_lite_bundle(script: &Path) -> bool {
    script.to_string_lossy().contains("app.asar.unpacked")
}

/// npm 安装的完整版 codebuddy 入口（node 脚本，无扩展名）。只认确定属于
/// @tencent-ai/codebuddy-code 的路径，避免误命中其它同名命令。
fn npm_codebuddy_script() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
        // npm -g 默认前缀 %APPDATA%\npm；--prefix 自定义时包落在 <prefix>\node_modules
        let mut v = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            v.push(PathBuf::from(appdata)
                .join("npm").join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin").join("codebuddy"));
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            v.push(home.join(".local").join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin").join("codebuddy"));
            v.push(home.join(".npm-global").join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin").join("codebuddy"));
        }
        v
    } else {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        vec![
            // npm --prefix ~/.local 的真实入口（bin/codebuddy 被本项目的包装脚本占用）
            home.join(".local/bin/codebuddy.real"),
            home.join(".local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"),
            // 常规 npm -g 位置
            home.join(".npm-global/bin/codebuddy"),
            PathBuf::from("/usr/local/bin/codebuddy"),
            PathBuf::from("/opt/homebrew/bin/codebuddy"),
        ]
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn npm_codebuddy_cli() -> Option<ClaudeLikeCli> {
    let electron = workbuddy_electron(&workbuddy_script_default()?)?;
    let script = npm_codebuddy_script()?;
    Some(ClaudeLikeCli {
        program: electron,
        prefix: vec![script.to_string_lossy().into_owned()],
        envs: vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())],
        permission_prompt_tool: false,
    })
}

fn workbuddy_script_default() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let p = PathBuf::from("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
        return p.is_file().then_some(p);
    }
    if cfg!(windows) {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(l).join("Programs").join("WorkBuddy"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(pf).join("WorkBuddy"));
        }
        roots.push(PathBuf::from("C:\\Program Files\\WorkBuddy"));
        // 装到 D 盘之类的自选位置时，固定路径都找不到；卸载注册表里有它的 exe 路径
        if let Some(r) = installed_dir_from_registry("WorkBuddy.exe") {
            roots.push(r);
        }
        return roots
            .into_iter()
            .map(|r| r.join("resources").join("app.asar.unpacked").join("cli").join("bin").join("codebuddy"))
            .find(|p| p.is_file());
    }
    None
}

/// Windows 桌面应用装在哪：从卸载注册表（HKCU / HKLM / WOW6432Node）的 DisplayIcon 里找以 `exe` 结尾的那条，
/// 返回它所在目录。安装时自选了别的盘（例如 `D:\Program Files\WorkBuddy`）只有这里有记录。
/// 用系统自带的 `reg query`，不为这一处加注册表依赖；只在探测时跑，几十毫秒。
#[cfg(windows)]
pub(crate) fn installed_dir_from_registry(exe: &str) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const HIVES: [&str; 3] = [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    HIVES.iter().find_map(|hive| {
        let out = std::process::Command::new("reg")
            .args(["query", hive, "/s", "/v", "DisplayIcon"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        registry_icon_dir(&String::from_utf8_lossy(&out.stdout), exe).filter(|d| d.join(exe).is_file())
    })
}

#[cfg(not(windows))]
pub(crate) fn installed_dir_from_registry(_exe: &str) -> Option<PathBuf> {
    None
}

/// 解析 `reg query … /v DisplayIcon` 的输出：取第一条以 `exe` 结尾（忽略大小写）的路径所在目录。
/// 值可能带引号、带 `,0` 图标序号。
fn registry_icon_dir(output: &str, exe: &str) -> Option<PathBuf> {
    let want = format!("\\{}", exe.to_ascii_lowercase());
    output.lines().find_map(|line| {
        let (_, value) = line.split_once("REG_SZ").or_else(|| line.split_once("REG_EXPAND_SZ"))?;
        let mut v = value.trim().trim_matches('"').to_string();
        if let Some((path, idx)) = v.rsplit_once(',') {
            if idx.trim().chars().all(|c| c.is_ascii_digit() || c == '-') {
                v = path.trim().trim_matches('"').to_string();
            }
        }
        if !v.to_ascii_lowercase().ends_with(&want) {
            return None;
        }
        PathBuf::from(v).parent().map(Path::to_path_buf)
    })
}

/// 从 CLI 脚本反推宿主 Electron：
/// macOS `<…>/Contents/Resources/app.asar.unpacked/…` 往上 5 级到 Contents，旁边 MacOS/Electron；
/// Windows `<安装根>/resources/app.asar.unpacked/…` 往上 5 级到安装根，旁边 WorkBuddy.exe
fn workbuddy_electron(script: &Path) -> Option<PathBuf> {
    let exe = if cfg!(target_os = "macos") {
        "MacOS/Electron"
    } else if cfg!(windows) {
        "WorkBuddy.exe"
    } else {
        return None;
    };
    script.ancestors().nth(5).map(|c| c.join(exe)).filter(|p| p.is_file())
}

/// CLI 默认绑 127.0.0.1 端口，桌面端开着会撞；env `WORKBUDDY_CLI_PORT` 可覆盖
fn workbuddy_cli_port() -> String {
    std::env::var("WORKBUDDY_CLI_PORT").unwrap_or_else(|_| "50991".into())
}

fn run_claude(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str) {
    run_claude_like(run, &ClaudeLikeCli { program: PathBuf::from("claude"), prefix: Vec::new(), envs: Vec::new(), permission_prompt_tool: true }, "claude", mode, key, cwd, text, images, branch_point, model, instructions, &[])
}

/// WorkBuddy 派活：协议与 claude 同构，仅两处退化——不支持 `--resume-session-at`
/// （分叉退化为从末尾分叉），模型目录不同（角色里的模型 id 需配 WorkBuddy 的）。
/// 登录态：应用内置 lite-wb 无 TUI 不能独立 /login，优先用 npm 完整版
/// （`npm i -g --prefix ~/.local @tencent-ai/codebuddy-code` 后在终端 `codebuddy` 里 /login 一次）。
fn run_workbuddy(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, images: &[String], _branch_point: &str, model: &str, instructions: &str) {
    match workbuddy_cli() {
        Some(cli) => {
            let extra = ["--port".to_string(), workbuddy_cli_port()];
            // branch_point 置空：codebuddy 不支持 --resume-session-at，分叉只能从末尾分
            run_claude_like(run, &cli, "workbuddy", mode, key, cwd, text, images, "", model, instructions, &extra)
        }
        None => run.fail("没找到 WorkBuddy 自带 CLI：请安装 WorkBuddy 桌面端，或设置环境变量 WORKBUDDY_CLI 指向其 cli/bin/codebuddy"),
    }
}

/// CodeBuddy CLI 入口（`@tencent-ai/codebuddy-code/bin/codebuddy`，node 脚本）。
/// 四种装法都认：env 覆盖 > npm 全局包 > WorkBuddy 自带 node 运行时里的包 > PATH 上各 prefix。
fn codebuddy_script() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CODEBUDDY_CLI") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = npm_codebuddy_script() {
        return Some(p);
    }
    if let Some(p) = workbuddy_node_codebuddy_script() {
        return Some(p);
    }
    // PATH 上的 `codebuddy` 只是 shim（sh / .cmd），跑不了 `node shim`，
    // 所以按 prefix 反查真实入口：<dir>\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin").join("codebuddy"))
        .find(|p| p.is_file())
}

/// WorkBuddy 桌面端自带的 node 运行时（`~/.workbuddy/binaries/node/versions/<版本>/`）里
/// 往往同层装着一份 @tencent-ai/codebuddy-code。这个目录只出现在 WorkBuddy 自己注入的
/// PATH 里，AgentHub GUI 进程看不到（开始菜单 / 自启启动拿不到），所以单独扫一遍；
/// 版本目录取字典序最大的。root 参数化是为了测试。
fn workbuddy_node_codebuddy_script_in(root: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.into_iter().rev()
        .map(|d| d.join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin").join("codebuddy"))
        .find(|p| p.is_file())
}

fn workbuddy_node_codebuddy_script() -> Option<PathBuf> {
    workbuddy_node_codebuddy_script_in(&crate::claude::home_dir()?.join(".workbuddy").join("binaries").join("node").join("versions"))
}

/// CodeBuddy CLI 是否装了：给执行器上报能力用，装了才会出现在角色的候选电脑里
pub fn codebuddy_installed() -> bool {
    codebuddy_script().is_some()
}

/// CodeBuddy CLI 定位：与 WorkBuddy 是同一份 CLI，只差装法——
/// CodeBuddy 走 npm 全局包（自带独立登录态），不依赖 WorkBuddy 桌面端，所以用系统 node 直接跑脚本。
/// 没有 node 时退回 WorkBuddy 自带 Electron 当 node（装了桌面端的机器总有）。
fn codebuddy_cli() -> Option<ClaudeLikeCli> {
    let script = codebuddy_script()?;
    let script_arg = script.to_string_lossy().into_owned();
    if let Some(node) = node_exe() {
        return Some(ClaudeLikeCli { program: node, prefix: vec![script_arg], envs: Vec::new(), permission_prompt_tool: false });
    }
    // 没有 node：WorkBuddy 的 Electron 也能当 node 用（只在其安装目录下有）
    let electron = workbuddy_electron(&script)?;
    Some(ClaudeLikeCli {
        program: electron,
        prefix: vec![script_arg],
        envs: vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())],
        permission_prompt_tool: false,
    })
}

/// 找 node 可执行文件：GUI 进程（从 Finder / 开始菜单启动）的 PATH 往往只有系统默认项，
/// 既没有 nvm / volta，也没有 homebrew 的 bin，所以 PATH 扫完还要看各平台默认安装位置。
pub(crate) fn node_exe() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CODEBUDDY_NODE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["node.exe", "node"] {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    let mut cands: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/opt/local/bin/node"] {
            cands.push(PathBuf::from(p));
        }
        if let Some(home) = crate::claude::home_dir() {
            // nvm / volta / fnm 的默认位置
            cands.extend(nvm_node_bins(&home));
            cands.push(home.join(".volta").join("bin").join("node"));
            cands.push(home.join(".local").join("bin").join("node"));
        }
    }
    if cfg!(windows) {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            cands.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
        }
        cands.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            cands.push(PathBuf::from(local).join("Programs").join("nodejs").join("node.exe"));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

/// GUI 启动（Finder / 开始菜单 / LaunchAgent / 开机自启）拿到的 PATH 往往只有系统默认目录：
/// mac 上常见 `/usr/bin:/bin:/usr/sbin:/sbin`，既没有 homebrew，也没有 nvm、volta、`~/.local/bin`。
/// 光靠 `node_exe()` 兜底只能救 CodeBuddy / ZCode；claude、codex 是直接按名字 exec 的，
/// PATH 里没有就既探测不到（`installed_agents`）也起不来（派活）。
/// 所以启动时把这些常见安装目录**追加**到 PATH 末尾：只补缺的、不插队，用户自己配的顺序不受影响。
pub fn widen_path() {
    let Some(current) = std::env::var_os("PATH") else { return };
    let extra = extra_path_dirs();
    if let Some(merged) = merge_path(&current, &extra) {
        std::env::set_var("PATH", merged);
    }
}

/// PATH 末尾要补的目录：只留真实存在的，免得往 PATH 里塞一堆不存在的路径
fn extra_path_dirs() -> Vec<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/local/bin", "/home/linuxbrew/.linuxbrew/bin"] {
            cands.push(PathBuf::from(p));
        }
        if let Some(home) = crate::claude::home_dir() {
            for rel in [".local/bin", ".volta/bin", ".asdf/shims", ".bun/bin", ".cargo/bin", ".npm-global/bin", ".deno/bin"] {
                cands.push(home.join(rel));
            }
            // nvm 不生成 shim，只能按版本目录补（新→旧，先命中的在 PATH 里更靠前）
            cands.extend(nvm_bin_dirs(&home));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            cands.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            cands.push(PathBuf::from(local).join("Programs").join("nodejs"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            cands.push(PathBuf::from(pf).join("nodejs"));
        }
        if let Some(home) = crate::claude::home_dir() {
            // WorkBuddy 的 npm 完整版默认就装在这下面（`--prefix ~/.local`）
            cands.push(home.join(".local").join("bin"));
            cands.push(home.join(".bun").join("bin"));
        }
    }
    cands.into_iter().filter(|d| d.is_dir()).collect()
}

/// 把 extra 追加到 current 末尾；已经在里面的跳过。一个都没加上就返回 None（别白改环境变量）。
fn merge_path(current: &std::ffi::OsStr, extra: &[PathBuf]) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(current).collect();
    let before = dirs.len();
    for e in extra {
        if !dirs.iter().any(|d| same_dir(d, e)) {
            dirs.push(e.clone());
        }
    }
    if dirs.len() == before {
        return None;
    }
    std::env::join_paths(&dirs).ok()
}

/// 路径相同判定：Windows 大小写不敏感、结尾的斜杠不算数
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

/// nvm 各版本的 bin 目录（新→旧），补 PATH 用
fn nvm_bin_dirs(home: &Path) -> Vec<PathBuf> {
    nvm_node_bins(home).into_iter().filter_map(|p| p.parent().map(Path::to_path_buf)).filter(|d| d.is_dir()).collect()
}

/// nvm 的 node 按版本号排目录：取最新装的那一版（`~/.nvm/versions/node/v22.x/bin/node`）
fn nvm_node_bins(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut vers: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    vers.sort();
    vers.reverse();
    vers.into_iter().map(|v| v.join("bin").join("node")).collect()
}

/// CodeBuddy 派活：协议与 claude 同构（同一份 codebuddy CLI 的 stream-json），
/// 退化点与 WorkBuddy 一致——不支持 `--resume-session-at`，分叉从末尾分。
fn run_codebuddy(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, images: &[String], _branch_point: &str, model: &str, instructions: &str) {
    match codebuddy_cli() {
        Some(cli) => {
            let extra = ["--port".to_string(), codebuddy_cli_port()];
            run_claude_like(run, &cli, "codebuddy", mode, key, cwd, text, images, "", model, instructions, &extra)
        }
        None => run.fail("没找到 CodeBuddy CLI：请先 npm i -g @tencent-ai/codebuddy-code，或设置 CODEBUDDY_CLI 指向其 bin/codebuddy"),
    }
}

/// CodeBuddy CLI 也绑本机端口：默认避开 WorkBuddy 用的 50991，env `CODEBUDDY_CLI_PORT` 可覆盖
fn codebuddy_cli_port() -> String {
    std::env::var("CODEBUDDY_CLI_PORT").unwrap_or_else(|_| "50992".into())
}

fn run_claude_like(run: &Run, cli: &ClaudeLikeCli, label: &str, mode: Mode, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str, extra_args: &[String]) {
    let mut cmd = Command::new(&cli.program);
    let mut args = cli.prefix.clone();
    args.extend(claude_branch_args(mode, key, branch_point, cli.permission_prompt_tool));
    if let (Some(m), "claude") = (&run.mandate, label) {
        claude_mandate_args(&mut args, m);
    }
    claude_role_args(&mut args, model, instructions);
    args.extend_from_slice(extra_args);
    cmd.args(args)
    .current_dir(cwd)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    for (k, v) in &cli.envs {
        cmd.env(k, v);
    }
    let mut child = match no_window(&mut cmd).spawn() {
        Ok(c) => c,
        Err(e) => return run.fail(&format!("启动 {label} 失败：{e}")),
    };
    let mut stdin = child.stdin.take();
    let tail = spawn_readers(&mut child, &run.tx);
    run.status("running", "");
    if !write_line(&mut stdin, &claude_user_line(text, images)) {
        kill_tree(&mut child);
        return run.fail("写入消息失败");
    }

    let start = Instant::now();
    // 没有 `--permission-prompt-tool stdio` 的 CLI（CodeBuddy / WorkBuddy）走 SDK 回包格式
    let sdk_style = !cli.permission_prompt_tool;
    let mut approvals = Approvals::default();
    let mut finish: Option<Finish> = None;
    let mut session_reported = mode == Mode::Resume;
    // 后台任务（异步 Agent / 后台 Bash）：只对 claude 系生效。收到 Result 时若还有没完成的，
    // 不关 stdin、不结束，等后台任务完成后 CLI 自动开下一轮的那次 Result。
    let mut pending_bg: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut bg_waiting = false; // 已收到一次 Result 但因后台任务未完成而继续等
    let mut queued_turns = false; // 本行 result 声明还有排队的下一轮
    let mut last_line = Instant::now();
    while finish.is_none() {
        if start.elapsed() > RUN_TIMEOUT {
            run.message("system", "运行超过 2 小时，已强制停止");
            finish = Some(Finish::Stopped);
            break;
        }
        match run.rx.recv_timeout(Duration::from_millis(500)) {
            Ok(RunMsg::Line(l)) => {
                last_line = Instant::now();
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
                        // 正文已经作为消息进对话流了，这里把「正在做什么」清掉，回到中性提示
                        ClaudeMsg::Text(_) => {
                            bg_waiting = false;
                            run.activity("idle", "")
                        }
                        ClaudeMsg::Thinking(t) => {
                            bg_waiting = false;
                            run.activity("thinking", &t)
                        }
                        ClaudeMsg::Tool { name, summary } => {
                            bg_waiting = false;
                            run.message("tool", &format!("{name} {summary}"));
                            run.activity("tool", &format!("{name} {summary}"));
                        }
                        ClaudeMsg::Approval { request_id, tool, detail, input } => {
                            // 提问走「用户输入」那张卡：光 allow 不带 answers，CLI 会直接判错
                            if tool == ASK_TOOL {
                                approvals.add_ask(&run.out, &run.run_id, &input, json!(request_id))
                            } else {
                                approvals.add(&run.out, &run.run_id, &tool, &detail, json!(request_id), "", input)
                            }
                        }
                        ClaudeMsg::Result { subtype, usage, model } => {
                            if let Some(u) = usage {
                                run.usage_model(&u, &model);
                            }
                            let queued = std::mem::take(&mut queued_turns);
                            if subtype == "success" && (!should_finish(&pending_bg) || queued) && stdin.is_some() {
                                bg_waiting = true;
                                run.activity("idle", &format!("等待后台任务完成（{} 个）", pending_bg.len()));
                            } else {
                                stdin = None; // 关闭 stdin，进程自己退出
                                finish = Some(if subtype == "success" { Finish::Done } else { Finish::Failed(format!("运行结束：{subtype}")) });
                            }
                        }
                        ClaudeMsg::BgStarted(id) => {
                            pending_bg.insert(id);
                        }
                        ClaudeMsg::BgDone(id) => {
                            pending_bg.remove(&id);
                        }
                        ClaudeMsg::BgSet(ids) => {
                            pending_bg = ids.into_iter().collect();
                        }
                        ClaudeMsg::QueuedTurns => queued_turns = true,
                    }
                }
            }
            Ok(RunMsg::Eof) => {
                let code = child.wait().ok().and_then(|s| s.code());
                finish = Some(Finish::Failed(format!("{label} 进程异常退出（{}）：{}", code.map_or("未知".into(), |c| c.to_string()), stderr_tail(&tail))));
            }
            Ok(RunMsg::Stop) => finish = Some(Finish::Stopped),
            Ok(RunMsg::Shutdown) => finish = Some(Finish::Silent),
            Ok(RunMsg::Created { local_id, approval_id }) => {
                if let Some((p, allow)) = approvals.created(local_id, approval_id, &run.out, &run.run_id) {
                    // 提前到的决定不可能带答案：提问按跳过处理，别把空 allow 送给 CLI 换一条报错
                    if p.method == USER_INPUT_METHOD {
                        answer_ask(&mut stdin, &p, None, sdk_style);
                    } else {
                        answer_claude(&mut stdin, &p, allow, sdk_style);
                    }
                }
            }
            Ok(RunMsg::Decide { approval_id, allow }) => {
                if let Some((p, allow)) = approvals.decide(&approval_id, allow) {
                    if p.method == USER_INPUT_METHOD {
                        answer_ask(&mut stdin, &p, None, sdk_style);
                    } else {
                        answer_claude(&mut stdin, &p, allow, sdk_style);
                    }
                }
            }
            // 提问的答案：原样拼进 updatedInput.answers（值必须是字符串）
            Ok(RunMsg::Answer { approval_id, answers }) => {
                if let Some(p) = approvals.take_answer(&approval_id) {
                    answer_ask(&mut stdin, &p, Some(&answers), sdk_style);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => finish = Some(Finish::Silent),
        }
        for p in approvals.expired(Instant::now(), &run.out, &run.run_id) {
            run.message("system", "授权等待超时，已拒绝");
            answer_claude(&mut stdin, &p, false, sdk_style);
        }
        if bg_waiting && finish.is_none() {
            let quiet = last_line.elapsed();
            if quiet > BG_WAIT_TIMEOUT {
                // 兜底：后台任务迟迟没有动静，按原行为结束
                run.message("system", "后台任务等待超时，已结束本次运行");
                stdin = None;
                finish = Some(Finish::Done);
            }
        }
    }
    let f = finish.unwrap();
    let exited = matches!(&f, Finish::Failed(m) if m.starts_with(&format!("{label} 进程异常退出")));
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
fn run_claude_terminal(run: &Run, key: &str, endpoint: &crate::claude_live::Endpoint, cwd: &str, text: &str) {
    let prepare = || -> Result<_,String> {
        let path=crate::claude_live::transcript(key,cwd)?;
        let offset=std::fs::metadata(&path).map_err(|_|"无法读取原终端记录")?.len();
        Ok((path,offset))
    };
    let (path,mut offset)=match prepare(){Ok(v)=>v,Err(e)=>return run.fail(&e)};
    match run.rx.try_recv() {
        Ok(RunMsg::Stop)=>{run.status("stopped","");return;},
        Ok(RunMsg::Shutdown)=>return,
        _=>{}
    }
    if let Err(e)=crate::claude_live::send(endpoint,key,&run.run_id,text){return run.fail(&e);}
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

fn answer_claude(stdin: &mut Option<ChildStdin>, p: &Pending, allow: bool, sdk_style: bool) {
    let id = p.key.as_str().unwrap_or("");
    write_line(stdin, &permission_response(id, allow, &p.input, sdk_style));
}

/// 提问的答复：有答案就把 `updatedInput.answers` 一起回；一条都没选就拒——
/// CLI 的 `requireAnswers` 不接受空对象，硬送会把一条看得懂的拒绝变成一条看不懂的报错。
fn answer_ask(stdin: &mut Option<ChildStdin>, p: &Pending, answers: Option<&Value>, sdk_style: bool) {
    let id = p.key.as_str().unwrap_or("");
    let line = match answers.and_then(|a| ask_answers(&p.input, a)) {
        Some(a) => ask_response(id, &p.input, &a, sdk_style),
        None => ask_deny(id, "AgentHub 这边没拿到有效答案，这次提问按跳过处理", sdk_style),
    };
    write_line(stdin, &line);
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
    // 最近一次上报过的用量：Codex 的 token_count 会边跑边刷，值没变就不再发
    let mut last_usage: Option<Usage> = None;
    // 正在做什么：流式增量拼成一句话，只发尾巴
    let mut live = Live::default();
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
                                        codex_turn_params(&thread_id, &input, run.mandate.as_ref()),
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
                CodexIn::Notification { method, params } => {
                    // 用量：token_count 通知（累计值）与 turn/completed 里的 turn.usage，只发变化过的
                    if let Some(u) = usage_from(&params) {
                        if last_usage.as_ref() != Some(&u) {
                            run.usage(&u);
                            last_usage = Some(u);
                        }
                    }
                    // 正在做什么：开始一件新事 / 正在吐字，都按 agent 自己的说法显示
                    if method == "item/started" {
                        if let Some((kind, text)) = codex_activity_started(&params) {
                            live.switch(kind);
                            run.activity(kind, &text);
                        }
                    } else if let Some((kind, delta)) = codex_activity_delta(&method, &params) {
                        let (kind, text) = live.push(kind, delta);
                        run.activity(kind, &text);
                    }
                    let event = codex_event(&method, &params);
                    match event {
                        Some(CodexEvent::Agent(t)) => {
                            let source = params["item"]["id"].as_str().filter(|s| valid_key(s));
                            let point = if params["item"]["phase"] == "final_answer" { turn_id.as_deref() } else { None };
                            run.message_at(&t, source, point);
                            // 正文已经落到对话流里，状态行回到中性提示
                            run.activity("idle", "");
                        }
                        Some(CodexEvent::Command(c)) => {
                            run.message("tool", &format!("命令：{c}"));
                            run.activity("idle", "");
                        }
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
                    }
                }
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

/// ZCode 权限请求的自动放行档位（配置键 zcodeAutoApprove）：
/// off = 每条都弹审批卡；low = 只放行 low；medium = low 与 medium 都放行。
/// riskLevel 缺失、写错或比档位高（high / critical）一律交给人——机器猜的风险不算数。
fn zcode_auto_allows(policy: &str, risk: &str) -> bool {
    let rank = |r: &str| match r {
        "low" => 1,
        "medium" => 2,
        "high" | "critical" => 3,
        _ => 0,
    };
    let cap = match policy {
        "low" => 1,
        "medium" => 2,
        _ => 0,
    };
    let r = rank(risk);
    cap > 0 && r > 0 && r <= cap
}

/// 迟到的重发在多久内还按同一个决定回
const ZCODE_PERM_REMEMBER: Duration = Duration::from_secs(120);

/// ZCode 的权限请求在没及时收到答复时会按退避（约 0 / 1 / 2 / 4 / 8 / 10 秒）重发：
/// `params.requestId` 相同，JSON-RPC 的 id 每次不同。逐条建卡，同一条命令就会弹出五六张、得一张张点。
/// 这里按请求把重发合并：等人决定期间的重发只记下 id；决定后同组所有 id 一起答复；
/// 刚决定过的请求又迟到重发一次，直接按同样的决定回。
#[derive(Default)]
struct ZcodePermDedup {
    /// 还在等人决定：组键 -> (首条请求的 id，之后重发来的 id)
    pending: HashMap<String, (Value, Vec<Value>)>,
    /// 刚决定过：组键 -> (决定，时间)
    decided: HashMap<String, (bool, Instant)>,
}

#[derive(Debug, PartialEq)]
enum ZcodePerm {
    /// 新请求：照常建审批卡
    New,
    /// 同一个请求的重发，已经有卡在等：只记下 id
    Merged,
    /// 刚决定过的请求又重发：直接按这个决定答复
    Answer(bool),
}

impl ZcodePermDedup {
    /// 组键：toolCallId 优先（同一次工具调用的重发一定相同；两次不同的调用即使命令一样也不同），
    /// 其次 requestId；都没有就按工具 + 入参（同一条命令）
    fn group(params: &Value, tool: &str, detail: &str) -> String {
        for k in ["toolCallId", "requestId"] {
            if let Some(s) = params.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return format!("{k}:{s}");
            }
        }
        format!("tool:{tool}\n{detail}")
    }

    fn arrive(&mut self, group: &str, id: &Value, now: Instant) -> ZcodePerm {
        self.decided.retain(|_, (_, at)| now.duration_since(*at) < ZCODE_PERM_REMEMBER);
        if let Some((allow, _)) = self.decided.get(group) {
            return ZcodePerm::Answer(*allow);
        }
        if let Some((_, extra)) = self.pending.get_mut(group) {
            extra.push(id.clone());
            return ZcodePerm::Merged;
        }
        self.pending.insert(group.to_string(), (id.clone(), Vec::new()));
        ZcodePerm::New
    }

    /// 首条请求（建卡的那条）有了决定：返回同组还没答复的重发 id，并记住这个决定
    fn resolve(&mut self, first: &Value, allow: bool, now: Instant) -> Vec<Value> {
        let Some(group) = self.pending.iter().find(|(_, (f, _))| f == first).map(|(g, _)| g.clone()) else {
            return Vec::new();
        };
        let (_, extra) = self.pending.remove(&group).unwrap_or_default();
        self.decided.insert(group, (allow, now));
        extra
    }
}

fn run_zcode(run: &Run, mode: Mode, key: &str, cwd: &str, text: &str, model: &str, instructions: &str, zcode_auto: &str) {
    if mode == Mode::Fork {
        return run.fail("ZCode 暂不支持按回复分叉：可以同目录新开会话，或直接在会话里继续聊");
    }
    let Some(install) = crate::zcode_exec::find_install() else {
        return run.fail(if cfg!(target_os = "macos") {
            "没找到 ZCode 安装目录（默认 /Applications/ZCode.app）"
        } else {
            "没找到 ZCode 安装目录（默认 C:\\Program Files\\ZCode）"
        });
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
    let mut perms = ZcodePermDedup::default();
    let mut session_id = key.to_string();
    let mut created = false;
    let mut stop_deadline: Option<Instant> = None;
    let mut finish: Option<Finish> = None;
    let mut project_token: Option<(String, String)> = None;
    let mut reply = String::new();
    // 会话实测模型：state.updated 捕获，随用量事件上报（没有就是空）
    let mut model_seen = String::new();
    // 正在做什么：model.streaming 的增量拼成一句话
    let mut live = Live::default();
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
                                    let kind = p.pointer("/payload/kind").and_then(Value::as_str).unwrap_or("");
                                    let delta = p.pointer("/payload/delta").and_then(Value::as_str);
                                    match kind {
                                        "text_delta" => {
                                            if let Some(d) = delta {
                                                reply.push_str(d);
                                                // 正在写的正文尾巴，直接当状态显示（agent 自己的话）
                                                let (_, text) = live.push("text", d);
                                                run.activity("text", &text);
                                            }
                                        }
                                        // 思考 / 推理增量：字段名各版本不一，认 thinking / reasoning 两种
                                        k if k.contains("thinking") || k.contains("reasoning") => {
                                            if let Some(d) = delta {
                                                let (_, text) = live.push("thinking", d);
                                                run.activity("thinking", &text);
                                            }
                                        }
                                        _ => {}
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
                                        // 工具在跑就显示它，跑完（completed 等）回到中性提示
                                        if matches!(status, "running" | "started" | "pending" | "in_progress") {
                                            run.activity("tool", name);
                                        } else {
                                            run.activity("idle", "");
                                        }
                                    }
                                }
                                "turn.completed" => {
                                    // 有 token 统计就一起报（这套 CLI 不一定给，给了就显示）
                                    if let Some(u) = usage_from(p) {
                                        run.usage_model(&u, &model_seen);
                                    }
                                    let content = p
                                        .pointer("/payload/content")
                                        .and_then(Value::as_str)
                                        .filter(|s| !s.trim().is_empty())
                                        .map(str::to_string)
                                        .unwrap_or_else(|| reply.clone());
                                    if !content.trim().is_empty() {
                                        let source = p.get("turnId").and_then(Value::as_str).filter(|s| valid_key(s));
                                        run.message_at(&content, source, None);
                                        run.activity("idle", "");
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
                        // 会话配置变更：model 换了就记下来，用量上报时带上实测模型
                        "state.updated" => {
                            if v.pointer("/params/scope").and_then(Value::as_str) == Some("session") {
                                if let Some(m) = v.pointer("/params/patch/model").and_then(Value::as_str) {
                                    if !m.is_empty() {
                                        model_seen = m.to_string();
                                    }
                                }
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
                                if let Some(u) = usage_from(&v["params"]) {
                                    run.usage_model(&u, &model_seen);
                                }
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
                            // 低风险快车道：ZCode 自己标的 riskLevel 在档位内就直接放，不弹卡打断人
                            let risk = v.pointer("/params/riskLevel").and_then(Value::as_str).unwrap_or("");
                            if zcode_auto_allows(zcode_auto, risk) {
                                let head = format!("{tool} {}", detail.replace('\n', " "));
                                run.message("system", &format!("已自动放行（{risk} 风险）：{}", head.chars().take(160).collect::<String>()));
                                write_line(&mut stdin, &zcode_response(&id, zcode_decision(true)));
                            } else {
                                let group = ZcodePermDedup::group(v.get("params").unwrap_or(&Value::Null), &tool, &detail);
                                match perms.arrive(&group, &id, Instant::now()) {
                                    ZcodePerm::New => approvals.add(&run.out, &run.run_id, &tool, &detail, id, ZCODE_PERMISSION, Value::Null),
                                    ZcodePerm::Merged => {}
                                    ZcodePerm::Answer(allow) => {
                                        write_line(&mut stdin, &zcode_response(&id, zcode_decision(allow)));
                                    }
                                }
                            }
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
                    for id in std::iter::once(p.key.clone()).chain(perms.resolve(&p.key, allow, Instant::now())) {
                        write_line(&mut stdin, &zcode_response(&id, zcode_decision(allow)));
                    }
                }
            }
            Ok(RunMsg::Decide { approval_id, allow }) => {
                if let Some((p, allow)) = approvals.decide(&approval_id, allow) {
                    // 同一个请求重发来的那几次一起答复
                    for id in std::iter::once(p.key.clone()).chain(perms.resolve(&p.key, allow, Instant::now())) {
                        write_line(&mut stdin, &zcode_response(&id, zcode_decision(allow)));
                    }
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
            for id in std::iter::once(p.key.clone()).chain(perms.resolve(&p.key, false, Instant::now())) {
                write_line(&mut stdin, &zcode_response(&id, zcode_decision(false)));
            }
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
                self.start(s("runId"), s("sessionId"), s("agent"), s("sessionKey"), s("cwd"), s("text"), images, s("mode"), s("branchPoint"), s("model"), s("instructions"), Mandate::from_msg(msg));
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
            Some("file.request") => {
                let (out, request_id, cwd, path) = (self.out.clone(), s("requestId"), s("cwd"), s("path"));
                let denied = self.config.read().unwrap().denied_roots.clone();
                std::thread::spawn(move || {
                    let m = match read_preview(&cwd, &path, &denied) {
                        Ok(p) => json!({"type":"file.result","requestId":request_id,"path":p.path,"text":p.text,"size":p.size,"truncated":p.truncated}),
                        Err(e) => json!({"type":"file.result","requestId":request_id,"error":e}),
                    };
                    let _ = out.send(m);
                });
            }
            _ => {}
        }
    }

    fn start(&self, run_id: String, session_id: String, agent: String, key: String, cwd: String, text: String, images: Vec<String>, mode: String, branch_point: String, model: String, instructions: String, mandate: Option<Mandate>) {
        let (tx, rx) = mpsc::channel();
        let run = Run { out: self.out.clone(), run_id: run_id.clone(), rx, tx: tx.clone(), activity: Mutex::new((Instant::now(), String::new())), mandate };
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
        let zcode_auto = self.config.read().unwrap().zcode_auto_approve.clone();
        let runs = self.runs.clone();
        std::thread::spawn(move || {
            execute(&run, &denied, &agent, &mode, &key, &cwd, &text, &images, &branch_point, &model, &instructions, &zcode_auto);
            runs.lock().unwrap().remove(&run.run_id);
        });
    }
}

/// 前置检查 + 按 agent 分派
fn execute(run: &Run, denied: &[String], agent: &str, mode: &str, key: &str, cwd: &str, text: &str, images: &[String], branch_point: &str, model: &str, instructions: &str, zcode_auto: &str) {
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
        // 「还开着吗」和「投递到哪」用同一次本机登记表读取判定，避免两次快照互相打架
        "claude" => match crate::claude_live::locate(key, cwd) {
            Ok(channels) if !channels.is_empty() => {
                // 终端里开着的会话只能投递文字，图片没有通道，明确报错而不是悄悄丢掉
                if !images.is_empty() {
                    return run.fail("这个会话开在终端里，没法附带图片；请在终端关掉它，或换成文字发送");
                }
                // 同一会话在多个终端里开着时，投给管道真的在监听的那个（关掉的终端不会读）
                let Some(ch) = channels.iter().find(|c| crate::claude_live::ready(&c.endpoint.socket)) else {
                    return run.fail("原终端的收件通道不可用，请确认终端仍然打开后重试");
                };
                let live_cwd = if ch.cwd.trim().is_empty() { cwd } else { ch.cwd.as_str() };
                run_claude_terminal(run, key, &ch.endpoint, live_cwd, text)
            }
            // 本机没有活着的持有者：可能真关了，也可能是后台任务或旧版 CLI 占着但没有收件通道
            Ok(_) => match claude_open_sessions() {
                Ok(open) if open.iter().any(|s| s == key) => run.fail(
                    "这个会话仍被 Claude 占着，但没有可用的本机收件通道（后台任务或过旧的 CLI）。请在原终端结束它后重试，或改用「复制会话」另起一份",
                ),
                Ok(_) => run_claude(run, mode, key, cwd, text, images, branch_point, model, instructions),
                Err(e) => run.fail(&format!("无法确认这个会话是否还开在终端里（claude agents --json：{e}）")),
            },
            Err(e) => run.fail(&e),
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
            run_zcode(run, mode, key, cwd, text, model, instructions, zcode_auto)
        }
        "workbuddy" => run_workbuddy(run, mode, key, cwd, text, images, branch_point, model, instructions),
        "codebuddy" => run_codebuddy(run, mode, key, cwd, text, images, branch_point, model, instructions),
        other => run.fail(&format!("不认识的 agent：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zcode_permission_retries_merge_into_one_card() {
        let t0 = Instant::now();
        let mut d = ZcodePermDedup::default();
        let params = json!({"requestId": "perm_1", "toolCallId": "call_1", "toolName": "Bash"});
        let g = ZcodePermDedup::group(&params, "Bash", "git diff");
        // ZCode 按退避重发：第一条建卡，后面几条只记 id
        assert_eq!(d.arrive(&g, &json!(101), t0), ZcodePerm::New);
        assert_eq!(d.arrive(&g, &json!(102), t0), ZcodePerm::Merged);
        assert_eq!(d.arrive(&g, &json!(103), t0), ZcodePerm::Merged);
        // 别的请求不受影响
        // 另一次调用（toolCallId 不同），即使命令一样也单独建卡
        let other = ZcodePermDedup::group(&json!({"requestId": "perm_2", "toolCallId": "call_2"}), "Bash", "git diff");
        assert_eq!(d.arrive(&other, &json!(201), t0), ZcodePerm::New);
        // 点一次允许：首条之外，重发的 102 / 103 一起答复
        assert_eq!(d.resolve(&json!(101), true, t0), vec![json!(102), json!(103)]);
        // 决定之后又迟到重发：直接按同样的决定回，不再建卡
        assert_eq!(d.arrive(&g, &json!(104), t0 + Duration::from_secs(5)), ZcodePerm::Answer(true));
        // 记忆过期后同一个 requestId 当新请求
        assert_eq!(d.arrive(&g, &json!(105), t0 + ZCODE_PERM_REMEMBER + Duration::from_secs(1)), ZcodePerm::New);
        // 重发时 requestId 变了也没关系，按 toolCallId 认
        assert_eq!(ZcodePermDedup::group(&json!({"requestId": "perm_9", "toolCallId": "call_1"}), "Bash", "x"), g);
        // 没有 requestId / toolCallId：按工具 + 入参合并
        assert_eq!(ZcodePermDedup::group(&json!({}), "Bash", "ls"), ZcodePermDedup::group(&Value::Null, "Bash", "ls"));
        assert_ne!(ZcodePermDedup::group(&json!({}), "Bash", "ls"), ZcodePermDedup::group(&json!({}), "Bash", "pwd"));
        // 不认识的首条 id：什么都不答
        assert!(d.resolve(&json!(999), false, t0).is_empty());
    }

    #[test]
    fn finds_install_dir_from_registry_display_icon() {
        // homelab 上的真实输出：WorkBuddy 装在 D 盘，固定路径都找不到
        let out = "\r\nHKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip\r\n    DisplayIcon    REG_SZ    C:\\Program Files\\7-Zip\\7zFM.exe\r\n\r\n\
HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BFD312E9-1019-4F57-9F44-F86246833B50\r\n    DisplayIcon    REG_SZ    D:\\Program Files\\WorkBuddy\\WorkBuddy.exe,0\r\n";
        assert_eq!(registry_icon_dir(out, "WorkBuddy.exe"), Some(PathBuf::from(r"D:\Program Files\WorkBuddy")));
        // 带引号、大小写不同也认
        let quoted = "    DisplayIcon    REG_SZ    \"E:\\Apps\\ZCode\\zcode.exe\",0\r\n";
        assert_eq!(registry_icon_dir(quoted, "ZCode.exe"), Some(PathBuf::from(r"E:\Apps\ZCode")));
        // 只是名字里带、不是以它结尾的不算
        assert_eq!(registry_icon_dir("    DisplayIcon    REG_SZ    C:\\x\\WorkBuddy.exe.bak\r\n", "WorkBuddy.exe"), None);
        assert_eq!(registry_icon_dir(out, "ZCode.exe"), None);
    }

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
        let run = Run { out: out_tx, run_id: "e2e".into(), rx, tx, activity: Mutex::new((Instant::now(), String::new())), mandate: None };
        run_zcode(&run, Mode::Fresh, "", cwd.to_str().unwrap(), "只回复 OK1", "", "", "low");
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
        let args=claude_branch_args(Mode::Fork,"original","reply-uuid",true);
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
        assert_eq!(claude_args(Mode::Resume, "k1", true), resume);
        let mut fork = vec!["-p", "--resume", "k1", "--fork-session"];
        fork.extend(tail);
        assert_eq!(claude_args(Mode::Fork, "k1", true), fork);
        let mut fresh = vec!["-p"];
        fresh.extend(tail);
        assert_eq!(claude_args(Mode::Fresh, "k1", true), fresh);
    }

    #[test]
    fn mandate_parses_only_for_auto_and_keeps_old_args_without_it() {
        // 没有 mandate / 不是 auto：不解析，Claude 与 Codex 的参数与旧版逐字一致
        assert_eq!(Mandate::from_msg(&json!({"type":"run.start"})), None);
        assert_eq!(Mandate::from_msg(&json!({"mandate":{"mode":"observe","scope":{"net":true}}})), None);
        assert_eq!(Mandate::from_msg(&json!({"mandate":{"mode":"auto"}})), None);
        let plain = claude_args(Mode::Fresh, "k1", true);
        assert!(plain.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert!(!plain.contains(&"--allowedTools".to_string()));
        let turn = codex_turn_params("t1", &[json!({"type":"text"})], None);
        assert_eq!(turn, json!({"threadId":"t1","input":[{"type":"text"}],"approvalPolicy":"on-request"}));
    }

    #[test]
    fn mandate_claude_args_accept_edits_and_allowlist() {
        let msg = json!({"mandate":{"id":1,"version":1,"mode":"auto","rulesetVersion":"x","scope":{"paths":[],"net":false,"push":false,"scripts":false,"commands":[],"allowedTools":[],"maxRuntimeMin":30}}});
        let m = Mandate::from_msg(&msg).expect("auto mandate");
        let mut args = claude_args(Mode::Fresh, "k1", true);
        let before = args.clone();
        claude_mandate_args(&mut args, &m);
        // 全目录可写：acceptEdits；其余原参数不动；永远不会出现 bypassPermissions
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("bypass") || a.contains("dangerously")), "{args:?}");
        assert!(args.contains(&"--permission-prompt-tool".to_string()));
        assert_eq!(args.len(), before.len() + 2);
        let tools = args[args.len() - 1].clone();
        assert_eq!(args[args.len() - 2], "--allowedTools");
        assert!(tools.contains("Read") && tools.contains("Edit") && tools.contains("Bash(npm test:*)"), "{tools}");
        // 联网 / 脚本 / 推远端没声明就不在白名单里；就算声明了，装包、脚本、push 也不进白名单（走服务端判）
        assert!(!tools.contains("WebFetch") && !tools.contains("git push") && !tools.contains("Bash(node:*)"), "{tools}");
        let net = Mandate { net: true, push: true, scripts: true, ..Mandate::default() };
        let t = mandate_allowed_tools(&net).join(",");
        assert!(t.contains("WebFetch") && !t.contains("git push") && !t.contains("Bash(node:*)"), "{t}");
    }

    #[test]
    fn mandate_with_paths_keeps_default_mode_and_scopes_writes() {
        let m = Mandate { paths: vec!["src".into()], ..Mandate::default() };
        let mut args = claude_args(Mode::Fresh, "k1", true);
        claude_mandate_args(&mut args, &m);
        // 声明了目录：不用 acceptEdits（它会放行整个工作目录），写只在目录内放行
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "default"]), "{args:?}");
        let tools = args[args.len() - 1].clone();
        assert!(tools.contains("Edit(src/**)") && !tools.split(',').any(|t| t == "Edit"), "{tools}");
        // 服务端显式给了白名单就原样使用
        let explicit = Mandate { allowed_tools: vec!["Read".into()], ..Mandate::default() };
        assert_eq!(mandate_allowed_tools(&explicit), vec!["Read".to_string()]);
    }

    #[test]
    fn mandate_codex_turn_keeps_sandbox_and_never_skips_approval() {
        let off = Mandate::default();
        let on = Mandate { net: true, ..Mandate::default() };
        let p = codex_turn_params("t1", &[], Some(&off));
        assert_eq!(p["approvalPolicy"], "on-request");
        assert_eq!(p["sandboxPolicy"], json!({"type":"workspaceWrite","networkAccess":false}));
        assert_eq!(codex_turn_params("t1", &[], Some(&on))["sandboxPolicy"]["networkAccess"], json!(true));
        // thread/start 仍是 workspace-write + on-request，不因 mandate 放开
        let r: Value = serde_json::from_str(&codex_thread_request(2, Mode::Fresh, "t1", "D:/x")).unwrap();
        assert_eq!(r["params"]["sandbox"], "workspace-write");
        assert_eq!(r["params"]["approvalPolicy"], "on-request");
    }

    #[test]
    fn codebuddy_args_omit_permission_prompt_tool() {
        // codebuddy 2.x 不认 `--permission-prompt-tool`，传了直接报错退出
        let a = claude_args(Mode::Resume, "k1", false);
        assert!(!a.contains(&"--permission-prompt-tool".to_string()), "{a:?}");
        assert!(a.windows(2).any(|p| p == ["--resume", "k1"]));
        assert!(a.contains(&"--permission-mode".to_string()) && a.contains(&"--input-format".to_string()));
        // true 时带（Claude 通道行为不变）
        assert!(claude_args(Mode::Fresh, "", true).contains(&"--permission-prompt-tool".to_string()));
    }

    #[test]
    fn workbuddy_cli_layout() {
        // 本机装了 WorkBuddy 才有意义：从 CLI 脚本反推宿主 Electron、node 模式；
        // 优先 npm 完整版（无 lite 强制），回退应用内置 lite-wb（必须强制）
        let script = PathBuf::from("/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
        if !script.is_file() { return; }
        let cli = workbuddy_cli().expect("装了 WorkBuddy 就应能定位 CLI");
        assert_eq!(cli.program, PathBuf::from("/Applications/WorkBuddy.app/Contents/MacOS/Electron"));
        assert!(cli.prefix.iter().any(|a| a.ends_with("codebuddy") || a.ends_with("codebuddy.real")));
        assert!(cli.envs.iter().any(|(k, v)| k == "ELECTRON_RUN_AS_NODE" && v == "1"));
        let is_app_builtin = cli.prefix.iter().any(|a| a.ends_with("cli/bin/codebuddy") && !a.ends_with("codebuddy.real"));
        assert_eq!(is_app_builtin, cli.envs.iter().any(|(k, v)| k == "CODEBUDDY_FORCE_LITE_WB_BUNDLE" && v == "1"));
    }

    #[test]
    fn workbuddy_node_runtime_codebuddy_is_found_newest_first() {
        let base = std::env::temp_dir().join(format!("agenthub-cb-{}", std::process::id()));
        let entry = |v: &str| {
            let p = base.join(v).join("node_modules").join("@tencent-ai").join("codebuddy-code").join("bin");
            std::fs::create_dir_all(&p).unwrap();
            let f = p.join("codebuddy");
            std::fs::write(&f, "").unwrap();
            f
        };
        let old = entry("22.20.0");
        let new = entry("22.22.2-6");
        assert_eq!(workbuddy_node_codebuddy_script_in(&base).as_ref(), Some(&new), "取字典序最大的版本");
        std::fs::remove_file(&new).unwrap();
        assert_eq!(workbuddy_node_codebuddy_script_in(&base).as_ref(), Some(&old), "新版本没有包时回退旧版本");
        std::fs::remove_file(&old).unwrap();
        assert!(workbuddy_node_codebuddy_script_in(&base).is_none(), "都没有包时不误报");
        // 目录不存在也不 panic
        assert!(workbuddy_node_codebuddy_script_in(&base.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn codebuddy_cli_points_at_the_node_script() {
        // 本机装了 CodeBuddy CLI 才有意义
        let Some(script) = codebuddy_script() else { return };
        assert!(codebuddy_installed(), "找得到入口就算装了");
        assert!(script.ends_with(Path::new("bin").join("codebuddy")), "入口应该是包里的 node 脚本：{script:?}");
        let cli = codebuddy_cli().expect("有入口就该能拼出命令");
        // 脚本作为第一个参数；进程本身是 node，没有 node 时才退回 Electron（要带 node 模式开关）
        assert_eq!(cli.prefix, vec![script.to_string_lossy().into_owned()]);
        let uses_node = cli.envs.is_empty();
        assert!(uses_node || cli.envs.iter().any(|(k, v)| k == "ELECTRON_RUN_AS_NODE" && v == "1"));
    }

    #[test]
    fn widen_path_appends_without_reordering() {
        // 已有目录保持原顺序，缺的追加到末尾，重复的不再加一遍
        let sep = if cfg!(windows) { ';' } else { ':' };
        let base = format!("/usr/bin{sep}/bin");
        let extra = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/bin"), PathBuf::from("/usr/bin")];
        let merged = merge_path(std::ffi::OsStr::new(&base), &extra).expect("有新增就该返回新值");
        let got: Vec<String> = std::env::split_paths(&merged).map(|p| p.to_string_lossy().into_owned()).collect();
        assert_eq!(got, vec!["/usr/bin".to_string(), "/bin".to_string(), "/opt/homebrew/bin".to_string()]);
        // 都在里面了就不用改（返回 None，调用方不会白 set_var）
        let again = merge_path(&merged, &[PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/bin")]);
        assert!(again.is_none(), "没有新增时不该产生新 PATH");
        // Windows 上大小写不同的同一个目录算重复
        let dup = merge_path(std::ffi::OsStr::new(&base), &[PathBuf::from("/USR/BIN")]);
        if cfg!(windows) {
            assert!(dup.is_none(), "Windows 大小写不敏感，/USR/BIN 与 /usr/bin 应视为同一目录");
        }
    }

    #[test]
    fn widen_path_leaves_path_usable() {
        // 真实跑一遍：结果里原目录一个不少，且补进来的目录都真实存在
        let before: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        widen_path();
        let after: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        assert!(after.starts_with(&before), "原有条目必须原样保留在最前面：{before:?} -> {after:?}");
        assert!(after.iter().skip(before.len()).all(|d| d.is_dir()), "只补真实存在的目录");
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
        let mut none = claude_args(Mode::Fresh, "k1", true);
        let before = none.clone();
        claude_role_args(&mut none, "", "");
        assert_eq!(none, before);

        // 有角色：模型和系统提示追加在末尾，原有参数一个不少
        let mut with = claude_args(Mode::Fresh, "k1", true);
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
    fn claude_background_task_lines() {
        // Agent 异步启动：文本以 Async agent launched 开头，带 agentId
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Async agent launched successfully.\nagentId: a24d3b079594f4810 (internal ID)"}]}}"#;
        assert_eq!(parse_claude_line(line), vec![ClaudeMsg::BgStarted("a24d3b079594f4810".into())]);
        // 结构化结果兜底
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"abc123"}}"#;
        assert_eq!(parse_claude_line(line), vec![ClaudeMsg::BgStarted("abc123".into())]);
        // 后台 Bash
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"Command running in background with ID: bx9k2. Output is being written to: /tmp/x"}]}}"#;
        assert_eq!(parse_claude_line(line), vec![ClaudeMsg::BgStarted("bx9k2".into())]);
        // 完成通知：一条带两个任务，其中一个还在跑的不算
        let line = r#"{"type":"user","message":{"role":"user","content":"<task-notification><task-id>a1</task-id><status>completed</status></task-notification>\n<task-notification><task-id>a2</task-id><status>running</status></task-notification>\n<task-notification><task-id>a3</task-id><status>killed</status></task-notification>"}}"#;
        assert_eq!(parse_claude_line(line), vec![ClaudeMsg::BgDone("a1".into()), ClaudeMsg::BgDone("a3".into())]);
        // 普通 user 行不识别
        assert!(parse_claude_line(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#).is_empty());
        // system 形态
        assert_eq!(
            parse_claude_line(r#"{"type":"system","subtype":"task_notification","task_id":"z1","status":"completed"}"#),
            vec![ClaudeMsg::BgDone("z1".into())]
        );
    }

    #[test]
    fn pending_bg_decides_finish() {
        let mut p = std::collections::HashSet::new();
        assert!(should_finish(&p));
        p.insert("a".to_string());
        assert!(!should_finish(&p));
        p.remove("a");
        assert!(should_finish(&p));
    }

    /// 实测 claude -p stream-json 的后台任务行（2026-11，字段截短）
    #[test]
    fn claude_background_system_lines() {
        assert_eq!(parse_claude_line(r#"{"type":"system","subtype":"task_started","task_id":"b5pfo810k","is_backgrounded":true,"task_type":"local_bash"}"#),
            vec![ClaudeMsg::BgStarted("b5pfo810k".into())]);
        assert_eq!(parse_claude_line(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b5pfo810k","task_type":"local_bash"}]}"#),
            vec![ClaudeMsg::BgSet(vec!["b5pfo810k".into()])]);
        assert_eq!(parse_claude_line(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#), vec![ClaudeMsg::BgSet(vec![])]);
        assert_eq!(parse_claude_line(r#"{"type":"system","subtype":"task_notification","task_id":"b5pfo810k","status":"completed"}"#),
            vec![ClaudeMsg::BgDone("b5pfo810k".into())]);
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"success","queued_turn_count":1}"#),
            vec![ClaudeMsg::QueuedTurns, ClaudeMsg::Result { subtype: "success".into(), usage: None, model: String::new() }]);
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"success","queued_turn_count":0}"#),
            vec![ClaudeMsg::Result { subtype: "success".into(), usage: None, model: String::new() }]);
    }

    fn preview_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-preview-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_preview_rules() {
        let d = preview_dir("rules");
        let cwd = d.to_string_lossy().to_string();
        std::fs::create_dir_all(d.join("docs")).unwrap();
        std::fs::create_dir_all(d.join("a")).unwrap();
        std::fs::create_dir_all(d.join("b")).unwrap();
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        std::fs::write(d.join("docs/x.md"), "# hi").unwrap();
        std::fs::write(d.join("a/dup.ts"), "1").unwrap();
        std::fs::write(d.join("b/dup.ts"), "2").unwrap();
        std::fs::write(d.join("only.rs"), "fn main(){}").unwrap();
        std::fs::write(d.join("node_modules/skip.js"), "x").unwrap();
        std::fs::write(d.join("bin.dat"), [0xffu8, 0xfe, 0x00, 0x01]).unwrap();
        let outside = d.parent().unwrap().join(format!("ah-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();

        let p = read_preview(&cwd, "docs/x.md", &[]).unwrap();
        assert_eq!((p.path.as_str(), p.text.as_str(), p.truncated), ("docs/x.md", "# hi", false));
        // 裸文件名唯一
        assert_eq!(read_preview(&cwd, "only.rs", &[]).unwrap().path, "only.rs");
        let p = read_preview(&cwd, "x.md", &[]).unwrap();
        assert_eq!(p.path, "docs/x.md");
        // 多个同名
        let e = read_preview(&cwd, "dup.ts", &[]).unwrap_err();
        assert!(e.starts_with("有多个同名文件："), "{e}");
        assert!(e.contains("a/dup.ts") && e.contains("b/dup.ts"), "{e}");
        // 找不到 / 被跳过的目录
        assert_eq!(read_preview(&cwd, "nope.ts", &[]).unwrap_err(), "找不到文件");
        assert_eq!(read_preview(&cwd, "skip.js", &[]).unwrap_err(), "找不到文件");
        // 越界
        let e = read_preview(&cwd, &format!("../{}", outside.file_name().unwrap().to_string_lossy()), &[]).unwrap_err();
        assert_eq!(e, "只能预览项目目录内的文件");
        let e = read_preview(&cwd, &outside.to_string_lossy(), &[]).unwrap_err();
        assert_eq!(e, "只能预览项目目录内的文件");
        // 目录不是普通文件
        assert_eq!(read_preview(&cwd, "docs", &[]).unwrap_err(), "不是普通文件");
        // 非 UTF-8
        assert_eq!(read_preview(&cwd, "bin.dat", &[]).unwrap_err(), "不是文本文件");
        // 黑名单
        assert!(read_preview(&cwd, "only.rs", &[cwd.clone()]).is_err());
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_preview_truncates_at_char_boundary() {
        let d = preview_dir("trunc");
        let cwd = d.to_string_lossy().to_string();
        // 每个「中」3 字节；512KB 不是 3 的倍数，截断点必落在字符中间
        let big = "中".repeat(PREVIEW_MAX / 3 + 100);
        std::fs::write(d.join("big.txt"), &big).unwrap();
        let p = read_preview(&cwd, "big.txt", &[]).unwrap();
        assert!(p.truncated);
        assert_eq!(p.size as usize, big.len());
        assert!(p.text.len() <= PREVIEW_MAX && p.text.chars().all(|c| c == '中'));
        let _ = std::fs::remove_dir_all(&d);
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
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"success","session_id":"s"}"#), vec![ClaudeMsg::Result { subtype: "success".into(), usage: None, model: String::new() }]);
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"error_max_turns"}"#), vec![ClaudeMsg::Result { subtype: "error_max_turns".into(), usage: None, model: String::new() }]);
    }

    #[test]
    fn usage_from_claude_result() {
        let l = r#"{"type":"result","subtype":"success","total_cost_usd":0.0421,"duration_ms":9100,
          "usage":{"input_tokens":1200,"output_tokens":345,"cache_read_input_tokens":8000,"cache_creation_input_tokens":100}}"#;
        match &parse_claude_line(l)[..] {
            [ClaudeMsg::Result { usage: Some(u), .. }] => {
                assert_eq!((u.input, u.output, u.cached, u.total), (1200, 345, 8000, 9545));
                assert!((u.cost_usd - 0.0421).abs() < 1e-9);
                let j = u.to_json();
                assert_eq!(j["input"], 1200);
                assert_eq!(j["cached"], 8000);
                assert_eq!(j["costUsd"], 0.0421);
            }
            o => panic!("{o:?}"),
        }
        // 空 usage 不能当成「用了 0 个 token」
        assert_eq!(parse_claude_line(r#"{"type":"result","subtype":"success","usage":{}}"#), vec![ClaudeMsg::Result { subtype: "success".into(), usage: None, model: String::new() }]);
    }

    #[test]
    fn usage_from_result_carries_model_and_credits() {
        // Claude result 自带实测模型 id；用量对象里的积分（字符串或数字）都认
        let l = r#"{"type":"result","subtype":"success","model":"glm-5.3",
          "usage":{"input_tokens":100,"output_tokens":20,"credits":12.5}}"#;
        match &parse_claude_line(l)[..] {
            [ClaudeMsg::Result { usage: Some(u), model, .. }] => {
                assert_eq!(model, "glm-5.3");
                assert!((u.credits - 12.5).abs() < 1e-9);
                let j = u.to_json();
                assert_eq!(j["credits"], 12.5);
                // model 不在 to_json 里，由 run.usage_model 加到事件层
                assert!(j.get("model").is_none());
            }
            o => panic!("{o:?}"),
        }
        // 只有积分没有 token 也算有效用量（积分制通道）
        let u = usage_from(&serde_json::json!({"usage": {"credits": "3.2"}})).expect("credits-only usage");
        assert!((u.credits - 3.2).abs() < 1e-9);
        assert_eq!((u.input, u.output), (0, 0));
    }

    #[test]
    fn claude_thinking_block_is_activity_not_message() {
        let l = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先看 runner 怎么解析"},{"type":"text","text":"好了"}]}}"#;
        assert_eq!(
            parse_claude_line(l),
            vec![ClaudeMsg::Thinking("先看 runner 怎么解析".into()), ClaudeMsg::Text("好了".into())]
        );
        // 空思考块不进提示，免得状态行空转
        assert!(parse_claude_line(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"  "}]}}"#).is_empty());
    }

    #[test]
    fn codex_activity_from_item_events() {
        assert_eq!(codex_activity_started(&json!({"item":{"type":"commandExecution","command":"npm test"}})), Some(("tool", "npm test".to_string())));
        assert_eq!(codex_activity_started(&json!({"item":{"type":"reasoning"}})), Some(("thinking", String::new())));
        assert_eq!(codex_activity_started(&json!({"item":{"type":"mcpToolCall","server":"fs","tool":"read"}})), Some(("tool", "fs/read".to_string())));
        assert_eq!(codex_activity_started(&json!({"item":{"type":"unknown"}})), None);
        assert_eq!(codex_activity_delta("item/agentMessage/delta", &json!({"delta":"好了"})), Some(("text", "好了")));
        assert_eq!(codex_activity_delta("item/reasoning/summaryTextDelta", &json!({"delta":"想"})), Some(("thinking", "想")));
        // 别的通知不掺和
        assert_eq!(codex_activity_delta("turn/completed", &json!({"delta":"x"})), None);
        assert_eq!(codex_activity_delta("item/commandExecution/outputDelta", &json!({"delta":"x"})), None);
    }

    #[test]
    fn live_accumulates_and_keeps_tail() {
        let mut live = Live::default();
        assert_eq!(live.push("thinking", "第一段"), ("thinking", "第一段".to_string()));
        assert_eq!(live.push("thinking", "，第二段").1, "第一段，第二段");
        // 换了种活动就把上一段清掉，别把思考和工作命令拼在一起
        assert_eq!(live.push("tool", "Bash").1, "Bash");
        let long = "字".repeat(400);
        assert_eq!(live.push("text", &long).1.chars().count(), ACTIVITY_MAX);
    }

    #[test]
    fn usage_from_codex_token_count() {
        // rollout 风格（snake_case，累计值优先于单次值）
        let v = json!({"threadId":"t","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":700,"reasoning_output_tokens":120,"total_tokens":5700},"last_token_usage":{"input_tokens":100,"output_tokens":20},"model_context_window":200000}});
        let u = usage_from(&v).unwrap();
        assert_eq!((u.input, u.output, u.cached, u.reasoning, u.total), (5000, 700, 4000, 120, 5700));
        // app-server 风格（camelCase，嵌在 turn 里）
        let v = json!({"turn":{"usage":{"inputTokens":12,"outputTokens":34}}});
        let u = usage_from(&v).unwrap();
        assert_eq!((u.input, u.output, u.total), (12, 34, 46));
        // 没有用量的普通通知不能误判
        assert!(usage_from(&json!({"item":{"type":"agentMessage","text":"好了"}})).is_none());
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

    /// CodeBuddy / WorkBuddy 的 SDK 客户端只认 `allowed`；给 `behavior` 会被当成 false，
    /// 工具就以 "Permission denied by SDK" 被拒（实测复现过）。
    #[test]
    fn sdk_response_lines() {
        let allow: Value = serde_json::from_str(&sdk_control_response("perm_1", true, &json!({"a":1}))).unwrap();
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["request_id"], "perm_1");
        assert_eq!(allow["response"]["response"]["allowed"], true);
        assert_eq!(allow["response"]["response"]["updatedInput"]["a"], 1);
        assert!(allow["response"]["response"].get("behavior").is_none(), "不要混进 Claude 的字段");
        let deny: Value = serde_json::from_str(&sdk_control_response("perm_1", false, &json!({}))).unwrap();
        assert_eq!(deny["response"]["response"]["allowed"], false);
        assert!(deny["response"]["response"]["reason"].as_str().unwrap().len() > 0);
        // 分发：有 --permission-prompt-tool 的是真 Claude，没有的是 CodeBuddy 系
        assert_eq!(permission_response("r", true, &json!({}), false), claude_control_response("r", true, &json!({})));
        assert_eq!(permission_response("r", true, &json!({}), true), sdk_control_response("r", true, &json!({})));
    }

    /// 提问：入参 → 卡片用的 questions；选择 → CLI 要的 {"题目原文":"A, B"}。
    /// 键换成题目原文、值必须是字符串，是 CLI `requireAnswers` 的硬要求。
    #[test]
    fn ask_question_roundtrip() {
        let input = json!({"questions":[
            {"question":"选哪个目录？","header":"目录","options":[{"label":"src","description":"源码"},{"label":"docs"}],"multiSelect":false},
            {"question":"要跑测试吗？","options":[{"label":"要"},{"label":"不要"}],"multiSelect":true}
        ]});
        let qs = ask_questions(&input);
        assert_eq!(qs[0]["id"], "q_0");
        assert_eq!(qs[0]["question"], "选哪个目录？");
        assert_eq!(qs[1]["id"], "q_1");
        assert_eq!(qs[1]["multiSelect"], true);

        let a = ask_answers(&input, &json!({"q_0":["docs"],"q_1":["要","不要"]})).unwrap();
        assert_eq!(a["选哪个目录？"], "docs");
        assert_eq!(a["要跑测试吗？"], "要, 不要");
        assert!(ask_answers(&input, &json!({"q_0":[],"q_1":[]})).is_none(), "空答案不给 CLI，改为拒绝");
        assert!(ask_answers(&input, &json!({})).is_none());

        let line: Value = serde_json::from_str(&ask_response("perm_2", &input, &a, true)).unwrap();
        assert_eq!(line["response"]["response"]["allowed"], true);
        assert_eq!(line["response"]["response"]["updatedInput"]["answers"]["选哪个目录？"], "docs");
        assert_eq!(line["response"]["response"]["updatedInput"]["questions"].as_array().unwrap().len(), 2, "原入参不能丢");
        let deny: Value = serde_json::from_str(&ask_deny("perm_2", "没选", true)).unwrap();
        assert_eq!(deny["response"]["response"]["allowed"], false);
        assert_eq!(deny["response"]["response"]["reason"], "没选");
        let claude: Value = serde_json::from_str(&ask_response("r", &input, &a, false)).unwrap();
        assert_eq!(claude["response"]["response"]["behavior"], "allow");
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
        // 新版协议：图片生成是 Extension 事件
        let ext = json!({"item":{"type":"Extension","kind":"image_gen.generation","status":"completed","savedPath":"C:/tmp/a.png"}});
        assert_eq!(codex_event("item/completed", &ext), Some(CodexEvent::Image("C:/tmp/a.png".into())));
        // 失败的生成不算图片
        let mut failed = ext.clone(); failed["item"]["failure"] = json!("boom");
        assert_eq!(codex_event("item/completed", &failed), None);
        // 其它 Extension（web.search / clock.sleep）不是图片
        assert_eq!(codex_event("item/completed", &json!({"item":{"type":"Extension","kind":"web.search"}})), None);
        assert_eq!(codex_event("turn/started", &json!({"turn":{"id":"t9"}})), Some(CodexEvent::TurnStarted("t9".into())));
        assert_eq!(codex_event("turn/completed", &json!({"turn":{"id":"t9","status":"completed"}})), Some(CodexEvent::TurnDone { status: "completed".into() }));
        assert_eq!(codex_event("turn/completed", &json!({"turn":{"status":"interrupted"}})), Some(CodexEvent::TurnDone { status: "interrupted".into() }));
        assert_eq!(codex_event("thread/started", &json!({})), None);
    }

    #[test]
    fn zcode_auto_allows_by_risk_level() {
        assert!(zcode_auto_allows("low", "low"), "low 档放行 low");
        assert!(!zcode_auto_allows("low", "medium"), "low 档不放行 medium");
        assert!(zcode_auto_allows("medium", "low") && zcode_auto_allows("medium", "medium"), "medium 档放行 low/medium");
        assert!(!zcode_auto_allows("medium", "high"), "high 永远要人看");
        assert!(!zcode_auto_allows("medium", "critical"), "critical 永远要人看");
        // 没开（off / 空串 / 写错）时一条都不放
        for off in ["off", "", " Low", "everything"] {
            assert!(!zcode_auto_allows(off, "low"), "档位 {off:?} 不该放行任何东西");
        }
        // 风险值缺失或写错时也不放——机器猜的风险不算数
        for bad in ["", "unknown", "LOW", " high"] {
            assert!(!zcode_auto_allows("medium", bad), "风险值 {bad:?} 不该被自动放行");
        }
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
