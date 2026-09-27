//! Per-turn token accounting read from DeepSeek Harness's own session log.
//!
//! DSH's ACP bridge reports no token counts: `session/prompt` answers with a
//! bare `stopReason`, and its `usage_update` notifications carry context-window
//! occupancy (`used` / `size`), not consumption. The numbers DSH's own UI shows
//! come from its durable log, `<DSH home>/sessions/<cwd key>/<session id>/
//! session.v*.jsonl[.zstd]`, where every model call's `assistant/message`
//! records `usage`. Summing those for the turn gives the same figure DSH shows,
//! cached prompt tokens included.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Token usage for one completed DSH turn, summed over its model calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnUsage {
    /// Prompt tokens sent, cached or not (DSH's `totalTokens - outputTokens`).
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    /// Prompt tokens served from the provider's cache, when every call reported it.
    pub cache_read_tokens: Option<u64>,
    /// Number of model calls in the turn; each one resends the context.
    pub model_calls: u32,
}

/// `$DSH_HOME` (with `~` expanded) when set and non-blank, else `~/.dsh`,
/// matching DSH's own resolution.
pub fn dsh_home() -> Option<PathBuf> {
    let user_home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Ok(configured) = std::env::var("DSH_HOME") {
        let configured = configured.trim();
        if !configured.is_empty() {
            if configured == "~" {
                return user_home;
            }
            if let Some(rest) = configured
                .strip_prefix("~/")
                .or_else(|| configured.strip_prefix("~\\"))
            {
                return user_home.map(|h| h.join(rest));
            }
            return Some(PathBuf::from(configured));
        }
    }
    user_home.map(|h| h.join(".dsh"))
}

/// Locate a session's log. The directory above it is DSH's encoding of the
/// session's cwd; session ids are UUIDs, so searching every cwd folder avoids
/// depending on that encoding.
pub fn find_session_log(dsh_home: &Path, session_id: &str) -> Option<PathBuf> {
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return None;
    }
    let sessions = std::fs::read_dir(dsh_home.join("sessions")).ok()?;
    for cwd_dir in sessions.flatten() {
        let dir = cwd_dir.path().join(session_id);
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut logs: Vec<PathBuf> = files
            .flatten()
            .map(|f| f.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("session.") && (n.ends_with(".jsonl.zstd") || n.ends_with(".jsonl")))
            })
            .collect();
        // Newest format version last in name order (session.v3 > session.v2).
        logs.sort();
        if let Some(log) = logs.pop() {
            return Some(log);
        }
    }
    None
}

/// Every event that can be read. The log is appended while DSH runs, so a
/// trailing partial frame or line is expected and simply ends the read.
pub fn read_events(path: &Path) -> Vec<Value> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "zstd") {
        match zstd::stream::read::Decoder::new(file) {
            Ok(decoder) => Box::new(decoder),
            Err(_) => return Vec::new(),
        }
    } else {
        Box::new(file)
    };
    let mut events = Vec::new();
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else {
            break;
        };
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            events.push(event);
        }
    }
    events
}

fn count(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

/// Usage of the log's most recent turn, once that turn has ended.
pub fn last_turn_usage(events: &[Value]) -> Option<TurnUsage> {
    let kind = |e: &Value| e.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let turn_of = |e: &Value| e.pointer("/data/turn").and_then(Value::as_u64);
    let turn = events
        .iter()
        .rev()
        .find(|e| kind(e) == "turn/start")
        .and_then(turn_of)?;
    // A turn still being written would under-count, so wait for its end.
    let ended = events
        .iter()
        .any(|e| kind(e) == "turn/end" && turn_of(e) == Some(turn));
    if !ended {
        return None;
    }

    let mut usage = TurnUsage {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: Some(0),
        model_calls: 0,
    };
    for event in events {
        if kind(event) != "assistant/message" || turn_of(event) != Some(turn) {
            continue;
        }
        let Some(u) = event.pointer("/data/usage") else {
            continue;
        };
        let (Some(uncached), Some(output)) = (count(u, "inputTokens"), count(u, "outputTokens")) else {
            continue;
        };
        let cache_read = count(u, "cacheReadTokens");
        let cache_write = count(u, "cacheWriteTokens").unwrap_or(0);
        let total = count(u, "totalTokens")
            .unwrap_or(uncached + cache_read.unwrap_or(0) + cache_write + output);
        usage.output_tokens += output;
        usage.total_tokens += total;
        usage.input_tokens += total.saturating_sub(output);
        usage.cache_read_tokens = match (usage.cache_read_tokens, cache_read) {
            (Some(sum), Some(v)) => Some(sum + v),
            _ => None,
        };
        usage.model_calls += 1;
    }
    (usage.model_calls > 0).then_some(usage)
}

/// The finished turn's usage for `session_id`, polling briefly because DSH
/// may answer the prompt a moment before its log has the turn's end.
pub fn turn_usage_for_session(session_id: &str, wait: Duration) -> Option<TurnUsage> {
    let home = dsh_home()?;
    let deadline = Instant::now() + wait;
    loop {
        if let Some(path) = find_session_log(&home, session_id) {
            if let Some(usage) = last_turn_usage(&read_events(&path)) {
                return Some(usage);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn assistant(turn: u64, usage: Value) -> Value {
        json!({ "type": "assistant/message", "data": { "turn": turn, "usage": usage } })
    }

    fn turn(kind: &str, n: u64) -> Value {
        json!({ "type": kind, "data": { "turn": n } })
    }

    #[test]
    fn sums_every_model_call_of_the_last_turn() {
        let events = vec![
            turn("turn/start", 1),
            assistant(1, json!({ "inputTokens": 5, "outputTokens": 5, "totalTokens": 10 })),
            turn("turn/end", 1),
            turn("turn/start", 2),
            assistant(2, json!({ "inputTokens": 706, "outputTokens": 341, "totalTokens": 14231, "cacheReadTokens": 13184 })),
            json!({ "type": "tool/call", "data": { "turn": 2 } }),
            assistant(2, json!({ "inputTokens": 100, "outputTokens": 50, "totalTokens": 15000, "cacheReadTokens": 14850 })),
            turn("turn/end", 2),
        ];
        let usage = last_turn_usage(&events).unwrap();
        assert_eq!(usage.model_calls, 2);
        assert_eq!(usage.total_tokens, 29231);
        assert_eq!(usage.output_tokens, 391);
        assert_eq!(usage.input_tokens, 29231 - 391);
        assert_eq!(usage.cache_read_tokens, Some(28034));
    }

    #[test]
    fn an_unfinished_turn_is_not_reported() {
        let events = vec![
            turn("turn/start", 1),
            assistant(1, json!({ "inputTokens": 1, "outputTokens": 1, "totalTokens": 2 })),
        ];
        assert_eq!(last_turn_usage(&events), None);
    }

    #[test]
    fn totals_are_derived_when_the_provider_omits_them() {
        let events = vec![
            turn("turn/start", 1),
            assistant(1, json!({ "inputTokens": 10, "outputTokens": 4, "cacheReadTokens": 90, "cacheWriteTokens": 6 })),
            assistant(1, json!({ "inputTokens": 3, "outputTokens": 2 })),
            turn("turn/end", 1),
        ];
        let usage = last_turn_usage(&events).unwrap();
        assert_eq!(usage.total_tokens, 110 + 5);
        // One call did not report cache reads, so no cache figure is claimed.
        assert_eq!(usage.cache_read_tokens, None);
    }

    #[test]
    fn reads_a_zstd_log_found_by_session_id_and_stops_at_a_torn_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions").join("--some-cwd--").join("sess-1");
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            turn("turn/start", 1),
            assistant(1, json!({ "inputTokens": 1, "outputTokens": 2, "totalTokens": 30 })),
            turn("turn/end", 1),
        ]
        .iter()
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let mut bytes = zstd::stream::encode_all(format!("{lines}\n").as_bytes(), 3).unwrap();
        // A frame DSH is still writing.
        bytes.extend_from_slice(&[0x28, 0xb5, 0x2f, 0xfd, 0x00]);
        std::fs::File::create(dir.join("session.v3.jsonl.zstd"))
            .unwrap()
            .write_all(&bytes)
            .unwrap();

        let log = find_session_log(tmp.path(), "sess-1").unwrap();
        let usage = last_turn_usage(&read_events(&log)).unwrap();
        assert_eq!(usage.total_tokens, 30);
        assert!(find_session_log(tmp.path(), "../sess-1").is_none());
        assert!(find_session_log(tmp.path(), "missing").is_none());
    }
}
