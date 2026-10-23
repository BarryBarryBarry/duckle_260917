//! The DuckDB CLI's agent mode, with an AI agent's environment in place.
//!
//! DuckDB 2.0 puts its CLI into "agent mode" when an AI agent variable such as
//! `AI_AGENT` is set and stdout is a pipe, unless an output mode flag was given.
//! It then prints a banner on stderr and reports every error as JSON. Duckle
//! drives the CLI through pipes and often runs under such an agent (its MCP
//! server is started by one), so a user read
//! `{"exception_type":"Catalog",...}` where DuckDB's own message belongs.
//!
//! The one test here sets `AI_AGENT` for this test binary, which is its own
//! process, so no other test sees it.

use duckle_duckdb_engine::{DuckdbEngine, PipelineDoc};
use serde_json::json;
use std::path::Path;

/// A CSV source feeding a SQL step that reads a table which does not exist.
fn failing_pipeline(csv: &str) -> PipelineDoc {
    serde_json::from_value(json!({
        "nodes": [
            { "id": "s", "position": { "x": 0, "y": 0 },
              "data": { "label": "s", "componentId": "src.csv", "properties": { "path": csv, "hasHeader": true } } },
            { "id": "q", "position": { "x": 0, "y": 0 },
              "data": { "label": "q", "componentId": "code.sql",
                        "properties": { "sql": "SELECT * FROM duckle_no_such_table", "rawSql": true } } }
        ],
        "edges": [ { "id": "e", "source": "s", "target": "q", "data": { "connectionType": "main" } } ]
    }))
    .unwrap()
}

#[test]
fn an_error_reads_as_duckdb_wrote_it_under_an_ai_agent() {
    let Some(bin) = std::env::var("DUCKLE_DUCKDB_BIN").ok().filter(|b| Path::new(b).exists()) else {
        eprintln!("skipping: set DUCKLE_DUCKDB_BIN to run");
        return;
    };
    std::env::set_var("AI_AGENT", "duckle-test");
    std::env::remove_var("DUCKDB_AGENT_MODE");
    let engine = DuckdbEngine::new(bin.into());
    let tmp = tempfile::tempdir().unwrap();
    let csv = tmp.path().join("in.csv");
    std::fs::write(&csv, "id\n1\n").unwrap();
    let doc = failing_pipeline(&csv.to_string_lossy().replace('\\', "/"));

    let expect_plain = |path: &str, error: Option<String>| {
        let error = error.unwrap_or_default();
        assert!(error.contains("Catalog Error"), "{path}: not DuckDB's own message: {error}");
        assert!(
            !error.contains("exception_type") && !error.contains("agent mode"),
            "{path}: the CLI answered in agent mode: {error}"
        );
    };
    // Batched: a whole pure-SQL pipeline in one CLI session.
    let r = engine.execute_pipeline(&doc);
    assert_eq!(r.status, "error");
    expect_plain("batched", r.error);
    // Per-stage: naming a target defeats batching, so each stage is its own CLI.
    let r = engine.execute_pipeline_with_events(&doc, Some("q"), None, |_| {});
    assert_eq!(r.status, "error");
    expect_plain("per-stage", r.error);

    // The third way in: a REST fan-out spills its parent rows with a statement
    // of its own. The SQL step before it is a view, so its bad cast only fails
    // when that statement reads it. Port 1 never answers, but no request goes
    // out: the spill fails first.
    let doc: PipelineDoc = serde_json::from_value(json!({
        "nodes": [
            { "id": "s", "position": { "x": 0, "y": 0 },
              "data": { "label": "s", "componentId": "src.csv", "properties": { "path": csv.to_string_lossy().replace('\\', "/"), "hasHeader": true } } },
            { "id": "bad", "position": { "x": 0, "y": 0 },
              "data": { "label": "bad", "componentId": "code.sql", "properties": { "sql": "SELECT CAST('not a number' AS INTEGER) AS id FROM s" } } },
            { "id": "c", "position": { "x": 0, "y": 0 },
              "data": { "label": "c", "componentId": "src.rest", "properties": {
                  "url": "http://127.0.0.1:1/x", "urlTemplate": "http://127.0.0.1:1/c/{id}", "parentKeyColumn": "id" } } }
        ],
        "edges": [
            { "id": "e1", "source": "s", "target": "bad", "data": { "connectionType": "main" } },
            { "id": "e2", "source": "bad", "target": "c", "data": { "connectionType": "main" } }
        ]
    }))
    .unwrap();
    let r = engine.execute_pipeline(&doc);
    assert_eq!(r.status, "error");
    let error = r.error.unwrap_or_default();
    assert!(error.contains("Conversion Error"), "spill: not DuckDB's own message: {error}");
    assert!(!error.contains("agent mode"), "spill: the CLI answered in agent mode: {error}");
}
