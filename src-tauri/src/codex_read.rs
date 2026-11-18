//! Read-only Codex Desktop read receipts. Unknown schemas/accounts/hosts fail closed.
use crate::{claude, codex, runner};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, path::Path};
use std::io::{BufRead, Read};

fn desktop_meta(line: &str, key: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return false; };
    let p = &v["payload"];
    v["type"] == "session_meta" && p["originator"] == "Codex Desktop" &&
        p["id"].as_str().or_else(||p["session_id"].as_str()) == Some(key)
}

fn desktop_session(path: &Path, key: &str) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false; };
    let line = std::io::BufReader::new(file.take(64*1024)).lines().next();
    line.and_then(Result::ok).is_some_and(|s|desktop_meta(&s,key))
}

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

// Same identity and execution-host namespaces as Codex Desktop's version-1 store.
// Tokens never leave this process; only the account/user claims are used locally.
fn identity(auth: &Value) -> Option<String> {
    if auth["auth_mode"] != "chatgpt" { return None; }
    let token = auth["tokens"]["id_token"].as_str()?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?).ok()?;
    let claims = &claims["https://api.openai.com/auth"];
    let account = auth["tokens"]["account_id"].as_str()?;
    if claims["chatgpt_account_id"].as_str()? != account { return None; }
    let user = claims["chatgpt_user_id"].as_str()?;
    if account.is_empty() || user.is_empty() { return None; }
    Some(hash(&json!(["chatgpt",account,user])))
}

struct Snapshot {
    identity: String,
    unread: HashSet<String>,
    persisted_at: chrono::DateTime<chrono::Utc>,
}

impl Snapshot {
    fn parse(state: &Value, identity: String, persisted_at: chrono::DateTime<chrono::Utc>) -> Option<Self> {
        let state = &state["electron-thread-read-state-v1"];
        if state["version"].as_u64()? != 1 { return None; }
        let host = format!("local:{}",hash(&json!(["local","local",null])));
        let ids = state["unreadByIdentity"].get(&identity)?.get(&host)?.as_array()?;
        let unread = ids.iter().map(|id| id.as_str().map(str::to_owned)).collect::<Option<HashSet<_>>>()?;
        Some(Self { identity, unread, persisted_at })
    }

    fn load(home: &Path) -> Option<Self> {
        let root = home.join(".codex");
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(root.join("auth.json")).ok()?).ok()?;
        let path = root.join(".codex-global-state.json");
        let persisted_at = std::fs::metadata(&path).ok()?.modified().ok()?.into();
        let state: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        Self::parse(&state,identity(&auth)?,persisted_at)
    }
}

#[derive(Default)]
pub struct ReadSync {
    // A read must remain confirmed across polls; transient missing unread entries
    // while Desktop processes a completion must not immediately clear the badge.
    candidates: HashMap<String, (String, String, chrono::DateTime<chrono::Utc>)>,
}

impl ReadSync {
    fn receipt(&mut self, snapshot: &Snapshot, s: &Value, latest: (&str, &str), now: chrono::DateTime<chrono::Utc>) -> Option<Value> {
        let id = s["id"].as_str()?;
        let key = id.strip_prefix("codex:")?;
        let at = s["eventAt"].as_str()?;
        let event_at = chrono::DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&chrono::Utc);
        let latest_at = chrono::DateTime::parse_from_rfc3339(latest.1).ok()?.with_timezone(&chrono::Utc);
        let eligible = s["acked"] == false && matches!(s["state"].as_str(),Some("done"|"aborted")) &&
            s["state"].as_str() == Some(latest.0) && latest_at == event_at &&
            snapshot.persisted_at >= event_at && !snapshot.unread.contains(key);
        if !eligible { self.candidates.remove(id); return None; }
        let candidate = self.candidates.entry(id.to_owned()).or_insert_with(|| (snapshot.identity.clone(),at.to_owned(),now));
        if candidate.0 != snapshot.identity || candidate.1 != at {
            *candidate = (snapshot.identity.clone(),at.to_owned(),now);
            return None;
        }
        if now.signed_duration_since(candidate.2).num_seconds() < 15 { return None; }
        Some(json!({"agent":"codex","sessionId":key,"machine":s["machine"],"cwd":s["cwd"],
            "state":s["state"],"at":at,"expectedAt":at,"readAt":snapshot.persisted_at.to_rfc3339(),"quiet":true}))
    }

    pub fn events(&mut self, home: &Path, sessions: &[Value]) -> Vec<Value> {
        let Some(snapshot) = Snapshot::load(home) else { self.candidates.clear(); return vec![]; };
        let now = chrono::Utc::now();
        let mut events = vec![];
        let known: HashSet<_> = sessions.iter().filter_map(|s|s["id"].as_str()).collect();
        self.candidates.retain(|id,_|known.contains(id.as_str()));
        for s in sessions {
            let Some(key) = s["id"].as_str().and_then(|id|id.strip_prefix("codex:")) else { continue; };
            if !runner::valid_key(key) || s["acked"] != false || !matches!(s["state"].as_str(),Some("done"|"aborted")) { continue; }
            let path = runner::codex_rollout(home, key);
            let latest = path.filter(|p|desktop_session(p,key)).and_then(|p|runner::read_tail(&p,256*1024).ok()).and_then(|text| {
                codex::FileState::new(Some(key.to_owned())).feed(&text.lines().collect::<Vec<_>>(),true,&claude::now_iso()).pop()
            });
            if let Some(latest) = latest {
                if let Some(ev) = self.receipt(&snapshot,s,(&latest.state,&latest.at),now) { events.push(ev); }
            } else { self.candidates.remove(s["id"].as_str().unwrap()); }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(unread: &[&str]) -> Snapshot {
        Snapshot {identity:"account".into(),unread:unread.iter().map(|s|s.to_string()).collect(),persisted_at:time(30)}
    }
    fn time(seconds: i64) -> chrono::DateTime<chrono::Utc> { chrono::DateTime::from_timestamp(1793494800+seconds,0).unwrap() }
    fn session() -> Value { json!({"id":"codex:abc","machine":"pc","cwd":"D:/project","state":"done","acked":false,"eventAt":time(0).to_rfc3339()}) }
    #[test]
    fn cli_or_other_session_metadata_is_not_read_evidence() {
        let mut meta=json!({"type":"session_meta","payload":{"id":"abc","originator":"Codex Desktop"}});
        assert!(desktop_meta(&meta.to_string(),"abc"));
        assert!(!desktop_meta(&meta.to_string(),"other"));
        meta["payload"]["originator"]=json!("codex_cli_rs");assert!(!desktop_meta(&meta.to_string(),"abc"));
        assert!(!desktop_meta("invalid","abc"));
    }
    #[test]
    fn exact_account_and_local_host_are_required() {
        let host = format!("local:{}",hash(&json!(["local","local",null])));
        let mut state=json!({"electron-thread-read-state-v1":{"version":1,"unreadByIdentity":{"account":{host:[]}}}});
        assert!(Snapshot::parse(&state,"account".into(),time(30)).is_some());
        assert!(Snapshot::parse(&state,"other-account".into(),time(30)).is_none());
        state["electron-thread-read-state-v1"]["version"]=json!(2);
        assert!(Snapshot::parse(&state,"account".into(),time(30)).is_none());
        assert!(Snapshot::parse(&json!({}),"account".into(),time(30)).is_none());
    }
    #[test]
    fn identity_uses_claims_and_never_falls_back_to_another_account() {
        let claims=json!({"https://api.openai.com/auth":{"chatgpt_account_id":"account","chatgpt_user_id":"user"}});
        let token=format!("header.{}.signature",URL_SAFE_NO_PAD.encode(claims.to_string()));
        let mut auth=json!({"auth_mode":"chatgpt","tokens":{"id_token":token,"account_id":"account"}});
        assert_eq!(identity(&auth),Some(hash(&json!(["chatgpt","account","user"]))));
        auth["tokens"]["account_id"]=json!("other");assert!(identity(&auth).is_none());
        assert!(identity(&json!({})).is_none());
    }
    #[test]
    fn read_must_be_stable_and_match_the_latest_completed_turn() {
        let mut sync=ReadSync::default();let s=session();let at=s["eventAt"].as_str().unwrap();
        assert!(sync.receipt(&snapshot(&[]),&s,("done",at),time(30)).is_none());
        let ev=sync.receipt(&snapshot(&[]),&s,("done",at),time(45)).unwrap();
        assert_eq!(ev["expectedAt"],s["eventAt"]);assert!(ev["readAt"].is_string());
        assert!(sync.receipt(&snapshot(&["abc"]),&s,("done",at),time(46)).is_none());
        assert!(sync.receipt(&snapshot(&[]),&s,("done",at),time(47)).is_none());
        assert!(sync.receipt(&snapshot(&[]),&s,("running",&time(1).to_rfc3339()),time(80)).is_none());
        assert!(sync.receipt(&snapshot(&[]),&s,("done",&time(1).to_rfc3339()),time(80)).is_none());
    }
    #[test]
    fn old_snapshots_and_approvals_cannot_be_acknowledged() {
        let mut sync=ReadSync::default();let mut s=session();let at=s["eventAt"].as_str().unwrap().to_owned();
        let mut old=snapshot(&[]);old.persisted_at=time(-1);
        assert!(sync.receipt(&old,&s,("done",&at),time(30)).is_none());
        s["state"]=json!("waiting");assert!(sync.receipt(&snapshot(&[]),&s,("waiting",&at),time(30)).is_none());
        s["state"]=json!("done");s["acked"]=json!(true);
        assert!(sync.receipt(&snapshot(&[]),&s,("done",&at),time(30)).is_none());
    }
}
