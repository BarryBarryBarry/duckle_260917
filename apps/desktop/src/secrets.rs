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
    if !duckle_secrets::store::valid_id(connection_id) {
        return Err(format!("invalid connection id: {connection_id:?}"));
    }
    if password.is_empty() {
        return Err("password is empty".into());
    }
    let saved = duckle_secrets::store::get(workspace, connection_id)?
        .ok_or_else(|| format!("connection '{connection_id}' not found"))?;
    let mut conn = saved.payload;
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
    // Seals the new password; fields already sealed are left as they are.
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
    Ok(duckle_secrets::store::save_sealed(workspace, connection_id, &saved.name, &sealed)?)
}

/// A saved connection as the editor sees it: decrypted, because the editor
/// shows and edits it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// Every saved connection in the workspace's connection store.
#[tauri::command]
pub async fn connection_store_list(workspace: String) -> Result<Vec<SavedConnection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        Ok(duckle_secrets::store::list_or_legacy(ws)?
            .into_iter()
            .map(|c| SavedConnection {
                payload: duckle_secrets::store::decrypted(ws, &c),
                id: c.id,
                name: c.name,
                kind: c.kind,
                created_at: c.created_at,
                updated_at: c.updated_at,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create or replace a saved connection; its secrets are encrypted before
/// they are stored. Answers `true`, so the editor can tell a save from a
/// backend that lacks the command.
#[tauri::command]
pub async fn connection_store_save(
    workspace: String,
    id: String,
    name: String,
    payload: serde_json::Value,
) -> Result<bool, String> {
    if payload.get("kind").and_then(|k| k.as_str()).map(str::trim).filter(|k| !k.is_empty()).is_none() {
        return Err("a connection needs a kind".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        duckle_secrets::store::save(Path::new(&workspace), &id, &name, &payload)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a saved connection. True when there was one.
#[tauri::command]
pub async fn connection_store_delete(workspace: String, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(duckle_secrets::store::delete(Path::new(&workspace), &id)?))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn credentials_are_stored_encrypted_and_resolve_at_run_time() {
        if !std::env::var_os("DUCKLE_DUCKDB_BIN").map(std::path::PathBuf::from).is_some_and(|p| p.is_file()) {
            eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        duckle_secrets::store::save(
            ws,
            "c1",
            "Orders",
            &serde_json::json!({ "kind": "mysql", "host": "db", "port": 3306, "username": "old" }),
        )
        .unwrap();

        set_connection_credentials(ws, "c1", Some(" root "), "s3cret!").unwrap();

        let raw = duckle_secrets::store::get(ws, "c1").unwrap().unwrap();
        assert!(!raw.payload.to_string().contains("s3cret!"), "password stored in clear text: {}", raw.payload);
        assert_eq!(raw.name, "Orders", "the name is kept");
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
