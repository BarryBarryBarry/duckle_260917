//! Workspace skills: `<workspace>/.duckle/skills/<name>/SKILL.md`.
//!
//! The Agent input lists them as `/skill:<name>` commands, read from disk on
//! every request so a skill added or edited while the app runs shows up at once.
//! A message that starts with `/skill:<name>` is expanded here, into the same
//! `<skill>` block Pi itself produces. Pi only expands a message that starts
//! with the command, and every message Otter sends starts with its context
//! block, and Pi reads its skills once at startup, so its own expansion would
//! neither see the command nor know a skill added since.

use std::path::{Path, PathBuf};

use serde::Serialize;

const SKILL_FILE: &str = "SKILL.md";
const COMMAND: &str = "/skill:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillInfo {
    /// What follows `/skill:`.
    pub name: String,
    pub description: Option<String>,
    /// The skill's SKILL.md.
    pub path: String,
}

pub fn skills_dir(workspace: &Path) -> PathBuf {
    workspace.join(".duckle").join("skills")
}

/// The workspace's skills, sorted by name, creating the folder if it is missing.
pub fn list_skills(workspace: &Path) -> Result<Vec<SkillInfo>, String> {
    let dir = skills_dir(workspace);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    let mut out: Vec<SkillInfo> = Vec::new();
    for entry in entries.flatten() {
        let folder = entry.path();
        let file = folder.join(SKILL_FILE);
        if !file.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        let meta = parse_frontmatter(&text);
        let Some(name) = [meta.name.as_deref(), Some(folder_name.as_str())]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|n| valid_name(n))
        else {
            continue;
        };
        // The first of two skills declaring one name wins, as in Pi.
        if out.iter().any(|s| s.name == name) {
            continue;
        }
        out.push(SkillInfo {
            name: name.to_string(),
            description: meta.description.filter(|d| !d.is_empty()),
            path: file.to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// A name has to survive being typed after `/skill:` and cut at the first space.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `prompt` with a leading `/skill:<name> [args]` replaced by the skill's
/// instructions, as Pi expands it. Anything else, an unknown skill included,
/// is returned unchanged.
pub fn expand_skill_command(workspace: &Path, prompt: &str) -> String {
    let Some(rest) = prompt.trim_start().strip_prefix(COMMAND) else {
        return prompt.to_string();
    };
    let (name, args) = match rest.find(char::is_whitespace) {
        Some(at) => (&rest[..at], rest[at..].trim()),
        None => (rest, ""),
    };
    let Ok(skills) = list_skills(workspace) else {
        return prompt.to_string();
    };
    let Some(skill) = skills.iter().find(|s| s.name == name) else {
        return prompt.to_string();
    };
    let Ok(text) = std::fs::read_to_string(&skill.path) else {
        return prompt.to_string();
    };
    let base = Path::new(&skill.path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let block = format!(
        "<skill name=\"{}\" location=\"{}\">\nReferences are relative to {}.\n\n{}\n</skill>",
        skill.name,
        skill.path,
        base,
        strip_frontmatter(&text).trim()
    );
    if args.is_empty() {
        block
    } else {
        format!("{block}\n\n{args}")
    }
}

/// The command a restored message was expanded from, so history shows what the
/// user typed rather than the whole skill.
pub fn collapse_skill_block(text: &str) -> Option<String> {
    let rest = text.strip_prefix("<skill name=\"")?;
    let (name, rest) = rest.split_once('"')?;
    let (_, after) = rest.split_once("\n</skill>")?;
    let args = after.trim();
    Some(if args.is_empty() {
        format!("{COMMAND}{name}")
    } else {
        format!("{COMMAND}{name} {args}")
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

/// The YAML frontmatter's lines, when the file opens with one.
fn frontmatter_lines(text: &str) -> Option<(Vec<&str>, &str)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut body_at = text.find('\n')? + 1;
    let mut inner = Vec::new();
    for line in lines {
        body_at += line.len();
        if line.trim_end() == "---" {
            return Some((inner, &text[body_at..]));
        }
        inner.push(line.trim_end_matches(['\n', '\r']));
    }
    None
}

fn strip_frontmatter(text: &str) -> &str {
    frontmatter_lines(text).map(|(_, body)| body).unwrap_or(text)
}

/// `name` and `description` from the frontmatter: plain, quoted, multi-line and
/// block (`|`, `>`) scalars, which is what SKILL.md files use.
fn parse_frontmatter(text: &str) -> Frontmatter {
    let mut out = Frontmatter::default();
    let Some((lines, _)) = frontmatter_lines(text) else {
        return out;
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with([' ', '\t', '#']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        let mut more = Vec::new();
        while i < lines.len() && (lines[i].trim().is_empty() || lines[i].starts_with([' ', '\t'])) {
            more.push(lines[i].trim());
            i += 1;
        }
        while more.last().is_some_and(|l| l.is_empty()) {
            more.pop();
        }
        let parsed = if value.starts_with('|') {
            more.join("\n")
        } else if value.starts_with('>') {
            fold(&more)
        } else {
            let mut all = vec![value];
            all.extend(more.iter().copied());
            unquote(&fold(&all))
        };
        let parsed = parsed.trim().to_string();
        match key {
            "name" => out.name = Some(parsed),
            "description" => out.description = Some(parsed),
            _ => {}
        }
    }
    out
}

/// Joins lines with spaces, a blank line becoming a line break, as YAML folds.
fn fold(lines: &[&str]) -> String {
    let mut out = String::new();
    for line in lines {
        if line.is_empty() {
            out.push('\n');
        } else {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push(' ');
            }
            out.push_str(line);
        }
    }
    out
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        return v[1..v.len() - 1].replace("\\\"", "\"").replace("\\n", "\n").replace("\\\\", "\\");
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(ws: &Path, folder: &str, text: &str) -> PathBuf {
        let dir = skills_dir(ws).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(SKILL_FILE);
        std::fs::write(&file, text).unwrap();
        file
    }

    #[test]
    fn frontmatter_takes_plain_quoted_and_block_values() {
        let fm = parse_frontmatter("---\nname: aio-review\ndescription: Review code.\n---\nbody");
        assert_eq!(fm.name.as_deref(), Some("aio-review"));
        assert_eq!(fm.description.as_deref(), Some("Review code."));

        let fm = parse_frontmatter("---\nname: \"x\"\ndescription: 'it''s: fine'\n---\n");
        assert_eq!((fm.name.as_deref(), fm.description.as_deref()), (Some("x"), Some("it's: fine")));

        let fm = parse_frontmatter("---\ndescription: >\n  Story-driven review\n  for branches.\nmetadata:\n  a: b\n---\n");
        assert_eq!(fm.description.as_deref(), Some("Story-driven review for branches."));

        let fm = parse_frontmatter("---\ndescription: |\n  line one\n  line two\n---\n");
        assert_eq!(fm.description.as_deref(), Some("line one\nline two"));

        let fm = parse_frontmatter("---\ndescription: 对指定方法做逻辑分析\n  覆盖职责\n---\n");
        assert_eq!(fm.description.as_deref(), Some("对指定方法做逻辑分析 覆盖职责"));

        assert_eq!(parse_frontmatter("# no frontmatter"), Frontmatter::default());
        assert_eq!(parse_frontmatter("---\nname: unterminated\n"), Frontmatter::default());
    }

    #[test]
    fn skills_are_listed_from_the_hidden_folder_and_the_folder_is_made() {
        let ws = tempfile::tempdir().unwrap();
        assert!(list_skills(ws.path()).unwrap().is_empty());
        assert!(skills_dir(ws.path()).is_dir(), "listing creates .duckle/skills");

        write_skill(ws.path(), "aio-review", "# no frontmatter\n");
        write_skill(ws.path(), "Method_logic_analysis", "---\ndescription: 方法逻辑分析\n---\nbody");
        write_skill(ws.path(), "folder", "---\nname: declared\ndescription: d\n---\n");
        write_skill(ws.path(), "bad name", "---\nname: also bad\n---\n");
        std::fs::create_dir_all(skills_dir(ws.path()).join("empty")).unwrap();

        let skills = list_skills(ws.path()).unwrap();
        let names: Vec<_> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["aio-review", "declared", "Method_logic_analysis"]);
        assert_eq!(skills[0].description, None);
        assert_eq!(skills[2].description.as_deref(), Some("方法逻辑分析"));
        assert!(skills[1].path.ends_with("folder/SKILL.md"), "{}", skills[1].path);
    }

    #[test]
    fn a_skill_command_expands_like_pi_and_collapses_back() {
        let ws = tempfile::tempdir().unwrap();
        let file = write_skill(ws.path(), "aio-review", "---\nname: aio-review\ndescription: d\n---\n\nDo the review.\n");

        let expanded = expand_skill_command(ws.path(), "/skill:aio-review check src/main.rs");
        let base = file.parent().unwrap().display().to_string();
        assert_eq!(
            expanded,
            format!(
                "<skill name=\"aio-review\" location=\"{}\">\nReferences are relative to {base}.\n\nDo the review.\n</skill>\n\ncheck src/main.rs",
                file.display()
            )
        );
        assert_eq!(collapse_skill_block(&expanded).as_deref(), Some("/skill:aio-review check src/main.rs"));

        let bare = expand_skill_command(ws.path(), "/skill:aio-review");
        assert!(bare.ends_with("Do the review.\n</skill>"), "{bare}");
        assert_eq!(collapse_skill_block(&bare).as_deref(), Some("/skill:aio-review"));

        for unchanged in ["/skill:missing do it", "please /skill:aio-review", "hello"] {
            assert_eq!(expand_skill_command(ws.path(), unchanged), unchanged);
        }
        assert_eq!(collapse_skill_block("hello"), None);
    }
}
