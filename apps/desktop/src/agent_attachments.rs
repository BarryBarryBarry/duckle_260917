//! Files the user attaches in the Agent input.
//!
//! Each one is copied into `<workspace>/.duckle/pi-agent/attachments/<conversation>/`
//! when its message is sent, so the conversation keeps what the agent was shown
//! even if the original changes or goes away, and the agent's `read` tool can
//! open it (the bridge allows that folder and nothing else under .duckle). The
//! folder is kept out of git and removed with its conversation.

use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The default per-file limit, in MB, when the workspace's settings do not set
/// one (Settings > Agent attachments). A larger file is refused rather than
/// copied: the agent reads text in pages and could not use most of it, and a
/// mistaken pick should not fill the disk.
pub const DEFAULT_MAX_ATTACHMENT_MB: u32 = 10;

/// Programs, installers, libraries and scripts the OS would run: never a
/// document the agent should read, so they are refused whatever their size.
#[rustfmt::skip]
const BLOCKED_EXTENSIONS: &[&str] = &[
    // Windows programs, installers, libraries and shell scripts
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle",
    "dll", "sys", "drv", "ocx", "efi", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "jse", "wsf", "wsh",
    "hta", "reg", "lnk", "scf", "inf", "gadget", "application",
    // macOS and Linux programs, installers, libraries and shell scripts
    "app", "dmg", "pkg", "mpkg", "command", "dylib", "so", "ko", "sh", "bash", "zsh", "csh", "ksh",
    "fish", "run", "deb", "rpm", "appimage", "snap", "flatpak",
    // Cross-platform executable bundles
    "jar", "war", "ear", "class", "apk", "aab", "xapk", "ipa",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rejection {
    pub path: String,
    pub error: String,
}

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
    max_mb: u32,
) -> Result<Vec<Attachment>, String> {
    let dir = conversation_dir(workspace, conversation_id)?;
    let mut checked = Vec::with_capacity(sources.len());
    for source in sources {
        let src = PathBuf::from(source);
        let size = check_file(&src, max_mb)?;
        checked.push((src, size));
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

/// The picks `attach_files` would refuse, each with why, without copying any;
/// lets the Agent input turn a bad pick away as soon as it is made.
pub fn check_files(sources: &[String], max_mb: u32) -> Vec<Rejection> {
    sources
        .iter()
        .filter_map(|source| {
            check_file(Path::new(source), max_mb).err().map(|error| Rejection {
                path: source.clone(),
                error,
            })
        })
        .collect()
}

/// The file's size if it may be attached.
fn check_file(src: &Path, max_mb: u32) -> Result<u64, String> {
    let source = src.display();
    let meta = std::fs::metadata(src).map_err(|e| format!("{source}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{source} is not a file"));
    }
    if is_blocked_extension(src) || has_executable_signature(src) {
        return Err(format!(
            "{} is an executable file; executable files cannot be attached",
            display_name(src)
        ));
    }
    let max_mb = if max_mb == 0 { DEFAULT_MAX_ATTACHMENT_MB } else { max_mb };
    if meta.len() > u64::from(max_mb) * 1024 * 1024 {
        return Err(format!(
            "{} is {} MB; attachments are limited to {} MB",
            display_name(src),
            meta.len().div_ceil(1024 * 1024),
            max_mb
        ));
    }
    Ok(meta.len())
}

fn is_blocked_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| BLOCKED_EXTENSIONS.contains(&e.as_str()))
}

/// Whether the file starts like a Windows PE, Linux ELF or macOS Mach-O
/// program, so a renamed executable is refused too.
fn has_executable_signature(path: &Path) -> bool {
    let mut head = [0u8; 64];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut len = 0;
    while len < head.len() {
        match file.read(&mut head[len..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => len += n,
        }
    }
    let head = &head[..len];
    if head.starts_with(b"\x7fELF") {
        return true;
    }
    if let Some(magic) = head.get(..4) {
        const MACH_O: [[u8; 4]; 5] = [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
        ];
        if MACH_O.iter().any(|m| m == magic) {
            return true;
        }
    }
    // A text file may well begin with "MZ"; a PE program also has "PE\0\0" at
    // the offset stored at 0x3C.
    if head.starts_with(b"MZ") && head.len() >= 0x40 {
        let offset = u32::from_le_bytes([head[0x3c], head[0x3d], head[0x3e], head[0x3f]]) as u64;
        let mut sig = [0u8; 4];
        return offset <= 64 * 1024 * 1024
            && file.seek(std::io::SeekFrom::Start(offset)).is_ok()
            && file.read_exact(&mut sig).is_ok()
            && &sig == b"PE\0\0";
    }
    false
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
            DEFAULT_MAX_ATTACHMENT_MB,
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
        assert!(attach_files(ws.path(), "c1", &[ok.clone(), missing], 10).is_err());
        let folder = src.path().to_string_lossy().into_owned();
        assert!(attach_files(ws.path(), "c1", &[ok.clone(), folder], 10).unwrap_err().contains("not a file"));
        let big = src.path().join("big.txt");
        std::fs::File::create(&big).unwrap().set_len(10 * 1024 * 1024 + 1).unwrap();
        let big = big.to_string_lossy().into_owned();
        let err = attach_files(ws.path(), "c1", &[ok.clone(), big.clone()], 10).unwrap_err();
        assert!(err.contains("big.txt") && err.contains("10 MB"), "{err}");
        let err = attach_files(ws.path(), "c1", &[ok.clone(), big.clone()], 0).unwrap_err();
        assert!(err.contains("10 MB"), "0 falls back to the default: {err}");
        let exe = src.path().join("setup.EXE");
        std::fs::write(&exe, "x").unwrap();
        let err = attach_files(ws.path(), "c1", &[ok.clone(), exe.to_string_lossy().into_owned()], 10).unwrap_err();
        assert!(err.contains("setup.EXE") && err.contains("executable"), "{err}");
        assert!(!attachments_root(ws.path()).exists(), "nothing copied");

        assert_eq!(attach_files(ws.path(), "c1", &[big], 11).unwrap()[0].size, 10 * 1024 * 1024 + 1);
        assert!(attach_files(ws.path(), "../escape", &[ok], 10).unwrap_err().contains("invalid conversation id"));
    }

    #[test]
    fn executables_are_refused_by_extension_or_content() {
        let src = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = src.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p.to_string_lossy().into_owned()
        };
        let mut pe = vec![0u8; 0x84];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        let blocked = [
            write("tool.exe", b"text"),
            write("install.msi", b"text"),
            write("run.bat", b"echo"),
            write("lib.dylib", b"x"),
            write("renamed.txt", &pe),
            write("program.csv", b"\x7fELF\x02\x01"),
            write("macho.md", &[0xcf, 0xfa, 0xed, 0xfe, 0, 0]),
        ];
        let mut text_mz = b"MZone,region\n".to_vec();
        text_mz.resize(0x60, b' ');
        let allowed = [
            write("spec.md", b"# Migration"),
            write("mapping.xlsx", b"PK\x03\x04"),
            write("mz.csv", &text_mz),
            write("noext", b"plain"),
        ];
        let all: Vec<String> = blocked.iter().chain(allowed.iter()).cloned().collect();
        let rejected: Vec<String> = check_files(&all, 10).into_iter().map(|r| r.path).collect();
        assert_eq!(rejected, blocked.to_vec());
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_file_name("a:b?.csv"), "a_b_.csv");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name("报表 2026.xlsx"), "报表 2026.xlsx");
    }
}
