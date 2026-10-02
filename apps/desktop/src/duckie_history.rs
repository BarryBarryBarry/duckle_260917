//! Chat history for Duckie and the Pi Agent, one JSON file per conversation
//! under `<workspace>/.duckle/<store>/conversations/<id>.json`.
//!
//! Messages are stored as opaque JSON so the frontend can keep its bubble
//! shape (status cards, usage, extracted pipelines) without a schema here.
//! Title and pin state only change through [`update_meta`], and [`save`] never
//! touches them on an existing file, so a message save racing a rename cannot
//! undo it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const TITLE_MAX_CHARS: usize = 120;
const ID_MAX_LEN: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// The DeepSeek Harness ACP session id, used to resume agent context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_session_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub id: String,
    /// Only used when the conversation is created.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub remote_session_id: Option<String>,
    pub messages: Vec<Value>,
}

/// Which assistant a conversation belongs to; each keeps its own folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Duckie,
    PiAgent,
}

impl Store {
    fn folder(self) -> &'static str {
        match self {
            Store::Duckie => "duckie",
            Store::PiAgent => "pi-agent",
        }
    }
}

fn conversations_dir(workspace: &Path, store: Store) -> PathBuf {
    workspace.join(".duckle").join(store.folder()).join("conversations")
}

fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= ID_MAX_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid conversation id: {id:?}"))
    }
}

fn conversation_path(workspace: &Path, store: Store, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(conversations_dir(workspace, store).join(format!("{id}.json")))
}

fn workspace_path(workspace: &str) -> Result<PathBuf, String> {
    let trimmed = workspace.trim();
    if trimmed.is_empty() {
        return Err("open a workspace to keep chat history".into());
    }
    Ok(PathBuf::from(trimmed))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn clean_title(title: &str) -> String {
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(TITLE_MAX_CHARS).collect()
}

fn read(path: &Path) -> Result<Option<Conversation>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write through a temp file + rename so a crash mid-write cannot leave a
/// truncated conversation behind.
fn write(path: &Path, conv: &Conversation) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("no parent for {}", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(conv).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

fn summary(conv: &Conversation) -> ConversationSummary {
    ConversationSummary {
        id: conv.id.clone(),
        title: conv.title.clone(),
        pinned: conv.pinned,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: conv.messages.len(),
    }
}

/// Pinned first, then most recently updated.
pub fn list(workspace: &Path, store: Store) -> Result<Vec<ConversationSummary>, String> {
    let dir = conversations_dir(workspace, store);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut out: Vec<ConversationSummary> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        // One unreadable file must not hide the rest of the history.
        .filter_map(|path| read(&path).ok().flatten())
        .filter(|conv| validate_id(&conv.id).is_ok())
        .map(|conv| summary(&conv))
        .collect();
    out.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

pub fn get(workspace: &Path, store: Store, id: &str) -> Result<Conversation, String> {
    read(&conversation_path(workspace, store, id)?)?
        .ok_or_else(|| format!("conversation {id} not found"))
}

pub fn save(workspace: &Path, store: Store, req: SaveRequest) -> Result<(), String> {
    let path = conversation_path(workspace, store, &req.id)?;
    let now = now_ms();
    let conv = match read(&path)? {
        Some(mut existing) => {
            existing.messages = req.messages;
            if req.remote_session_id.is_some() {
                existing.remote_session_id = req.remote_session_id;
            }
            existing.updated_at = now;
            existing
        }
        None => Conversation {
            id: req.id,
            title: clean_title(&req.title),
            pinned: false,
            created_at: now,
            updated_at: now,
            remote_session_id: req.remote_session_id,
            messages: req.messages,
        },
    };
    write(&path, &conv)
}

pub fn update_meta(
    workspace: &Path,
    store: Store,
    id: &str,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<(), String> {
    let path = conversation_path(workspace, store, id)?;
    let mut conv = read(&path)?.ok_or_else(|| format!("conversation {id} not found"))?;
    if let Some(title) = title {
        let title = clean_title(&title);
        if title.is_empty() {
            return Err("conversation title cannot be empty".into());
        }
        conv.title = title;
    }
    if let Some(pinned) = pinned {
        conv.pinned = pinned;
    }
    write(&path, &conv)
}

pub fn delete(workspace: &Path, store: Store, id: &str) -> Result<(), String> {
    let path = conversation_path(workspace, store, id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", path.display())),
    }
}

// ---- Tauri commands ----------------------------------------------------
// Every mutation returns the refreshed list so the sidebar re-renders from
// one round trip.

#[tauri::command]
pub fn duckie_conversations_list(workspace: String) -> Result<Vec<ConversationSummary>, String> {
    list(&workspace_path(&workspace)?, Store::Duckie)
}

#[tauri::command]
pub fn duckie_conversation_get(workspace: String, id: String) -> Result<Conversation, String> {
    get(&workspace_path(&workspace)?, Store::Duckie, &id)
}

#[tauri::command]
pub fn duckie_conversation_save(
    workspace: String,
    conversation: SaveRequest,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    save(&ws, Store::Duckie, conversation)?;
    list(&ws, Store::Duckie)
}

#[tauri::command]
pub fn duckie_conversation_update_meta(
    workspace: String,
    id: String,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    update_meta(&ws, Store::Duckie, &id, title, pinned)?;
    list(&ws, Store::Duckie)
}

#[tauri::command]
pub fn duckie_conversation_delete(
    workspace: String,
    id: String,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    delete(&ws, Store::Duckie, &id)?;
    list(&ws, Store::Duckie)
}

// The Pi Agent keeps its own history, beside Duckie's.

#[tauri::command]
pub fn agent_conversations_list(workspace: String) -> Result<Vec<ConversationSummary>, String> {
    list(&workspace_path(&workspace)?, Store::PiAgent)
}

#[tauri::command]
pub fn agent_conversation_get(workspace: String, id: String) -> Result<Conversation, String> {
    get(&workspace_path(&workspace)?, Store::PiAgent, &id)
}

#[tauri::command]
pub fn agent_conversation_save(
    workspace: String,
    conversation: SaveRequest,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    save(&ws, Store::PiAgent, conversation)?;
    list(&ws, Store::PiAgent)
}

#[tauri::command]
pub fn agent_conversation_update_meta(
    workspace: String,
    id: String,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    update_meta(&ws, Store::PiAgent, &id, title, pinned)?;
    list(&ws, Store::PiAgent)
}

#[tauri::command]
pub fn agent_conversation_delete(
    workspace: String,
    id: String,
) -> Result<Vec<ConversationSummary>, String> {
    let ws = workspace_path(&workspace)?;
    delete(&ws, Store::PiAgent, &id)?;
    list(&ws, Store::PiAgent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn save_req(id: &str, title: &str, messages: Vec<Value>) -> SaveRequest {
        SaveRequest {
            id: id.into(),
            title: title.into(),
            remote_session_id: None,
            messages,
        }
    }

    #[test]
    fn save_creates_then_updates_without_touching_title_or_pin() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        save(ws, Store::Duckie, save_req("c1", "  First   question ", vec![json!({"role": "user"})])).unwrap();
        update_meta(ws, Store::Duckie, "c1", Some("Renamed".into()), Some(true)).unwrap();

        let mut again = save_req("c1", "ignored on update", vec![json!({}), json!({})]);
        again.remote_session_id = Some("acp-1".into());
        save(ws, Store::Duckie, again).unwrap();

        let conv = get(ws, Store::Duckie, "c1").unwrap();
        assert_eq!(conv.title, "Renamed");
        assert!(conv.pinned);
        assert_eq!(conv.messages.len(), 2);
        assert_eq!(conv.remote_session_id.as_deref(), Some("acp-1"));

        // A later save without a remote id keeps the one already recorded.
        save(ws, Store::Duckie, save_req("c1", "", vec![json!({})])).unwrap();
        assert_eq!(get(ws, Store::Duckie, "c1").unwrap().remote_session_id.as_deref(), Some("acp-1"));
    }

    #[test]
    fn new_titles_are_collapsed_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        save(tmp.path(), Store::Duckie, save_req("c1", "  a \n b  ", vec![])).unwrap();
        assert_eq!(get(tmp.path(), Store::Duckie, "c1").unwrap().title, "a b");
        assert!(update_meta(tmp.path(), Store::Duckie, "c1", Some("   ".into()), None).is_err());
    }

    #[test]
    fn list_puts_pinned_first_then_newest() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        for id in ["old", "pinned", "new"] {
            save(ws, Store::Duckie, save_req(id, id, vec![])).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        update_meta(ws, Store::Duckie, "old", None, Some(false)).unwrap();
        update_meta(ws, Store::Duckie, "pinned", None, Some(true)).unwrap();
        // A broken file is skipped rather than failing the whole list.
        std::fs::write(conversations_dir(ws, Store::Duckie).join("broken.json"), "{").unwrap();

        let ids: Vec<String> = list(ws, Store::Duckie).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["pinned", "new", "old"]);
    }

    #[test]
    fn rejects_ids_that_could_escape_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", "../x", "a/b", "a.b", "x\\y"] {
            assert!(get(tmp.path(), Store::Duckie, bad).is_err(), "{bad:?} should be rejected");
            assert!(delete(tmp.path(), Store::Duckie, bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn delete_is_idempotent_and_missing_history_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list(tmp.path(), Store::Duckie).unwrap().is_empty());
        save(tmp.path(), Store::Duckie, save_req("c1", "t", vec![])).unwrap();
        delete(tmp.path(), Store::Duckie, "c1").unwrap();
        delete(tmp.path(), Store::Duckie, "c1").unwrap();
        assert!(list(tmp.path(), Store::Duckie).unwrap().is_empty());
    }

    #[test]
    fn stores_are_kept_apart() {
        let tmp = tempfile::tempdir().unwrap();
        save(tmp.path(), Store::PiAgent, save_req("c1", "agent", vec![])).unwrap();
        assert!(list(tmp.path(), Store::Duckie).unwrap().is_empty());
        assert_eq!(list(tmp.path(), Store::PiAgent).unwrap()[0].title, "agent");
        assert!(tmp.path().join(".duckle/pi-agent/conversations/c1.json").exists());
    }
}
