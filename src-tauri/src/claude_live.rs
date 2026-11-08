//! Deliver to an existing Claude inbox. Never resume a second writer or type into a terminal.
use crate::{claude::home_dir, runner::{norm_path, valid_key}};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::{BufRead, BufReader, Seek, SeekFrom, Write}, path::{Path, PathBuf}, time::Duration};

// Intentionally no Debug/Serialize: the peer token must remain on this machine.
pub struct Endpoint { pub socket: String, token: String }

/// 原终端的本机收件通道，以及终端那边的真实工作目录（AgentHub 记的目录可能已经过时）
pub struct Channel { pub endpoint: Endpoint, pub cwd: String }

fn pipe_path(path: &str) -> bool {
    path.to_ascii_lowercase().starts_with(r"\\.\pipe\") && !path.contains(['\n','\r','\0'])
}

pub fn key_name(pid: u32, socket: &str) -> Result<String,String> {
    if pid == 0 || !pipe_path(socket) { return Err("原终端的本机收件地址无效".into()); }
    Ok(format!("{pid}.{:x}.key",Sha256::digest(socket.to_ascii_lowercase().as_bytes())))
}

/// 还活着的进程号。只信这一份快照，不给每个会话再跑一次 `claude agents --json`：
/// 两次调用的结果可能不同（会话正在切换状态），那正是旧版「无法唯一确认」的来源。
#[cfg(windows)]
fn live_pids() -> HashSet<u32> { crate::focus::win::snapshot().into_keys().collect() }
#[cfg(not(windows))]
fn live_pids() -> HashSet<u32> { HashSet::new() }

struct Holder { pid: u32, cwd: String, socket: String, updated: u64 }

/// `~/.claude/sessions/<pid>.json` 里登记、进程仍存活、且认这个会话的持有者。
/// 这些文件由 Claude Code 常驻更新，可能正写到一半：读不出来就下一轮重试，不当作「没有」。
fn holders_in(sessions: &Path, key: &str, alive: &HashSet<u32>) -> Vec<Holder> {
    let mut out=Vec::new();
    let Ok(rd)=std::fs::read_dir(sessions) else { return out };
    for entry in rd.flatten() {
        // 只认 `<pid>.json`；`<pid>.<hex>.key` 是认证文件，不是登记项
        let path=entry.path();
        let Some(stem)=path.file_name().and_then(|s|s.to_str()).and_then(|s|s.strip_suffix(".json")) else {continue};
        let Ok(pid)=stem.parse::<u32>() else {continue};
        if !alive.contains(&pid) { continue; }
        let Some(v)=std::fs::read_to_string(&path).ok().and_then(|s|serde_json::from_str::<Value>(&s).ok()) else {continue};
        if v["sessionId"].as_str()!=Some(key) || v["pid"].as_u64()!=Some(pid as u64) { continue; }
        if let Some(socket)=v["messagingSocketPath"].as_str().filter(|p|pipe_path(p)) {
            out.push(Holder{pid,cwd:v["cwd"].as_str().unwrap_or("").to_owned(),socket:socket.to_owned(),
                updated:v["updatedAt"].as_u64().unwrap_or(0)});
        }
    }
    out
}

fn channel_of(sessions: &Path, holder: Holder) -> Result<Channel,String> {
    let key_file=sessions.join(key_name(holder.pid,&holder.socket)?);
    if std::fs::symlink_metadata(&key_file).map_err(|_|"原终端的消息认证信息不可用")?.file_type().is_symlink() {
        return Err("原终端的消息认证文件不能是符号链接".into());
    }
    let auth:Value=serde_json::from_str(&std::fs::read_to_string(key_file).map_err(|_|"无法读取原终端的消息认证信息")?)
        .map_err(|_|"原终端的消息认证信息格式不正确")?;
    let token=auth["peerToken"].as_str().filter(|s|s.len()==32 && s.bytes().all(|b|b.is_ascii_hexdigit()))
        .ok_or("原终端的消息认证信息不完整")?.to_owned();
    Ok(Channel{endpoint:Endpoint{socket:holder.socket,token},cwd:holder.cwd})
}

/// 本机还认这个会话的收件通道，按「能用的可能性」排好序：目录一致优先，其次登记表最近更新的那个。
/// 空表示终端已经关了、可以 resume。会话 id 全球唯一，所以目录对不上不算错——
/// 终端可能在别的目录 resume 过，记录按终端那边的目录读即可。
pub fn locate_in(sessions: &Path, key: &str, cwd: &str, alive: &HashSet<u32>) -> Result<Vec<Channel>,String> {
    if !valid_key(key) { return Err("会话 id 格式不对".into()); }
    let mut all=Vec::new();
    for attempt in 0..3 {
        all=holders_in(sessions,key,alive);
        if !all.is_empty() { break; }
        if attempt<2 { std::thread::sleep(Duration::from_millis(60)); }
    }
    if all.is_empty() { return Ok(Vec::new()); }
    all.sort_by_key(|h| (norm_path(&h.cwd)!=norm_path(cwd), std::cmp::Reverse(h.updated)));
    let mut out=Vec::new();
    let mut first_err=None;
    for holder in all {
        match channel_of(sessions,holder) {
            Ok(ch)=>out.push(ch),
            Err(e)=>{ first_err.get_or_insert(e); }
        }
    }
    match (out.is_empty(), first_err) {
        (true, Some(e)) => Err(e),
        _ => Ok(out),
    }
}

pub fn locate(key: &str, cwd: &str) -> Result<Vec<Channel>,String> {
    let home=home_dir().ok_or("找不到用户目录")?;
    locate_in(&home.join(".claude").join("sessions"), key, cwd, &live_pids())
}

/// 这条命名管道现在有没有监听方。多终端持有同一会话时，用它挑出真正还在跑的那个。
pub fn ready(socket: &str) -> bool {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        if !pipe_path(socket) { return false; }
        let wide:Vec<u16>=std::ffi::OsStr::new(socket).encode_wide().chain(Some(0)).collect();
        unsafe { windows_sys::Win32::System::Pipes::WaitNamedPipeW(wide.as_ptr(),500)!=0 }
    }
    #[cfg(not(windows))] { let _=socket; false }
}

pub fn frames(token: &str, key: &str, message_id: &str, text: &str) -> String {
    format!("{}\n{}\n",json!({"type":"auth","token":token}),json!({"type":"user","session_id":key,
        "uuid":message_id,"msg_id":message_id,"from":"AgentHub","priority":"next","message":{"role":"user","content":text}}))
}

pub fn send(endpoint: &Endpoint, key: &str, message_id: &str, text: &str) -> Result<(),String> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        let wide:Vec<u16>=std::ffi::OsStr::new(&endpoint.socket).encode_wide().chain(Some(0)).collect();
        if unsafe { windows_sys::Win32::System::Pipes::WaitNamedPipeW(wide.as_ptr(),2000) }==0 {
            return Err("原终端收件通道不可用，请确认终端仍然打开后重试".into());
        }
        let mut pipe=std::fs::OpenOptions::new().write(true).open(&endpoint.socket)
            .map_err(|_|"无法连接原终端的本机收件通道")?;
        // After attempting a write, never retry automatically: it may already have arrived.
        pipe.write_all(frames(&endpoint.token,key,message_id,text).as_bytes())
            .map_err(|_|"原终端投递结果不确定，请先检查终端，避免重复发送".to_string())?;
        Ok(())
    }
    #[cfg(not(windows))] { let _=(endpoint,key,message_id,text); Err("原终端续聊目前仅支持 Windows".into()) }
}

/// Incremental complete JSONL rows only; leave an unfinished line for the next read.
pub fn read_rows(path: &Path, offset: &mut u64) -> Result<Vec<Value>,String> {
    let mut f=std::fs::File::open(path).map_err(|_|"无法读取原终端的对话记录")?;
    if f.metadata().map_err(|_|"无法读取原终端记录长度")?.len()<*offset { return Err("原终端记录已被替换，请刷新后重试".into()); }
    f.seek(SeekFrom::Start(*offset)).map_err(|_|"无法定位原终端记录")?;
    let mut reader=BufReader::new(f);let mut rows=Vec::new();let mut line=String::new();
    loop {
        line.clear();
        let bytes=reader.read_line(&mut line).map_err(|_|"读取原终端记录失败")?;
        if bytes==0 || !line.ends_with('\n') {break;}
        *offset+=bytes as u64;
        if let Ok(row)=serde_json::from_str(&line) {rows.push(row);}
    }
    Ok(rows)
}

pub fn transcript(key: &str,cwd: &str) -> Result<PathBuf,String> {
    crate::runner::find_claude_transcript(&home_dir().ok_or("找不到用户目录")?.join(".claude/projects"),cwd,key)
        .ok_or_else(||"找不到原终端的对话记录，请先在终端完成一轮对话".into())
}

pub enum Observed { Delivered, Reply {source:Option<String>,text:String,finished:bool}, OtherInput }
pub struct ObservedTurn {id:String,pub delivered:bool,seen:std::collections::HashSet<String>}
impl ObservedTurn {
    pub fn new(id:&str)->Self {Self{id:id.into(),delivered:false,seen:Default::default()}}
    pub fn consume(&mut self,row:&Value)->Vec<Observed> {
        if row["type"]=="user" && row["uuid"]==self.id {
            if self.delivered{return vec![];}
            self.delivered=true;return vec![Observed::Delivered];
        }
        if !self.delivered{return vec![];}
        // 只把「人打的字」当另一条输入：后台任务完成通知（task-notification）、
        // 别的会话发来的 peer 消息也是 user 行，它们出现不代表终端里有人在插话
        if row["type"]=="user" && row["isMeta"]!=true && row["parent_tool_use_id"].is_null()
            && crate::message_history::claude_human_input(row) {
            let is_tool=row["message"]["content"].as_array().is_some_and(|a|a.iter().any(|p|p["type"]=="tool_result"));
            if !is_tool{return vec![Observed::OtherInput];}
        }
        if row["type"]!="assistant" || !row["parent_tool_use_id"].is_null(){return vec![];}
        let source=row["uuid"].as_str().filter(|s|valid_key(s)).map(String::from);
        if source.as_ref().is_some_and(|s|!self.seen.insert(s.clone())){return vec![];}
        let text=row["message"]["content"].as_array().into_iter().flatten().filter(|p|p["type"]=="text")
            .filter_map(|p|p["text"].as_str()).collect::<Vec<_>>().join("\n");
        if text.trim().is_empty(){return vec![];}
        let finished=matches!(row["message"]["stop_reason"].as_str(),Some("end_turn"|"stop_sequence"));
        vec![Observed::Reply{source,text,finished}]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_keep_user_text_literal_and_identify_session() {
        let lines=frames("secret","sid","message-1","hello\n/compact\n\"quoted\"");
        let rows:Vec<Value>=lines.lines().map(|s|serde_json::from_str(s).unwrap()).collect();
        assert_eq!(rows.len(),2);assert_eq!(rows[0]["type"],"auth");
        assert_eq!(rows[1]["session_id"],"sid");assert_eq!(rows[1]["uuid"],"message-1");
        assert_eq!(rows[1]["message"]["content"],"hello\n/compact\n\"quoted\"");
        assert!(rows[1].get("permission_mode").is_none());
        assert!(key_name(1,"https://example.com").is_err());
        assert!(key_name(0,r"\\.\pipe\claude").is_err());
    }
    #[test]
    fn registry_must_match_live_pid_and_session() {
        let dir=std::env::temp_dir().join(format!("agenthub-live-discovery-{}",std::process::id()));
        let sessions=dir.join(".claude/sessions");std::fs::create_dir_all(&sessions).unwrap();
        let socket=r"\\.\pipe\claude-test-inbox";
        let alive:HashSet<u32>=[1].into_iter().collect();
        std::fs::write(sessions.join("1.json"),json!({"pid":1,"sessionId":"sid","cwd":"D:/project","messagingSocketPath":socket}).to_string()).unwrap();
        std::fs::write(sessions.join(key_name(1,socket).unwrap()),json!({"peerToken":"a".repeat(32)}).to_string()).unwrap();
        assert_eq!(locate_in(&sessions,"sid","D:/project",&alive).unwrap().len(),1);
        // 终端在别的目录 resume 过也要能投递：会话 id 唯一，按终端那边的目录读记录
        let ch=&locate_in(&sessions,"sid","D:/elsewhere",&alive).unwrap()[0];
        assert_eq!(ch.cwd,"D:/project");
        assert_eq!(ch.endpoint.socket,socket);
        assert!(locate_in(&sessions,"other","D:/project",&alive).unwrap().is_empty());
        // 进程已经退出：登记项不可信，当作终端已关闭，交给 resume
        assert!(locate_in(&sessions,"sid","D:/project",&HashSet::new()).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn several_holders_are_ranked_by_cwd_then_freshness() {
        let dir=std::env::temp_dir().join(format!("agenthub-live-shared-{}",std::process::id()));
        let sessions=dir.join(".claude/sessions");std::fs::create_dir_all(&sessions).unwrap();
        let alive:HashSet<u32>=[1,2,3].into_iter().collect();
        for (pid,cwd,socket,updated) in [
            (1,"D:/a",r"\\.\pipe\claude-a",100),
            (2,"D:/b",r"\\.\pipe\claude-b",200),
            (3,"D:/c",r"\\.\pipe\claude-c",300),
        ] {
            std::fs::write(sessions.join(format!("{pid}.json")),json!({"pid":pid,"sessionId":"sid","cwd":cwd,"messagingSocketPath":socket,"updatedAt":updated}).to_string()).unwrap();
            std::fs::write(sessions.join(key_name(pid,socket).unwrap()),json!({"peerToken":"b".repeat(32)}).to_string()).unwrap();
        }
        // 目录一致的那个排第一，其余按登记表最近更新排；投递方按这个顺序找真正在监听的管道
        let order=|cwd:&str| locate_in(&sessions,"sid",cwd,&alive).unwrap().iter().map(|c|c.cwd.clone()).collect::<Vec<_>>();
        assert_eq!(order("D:/b"),vec!["D:/b","D:/c","D:/a"]);
        assert_eq!(order("D:/nowhere"),vec!["D:/c","D:/b","D:/a"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn incremental_reader_does_not_consume_partial_records() {
        let path=std::env::temp_dir().join(format!("agenthub-live-rows-{}.jsonl",std::process::id()));
        std::fs::write(&path,"{\"uuid\":\"old\"}\n{\"uuid\":").unwrap();
        let mut offset=0;assert_eq!(read_rows(&path,&mut offset).unwrap().len(),1);
        assert!(read_rows(&path,&mut offset).unwrap().is_empty());
        let mut f=std::fs::OpenOptions::new().append(true).open(&path).unwrap();writeln!(f,"\"new\"}}").unwrap();
        assert_eq!(read_rows(&path,&mut offset).unwrap()[0]["uuid"],"new");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn only_tracks_replies_after_our_message_and_stops_at_other_human_input() {
        let mut turn=ObservedTurn::new("our-id");
        let reply=json!({"type":"assistant","uuid":"r1","message":{"content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn"}});
        assert!(turn.consume(&reply).is_empty());
        assert!(turn.consume(&json!({"type":"user","uuid":"someone-else"})).is_empty());
        assert!(matches!(turn.consume(&json!({"type":"user","uuid":"our-id","isMeta":true}))[0],Observed::Delivered));
        assert!(matches!(turn.consume(&reply)[0],Observed::Reply{finished:true,..}));
        assert!(turn.consume(&reply).is_empty());
        assert!(turn.consume(&json!({"type":"user","message":{"content":[{"type":"tool_result"}]}})).is_empty());
        // 后台任务完成通知也是 user 行，但没人插话，不能因此断掉回复跟踪
        assert!(turn.consume(&json!({"type":"user","uuid":"task-note","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>x</task-notification>"}})).is_empty());
        assert!(matches!(turn.consume(&json!({"type":"user","uuid":"new-human","origin":{"kind":"human"},"message":{"content":"hi"}}))[0],Observed::OtherInput));
    }
    /// 只读探测本机真实登记表（排查「投递通道找不到」时用）：
    /// `AH_PROBE_KEY=<sessionId> AH_PROBE_CWD=<项目目录> cargo test --lib live_probe -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_probe_reads_this_machines_registry() {
        let Ok(key)=std::env::var("AH_PROBE_KEY") else { return };
        let cwd=std::env::var("AH_PROBE_CWD").unwrap_or_default();
        match locate(&key,&cwd) {
            Ok(c) if c.is_empty()=>println!("MISS 没有存活持有者（可以 resume）"),
            Ok(c)=>println!("HIT {} 条通道，首选 cwd={} socket={} ready={}",
                c.len(),c[0].cwd,c[0].endpoint.socket,ready(&c[0].endpoint.socket)),
            Err(e)=>println!("ERR {e}"),
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_named_pipe_receives_auth_and_exact_message_once() {
        use std::os::windows::process::CommandExt;
        let name=format!("agenthub-live-test-{}",std::process::id());
        let script=format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $s=[IO.Pipes.NamedPipeServerStream]::new('{name}',[IO.Pipes.PipeDirection]::In); [Console]::WriteLine('ready'); if(-not $s.WaitForConnectionAsync().Wait(5000)){{exit 1}}; $r=[IO.StreamReader]::new($s); [Console]::WriteLine($r.ReadLine()); [Console]::WriteLine($r.ReadLine()); $r.Dispose(); $s.Dispose()");
        let mut child=std::process::Command::new("powershell").args(["-NoProfile","-Command",&script])
            .creation_flags(0x0800_0000).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let mut reader=BufReader::new(child.stdout.take().unwrap());let mut line=String::new();
        reader.read_line(&mut line).unwrap();assert_eq!(line.trim(),"ready");
        let endpoint=Endpoint{socket:format!(r"\\.\pipe\{name}"),token:"a".repeat(32)};
        send(&endpoint,"session-1","message-1","原终端\n继续聊").unwrap();
        line.clear();reader.read_line(&mut line).unwrap();let auth:Value=serde_json::from_str(&line).unwrap();
        assert_eq!(auth["type"],"auth");assert_eq!(auth["token"],"a".repeat(32));
        line.clear();reader.read_line(&mut line).unwrap();let message:Value=serde_json::from_str(&line).unwrap();
        assert_eq!(message["uuid"],"message-1");assert_eq!(message["message"]["content"],"原终端\n继续聊");
        assert!(child.wait().unwrap().success());
    }
}
