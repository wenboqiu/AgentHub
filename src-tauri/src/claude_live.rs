//! Deliver to an existing Claude inbox. Never resume a second writer or type into a terminal.
use crate::{claude::home_dir, runner::{norm_path, valid_key}};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::{BufRead, BufReader, Seek, SeekFrom, Write}, path::{Path, PathBuf}};

// Intentionally no Debug/Serialize: the peer token must remain on this machine.
pub struct Endpoint { pub socket: String, token: String }

fn pipe_path(path: &str) -> bool {
    path.to_ascii_lowercase().starts_with(r"\\.\pipe\") && !path.contains(['\n','\r','\0'])
}

pub fn key_name(pid: u32, socket: &str) -> Result<String,String> {
    if pid == 0 || !pipe_path(socket) { return Err("原终端的本机收件地址无效".into()); }
    Ok(format!("{pid}.{:x}.key",Sha256::digest(socket.to_ascii_lowercase().as_bytes())))
}

pub fn discover_in(home: &Path, key: &str, cwd: &str, live_pids: &[u32]) -> Result<Endpoint,String> {
    if !valid_key(key) { return Err("会话 id 格式不对".into()); }
    let sessions=home.join(".claude/sessions");
    let mut matches=Vec::new();
    for pid in live_pids {
        let path=sessions.join(format!("{pid}.json"));
        let Some(v)=std::fs::read_to_string(path).ok().and_then(|s|serde_json::from_str::<Value>(&s).ok()) else {continue};
        if v["sessionId"]!=key || v["pid"].as_u64()!=Some(*pid as u64) { continue; }
        if v["cwd"].as_str().is_none_or(|p|norm_path(p)!=norm_path(cwd)) { continue; }
        if let Some(socket)=v["messagingSocketPath"].as_str().filter(|p|pipe_path(p)) {
            matches.push((*pid,socket.to_owned()));
        }
    }
    if matches.len()!=1 { return Err("无法唯一确认原终端的收件通道，请确认 Claude Code 支持本机会话消息并刷新会话".into()); }
    let (pid,socket)=matches.pop().unwrap();
    let key_file=sessions.join(key_name(pid,&socket)?);
    if std::fs::symlink_metadata(&key_file).map_err(|_|"原终端的消息认证信息不可用")?.file_type().is_symlink() {
        return Err("原终端的消息认证文件不能是符号链接".into());
    }
    let auth:Value=serde_json::from_str(&std::fs::read_to_string(key_file).map_err(|_|"无法读取原终端的消息认证信息")?)
        .map_err(|_|"原终端的消息认证信息格式不正确")?;
    let token=auth["peerToken"].as_str().filter(|s|s.len()==32 && s.bytes().all(|b|b.is_ascii_hexdigit()))
        .ok_or("原终端的消息认证信息不完整")?.to_owned();
    Ok(Endpoint{socket,token})
}

pub fn discover(key: &str, cwd: &str) -> Result<Endpoint,String> {
    let home=home_dir().ok_or("找不到用户目录")?;
    let entries=crate::runner::claude_open_entries()?;
    let pids:Vec<_>=entries.into_iter().filter(|(id,_)|id==key).filter_map(|(_,pid)|pid).collect();
    discover_in(&home,key,cwd,&pids)
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
        if row["type"]=="user" && row["isMeta"]!=true && row["parent_tool_use_id"].is_null() {
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
    fn registry_must_match_live_pid_session_and_project() {
        let dir=std::env::temp_dir().join(format!("agenthub-live-discovery-{}",std::process::id()));
        let sessions=dir.join(".claude/sessions");std::fs::create_dir_all(&sessions).unwrap();
        let socket=r"\\.\pipe\claude-test-inbox";
        std::fs::write(sessions.join("1.json"),json!({"pid":1,"sessionId":"sid","cwd":"D:/project","messagingSocketPath":socket}).to_string()).unwrap();
        std::fs::write(sessions.join(key_name(1,socket).unwrap()),json!({"peerToken":"a".repeat(32)}).to_string()).unwrap();
        assert!(discover_in(&dir,"sid","d:\\project",&[1]).is_ok());
        assert!(discover_in(&dir,"other","D:/project",&[1]).is_err());
        assert!(discover_in(&dir,"sid","D:/elsewhere",&[1]).is_err());
        assert!(discover_in(&dir,"sid","D:/project",&[]).is_err());
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
        assert!(matches!(turn.consume(&json!({"type":"user","uuid":"new-human","message":{"content":"hi"}}))[0],Observed::OtherInput));
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
