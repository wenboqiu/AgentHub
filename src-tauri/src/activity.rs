//! 活动时间戳 → 5 分钟活动桶。
//!
//! 服务端把 `session_activity` 按 5 分钟聚合，日历用它画"活动分段"和"对话跨度"。
//! WorkBuddy / ZCode 一直上报；Claude / Codex 以前只报状态，时间轴上只剩一个
//! "最后活动"点，跨度带画不出来。这里把 transcript / rollout 里的消息时间戳
//! 抽出来，走同一套桶与会话事件一起上报（服务端对同一桶取 GREATEST，重复上报无害）。

use crate::forwarder::Bucket;
use chrono::TimeZone;
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 单事件最多带多少个桶：服务端超过 2000 个整批 400，留足余量并只保留最近的
pub const MAX_BUCKETS: usize = 500;
/// 回看窗口：更早的活动画不到，也省得每轮扫全文件
pub const LOOKBACK_MS: i64 = 7 * 86400 * 1000;

pub fn iso(ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(crate::claude::now_iso)
}

/// 时间戳聚合成 5 分钟桶，与服务端 session_activity 同粒度
pub fn buckets_of(ms: &[i64]) -> Vec<Bucket> {
    const BUCKET_MS: i64 = 5 * 60_000;
    let mut m: BTreeMap<i64, u32> = BTreeMap::new();
    for t in ms {
        *m.entry(t.div_euclid(BUCKET_MS) * BUCKET_MS).or_insert(0) += 1;
    }
    m.into_iter().map(|(b, c)| Bucket { at: iso(b), count: c }).collect()
}

/// 只保留最近的桶：事件超长会让服务端拒绝整批，历史桶丢一点比整批丢强
pub fn capped(buckets: Vec<Bucket>) -> Vec<Bucket> {
    if buckets.len() <= MAX_BUCKETS {
        return buckets;
    }
    buckets[buckets.len() - MAX_BUCKETS..].to_vec()
}

/// RFC3339 → 毫秒（Claude / Codex 的时间戳都是 ISO 字符串）
pub fn ms_of_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis())
}

/// 从文件尾部读最多 limit 字节，挑出 `"timestamp":"<ISO>"` 且 since_ms 之后的行。
/// `keep` 由各 agent 决定哪些行算活动（消息 / 工具调用），避免把标题、meta 算进去。
pub fn tail_timestamps(path: &Path, limit: u64, since_ms: i64, keep: impl Fn(&str) -> bool) -> Vec<i64> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(limit);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.take(limit).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        // 从文件中段开始读时，第一行可能是半截
        if start > 0 && i == 0 {
            continue;
        }
        if !keep(line) {
            continue;
        }
        let Some(t) = field_iso(line, "timestamp") else { continue };
        if let Some(ms) = ms_of_iso(&t) {
            if ms >= since_ms {
                out.push(ms);
            }
        }
    }
    out
}

/// 取行内 `"<name>":"<value>"` 的字符串值（不解析整行 JSON，大文件也够快）
pub fn field_iso(line: &str, name: &str) -> Option<String> {
    let key = format!("\"{name}\":\"");
    let i = line.find(&key)? + key.len();
    let rest = &line[i..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_793_590_000_000; // 2026-11-05 前后

    #[test]
    fn buckets_quantize_to_five_minutes() {
        let ms = [T0, T0 + 1000, T0 + 5 * 60_000 + 7];
        let b = buckets_of(&ms);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].count, 2);
        assert_eq!(ms_of_iso(&b[0].at).unwrap() % 300_000, 0);
        assert_eq!(b[1].count, 1);
    }

    #[test]
    fn capped_keeps_the_newest() {
        let many: Vec<Bucket> = (0..(MAX_BUCKETS as i64 + 20)).map(|i| Bucket { at: iso(T0 + i * 300_000), count: 1 }).collect();
        let kept = capped(many);
        assert_eq!(kept.len(), MAX_BUCKETS);
        assert_eq!(kept.last().unwrap().at, iso(T0 + (MAX_BUCKETS as i64 + 19) * 300_000));
    }

    #[test]
    fn tail_scan_skips_partial_line_and_old_rows() {
        let dir = std::env::temp_dir().join(format!("agenthub-act-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let body = format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{}\"}}\n{{\"type\":\"assistant\",\"timestamp\":\"{}\"}}\n",
            iso(T0 - LOOKBACK_MS - 60_000),
            iso(T0)
        );
        std::fs::write(&p, body).unwrap();
        let all = tail_timestamps(&p, 1 << 20, T0 - 60_000, |l| l.contains("\"type\":\"assistant\""));
        assert_eq!(all, vec![T0]);
        // 只读尾部时首行是半截，不能当成一条活动
        let tail = tail_timestamps(&p, 40, 0, |_| true);
        assert!(tail.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
