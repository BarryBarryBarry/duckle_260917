//! Database credentials for agent-built pipelines, without the agent ever
//! holding a password.
//!
//! Pipelines reference a saved connection (`connectionRef`), and the password
//! lives encrypted in `<workspace>/connections/<id>.json`. When a run is
//! refused because a saved connection has no password or a wrong one, the
//! tool result carries a `needsCredentials` block. Duckle's chat turns that
//! into a secure form and writes the password into the connection itself, so
//! it never passes through the model, the chat, or its saved history.

use std::path::Path;

use serde_json::{json, Map, Value};

/// Beyond the engine's own `auth` bucket: drivers that report a missing
/// password in words the generic needles do not cover.
const EXTRA_AUTH_NEEDLES: &[&str] = &[
    "no password supplied",
    "using password: no",
    "using password: yes",
    "invalid username/password",
    "ora-01017",
];

const ERROR_EXCERPT_CHARS: usize = 300;

pub const AGENT_NOTE: &str = "The database refused the login for the saved connection(s) in needsCredentials. \
Duckle is now showing the user a secure form to enter the password; the password is stored encrypted in the \
connection and is never shown to you. Tell the user in one short sentence to fill in the form, then STOP and \
wait. Do not ask them to type a password in the chat and do not put one in any pipeline or connection. When the \
user says the credentials are saved, call run_pipeline again with the same arguments.";

pub const INLINE_HINT: &str = "A node failed to authenticate and has no saved connection. Create one with \
create_connection (host, port, database, username - omit the password), set the node's 'connectionRef' to the \
returned id with update_pipeline, and run again: Duckle will then ask the user for the password securely.";

/// The first node property that holds a literal password, as (node id, key).
/// Placeholders (`${...}`), ciphertext and empty values are fine. Only
/// `password` is policed: it is the credential agents were being handed in
/// prompts, and other secret-looking keys have legitimate non-secret uses.
pub fn literal_password_in_nodes(pipeline: &Value) -> Option<(String, String)> {
    let nodes = pipeline.get("nodes")?.as_array()?;
    nodes.iter().find_map(|node| {
        let props = node.pointer("/data/properties")?.as_object()?;
        props.iter().find_map(|(key, value)| {
            let is_password = key.eq_ignore_ascii_case("password");
            let s = value.as_str()?.trim();
            let literal = !s.is_empty() && !s.starts_with("${") && !s.starts_with("enc:");
            (is_password && literal).then(|| {
                let id = node.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
                (id, key.clone())
            })
        })
    })
}

pub fn literal_password_error(node_id: &str, key: &str) -> String {
    format!(
        "node '{node_id}' property '{key}' holds a literal password; secrets must not be written into a pipeline. \
Reference a saved connection instead: call list_connections, or create_connection without the password, \
set the node's 'connectionRef' to its id and leave '{key}' out. Duckle asks the user for the password securely."
    )
}

fn non_empty<'a>(conn: &'a Value, key: &str) -> Option<&'a str> {
    conn.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Secret fields a saved connection still needs: a password when it names a
/// user but has none. Read from the raw file, where a stored password is
/// ciphertext - present, so not missing.
pub fn missing_secrets(conn: &Value) -> Vec<&'static str> {
    if non_empty(conn, "username").is_some() && non_empty(conn, "password").is_none() {
        vec!["password"]
    } else {
        Vec::new()
    }
}

/// Whether a connection is the kind a user signs in to with a password.
fn uses_password(conn: &Value) -> bool {
    conn.get("username").is_some() || conn.get("password").is_some()
}

pub fn connection_name(workspace: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(workspace.join("repository.json")).ok()?;
    let repo: Value = serde_json::from_str(&text).ok()?;
    repo.as_array()?
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get("name").and_then(Value::as_str))
        .map(str::to_string)
}

fn read_raw_connection(workspace: &Path, id: &str) -> Option<Value> {
    let safe = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe {
        return None;
    }
    let text = std::fs::read_to_string(workspace.join("connections").join(format!("{id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

fn is_auth_failure(status: &Value) -> bool {
    if status.get("category").and_then(Value::as_str) == Some("auth") {
        return true;
    }
    let error = status
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    EXTRA_AUTH_NEEDLES.iter().any(|n| error.contains(n))
}

fn excerpt(s: &str) -> String {
    let mut out: String = s.chars().take(ERROR_EXCERPT_CHARS).collect();
    if s.chars().count() > ERROR_EXCERPT_CHARS {
        out.push('…');
    }
    out
}

/// What a failed run needs from the user, if it failed to sign in.
pub struct CredentialFindings {
    /// The `needsCredentials` block, when a saved connection was refused.
    pub needs: Option<Value>,
    /// True when an auth failure hit a node that has no saved connection.
    pub inline_auth_failure: bool,
}

/// Map a run's auth failures back to the saved connections behind them.
/// `pipeline` is the pipeline as written (before connection refs expand), so
/// each node's `connectionRef` is still visible.
pub fn from_run(pipeline: &Value, result: &Value, workspace: &Path) -> CredentialFindings {
    let mut findings = CredentialFindings { needs: None, inline_auth_failure: false };
    if result.get("status").and_then(Value::as_str) == Some("success") {
        return findings;
    }
    let node_status = result.get("nodes").and_then(Value::as_object);
    let any_node_auth = node_status.is_some_and(|m| m.values().any(is_auth_failure));
    // A failure reported only at run level cannot be pinned to one node, so
    // every node that signs in is a suspect.
    let run_level_auth = !any_node_auth && is_auth_failure(result);
    let Some(nodes) = pipeline.get("nodes").and_then(Value::as_array) else {
        return findings;
    };

    let mut by_ref: Map<String, Value> = Map::new();
    for node in nodes {
        let node_id = node.get("id").and_then(Value::as_str).unwrap_or_default();
        let status = node_status.and_then(|m| m.get(node_id));
        let node_failed_auth = status.is_some_and(is_auth_failure);
        if !node_failed_auth && !run_level_auth {
            continue;
        }
        let conn_ref = node
            .pointer("/data/properties/connectionRef")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(conn_ref) = conn_ref else {
            let signs_in = node
                .pointer("/data/properties")
                .is_some_and(|p| p.get("username").is_some() || p.get("host").is_some());
            if node_failed_auth && signs_in {
                findings.inline_auth_failure = true;
            }
            continue;
        };
        let Some(conn) = read_raw_connection(workspace, conn_ref) else {
            continue;
        };
        if !uses_password(&conn) {
            continue;
        }
        let error = status
            .and_then(|s| s.get("error"))
            .or_else(|| result.get("error"))
            .and_then(Value::as_str)
            .map(excerpt);
        let entry = by_ref.entry(conn_ref.to_string()).or_insert_with(|| {
            let missing = non_empty(&conn, "password").is_none();
            json!({
                "connectionRef": conn_ref,
                "name": connection_name(workspace, conn_ref).unwrap_or_else(|| conn_ref.to_string()),
                "kind": conn.get("kind").cloned().unwrap_or(Value::Null),
                "host": conn.get("host").cloned().unwrap_or(Value::Null),
                "port": conn.get("port").cloned().unwrap_or(Value::Null),
                "database": conn.get("database").cloned().unwrap_or(Value::Null),
                "username": conn.get("username").cloned().unwrap_or(Value::Null),
                "fields": ["username", "password"],
                "reason": if missing { "missing" } else { "rejected" },
                "nodes": [],
                "error": error,
            })
        });
        if let Some(list) = entry.get_mut("nodes").and_then(Value::as_array_mut) {
            list.push(json!(node_id));
        }
    }
    if !by_ref.is_empty() {
        findings.needs = Some(json!({ "connections": by_ref.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }));
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(ws: &Path, rel: &str, v: Value) {
        let p = ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
    }

    fn pipeline() -> Value {
        json!({ "nodes": [
            { "id": "src", "data": { "componentId": "src.mysql", "properties": { "connectionRef": "c1", "table": "t" } } },
            { "id": "csv", "data": { "componentId": "snk.csv", "properties": { "path": "out.csv" } } }
        ]})
    }

    #[test]
    fn literal_passwords_are_refused_but_placeholders_pass() {
        let bad = json!({ "nodes": [ { "id": "n1", "data": { "properties": { "host": "h", "password": "hunter2" } } } ] });
        assert_eq!(literal_password_in_nodes(&bad), Some(("n1".into(), "password".into())));
        for ok in ["", "${ENV:DB_PASS}", "enc:v2:abc"] {
            let v = json!({ "nodes": [ { "id": "n1", "data": { "properties": { "password": ok } } } ] });
            assert_eq!(literal_password_in_nodes(&v), None, "{ok:?} should pass");
        }
        assert_eq!(literal_password_in_nodes(&pipeline()), None);
    }

    #[test]
    fn missing_secrets_needs_a_user_without_a_password() {
        assert_eq!(missing_secrets(&json!({ "username": "root" })), vec!["password"]);
        assert_eq!(missing_secrets(&json!({ "username": "root", "password": "" })), vec!["password"]);
        assert!(missing_secrets(&json!({ "username": "root", "password": "enc:v2:x" })).is_empty());
        assert!(missing_secrets(&json!({ "kind": "s3", "bucket": "b" })).is_empty());
    }

    #[test]
    fn an_auth_failure_names_the_saved_connection() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "connections/c1.json", json!({ "kind": "mysql", "host": "db", "port": 3306, "username": "root" }));
        write(ws, "repository.json", json!([ { "id": "c1", "name": "Orders DB", "type": "connection" } ]));
        let result = json!({ "status": "error", "nodes": {
            "src": { "status": "error", "category": "auth", "error": "Access denied for user 'root'@'x' (using password: NO)" },
            "csv": { "status": "skipped" }
        }});
        let f = from_run(&pipeline(), &result, ws);
        let conns = f.needs.unwrap()["connections"].as_array().unwrap().clone();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["connectionRef"], "c1");
        assert_eq!(conns[0]["name"], "Orders DB");
        assert_eq!(conns[0]["reason"], "missing");
        assert_eq!(conns[0]["nodes"], json!(["src"]));
        assert!(!f.inline_auth_failure);
    }

    #[test]
    fn a_wrong_stored_password_is_reported_as_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "connections/c1.json", json!({ "kind": "postgres", "username": "u", "password": "enc:v2:x" }));
        let result = json!({ "status": "error", "nodes": {
            "src": { "status": "error", "error": "FATAL: password authentication failed for user \"u\"", "category": "auth" }
        }});
        let conns = from_run(&pipeline(), &result, ws).needs.unwrap();
        assert_eq!(conns["connections"][0]["reason"], "rejected");
        assert_eq!(conns["connections"][0]["name"], "c1");
    }

    #[test]
    fn other_failures_and_inline_nodes_do_not_ask_for_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        write(ws, "connections/c1.json", json!({ "kind": "mysql", "username": "root" }));
        let syntax = json!({ "status": "error", "nodes": { "src": { "status": "error", "category": "syntax", "error": "Parser Error" } } });
        assert!(from_run(&pipeline(), &syntax, ws).needs.is_none());
        assert!(from_run(&pipeline(), &json!({ "status": "success", "nodes": {} }), ws).needs.is_none());

        let inline = json!({ "nodes": [ { "id": "src", "data": { "properties": { "host": "db", "username": "root" } } } ] });
        let denied = json!({ "status": "error", "nodes": { "src": { "status": "error", "category": "auth", "error": "Access denied" } } });
        let f = from_run(&inline, &denied, ws);
        assert!(f.needs.is_none());
        assert!(f.inline_auth_failure);
    }
}
