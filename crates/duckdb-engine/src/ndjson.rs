//! Append-only record logs, written so a torn line costs only itself.
//!
//! Several stores are one JSON record per line, appended and never rewritten:
//! the publication log, schedule occurrences, batch and work ledgers,
//! checkpoints, both audit logs, the listen spool, OpenLineage events. Every
//! reader skips a line that will not parse, so a process killed mid-write costs
//! one record. That only holds if the NEXT append starts on a line of its own:
//! written straight after a torn tail, the new record is glued onto the broken
//! bytes, the joined line does not parse, and the record that was written
//! correctly is lost too. The batch work ledger healed its tail before
//! appending; the others did not.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Append records to `path`, terminating a torn last line first.
///
/// `text` is one or more lines; a missing final newline is added. It goes out
/// in a single write, because O_APPEND makes each write atomic and a separate
/// write for the newline lets two writers interleave.
pub fn append_records(path: &Path, text: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    let mut payload = String::with_capacity(text.len() + 2);
    if !ends_with_newline(path)? {
        payload.push('\n');
    }
    payload.push_str(text);
    if !text.ends_with('\n') {
        payload.push('\n');
    }
    f.write_all(payload.as_bytes())
}

/// Terminate a torn last line, for a writer that keeps the file open and appends
/// many records through one handle. Call it before opening that handle.
pub fn heal_tail(path: &Path) -> std::io::Result<()> {
    if ends_with_newline(path)? {
        return Ok(());
    }
    std::fs::OpenOptions::new().append(true).open(path)?.write_all(b"\n")
}

/// True for a missing or empty file, which has no torn line to heal.
fn ends_with_newline(path: &Path) -> std::io::Result<bool> {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e),
    };
    if f.metadata()?.len() == 0 {
        return Ok(true);
    }
    f.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    f.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_appended_after_a_torn_line_is_on_a_line_of_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("log.ndjson");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":").unwrap();
        append_records(&p, "{\"c\":3}").unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text, "{\"a\":1}\n{\"b\":\n{\"c\":3}\n");
        let parsed: Vec<serde_json::Value> =
            text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        assert_eq!(parsed.len(), 2, "only the torn record may be lost");
    }

    #[test]
    fn a_clean_or_missing_log_is_appended_to_as_is() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("new.ndjson");
        append_records(&p, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        append_records(&p, "{\"c\":3}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");
    }

    #[test]
    fn healing_a_held_open_log_terminates_its_torn_line_once() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("spool.ndjson");
        std::fs::write(&p, "{\"torn\":").unwrap();
        heal_tail(&p).unwrap();
        heal_tail(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"torn\":\n");
    }
}
