//! Saved connections, kept in one DuckDB table at
//! `<workspace>/.duckle/connections.duckdb`.
//!
//! Each row holds the connection's display name, its kind and the few fields a
//! list shows (host, port, database, username), plus the whole connection JSON
//! in `payload`, sealed exactly as the per-connection files used to be: the
//! sensitive fields encrypted with the workspace key and bound to the
//! connection id. So everything downstream of [`crate::load_connection`] reads
//! the same value it always has.
//!
//! Driven through the DuckDB CLI the engine already ships with, one process per
//! call, under a cross-process lock so the desktop, the runner, the scheduler
//! and MCP never open the file at once. Values reach SQL only through
//! [`sql_quote`].
//!
//! `connections/*.json` is the previous home. Any file still there is imported
//! (keeping its id, so every `connectionRef` stays valid; a row already in the
//! table wins) and moved to `.duckle/connections-imported/` the next time the
//! store is opened.

use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const STORE_FILE: &str = ".duckle/connections.duckdb";
const LEGACY_DIR: &str = "connections";
const IMPORTED_DIR: &str = ".duckle/connections-imported";
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_WAIT: Duration = Duration::from_secs(10);
/// Fields a list shows without decrypting anything.
const SUMMARY_KEYS: &[&str] = &["host", "database", "username"];

#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// No DuckDB CLI to drive: not downloaded yet, or not on PATH.
    EngineMissing(PathBuf),
    Other(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::EngineMissing(p) => {
                write!(f, "the DuckDB CLI was not found at {}", p.display())
            }
            StoreError::Other(m) => f.write_str(m),
        }
    }
}

impl From<StoreError> for String {
    fn from(e: StoreError) -> String {
        e.to_string()
    }
}

fn other(e: impl fmt::Display) -> StoreError {
    StoreError::Other(e.to_string())
}

/// One saved connection. `payload` is sealed (secrets encrypted) unless a
/// caller decrypted it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub payload: JsonValue,
    pub created_at: String,
    pub updated_at: String,
}

pub fn store_path(workspace: &Path) -> PathBuf {
    workspace.join(STORE_FILE)
}

/// The DuckDB CLI: `DUCKLE_DUCKDB_BIN`, else a `duckdb` beside this program
/// (how bundles ship it), else `duckdb` on PATH - the order every Duckle
/// program resolves it in.
pub fn duckdb_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("DUCKLE_DUCKDB_BIN")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
    {
        if p.exists() {
            return p;
        }
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        for name in ["duckdb", "duckdb.exe"] {
            let p = dir.join(name);
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from(if cfg!(windows) {
        "duckdb.exe"
    } else {
        "duckdb"
    })
}

/// A connection id is a file-name-safe token; refusing anything else keeps
/// ids that were once file names usable as such.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ---- public operations ---------------------------------------------------------

/// Every saved connection, sealed, by name.
pub fn list(workspace: &Path) -> Result<Vec<StoredConnection>, StoreError> {
    let out = run(
        workspace,
        &format!("{SELECT_ROWS} ORDER BY lower(name), id;"),
    )?;
    rows(&out)
}

/// [`list`], or - with no DuckDB CLI to open the store yet - whatever is
/// still in the old `connections/*.json`.
pub fn list_or_legacy(workspace: &Path) -> Result<Vec<StoredConnection>, String> {
    match list(workspace) {
        Err(StoreError::EngineMissing(_)) => {
            let names = repository_names(workspace);
            let mut found: Vec<StoredConnection> = legacy_files(workspace)
                .into_iter()
                .map(|(id, _, payload)| StoredConnection {
                    name: legacy_name(&names, &id, &payload),
                    kind: payload
                        .get("kind")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string(),
                    id,
                    payload,
                    created_at: String::new(),
                    updated_at: String::new(),
                })
                .collect();
            // The store's own order.
            found.sort_by(|a, b| {
                a.name
                    .to_lowercase()
                    .cmp(&b.name.to_lowercase())
                    .then_with(|| a.id.cmp(&b.id))
            });
            Ok(found)
        }
        other => other.map_err(String::from),
    }
}

/// The sealed payloads of these connections, by id. Ids not saved are absent.
pub fn load_many(
    workspace: &Path,
    ids: &[String],
) -> Result<HashMap<String, JsonValue>, StoreError> {
    let ids: Vec<&String> = ids.iter().filter(|id| valid_id(id)).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let list = ids
        .iter()
        .map(|id| sql_quote(id))
        .collect::<Result<Vec<_>, _>>()?
        .join(", ");
    let out = run(workspace, &format!("{SELECT_ROWS} WHERE id IN ({list});"))?;
    Ok(rows(&out)?.into_iter().map(|c| (c.id, c.payload)).collect())
}

/// One connection, sealed.
pub fn get(workspace: &Path, id: &str) -> Result<Option<StoredConnection>, StoreError> {
    if !valid_id(id) {
        return Ok(None);
    }
    let out = run(
        workspace,
        &format!("{SELECT_ROWS} WHERE id = {};", sql_quote(id)?),
    )?;
    Ok(rows(&out)?.into_iter().next())
}

/// Create or replace a connection from a plaintext payload; its secrets are
/// encrypted before they reach the table, and the workspace key is created on
/// first use.
pub fn save(workspace: &Path, id: &str, name: &str, payload: &JsonValue) -> Result<(), StoreError> {
    let plain = serde_json::to_string(payload).map_err(other)?;
    let sealed = crate::encrypt_payload_json(workspace, id, &plain).map_err(StoreError::Other)?;
    let sealed: JsonValue = serde_json::from_str(&sealed).map_err(other)?;
    save_sealed(workspace, id, name, &sealed)
}

/// Create or replace a connection whose payload is already sealed.
pub fn save_sealed(
    workspace: &Path,
    id: &str,
    name: &str,
    sealed: &JsonValue,
) -> Result<(), StoreError> {
    if !valid_id(id) {
        return Err(StoreError::Other(format!("invalid connection id: {id:?}")));
    }
    if !sealed.is_object() {
        return Err(StoreError::Other(format!(
            "connection '{id}' is not a JSON object"
        )));
    }
    run(workspace, &upsert_sql(id, name, sealed, true)?).map(|_| ())
}

/// Delete a connection. True when there was one.
pub fn delete(workspace: &Path, id: &str) -> Result<bool, StoreError> {
    if !valid_id(id) {
        return Ok(false);
    }
    let q = sql_quote(id)?;
    let out = run(
        workspace,
        &format!("SELECT count(*) AS n FROM connection WHERE id = {q};\nDELETE FROM connection WHERE id = {q};"),
    )?;
    let found = results(&out)?
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next())
        .and_then(|r| r.get("n").and_then(JsonValue::as_u64))
        .unwrap_or(0);
    Ok(found > 0)
}

/// The decrypted connection, leniently: a value that cannot be decrypted
/// (no key yet, a legacy plain value) is returned as stored. For editors;
/// the run-time path is [`crate::load_connection`], which is strict.
pub fn decrypted(workspace: &Path, conn: &StoredConnection) -> JsonValue {
    let text = conn.payload.to_string();
    crate::decrypt_payload_json(workspace, &conn.id, &text)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| conn.payload.clone())
}

/// A payload with its secrets removed, for callers that may not see them.
pub fn redacted(payload: &JsonValue) -> JsonValue {
    let mut v = payload.clone();
    if let Some(map) = v.as_object_mut() {
        map.retain(|k, _| !crate::SENSITIVE_KEYS.contains(&k.as_str()));
    }
    v
}

// ---- SQL -------------------------------------------------------------------------

const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS connection (\
     id VARCHAR NOT NULL PRIMARY KEY, name VARCHAR NOT NULL, kind VARCHAR NOT NULL, \
     host VARCHAR, port BIGINT, database VARCHAR, username VARCHAR, payload VARCHAR NOT NULL, \
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());\n\
     CREATE TABLE IF NOT EXISTS connection_meta (key VARCHAR NOT NULL PRIMARY KEY, value VARCHAR NOT NULL);\n\
     INSERT INTO connection_meta VALUES ('schema_version', '1') ON CONFLICT DO NOTHING;\n";

const SELECT_ROWS: &str = "SELECT id, name, kind, payload, \
     strftime(created_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS created_at, \
     strftime(updated_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS updated_at FROM connection";

/// A SQL string literal. A NUL cannot be represented and is refused.
pub(crate) fn sql_quote(s: &str) -> Result<String, StoreError> {
    if s.contains('\0') {
        return Err(StoreError::Other("a value contains a NUL character".into()));
    }
    Ok(format!("'{}'", s.replace('\'', "''")))
}

fn opt_text(payload: &JsonValue, key: &str) -> Result<String, StoreError> {
    match payload
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => sql_quote(s),
        None => Ok("NULL".into()),
    }
}

fn port_literal(payload: &JsonValue) -> String {
    let port = match payload.get("port") {
        Some(JsonValue::Number(n)) => n.as_i64(),
        Some(JsonValue::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    port.map(|p| p.to_string()).unwrap_or_else(|| "NULL".into())
}

/// `replace`: overwrite a row that exists; otherwise the row already there wins.
fn upsert_sql(
    id: &str,
    name: &str,
    sealed: &JsonValue,
    replace: bool,
) -> Result<String, StoreError> {
    let name = name.trim();
    let name = if name.is_empty() { id } else { name };
    let kind = sealed
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mut cols = vec![sql_quote(id)?, sql_quote(name)?, sql_quote(&kind)?];
    cols.push(opt_text(sealed, SUMMARY_KEYS[0])?);
    cols.push(port_literal(sealed));
    cols.push(opt_text(sealed, SUMMARY_KEYS[1])?);
    cols.push(opt_text(sealed, SUMMARY_KEYS[2])?);
    cols.push(sql_quote(&sealed.to_string())?);
    let conflict = if replace {
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, host = excluded.host, \
         port = excluded.port, database = excluded.database, username = excluded.username, \
         payload = excluded.payload, updated_at = now()"
    } else {
        "ON CONFLICT DO NOTHING"
    };
    Ok(format!(
        "INSERT INTO connection (id, name, kind, host, port, database, username, payload) VALUES ({}) {conflict};",
        cols.join(", ")
    ))
}

// ---- running the CLI ----------------------------------------------------------------

/// The schema, any legacy files, then `sql` - all under the store lock.
fn run(workspace: &Path, sql: &str) -> Result<String, StoreError> {
    let db = store_path(workspace);
    if let Some(dir) = db.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| other(format!("create {}: {e}", dir.display())))?;
    }
    let _lock = StoreLock::acquire(workspace)?;
    let bin = duckdb_bin();
    import_legacy(workspace, &bin, &db)?;
    run_cli(&bin, &db, &format!("{SCHEMA_SQL}{sql}"))
}

fn run_cli(bin: &Path, db: &Path, sql: &str) -> Result<String, StoreError> {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.arg(db)
        .args(["-storage-version", "v1.5.0", "-no-init", "-bail", "-json"]);
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StoreError::EngineMissing(bin.to_path_buf()))
        }
        Err(e) => return Err(other(format!("start {}: {e}", bin.display()))),
    };
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    if let Some(mut stdin) = child.stdin.take() {
        // A CLI that stops early (bad SQL under -bail) closes the pipe; its
        // stderr says why, so a failed write is not the error to report.
        let _ = stdin.write_all(sql.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(other(format!("wait for the DuckDB CLI: {e}"))),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(other(format!(
                "the connection store did not answer within {}s",
                CLI_TIMEOUT.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    let err = err.trim();
    if !status.success() || err.contains("Error") {
        return Err(other(format!(
            "the connection store refused the statement: {}",
            err.chars().take(2000).collect::<String>()
        )));
    }
    Ok(out)
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_string(&mut text);
        }
        text
    })
}

/// Each SELECT's rows, in statement order. The CLI prints nothing at all for
/// an empty result.
fn results(out: &str) -> Result<Vec<Vec<JsonValue>>, StoreError> {
    serde_json::Deserializer::from_str(out)
        .into_iter::<Vec<JsonValue>>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| other(format!("unreadable answer from the connection store: {e}")))
}

fn rows(out: &str) -> Result<Vec<StoredConnection>, StoreError> {
    let last = results(out)?.pop().unwrap_or_default();
    last.into_iter()
        .map(|r| {
            let text = |k: &str| {
                r.get(k)
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let payload = serde_json::from_str(&text("payload")).map_err(|e| {
                other(format!(
                    "connection '{}' holds invalid JSON: {e}",
                    text("id")
                ))
            })?;
            Ok(StoredConnection {
                id: text("id"),
                name: text("name"),
                kind: text("kind"),
                payload,
                created_at: text("created_at"),
                updated_at: text("updated_at"),
            })
        })
        .collect()
}

// ---- importing connections/*.json ------------------------------------------------------

/// Display names from `repository.json`, where connections used to be named.
fn repository_names(workspace: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(workspace.join("repository.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<JsonValue>>(&t).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|it| {
            let id = it.get("id")?.as_str()?;
            let name = it.get("name")?.as_str()?.trim();
            (!name.is_empty()).then(|| (id.to_string(), name.to_string()))
        })
        .collect()
}

/// The parseable `connections/*.json` files: id, path, sealed payload.
fn legacy_files(workspace: &Path) -> Vec<(String, PathBuf, JsonValue)> {
    let Ok(entries) = std::fs::read_dir(workspace.join(LEGACY_DIR)) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !valid_id(&id) {
            continue;
        }
        let Some(value) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<JsonValue>(&t).ok())
        else {
            continue;
        };
        if value.is_object() {
            found.push((id, path, value));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// The repository name, else one in the file, else the database it points at;
/// the generated id is the last resort.
fn legacy_name(names: &HashMap<String, String>, id: &str, payload: &JsonValue) -> String {
    let field = |k: &str| {
        payload
            .get(k)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    names
        .get(id)
        .cloned()
        .or_else(|| field("name"))
        .or_else(|| field("database"))
        .unwrap_or_else(|| id.to_string())
}

/// Move what is left in `connections/` into the table, then out of the way.
/// A file that does not parse is left where it is, to be looked at.
fn import_legacy(workspace: &Path, bin: &Path, db: &Path) -> Result<(), StoreError> {
    let found = legacy_files(workspace);
    if found.is_empty() {
        return Ok(());
    }
    let names = repository_names(workspace);
    let mut sql = String::from(SCHEMA_SQL);
    for (id, _, value) in &found {
        sql.push_str(&upsert_sql(
            id,
            &legacy_name(&names, id, value),
            value,
            false,
        )?);
        sql.push('\n');
    }
    run_cli(bin, db, &sql)?;
    let backup = workspace.join(IMPORTED_DIR);
    std::fs::create_dir_all(&backup)
        .map_err(|e| other(format!("create {}: {e}", backup.display())))?;
    for (id, path, _) in &found {
        let to = backup.join(format!("{id}.json"));
        if std::fs::rename(path, &to).is_err() {
            // Across devices: copy, then remove.
            std::fs::copy(path, &to)
                .map_err(|e| other(format!("back up {}: {e}", path.display())))?;
            let _ = std::fs::remove_file(path);
        }
    }
    // Only when nothing else is in it (Finder's .DS_Store aside).
    let legacy = workspace.join(LEGACY_DIR);
    let only_finder = std::fs::read_dir(&legacy)
        .map(|d| d.flatten().all(|e| e.file_name() == ".DS_Store"))
        .unwrap_or(false);
    if only_finder {
        let _ = std::fs::remove_file(legacy.join(".DS_Store"));
    }
    let _ = std::fs::remove_dir(&legacy);
    Ok(())
}

// ---- the lock --------------------------------------------------------------------------

struct StoreLock {
    _file: File,
}

impl StoreLock {
    /// Wait briefly for whoever has the store: a call takes milliseconds, and
    /// the kernel releases the lock if its holder dies.
    fn acquire(workspace: &Path) -> Result<StoreLock, StoreError> {
        let path = workspace
            .join(".duckle")
            .join("locks")
            .join("store")
            .join("connections-db.lock");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| other(format!("create {}: {e}", dir.display())))?;
        }
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match open_exclusive(&path) {
                Ok(file) => return Ok(StoreLock { _file: file }),
                Err(e) if Instant::now() >= deadline => {
                    return Err(other(format!(
                        "timed out waiting for the connection store: {e}"
                    )))
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(path)
}

#[cfg(unix)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::unix::io::AsRawFd;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    // SAFETY: flock on a descriptor this function owns.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(file)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
