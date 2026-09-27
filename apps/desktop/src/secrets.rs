//! Encryption at rest for saved connection secrets and the cached git PAT.
//!
//! The AES-256-GCM implementation lives in the shared `duckle-secrets` crate
//! (#166 stage 2) so the headless runner resolves saved connections through
//! the exact same decrypt path; this module keeps the desktop-facing Tauri
//! commands and re-exports the primitives `workspace_git.rs` uses.

use std::path::Path;

pub(crate) use duckle_secrets::{decrypt_value, encrypt_value, is_encrypted, workspace_key};

/// Encrypt the sensitive fields of a connection payload JSON before it is
/// written to disk.
#[tauri::command]
pub fn connection_encrypt_payload(
    workspace: String,
    connection_id: String,
    payload_json: String,
) -> Result<String, String> {
    duckle_secrets::encrypt_payload_json(Path::new(&workspace), &connection_id, &payload_json)
}

/// Decrypt the sensitive fields of a connection payload JSON after it is read
/// from disk. If the workspace key is missing, the payload is returned
/// unchanged so plaintext / legacy values still load.
#[tauri::command]
pub fn connection_decrypt_payload(
    workspace: String,
    connection_id: String,
    payload_json: String,
) -> Result<String, String> {
    duckle_secrets::decrypt_payload_json(Path::new(&workspace), &connection_id, &payload_json)
}

/// Store what the user typed into Duckie's credential form straight into a
/// saved connection, encrypted like the connection editor does. This is the
/// only path the password takes: it is never sent to the agent, echoed into
/// the chat, or written to the chat history.
#[tauri::command]
pub fn duckie_connection_set_credentials(
    workspace: String,
    connection_id: String,
    username: Option<String>,
    password: String,
) -> Result<(), String> {
    set_connection_credentials(
        Path::new(&workspace),
        &connection_id,
        username.as_deref(),
        &password,
    )
}

fn set_connection_credentials(
    workspace: &Path,
    connection_id: &str,
    username: Option<&str>,
    password: &str,
) -> Result<(), String> {
    let safe_id = !connection_id.is_empty()
        && connection_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe_id {
        return Err(format!("invalid connection id: {connection_id:?}"));
    }
    if password.is_empty() {
        return Err("password is empty".into());
    }
    let path = workspace
        .join("connections")
        .join(format!("{connection_id}.json"));
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("connection '{connection_id}' not found: {e}"))?;
    let mut conn: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("connection '{connection_id}': {e}"))?;
    let map = conn
        .as_object_mut()
        .ok_or_else(|| format!("connection '{connection_id}' is not an object"))?;
    if let Some(user) = username.map(str::trim).filter(|u| !u.is_empty()) {
        map.insert("username".into(), serde_json::Value::String(user.into()));
    }
    map.insert(
        "password".into(),
        serde_json::Value::String(password.into()),
    );
    let plain = serde_json::to_string(&conn).map_err(|e| e.to_string())?;
    let sealed = duckle_secrets::encrypt_payload_json(workspace, connection_id, &plain)?;
    let sealed: serde_json::Value = serde_json::from_str(&sealed).map_err(|e| e.to_string())?;
    let stored = sealed
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if !is_encrypted(stored) {
        return Err("refusing to store an unencrypted password".into());
    }
    let pretty = serde_json::to_string_pretty(&sealed).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn credentials_are_stored_encrypted_and_resolve_at_run_time() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        std::fs::create_dir_all(ws.join("connections")).unwrap();
        std::fs::write(
            ws.join("connections").join("c1.json"),
            r#"{"kind":"mysql","host":"db","port":3306,"username":"old"}"#,
        )
        .unwrap();

        set_connection_credentials(ws, "c1", Some(" root "), "s3cret!").unwrap();

        let raw = std::fs::read_to_string(ws.join("connections").join("c1.json")).unwrap();
        assert!(!raw.contains("s3cret!"), "password written in clear text: {raw}");
        let loaded = duckle_secrets::load_connection(ws, "c1").unwrap();
        assert_eq!(loaded["password"], "s3cret!");
        assert_eq!(loaded["username"], "root");
        assert_eq!(loaded["host"], "db");
    }

    #[test]
    fn bad_ids_empty_passwords_and_missing_connections_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(set_connection_credentials(tmp.path(), "../x", None, "p").is_err());
        assert!(set_connection_credentials(tmp.path(), "c1", None, "").is_err());
        assert!(set_connection_credentials(tmp.path(), "nope", None, "p").is_err());
    }
}
