//! ZCode 执行器的宿主侧配套：安装定位、Node 运行时、provider 凭证与 Project Token 换取。
//!
//! ZCode 的 CLI（`zcode.cjs`）不带 provider 账号状态，桌面端由 Host 负责三件事，
//! 裸跑时必须由 AgentHub 自己补上（见 docs/zcode-app-server.md）：
//! 1. 指向内置 provider 配置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`；
//! 2. `provider/updateAccountConfig` 下发账号权益（否则 registry 为空、选不到模型）；
//! 3. 响应 `interaction/requestProviderRuntimeHeaders`，注入 Project Access Token。
//!
//! 凭证只在内存里换、用完即弃，不写日志。

use crate::claude::home_dir;
use aes_gcm::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    Aes256Gcm,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// ZCode 安装目录里执行器需要的三样东西
pub struct Install {
    pub root: PathBuf,
    pub cjs: PathBuf,
    pub provider_config: PathBuf,
}

fn is_install(root: &Path) -> Option<Install> {
    let cjs = root.join("resources").join("glm").join("zcode.cjs");
    let provider_config = root.join("resources").join("config").join("provider").join("zcode-builtin.json");
    (cjs.is_file() && provider_config.is_file()).then(|| Install { root: root.to_path_buf(), cjs, provider_config })
}

/// 找 ZCode 安装目录：先看默认安装位置，再看 ProgramFiles 环境变量
pub fn find_install() -> Option<Install> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(pf).join("ZCode"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\ZCode"));
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(pf86).join("ZCode"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs").join("ZCode"));
    }
    roots.into_iter().find_map(|r| is_install(&r))
}

/// 跑 CLI 用的运行时：ZCode 自带 Electron，用 `ELECTRON_RUN_AS_NODE=1` 当 node 用，
/// 这样不依赖用户机器上装没装 Node。Electron 不在时退回系统 node。
pub enum Runtime {
    Electron(PathBuf),
    Node(PathBuf),
}

pub fn runtime(install: &Install) -> Runtime {
    let exe = install.root.join("ZCode.exe");
    if exe.is_file() {
        return Runtime::Electron(exe);
    }
    for cand in [
        std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("nodejs").join("node.exe")),
        Some(PathBuf::from(r"C:\Program Files\nodejs\node.exe")),
    ]
    .into_iter()
    .flatten()
    {
        if cand.is_file() {
            return Runtime::Node(cand);
        }
    }
    Runtime::Node(PathBuf::from("node"))
}

/// 给 `Command` 挂上运行 ZCode CLI 需要的环境
pub fn prepare_command(cmd: &mut Command, install: &Install, log_dir: &Path) {
    let _ = std::fs::create_dir_all(log_dir);
    cmd.env("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", &install.provider_config)
        .env("ZCODE_RUNTIME_ENV", "production")
        .env("ZCODE_LOG_DIR", log_dir)
        .env("NO_COLOR", "1");
}

/// 从 CLI 日志里读 `provider_registry.ready` 带的 configRevision（形如 `zcode-builtin:43:<sha>`）。
/// 这个值随 ZCode 版本变化，不能硬编码；拿不到时返回 None，调用方跳过 CAS 字段。
pub fn builtin_revision(log_dir: &Path) -> Option<String> {
    let mut roots: Vec<PathBuf> = vec![log_dir.to_path_buf()];
    // CLI 也可能写默认日志目录（ZCODE_LOG_DIR 不被认时）
    if let Some(home) = home_dir() {
        roots.push(home.join(".zcode").join("cli").join("log"));
    }
    roots.into_iter().find_map(|root| scan_dir(&root))
}

fn scan_dir(root: &Path) -> Option<String> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if let Some(rev) = scan_revision(&text) {
            if best.as_ref().is_none_or(|(t, _)| mtime >= *t) {
                best = Some((mtime, rev));
            }
        }
    }
    best.map(|(_, r)| r)
}

fn scan_revision(text: &str) -> Option<String> {
    for line in text.lines().rev() {
        if !line.contains("provider_registry.ready") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        // 字段在 context 下，值是 JSON 字符串：["zcode-builtin:43:<sha>","<account revision>"]
        for holder in [&v, &v["context"]] {
            let Some(raw) = holder.get("configRevision").and_then(Value::as_str) else { continue };
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) {
                if let Some(rev) = items.iter().find_map(Value::as_str).filter(|s| s.starts_with("zcode-builtin:")) {
                    return Some(rev.to_string());
                }
            }
            if raw.starts_with("zcode-builtin:") {
                return Some(raw.to_string());
            }
        }
    }
    None
}

/// 凭证文件里的敏感值是 `enc:v1:<iv>.<tag>.<ciphertext>`（base64url、aes-256-gcm），
/// 密钥是 sha256(secret)，secret 缺省由平台 + 用户名派生（与 ZCode 一致）。
fn decrypt_credential(value: &str) -> Option<String> {
    let Some(rest) = value.strip_prefix("enc:v1:") else { return Some(value.to_string()) };
    let mut parts = rest.split('.');
    let iv = parts.next()?;
    let tag = parts.next()?;
    let data = parts.next()?;
    let secret = std::env::var("ZCODE_CREDENTIAL_SECRET").unwrap_or_else(|_| {
        let home = home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
        let user = std::env::var("USERNAME").unwrap_or_default();
        format!("zcode-credential-fallback:win32:{home}:{user}")
    });
    let key = Sha256::digest(secret.as_bytes());
    let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
    let iv = URL_SAFE_NO_PAD.decode(iv).ok()?;
    let tag = URL_SAFE_NO_PAD.decode(tag).ok()?;
    let data = URL_SAFE_NO_PAD.decode(data).ok()?;
    let mut sealed = data;
    sealed.extend_from_slice(&tag);
    let plain = cipher.decrypt(GenericArray::from_slice(&iv), sealed.as_ref()).ok()?;
    String::from_utf8(plain).ok()
}

fn credentials() -> Option<Value> {
    let path = home_dir()?.join(".zcode").join("v2").join("credentials.json");
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// 当前登录的是哪家（bigmodel / zai），决定默认 provider id 与鉴权头形式
pub fn credential_family() -> String {
    credentials()
        .and_then(|c| c.get("oauth:active_provider").and_then(Value::as_str).map(str::to_string))
        .and_then(|v| decrypt_credential(&v))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "bigmodel".into())
}

pub fn default_provider_id() -> String {
    if credential_family() == "zai" {
        "account:zai-individual-coding-plan".into()
    } else {
        "account:bigmodel-individual-coding-plan".into()
    }
}

/// 角色的 model 文本 → (providerId, modelId)。
/// 支持 `providerId/modelId`，只写模型名时 provider 用账号默认。
pub fn model_selection(model: &str) -> (String, String) {
    let model = model.trim();
    if model.is_empty() {
        return (default_provider_id(), "GLM-5.3".into());
    }
    match model.split_once('/') {
        Some((p, m)) if p.starts_with("account:") && !m.is_empty() => (p.to_string(), m.to_string()),
        _ => (default_provider_id(), model.to_string()),
    }
}

/// Project Access Token 换取链（桌面 Host 的 ProjectAccessTokenClient 同款）：
/// OAuth access_token → getCustomerInfo → api_keys → access_tokens。返回 (apiKey, apiKeyId)。
pub fn project_token() -> Option<(String, String)> {
    let cred = credentials()?;
    let access = cred.get("oauth:bigmodel:access_token").or_else(|| cred.get("oauth:zai:access_token"))?;
    let token = decrypt_credential(access.as_str()?)?;
    if token.is_empty() {
        return None;
    }
    let family = credential_family();
    let origin = if family == "zai" { "https://z.ai" } else { "https://bigmodel.cn" };
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).build().ok()?;

    // 位置缓存：有些登录态里直接带了 organization/project/apiKey
    let mut location: Option<(String, String, Option<String>)> = None;
    for (k, v) in cred.as_object()? {
        if !k.starts_with("project-key-location:") {
            continue;
        }
        let Some(raw) = v.as_str().and_then(decrypt_credential) else { continue };
        let decoded = raw
            .strip_prefix("v1:")
            .and_then(|s| url_decode(s))
            .unwrap_or(raw);
        if let Ok(json) = serde_json::from_str::<Value>(&decoded) {
            let org = json.get("organizationId").and_then(Value::as_str);
            let proj = json.get("projectId").and_then(Value::as_str);
            let key = json.get("apiKeyId").and_then(Value::as_str).map(str::to_string);
            if let (Some(o), Some(p)) = (org, proj) {
                location = Some((o.to_string(), p.to_string(), key));
            }
        }
    }

    if location.is_none() {
        let body: Value = client
            .get(format!("{origin}/api/biz/customer/getCustomerInfo"))
            .header("Authorization", &token)
            .send()
            .ok()?
            .json()
            .ok()?;
        let data = body.get("data").unwrap_or(&body);
        let org = data.get("organizations")?.as_array()?.first()?;
        let proj = org.get("projects")?.as_array()?.first()?;
        location = Some((
            org.get("organizationId")?.as_str()?.to_string(),
            proj.get("projectId")?.as_str()?.to_string(),
            None,
        ));
    }
    let (org, proj, mut key_id) = location?;
    let auth = if family == "zai" { format!("Bearer {token}") } else { token.clone() };
    let key_list = format!(
        "{origin}/api/biz/v1/organization/{}/projects/{}/api_keys",
        url_encode(&org),
        url_encode(&proj)
    );

    if key_id.is_none() {
        let list: Value = client.get(&key_list).header("Authorization", &auth).send().ok()?.json().ok()?;
        let items = list.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        key_id = items
            .iter()
            .find(|k| k.get("name").and_then(Value::as_str) == Some("zcode-api-key"))
            .and_then(|k| k.get("apiKey").and_then(Value::as_str))
            .map(str::to_string);
        if key_id.is_none() {
            let created: Value = client
                .post(&key_list)
                .header("Authorization", &auth)
                .json(&serde_json::json!({"name":"zcode-api-key","usageScene":"coding_plan"}))
                .send()
                .ok()?
                .json()
                .ok()?;
            key_id = created
                .get("data")
                .and_then(|d| d.get("apiKey"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    let key_id = key_id?;
    let version = app_version().unwrap_or_else(|| "0.0.0".into());
    let resp: Value = client
        .post(format!("{key_list}/{}/access_tokens", url_encode(&key_id)))
        .header("Authorization", &auth)
        .json(&serde_json::json!({"clientType":"zcode","clientVersion":version}))
        .send()
        .ok()?
        .json()
        .ok()?;
    let data = resp.get("data").unwrap_or(&resp);
    let api_key = data
        .get("token")
        .or_else(|| data.get("accessToken"))
        .and_then(Value::as_str)?
        .to_string();
    Some((api_key, key_id))
}

/// 会话文件路径：`~/.zcode/v2/sessions/<工作区哈希>/sess_<uuid>.json`
pub fn session_file(id: &str) -> Option<PathBuf> {
    let root = home_dir()?.join(".zcode").join("v2").join("sessions");
    let want = format!("{id}.json");
    for ws in std::fs::read_dir(root).ok()?.flatten() {
        let p = ws.path().join(&want);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// 从会话文件读历史消息（ZCode 的会话是完整 JSON，messages 里带 role / content / timestamp）
pub fn history(id: &str, limit: usize) -> Option<Vec<crate::message_history::HistoryMessage>> {
    use chrono::TimeZone;
    let v: Value = serde_json::from_str(&std::fs::read_to_string(session_file(id)?).ok()?).ok()?;
    let mut out: Vec<crate::message_history::HistoryMessage> = Vec::new();
    for m in v.get("messages")?.as_array()? {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = m.get("content").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let at = m
            .get("timestamp")
            .and_then(Value::as_i64)
            .and_then(|ms| chrono::Local.timestamp_millis_opt(ms).single())
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, false));
        out.push(crate::message_history::HistoryMessage {
            role: role.to_string(),
            text: crate::runner::truncate_history_text(&text),
            source_id: None,
            branch_point: None,
            at,
        });
    }
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    Some(out)
}

fn app_version() -> Option<String> {
    let tex = std::fs::read_to_string(find_install()?.root.join("resources").join("app-update.yml")).ok()?;
    tex.lines()
        .find_map(|l| l.trim().strip_prefix("version:").map(|v| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn url_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_text_parses_provider_and_model() {
        let (p, m) = model_selection("account:zai-individual-coding-plan/GLM-5.3");
        assert_eq!(p, "account:zai-individual-coding-plan");
        assert_eq!(m, "GLM-5.3");
        let (_, m) = model_selection("GLM-5.3");
        assert_eq!(m, "GLM-5.3");
        let (_, m) = model_selection("  ");
        assert_eq!(m, "GLM-5.3");
    }

    #[test]
    fn plain_values_pass_through_decrypt() {
        assert_eq!(decrypt_credential("bigmodel").as_deref(), Some("bigmodel"));
        assert!(decrypt_credential("enc:v1:bad").is_none());
    }

    #[test]
    fn revision_is_read_from_registry_log() {
        let dir = std::env::temp_dir().join(format!("zc-rev-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("zcode-2026-11-05.jsonl");
        std::fs::write(
            &f,
            // 真实格式：configRevision 在 context 下，值是被字符串化的数组
            "{\"event\":\"zcode_protocol.provider_registry.ready\",\"context\":{\"configRevision\":\"[\\\"zcode-builtin:43:abc\\\",\\\"acc\\\"]\",\"providerCount\":0}}\n",
        )
        .unwrap();
        assert_eq!(builtin_revision(&dir).as_deref(), Some("zcode-builtin:43:abc"));
        std::fs::write(&f, "{\"event\":\"other\"}\n").unwrap();
        // 只断言单目录扫描（builtin_revision 还会兜底读本机真实日志目录）
        assert!(scan_dir(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_helpers_roundtrip() {
        assert_eq!(url_decode(&url_encode("a b/c:d")).as_deref(), Some("a b/c:d"));
    }
}
