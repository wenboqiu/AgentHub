//! 各执行端的模型清单（只读，不派活）。
//!
//! 两家的来源完全不同：
//! - **CodeBuddy**：CLI 把服务端下发的账号配置缓存在 `~/.codebuddy/local_storage/entry_*.info`，
//!   `data.models` 是全量目录（带 credits / 上下文 / 能力 / 中英描述），
//!   `data.agents[cli].models` 才是这个账号实际能用的 id，两者取交集。读文件，毫秒级。
//! - **ZCode**：安装包的 `zcode-builtin.json` 里 `builtinProviderModelRules` 是
//!   provider × 模型的搭配表，按账号所在套餐过滤即得内置模型清单。
//!
//! ZCode 没有「账号实际可用」的离线缓存，会话快照 `settings.model.available` 也不给全量：
//! 它只报**当前选中的模型**（未选模型时恒为空数组），而 registry 里的模型要桌面端
//! Host 的完整 provider 流水线才会被填充——裸跑 app-server 下发 account 配置、
//! `session/setModel` 逐个试都拿不到（实测见 docs/zcode-app-server.md §15）。
//! 所以这里只内置清单：它跟着 ZCode 版本走，切换套餐后升级/重装会更新。

use serde::Serialize;
use serde_json::Value;
use std::time::SystemTime;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// 写进角色 / 派活用的值（ZCode 是 modelId，大小写敏感）
    pub id: String,
    /// 展示名（CodeBuddy 有正式名，ZCode 就是 modelId）
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    /// `account` = 账号下发的实际可用；`static` = 安装包内置；`empty` = 没有清单
    pub source: String,
    pub models: Vec<ModelChoice>,
    /// 人话版来源说明（前端放 title / 提示行）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ModelList {
    fn empty(detail: impl Into<String>) -> Self {
        Self { source: "empty".into(), models: Vec::new(), detail: Some(detail.into()) }
    }

    fn of(source: &str, models: Vec<ModelChoice>, detail: impl Into<String>) -> Self {
        Self { source: source.into(), models, detail: Some(detail.into()) }
    }
}

/// 前端入口。`refresh` 语义：重新读一遍来源（不缓存，账号换过之后点一下就能刷新）
pub fn list(agent: &str, _refresh: bool) -> ModelList {
    match agent {
        "codebuddy" => codebuddy(),
        "zcode" => zcode(),
        _ => ModelList::empty("这个执行端用固定别名，没有可拉取的清单"),
    }
}

// ---------------------------------------------------------------- CodeBuddy

fn codebuddy() -> ModelList {
    let Some(home) = crate::claude::home_dir() else {
        return ModelList::empty("找不到用户目录");
    };
    let dir = home.join(".codebuddy").join("local_storage");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return ModelList::empty("CodeBuddy 还没在这台机器上跑过（没有 local_storage 缓存）");
    };

    // entry_<hash>.info 才是正式文件；`.info.<uuid>.tmp` 是写到一半的临时文件，跳过
    let mut best: Option<(SystemTime, Value)> = None;
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.starts_with("entry_") || !name.ends_with(".info") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(data) = entry_data(&v) else { continue };
        let has_models = data
            .get("models")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        if !has_models {
            continue;
        }
        let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(t, _)| mtime >= *t) {
            best = Some((mtime, data));
        }
    }
    let Some((mtime, data)) = best else {
        return ModelList::empty("CodeBuddy 缓存里还没有模型清单（登录后同步一次账号配置就有了）");
    };

    let catalog = data.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    // 账号实际可用的 id 顺序以 agents[cli].models 为准；拿不到就退回全量目录里的编码模型
    let usable: Vec<String> = data
        .get("agents")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some("cli")))
        .and_then(|x| x.get("models"))
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    let mut models: Vec<ModelChoice> = Vec::new();
    if usable.is_empty() {
        for m in &catalog {
            // 没白名单时只在「有 token 预算」的条目里挑，滤掉图片 / 视频模型
            if m.get("maxInputTokens").and_then(Value::as_u64).is_none() {
                continue;
            }
            if let Some(c) = codebuddy_choice(m) {
                models.push(c);
            }
        }
    } else {
        for id in &usable {
            match catalog.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id.as_str())) {
                Some(m) => models.extend(codebuddy_choice(m)),
                None => models.push(ModelChoice { id: id.clone(), label: id.clone(), note: None, hint: None }),
            }
        }
    }

    let when = chrono::DateTime::<chrono::Local>::from(mtime).format("%m-%d %H:%M");
    ModelList::of("account", models, format!("CodeBuddy 账号可用（缓存更新于 {when}）"))
}

/// local_storage 的条目有两种外形：`[{userId, data}]` 或直接 `{data}`
fn entry_data(v: &Value) -> Option<Value> {
    match v {
        Value::Array(a) => a.first()?.get("data").cloned(),
        _ => v.get("data").cloned(),
    }
}

fn codebuddy_choice(m: &Value) -> Option<ModelChoice> {
    let id = m.get("id").and_then(Value::as_str)?.to_string();
    let label = m.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
    let ctx = m.get("maxInputTokens").and_then(Value::as_u64);
    let credits = m
        .get("credits")
        .and_then(Value::as_str)
        .map(|c| c.trim_end_matches(" credits").trim().to_string())
        .filter(|c| !c.is_empty());
    let note = match (ctx.map(context_label), credits) {
        (Some(c), Some(k)) => Some(format!("{c} 上下文 · {k}")),
        (Some(c), None) => Some(format!("{c} 上下文")),
        (None, Some(k)) => Some(k),
        (None, None) => None,
    };
    let hint = m
        .get("descriptionZh")
        .and_then(Value::as_str)
        .or_else(|| m.get("descriptionEn").and_then(Value::as_str))
        .map(str::to_string);
    Some(ModelChoice { id, label, note, hint })
}

/// 1000000 → `1M`，256000 → `256K`
fn context_label(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if (m - m.round()).abs() < 0.05 {
            format!("{}M", m.round() as u64)
        } else {
            format!("{m:.1}M")
        }
    } else if n >= 1000 {
        format!("{}K", (n as f64 / 1000.0).round() as u64)
    } else {
        n.to_string()
    }
}

// ---------------------------------------------------------------- ZCode

fn zcode() -> ModelList {
    let Some(install) = crate::zcode_exec::find_install() else {
        return ModelList::empty("没找到 ZCode 安装目录");
    };
    let Ok(text) = std::fs::read_to_string(&install.provider_config) else {
        return ModelList::empty("读不到 ZCode 内置 provider 配置");
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return ModelList::empty("ZCode 内置 provider 配置不是合法 JSON");
    };
    let revision = v.get("revision").and_then(Value::as_u64);
    let rules = v
        .pointer("/config/modelConfigRules/builtinProviderModelRules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // 同一个模型在 10 个套餐里都出现，按 modelId 去重；顺序按配置里第一次出现的先后
    let mut models: Vec<ModelChoice> = Vec::new();
    for rule in &rules {
        let Some(id) = rule.get("modelId").and_then(Value::as_str) else { continue };
        if models.iter().any(|m| m.id == id) {
            continue;
        }
        models.push(ModelChoice { id: id.to_string(), label: id.to_string(), note: None, hint: None });
    }
    if models.is_empty() {
        return ModelList::empty("ZCode 内置配置里没有模型规则");
    }
    let rev = revision.map(|r| format!("，配置 revision {r}")).unwrap_or_default();
    ModelList::of(
        "static",
        models,
        format!("ZCode 内置清单{rev}；具体可用哪些由套餐决定，换套餐后升级 ZCode 会更新"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_label_reads_like_a_human() {
        assert_eq!(context_label(1_000_000), "1M");
        assert_eq!(context_label(960_000), "960K");
        assert_eq!(context_label(256_000), "256K");
        assert_eq!(context_label(500), "500");
    }

    #[test]
    fn local_storage_entry_can_be_array_or_object() {
        let arr: Value = serde_json::json!([{ "userId": "u", "data": { "models": [{ "id": "glm-5.3" }] } }]);
        assert_eq!(entry_data(&arr).unwrap()["models"][0]["id"], "glm-5.3");
        let obj: Value = serde_json::json!({ "data": { "models": [] } });
        assert_eq!(entry_data(&obj).unwrap()["models"], serde_json::json!([]));
        assert!(entry_data(&serde_json::json!({})).is_none());
    }

    #[test]
    fn choice_carries_context_and_credits() {
        let m: Value = serde_json::json!({
            "id": "glm-5.3", "name": "GLM-5.3", "maxInputTokens": 1000000,
            "credits": "x0.69 credits", "descriptionZh": "旗舰"
        });
        let c = codebuddy_choice(&m).unwrap();
        assert_eq!(c.id, "glm-5.3");
        assert_eq!(c.label, "GLM-5.3");
        assert_eq!(c.note.as_deref(), Some("1M 上下文 · x0.69"));
        assert_eq!(c.hint.as_deref(), Some("旗舰"));
    }

    /// 本机装了 ZCode 才有内置配置可读；没装就跳过
    #[test]
    fn zcode_static_list_dedupes_plans() {        if crate::zcode_exec::find_install().is_none() {
            return;
        }
        let list = zcode();
        assert_eq!(list.source, "static");
        assert!(list.models.iter().any(|m| m.id.starts_with("GLM-")), "{:?}", list.models);
        let mut ids: Vec<&str> = list.models.iter().map(|m| m.id.as_str()).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "模型 id 不能重复");
    }

    /// 真机看一眼实际读出来的清单（会打印条目）：
    /// `cargo test --lib real_machine_lists -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_machine_lists() {
        for agent in ["codebuddy", "zcode"] {
            let l = list(agent, false);
            println!("{agent}: source={} detail={:?}", l.source, l.detail);
            for m in l.models.iter().take(6) {
                println!("   {} | {} | {:?}", m.id, m.label, m.note);
            }
            println!("   共 {} 个", l.models.len());
        }
    }
}
