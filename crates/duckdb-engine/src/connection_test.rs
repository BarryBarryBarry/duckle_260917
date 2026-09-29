//! "Test connection": whether a saved connection reaches its server, and what it
//! can see there.
//!
//! A test runs what a node using the connection runs. The connection is merged
//! onto that node's properties by `duckle_secrets::connection_node_props`, its
//! `${ENV:...}` and `${VAULT:...}` placeholders are resolved as a run resolves
//! them, and the query goes through the source's own reader or driver. So a
//! connection that passes here is one a run can use, and one that fails says
//! what a run would have said.

use crate::{context, plan, sql_escape, DuckdbEngine, EngineError, PipelineDoc};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};

/// Names listed at most. One more is read, to know whether there are more.
const MAX_OBJECTS: usize = 200;

/// What a test found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionTest {
    /// The connection reached its server and signed in.
    pub ok: bool,
    /// One sentence saying so, or why not, with the connection's secrets blanked.
    pub message: String,
    /// Tables and views, or the objects at the top of a bucket, sorted.
    pub objects: Vec<String>,
    /// There are more than `objects` holds.
    pub more: bool,
}

/// How a connection kind is tested.
enum Probe {
    /// A database. `list` names what the login can see as a column called
    /// `name`; `ping` only proves the connection works and is asked when `list`
    /// fails, so a login that may not read the catalog still tests as connected.
    /// Neither has an ORDER BY: a driver caps the query by wrapping it in a
    /// derived table, where SQL Server refuses one, so the names are sorted here.
    Tables { component: &'static str, list: &'static str, ping: &'static str },
    /// An object store: the objects at the top of its bucket.
    Bucket,
    /// An HTTP API: its URL, requested with the headers and auth a node sends.
    Http,
}

/// Tables and views of the catalog an ATTACH source mounts as `duckle_src`,
/// listed by DuckDB, so one query serves every wire family. The server's own
/// catalog schemas are left out: Postgres alone has some 70 views there, which
/// sort ahead of `public` and pushed the user's tables off the list.
const ATTACHED_TABLES: &str = "SELECT schema_name || '.' || table_name AS name FROM duckdb_tables() \
     WHERE database_name = 'duckle_src' AND schema_name NOT IN ('information_schema', 'pg_catalog', \
     'mysql', 'performance_schema', 'sys') UNION ALL SELECT schema_name || '.' || view_name AS name \
     FROM duckdb_views() WHERE database_name = 'duckle_src' AND NOT internal AND schema_name NOT IN \
     ('information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys')";

/// The kinds a test exists for: the ones nodes reference whose connection a
/// test can reach the way a run does.
fn probe(kind: &str) -> Option<Probe> {
    let attached = |component| Some(Probe::Tables { component, list: ATTACHED_TABLES, ping: "SELECT 1 AS ok" });
    match kind {
        "postgres" => attached("src.postgres"),
        "redshift" => attached("src.redshift"),
        "mysql" => attached("src.mysql"),
        "mariadb" => attached("src.mariadb"),
        "sqlserver" => Some(Probe::Tables {
            component: "src.sqlserver",
            list: "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES",
            ping: "SELECT 1 AS ok",
        }),
        "s3" => Some(Probe::Bucket),
        "rest" => Some(Probe::Http),
        _ => None,
    }
}

impl DuckdbEngine {
    /// Test `conn`, a connection payload as the Connections editor holds it.
    pub fn test_connection(&self, conn: &JsonValue) -> ConnectionTest {
        let kind = conn.get("kind").and_then(JsonValue::as_str).unwrap_or("");
        let Some(probe) = probe(kind) else {
            return failed(format!(
                "Testing a {kind} connection is not supported yet. Run a node that uses it instead."
            ));
        };
        let component = match &probe {
            Probe::Tables { component, .. } => *component,
            Probe::Bucket => "src.s3",
            Probe::Http => "src.rest",
        };
        let mut props = match duckle_secrets::connection_node_props(component, conn) {
            Ok(p) => p,
            Err(e) => return failed(e),
        };
        resolve_placeholders(component, &mut props);
        // libpq otherwise waits out the operating system's TCP timeout on a host
        // that does not answer, which is minutes on Linux.
        if matches!(kind, "postgres" | "redshift") && props.get("connectTimeout").is_none() {
            props["connectTimeout"] = json!(10);
        }
        let secrets = secret_values(&props);
        match probe {
            Probe::Tables { component, list, ping } => {
                let format = component.trim_start_matches("src.");
                match self.probe_names(format, &props, list) {
                    Ok(names) => found(names, "table", "visible to this login"),
                    Err(list_err) => match self.probe_names(format, &props, ping) {
                        Ok(_) => ConnectionTest {
                            ok: true,
                            message: blank(
                                &format!("Connected, but the tables could not be listed: {list_err}"),
                                &secrets,
                            ),
                            objects: Vec::new(),
                            more: false,
                        },
                        Err(e) => failed(blank(&e.to_string(), &secrets)),
                    },
                }
            }
            Probe::Bucket => {
                let Some(bucket) = props
                    .get("bucket")
                    .and_then(JsonValue::as_str)
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .map(str::to_string)
                else {
                    return failed("Set a bucket: an S3 connection is tested by listing it.".into());
                };
                let prefix = format!("s3://{bucket}/");
                let sql = format!(
                    "{}SELECT file AS name FROM glob('{}*') LIMIT {};",
                    self.source_prelude("s3", &props),
                    sql_escape(&prefix),
                    MAX_OBJECTS + 1
                );
                match self.run_last_rows(None, &sql) {
                    Ok(rows) => {
                        let names = rows
                            .iter()
                            .filter_map(first_text)
                            .map(|n| n.strip_prefix(&prefix).map(str::to_string).unwrap_or(n))
                            .collect();
                        found(names, "object", &format!("at the top of {bucket}"))
                    }
                    Err(e) => failed(blank(&e.to_string(), &secrets)),
                }
            }
            Probe::Http => match request_url(&props) {
                Ok(r) => ConnectionTest { message: blank(&r.message, &secrets), ..r },
                Err(e) => failed(blank(&e.to_string(), &secrets)),
            },
        }
    }

    /// Run `query` through `src.<format>` as a node would, and return the `name`
    /// column (or the first column) of at most `MAX_OBJECTS + 1` rows.
    fn probe_names(&self, format: &str, props: &JsonValue, query: &str) -> Result<Vec<String>, EngineError> {
        let mut props = props.clone();
        props["query"] = json!(query);
        let rows = match plan::source_select_for_format(format, &props) {
            Some(select) => self.run_last_rows(
                None,
                &format!(
                    "{}SELECT * FROM {} LIMIT {};",
                    self.source_prelude(format, &props),
                    select,
                    MAX_OBJECTS + 1
                ),
            )?,
            None => {
                let out = self.run_driver_probe(format, &props, MAX_OBJECTS + 1)?;
                let path = out.to_string_lossy().replace('\\', "/");
                let rows = self.run_rows(
                    None,
                    &format!("SELECT * FROM read_parquet('{}') LIMIT {};", sql_escape(&path), MAX_OBJECTS + 1),
                );
                let _ = std::fs::remove_file(&out);
                rows?
            }
        };
        Ok(rows.iter().filter_map(first_text).collect())
    }
}

/// Request a REST connection's URL the way `src.rest` requests it: the node's
/// headers, its auth, and a token minted from its client credentials when it
/// has them, through the agent every request uses, so the network policy and
/// the timeouts apply. What answered decides: 401 and 403 refused the
/// credentials and 5xx is the server failing, while any other status reached a
/// server that let the request in - a 404 included, since nodes usually add a
/// path to a base URL.
fn request_url(props: &JsonValue) -> Result<ConnectionTest, EngineError> {
    let Some(url) = props.get("url").and_then(JsonValue::as_str).map(str::trim).filter(|u| !u.is_empty()) else {
        return Ok(failed("Set a base URL: a REST connection is tested by requesting it.".into()));
    };
    let mut headers = plan::headers_from_props(props);
    plan::push_rest_auth(&mut headers, props);
    if let Some(o) = plan::rest_oauth_from_props(props, false)? {
        let (token, _) = crate::connectors::mint_oauth_token(&o)?;
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    let mut req = crate::tls::http_agent().get(url);
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let reached = |code: u16| ConnectionTest {
        ok: true,
        message: if code < 400 {
            format!("Connected. {url} answered HTTP {code}.")
        } else {
            format!("Connected to the server, and {url} itself answered HTTP {code}; fine if nodes add a path to it.")
        },
        objects: Vec::new(),
        more: false,
    };
    Ok(match req.call() {
        Ok(r) => reached(r.status()),
        Err(ureq::Error::Status(code @ (401 | 403), _)) => {
            failed(format!("{url} refused the credentials: HTTP {code}."))
        }
        Err(ureq::Error::Status(code, _)) if code >= 500 => {
            failed(format!("{url} answered with a server error: HTTP {code}."))
        }
        Err(ureq::Error::Status(code, _)) => reached(code),
        Err(e) => failed(format!("{url} could not be reached: {e}")),
    })
}

/// `${ENV:...}` and `${VAULT:...}` in the props, resolved by the passes a run
/// uses, which work on a pipeline: the props ride a one-node pipeline through.
fn resolve_placeholders(component: &str, props: &mut JsonValue) {
    let doc = json!({
        "nodes": [{ "id": "connection_test", "position": { "x": 0, "y": 0 },
                    "data": { "label": "connection_test", "componentId": component,
                              "properties": props.clone() } }],
        "edges": []
    });
    let Ok(mut doc) = serde_json::from_value::<PipelineDoc>(doc) else { return };
    context::apply_env(&mut doc);
    context::apply_vault(&mut doc);
    if let Some(p) = doc.nodes.into_iter().next().and_then(|n| n.data.properties) {
        *props = p;
    }
}

/// The `name` of a row, or its first value, as text.
fn first_text(row: &JsonValue) -> Option<String> {
    let v = row.get("name").or_else(|| row.as_object()?.values().next())?;
    match v {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Null => None,
        other => Some(other.to_string()),
    }
}

/// The connection's secret values, to blank from anything a test reports. A
/// driver error can quote the connection string it was given.
fn secret_values(props: &JsonValue) -> Vec<String> {
    ["password", "secretKey", "accountKey", "sessionToken", "authToken", "clientSecret"]
        .iter()
        .filter_map(|k| props.get(*k).and_then(JsonValue::as_str))
        .filter(|s| s.len() >= 3)
        .map(str::to_string)
        .collect()
}

fn blank(message: &str, secrets: &[String]) -> String {
    secrets.iter().fold(message.to_string(), |m, s| m.replace(s.as_str(), "***"))
}

fn failed(message: String) -> ConnectionTest {
    ConnectionTest { ok: false, message, objects: Vec::new(), more: false }
}

/// A connected result listing `names`: sorted, and cut to `MAX_OBJECTS` with
/// `more` set when there were more than that.
fn found(mut names: Vec<String>, noun: &str, place: &str) -> ConnectionTest {
    names.sort();
    let more = names.len() > MAX_OBJECTS;
    names.truncate(MAX_OBJECTS);
    let message = match (names.len(), more) {
        (0, _) => format!("Connected. No {noun}s {place}."),
        (_, true) => format!("Connected. More than {MAX_OBJECTS} {noun}s {place}; {MAX_OBJECTS} of them are listed."),
        (1, false) => format!("Connected. 1 {noun} {place}."),
        (n, false) => format!("Connected. {n} {noun}s {place}."),
    };
    ConnectionTest { ok: true, message, objects: names, more }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A kind no test exists for says so, and does not claim a result.
    #[test]
    fn a_kind_without_a_test_says_so() {
        let engine = DuckdbEngine::new("no-duckdb-needed".into());
        let r = engine.test_connection(&json!({ "kind": "kafka", "brokers": "b:9092" }));
        assert!(!r.ok);
        assert!(r.message.contains("kafka") && r.message.contains("not supported"), "{}", r.message);
    }

    /// An S3 connection is tested by listing its bucket, so one without a
    /// bucket is refused before anything connects.
    #[test]
    fn an_s3_connection_without_a_bucket_is_refused() {
        let engine = DuckdbEngine::new("no-duckdb-needed".into());
        let r = engine.test_connection(&json!({ "kind": "s3", "accessKey": "a", "secretKey": "b" }));
        assert!(!r.ok);
        assert!(r.message.contains("bucket"), "{}", r.message);
    }

    /// A REST connection is tested by requesting its URL, so one without a URL
    /// is refused before anything is sent.
    #[test]
    fn a_rest_connection_without_a_url_is_refused() {
        let engine = DuckdbEngine::new("no-duckdb-needed".into());
        let r = engine.test_connection(&json!({ "kind": "rest", "authType": "bearer", "authToken": "t0ken" }));
        assert!(!r.ok);
        assert!(r.message.contains("URL"), "{}", r.message);
    }

    #[test]
    fn found_sorts_counts_and_cuts() {
        let r = found(vec!["b".into(), "a".into()], "table", "visible to this login");
        assert_eq!((r.ok, r.objects.clone(), r.more), (true, vec!["a".to_string(), "b".to_string()], false));
        assert_eq!(r.message, "Connected. 2 tables visible to this login.");
        assert_eq!(found(vec![], "object", "at the top of b").message, "Connected. No objects at the top of b.");
        assert_eq!(found(vec!["x".into()], "table", "here").message, "Connected. 1 table here.");
        let many = found((0..=MAX_OBJECTS).map(|i| format!("t{i:04}")).collect(), "table", "here");
        assert!(many.more && many.objects.len() == MAX_OBJECTS, "{}", many.message);
        assert!(many.message.contains("More than 200"), "{}", many.message);
    }

    /// A driver error can quote the connection string; the secret in it is
    /// blanked, and a value too short to be told from ordinary text is not.
    #[test]
    fn secrets_are_blanked_from_a_message() {
        let props = json!({ "password": "hunter22", "secretKey": "s3cr3tKEY", "accessKey": "AKIA", "sessionToken": "x" });
        let secrets = secret_values(&props);
        assert_eq!(
            blank("could not connect: host=h user=u password=hunter22 key s3cr3tKEY", &secrets),
            "could not connect: host=h user=u password=*** key ***"
        );
        assert_eq!(secrets.len(), 2, "the access key id is not a secret, and 'x' is too short: {secrets:?}");
    }

    #[test]
    fn first_text_prefers_name_then_the_first_column() {
        assert_eq!(first_text(&json!({ "ok": 1, "name": "public.t" })).as_deref(), Some("public.t"));
        assert_eq!(first_text(&json!({ "file": "s3://b/x" })).as_deref(), Some("s3://b/x"));
        assert_eq!(first_text(&json!({ "n": 7 })).as_deref(), Some("7"));
        assert_eq!(first_text(&json!({ "name": null })), None);
    }
}
