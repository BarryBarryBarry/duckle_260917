//! Files the user attaches in the Agent input.
//!
//! Each one is copied into `<workspace>/.duckle/pi-agent/attachments/<conversation>/`
//! when its message is sent, so the conversation keeps what the agent was shown
//! even if the original changes or goes away, and the agent's `read` tool can
//! open it (the bridge allows that folder and nothing else under .duckle). The
//! folder is kept out of git and removed with its conversation.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A larger file is refused rather than copied: the agent reads text in pages
/// and could not use most of it, and a mistaken pick should not fill the disk.
pub const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    /// The file name as the user knows it.
    pub name: String,
    /// The copy the agent reads.
    pub path: String,
    pub size: u64,
}

pub fn attachments_root(workspace: &Path) -> PathBuf {
    workspace.join(".duckle").join("pi-agent").join("attachments")
}

fn conversation_dir(workspace: &Path, conversation_id: &str) -> Result<PathBuf, String> {
    let ok = !conversation_id.is_empty()
        && conversation_id.len() <= 80
        && conversation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(format!("invalid conversation id: {conversation_id:?}"));
    }
    Ok(attachments_root(workspace).join(conversation_id))
}

/// Copy `sources` into the conversation's attachment folder. All are checked
/// before any is copied, so one bad pick does not leave the others behind.
pub fn attach_files(
    workspace: &Path,
    conversation_id: &str,
    sources: &[String],
) -> Result<Vec<Attachment>, String> {
    let dir = conversation_dir(workspace, conversation_id)?;
    let mut checked = Vec::with_capacity(sources.len());
    for source in sources {
        let src = PathBuf::from(source);
        let meta = std::fs::metadata(&src).map_err(|e| format!("{source}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{source} is not a file"));
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "{} is {} MB; attachments are limited to {} MB",
                display_name(&src),
                meta.len().div_ceil(1024 * 1024),
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ));
        }
        checked.push((src, meta.len()));
    }
    if checked.is_empty() {
        return Ok(Vec::new());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let mut out = Vec::with_capacity(checked.len());
    for (src, size) in checked {
        let name = display_name(&src);
        let dest = unique_path(&dir, &safe_file_name(&name));
        std::fs::copy(&src, &dest).map_err(|e| format!("copy {}: {e}", src.display()))?;
        out.push(Attachment {
            name,
            path: dest.to_string_lossy().into_owned(),
            size,
        });
    }
    Ok(out)
}

/// Remove a conversation's attachments; a conversation without any is fine.
pub fn remove_conversation(workspace: &Path, conversation_id: &str) -> Result<(), String> {
    let dir = conversation_dir(workspace, conversation_id)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", dir.display())),
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "attachment".to_string())
}

/// A name every filesystem takes: no separators, reserved or control characters.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `name`, or `stem (2).ext`, `stem (3).ext`, ... when it is taken.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("an unused name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_copied_under_the_conversation_and_kept_apart() {
        let src = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let a = src.path().join("orders.csv");
        std::fs::write(&a, "id,amount\n1,10\n").unwrap();
        let other = src.path().join("sub");
        std::fs::create_dir_all(&other).unwrap();
        let b = other.join("orders.csv");
        std::fs::write(&b, "id\n2\n").unwrap();

        let got = attach_files(
            ws.path(),
            "c-1-ab",
            &[a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()],
        )
        .unwrap();
        let dir = attachments_root(ws.path()).join("c-1-ab");
        assert_eq!(got[0].name, "orders.csv");
        assert_eq!(got[0].size, 15);
        assert_eq!(PathBuf::from(&got[0].path), dir.join("orders.csv"));
        assert_eq!(PathBuf::from(&got[1].path), dir.join("orders (2).csv"), "a second file of one name is kept");
        assert_eq!(std::fs::read_to_string(&got[1].path).unwrap(), "id\n2\n");

        remove_conversation(ws.path(), "c-1-ab").unwrap();
        assert!(!dir.exists());
        remove_conversation(ws.path(), "c-1-ab").unwrap();
    }

    #[test]
    fn bad_picks_copy_nothing() {
        let src = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let ok = src.path().join("ok.txt");
        std::fs::write(&ok, "x").unwrap();
        let ok = ok.to_string_lossy().into_owned();

        let missing = src.path().join("missing.txt").to_string_lossy().into_owned();
        assert!(attach_files(ws.path(), "c1", &[ok.clone(), missing]).is_err());
        let folder = src.path().to_string_lossy().into_owned();
        assert!(attach_files(ws.path(), "c1", &[ok.clone(), folder]).unwrap_err().contains("not a file"));
        let big = src.path().join("big.bin");
        std::fs::File::create(&big).unwrap().set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        let err = attach_files(ws.path(), "c1", &[ok.clone(), big.to_string_lossy().into_owned()]).unwrap_err();
        assert!(err.contains("big.bin") && err.contains("50 MB"), "{err}");
        assert!(!attachments_root(ws.path()).exists(), "nothing copied");

        assert!(attach_files(ws.path(), "../escape", &[ok]).unwrap_err().contains("invalid conversation id"));
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_file_name("a:b?.csv"), "a_b_.csv");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name("报表 2026.xlsx"), "报表 2026.xlsx");
    }
}
