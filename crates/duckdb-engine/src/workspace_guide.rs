//! A workspace's own user guide: `<workspace>/guide/manual.<lang>.md`, with its
//! pictures under `<workspace>/guide/images/`. When a workspace has one, the
//! Guide panel shows it in place of the manual bundled with the app.

use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Map, Value};

pub const GUIDE_DIR: &str = "guide";
const CHINESE_LANG: &str = "zh-CN";
const DEFAULT_LANG: &str = "en";
/// Pictures past this size are left out rather than inlined into the reply.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

fn manual_path(dir: &Path, lang: &str) -> Option<PathBuf> {
    let valid = !lang.is_empty() && lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let path = dir.join(format!("manual.{lang}.md"));
    (valid && path.is_file()).then_some(path)
}

/// The same fallback as the bundled guide: the UI language, then Simplified
/// Chinese for any Chinese variant, then English, then Simplified Chinese.
fn resolve(dir: &Path, lang: Option<&str>) -> Option<(String, PathBuf)> {
    let is_chinese = lang.is_some_and(|l| l.to_ascii_lowercase().starts_with("zh"));
    let candidates = [lang, is_chinese.then_some(CHINESE_LANG), Some(DEFAULT_LANG), Some(CHINESE_LANG)];
    candidates
        .into_iter()
        .flatten()
        .find_map(|l| manual_path(dir, l).map(|p| (l.to_string(), p)))
}

fn mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// `./images/a b.png` or `images/a%20b.png` -> `images/a b.png`, refusing
/// anything that would leave the guide folder.
fn image_rel(src: &str) -> Option<String> {
    let rel = src.trim().trim_start_matches("./");
    let rel = percent_decode(rel);
    if !rel.starts_with("images/") {
        return None;
    }
    let ok = Path::new(&rel).components().all(|c| matches!(c, Component::Normal(_)));
    ok.then_some(rel)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Image sources referenced by Markdown `![alt](src)` and HTML `<img src="...">`.
fn image_sources(markdown: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = markdown;
    while let Some(i) = rest.find("](") {
        let after = &rest[i + 2..];
        let end = after.find(')').unwrap_or(after.len());
        let target = after[..end].trim();
        // `![x](src "title")`: the title is not part of the path.
        let src = target.split_whitespace().next().unwrap_or("").trim_matches(|c| c == '<' || c == '>');
        found.push(src.to_string());
        rest = &after[end..];
    }
    let mut rest = markdown;
    while let Some(i) = rest.find("src=") {
        let after = &rest[i + 4..];
        let quote = after.chars().next();
        if let Some(q @ ('"' | '\'')) = quote {
            let body = &after[1..];
            if let Some(end) = body.find(q) {
                found.push(body[..end].to_string());
            }
        }
        rest = after;
    }
    found
}

/// The workspace's guide for `lang`, or `None` when it has none. The reply is
/// `{ lang, markdown, images }`, `images` mapping each picture the manual
/// references (`images/...`) to a data URL.
pub fn load(workspace: &Path, lang: Option<&str>) -> Result<Option<Value>, String> {
    let dir = workspace.join(GUIDE_DIR);
    let Some((resolved, path)) = resolve(&dir, lang) else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let markdown = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string();

    let mut images = Map::new();
    for src in image_sources(&markdown) {
        let Some(rel) = image_rel(&src) else { continue };
        if images.contains_key(&rel) {
            continue;
        }
        let file = dir.join(&rel);
        let Some(mime) = mime_for(&file) else { continue };
        let Ok(meta) = std::fs::metadata(&file) else { continue };
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&file) {
            images.insert(rel, Value::String(format!("data:{mime};base64,{}", B64.encode(bytes))));
        }
    }
    Ok(Some(json!({ "lang": resolved, "markdown": markdown, "images": images })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_guide_folder_means_none() {
        let ws = tempfile::tempdir().unwrap();
        assert!(load(ws.path(), Some("zh-CN")).unwrap().is_none());
    }

    #[test]
    fn falls_back_by_language_and_inlines_images() {
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(GUIDE_DIR);
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images/a b.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(
            dir.join("manual.zh-CN.md"),
            "# 手册\n![x](./images/a%20b.png \"t\")\n![y](images/missing.png)\n![z](../secret.png)",
        )
        .unwrap();

        let got = load(ws.path(), Some("zh-TW")).unwrap().unwrap();
        assert_eq!(got["lang"], "zh-CN");
        assert!(got["markdown"].as_str().unwrap().starts_with("# 手册"));
        let images = got["images"].as_object().unwrap();
        assert_eq!(images.len(), 1);
        assert!(images["images/a b.png"].as_str().unwrap().starts_with("data:image/png;base64,"));

        // English UI with only a Chinese manual still gets the workspace one.
        assert_eq!(load(ws.path(), Some("en")).unwrap().unwrap()["lang"], "zh-CN");
    }

    #[test]
    fn rejects_odd_language_names() {
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(GUIDE_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(manual_path(&dir, "../x").is_none());
    }
}
