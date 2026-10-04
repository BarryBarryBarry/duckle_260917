//! Plan 003: the run metrics endpoints, `GET /api/metrics/runs` and
//! `GET /api/metrics/events`, and the web editor's `metrics_runs` and
//! `metrics_pipelines` commands.
//!
//! Only the HTTP shape lives here. Parsing, checking and answering belong to
//! `duckle_duckdb_engine::metrics_query`, which the desktop calls too, so the
//! three surfaces answer the same question the same way.

use duckle_duckdb_engine::metrics_query::{self, QueryError};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// `GET /api/metrics/runs`: a status line and the JSON body.
pub(crate) fn runs(workspace: &Path, duckdb: &Path, query: &HashMap<String, String>) -> (&'static str, Value) {
    answer(metrics_query::runs(workspace, duckdb, query))
}

/// `GET /api/metrics/events`.
pub(crate) fn events(workspace: &Path, duckdb: &Path, query: &HashMap<String, String>) -> (&'static str, Value) {
    answer(metrics_query::events(workspace, duckdb, query))
}

/// The editor's `metrics_runs`. Always a 200: a command that fails answers
/// with an object carrying `error` (and `reason`, `status`), which the page
/// shows in place of the table rather than losing to a failed request.
pub(crate) fn editor_runs(workspace: &Path, duckdb: &Path, args: &Value) -> Value {
    let params = metrics_query::params_from_json(args);
    match metrics_query::runs(workspace, duckdb, &params) {
        Ok(v) => v,
        Err(e) => editor_error(&e),
    }
}

pub(crate) fn editor_pipelines(workspace: &Path) -> Value {
    metrics_query::pipelines(workspace)
}

fn answer(result: Result<Value, QueryError>) -> (&'static str, Value) {
    match result {
        Ok(v) => ("200 OK", v),
        Err(e) => (e.status(), e.body()),
    }
}

fn editor_error(e: &QueryError) -> Value {
    let mut body = e.body();
    let code: u16 = e.status().split_whitespace().next().and_then(|c| c.parse().ok()).unwrap_or(500);
    body["status"] = Value::from(code);
    body
}
