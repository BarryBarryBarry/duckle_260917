//! The accepted XSD parser-contract store (#315).
//!
//! The connector and the headless CLI must use the same file format. Keeping
//! the small read/replace operation here prevents an operator accepting a
//! contract through one surface from being invisible to another.

use std::path::{Path, PathBuf};

/// Where accepted parser contracts live for a workspace.
pub fn path(workspace: &Path) -> PathBuf {
    workspace.join(".duckle").join("xsd_contracts")
}

/// Split one `<uri> <fingerprint>` line, from the RIGHT.
///
/// A schema URI is an operator-supplied path and may contain spaces;
/// `C:/my schemas/order.xsd` is ordinary. Splitting at the first whitespace
/// returned `C:/my` as the URI, so a contract written for such a schema could
/// never be read back: every run took the first-sight branch and
/// `xsdChangePolicy: fail` silently stopped refusing anything.
///
/// The fingerprint is a SHA-256 hex digest and never contains whitespace, so
/// the last whitespace is the only unambiguous boundary. Lines written by the
/// old code parse identically, because they had no space to be confused by.
fn split_line(line: &str) -> Option<(&str, &str)> {
    let (uri, fingerprint) = line.rsplit_once(char::is_whitespace)?;
    let (uri, fingerprint) = (uri.trim_end(), fingerprint.trim());
    (!uri.is_empty() && !fingerprint.is_empty()).then_some((uri, fingerprint))
}

/// Return every well-formed accepted contract, in file order.
///
/// Takes the workspace, not the store file, so that every entry point names the
/// same thing. `accept` has to take the workspace anyway to lock it, and a
/// module where one function wants a directory and its neighbours want a file
/// is an invitation to pass the wrong one - both are `&Path`, so nothing would
/// say so.
pub fn list(workspace: &Path) -> Result<Vec<(String, String)>, String> {
    let store = path(workspace);
    let text = match std::fs::read_to_string(&store) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", store.display())),
    };
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (uri, fingerprint) = split_line(line)?;
            Some((uri.to_string(), fingerprint.to_string()))
        })
        .collect())
}

/// Return the accepted fingerprint for one schema root.
pub fn accepted(workspace: &Path, uri: &str) -> Option<String> {
    list(workspace)
        .ok()?
        .into_iter()
        .find_map(|(known_uri, fingerprint)| (known_uri == uri).then_some(fingerprint))
}

/// Replace one URI's accepted fingerprint, preserving comments and other URIs.
///
/// The old value is returned for the audit record. A missing value means this
/// is the first explicit acceptance for the URI.
pub fn accept(workspace: &Path, uri: &str, fingerprint: &str) -> Result<Option<String>, String> {
    // Before the read, because the whole read-modify-write is the critical
    // section: the rebuilt file is derived from a snapshot, so a second writer
    // that read the same snapshot publishes a store that never contained this
    // line, and this call still returns Ok for it. Measured at 8 threads: seven
    // reported success and one line survived.
    //
    // A nested "store" key, so it cannot be blocked by a pipeline run holding
    // its own lock, and the run lock cannot be blocked by this. That also makes
    // the fixed temp name below safe, since only one writer is ever inside.
    let _guard = crate::runlock::lock_store(workspace, "xsd-contracts")?;
    let store = path(workspace);
    let existing = match std::fs::read_to_string(&store) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", store.display())),
    };
    let previous = existing.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let (known_uri, known_fingerprint) = split_line(trimmed)?;
        (known_uri == uri).then_some(known_fingerprint.to_string())
    });
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return true;
            }
            split_line(trimmed).map(|(known_uri, _)| known_uri != uri).unwrap_or(true)
        })
        .map(str::to_string)
        .collect();
    lines.push(format!("{uri} {fingerprint}"));
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    // Temp then rename, so a reader sees the whole old store or the whole new
    // one. A bare write truncates first, and a truncated store parses cleanly
    // as "nothing is accepted" - which is the same fail-open as an unreadable
    // URI, reached by a different route. The engine records a contract at run
    // time while an operator can be accepting one from the CLI, so the two
    // really can meet.
    let tmp = store.with_extension("tmp");
    std::fs::write(&tmp, lines.join("\n") + "\n")
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    // Windows rename REPLACES, which is what this needs; it is not the
    // remove-then-rename that would leave a window with no file at all.
    std::fs::rename(&tmp, &store).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", store.display())
    })?;
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A schema path containing a space could be WRITTEN but never READ BACK,
    /// because the line was split at the first whitespace and the URI came back
    /// truncated. Nothing reported it: every run then took the first-sight
    /// branch, so under `xsdChangePolicy: fail` a schema that moved was never
    /// refused. Fail-open, silent, and a path with a space is ordinary.
    ///
    /// The fingerprint is a SHA-256 and never contains whitespace, so the split
    /// belongs at the LAST one.
    #[test]
    fn a_uri_containing_a_space_is_found_again() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let uri = "C:/my schemas/order v2.xsd";

        accept(ws, uri, "abc123").expect("accepted");
        assert_eq!(
            accepted(ws, uri).as_deref(),
            Some("abc123"),
            "a contract that cannot be read back is a fail-open"
        );

        // And it is one entry, not two: the replace has to match it as well.
        accept(ws, uri, "def456").expect("re-accepted");
        let all = list(ws).expect("listed");
        assert_eq!(all.len(), 1, "the replace did not match its own line: {all:?}");
        assert_eq!(all[0], (uri.to_string(), "def456".to_string()));
    }

    /// The previous fingerprint is what the audit record reports, and it comes
    /// from the same parse, so it has to survive a spaced URI too.
    #[test]
    fn the_previous_fingerprint_survives_a_spaced_uri() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let uri = "/srv/xsd files/a.xsd";
        assert_eq!(accept(ws, uri, "one").expect("first"), None);
        assert_eq!(
            accept(ws, uri, "two").expect("second").as_deref(),
            Some("one"),
            "an audit record that cannot name what it replaced is not a record"
        );
    }

    /// A torn write leaves a truncated store, and a truncated store reads as
    /// "nothing is accepted" - the same fail-open by another route. Replacing
    /// through a temp file and a rename means a reader sees the whole old file
    /// or the whole new one.
    ///
    /// This asserts the housekeeping half only: that the rename happened and
    /// left no temp behind. It does NOT prove atomicity, which needs a reader
    /// racing a writer; the guarantee there comes from rename being atomic on
    /// both platforms rather than from this test.
    #[test]
    fn replacing_the_store_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        accept(ws, "a.xsd", "one").expect("a");
        accept(ws, "b.xsd", "two").expect("b");

        // The store shares `.duckle` with the lock this now takes, so the check
        // is for a leftover temp specifically rather than for an empty
        // directory - which would have started failing on the lock itself and
        // said nothing about the temp file.
        let dir = path(ws).parent().expect("the store has a parent").to_path_buf();
        let stray: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "left a temp file behind: {stray:?}");
        assert_eq!(list(ws).expect("listed").len(), 2);
    }

    /// The store lands where every other surface looks for it.
    ///
    /// `accept` takes a workspace and `path` derives the file, and both are
    /// `&Path`, so a caller handing over the store file instead compiles and
    /// then writes `<store>/.duckle/xsd_contracts` that nothing reads. Nothing
    /// else in the module would notice: the round-trip tests pass either way,
    /// because they would be consistently wrong.
    #[test]
    fn accept_writes_the_file_the_other_surfaces_read() {
        let tmp = tempfile::tempdir().unwrap();
        accept(tmp.path(), "a.xsd", "aa").expect("accepted");
        let store = path(tmp.path());
        assert!(
            store.is_file(),
            "accept wrote somewhere else; {} does not exist",
            store.display()
        );
    }

    #[test]
    fn accepts_one_uri_without_disturbing_comments_or_other_contracts() {
        let temp = tempfile::tempdir().unwrap();
        let ws = temp.path();
        let file = path(ws);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "# keep\na.xsd old\nb.xsd other\n").unwrap();

        assert_eq!(accept(ws, "a.xsd", "new").unwrap(), Some("old".into()));
        assert_eq!(
            list(ws).unwrap(),
            vec![
                ("b.xsd".into(), "other".into()),
                ("a.xsd".into(), "new".into())
            ]
        );
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .starts_with("# keep\n"));
    }

    /// Acceptances that happen at the same moment must all survive.
    ///
    /// `accept` reads the whole store, rebuilds it without the URI it is
    /// replacing, appends its own line and renames the result over the file.
    /// Nothing holds the store still between the read and the rename, so a
    /// second writer working from the same snapshot publishes a file that never
    /// contained the first one's line. The loser still returns `Ok`, and on the
    /// CLI path its caller writes an audit record for an acceptance that is not
    /// in the store.
    ///
    /// The loss is fail-open where it counts: the next run finds no contract
    /// for that URI, takes the first-sight branch, and records whatever
    /// fingerprint it sees now - which under `xsdChangePolicy: fail` is exactly
    /// the substitution the feature exists to refuse.
    ///
    /// Same shape as
    /// `schedules::tests::the_store_survives_writers_running_at_the_same_time`,
    /// because it is the same bug and the same fix.
    #[test]
    fn contracts_accepted_at_the_same_moment_all_survive() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_path_buf();

        let threads: Vec<_> = (0..8)
            .map(|i| {
                let ws = ws.clone();
                std::thread::spawn(move || {
                    accept(&ws, &format!("s{i}.xsd"), &format!("{i:064}")).is_ok()
                })
            })
            .collect();
        // `is_ok` rather than `expect`: without the lock the shared temp name
        // can also make a rename fail, and panicking there would report that
        // instead of the count, which is the property under test.
        let reported = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|ok| *ok)
            .count();

        let survived = list(&ws).expect("listed").len();
        assert_eq!(
            survived, 8,
            "{reported} acceptances reported success but {survived} are in the store"
        );
    }

    #[test]
    fn a_missing_store_is_an_empty_store() {
        let temp = tempfile::tempdir().unwrap();
        let ws = temp.path().join("missing");
        assert!(list(&ws).unwrap().is_empty());
        assert_eq!(accepted(&ws, "a.xsd"), None);
    }
}
