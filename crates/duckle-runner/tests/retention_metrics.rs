//! Plan 003: `duckle-runner retention prune --metrics-days N` bounds the run
//! metrics store, previews exactly what it then does, and never deletes the
//! store's file.

use duckle_duckdb_engine::metrics_model::{NodeRunPatch, PipelineRunPatch, RunStatus};
use duckle_duckdb_engine::metrics_store::MetricsStore;
use std::path::{Path, PathBuf};
use std::process::Command;

fn cli() -> Option<PathBuf> {
    std::env::var_os("DUCKLE_DUCKDB_BIN").map(PathBuf::from).filter(|p| p.is_file())
}

fn prune(ws: &Path, extra: &[&str]) -> (i32, serde_json::Value, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_duckle-runner"))
        .args(["retention", "prune", "--json", "--workspace"])
        .arg(ws)
        .args(extra)
        .env_remove("DUCKLE_DUCKDB_BIN")
        .output()
        .expect("runs");
    let body = serde_json::from_slice(&out.stdout).unwrap_or_default();
    (out.status.code().unwrap_or(-1), body, String::from_utf8_lossy(&out.stderr).into_owned())
}

fn seed(store: &MetricsStore, key: &str, days_ago: i64) {
    store
        .apply_run_patch(&PipelineRunPatch {
            run_key: key.into(),
            pipeline_id: Some("orders".into()),
            status: Some(RunStatus::Ok),
            started_at: Some((chrono::Utc::now() - chrono::Duration::days(days_ago)).to_rfc3339()),
            ..Default::default()
        })
        .unwrap();
    store
        .apply_node_patches(&[
            NodeRunPatch { run_key: key.into(), node_id: "a".into(), ..Default::default() },
            NodeRunPatch { run_key: key.into(), node_id: "b".into(), ..Default::default() },
        ])
        .unwrap();
    store.ensure_run_started_event(key).unwrap();
}

#[test]
fn the_dry_run_and_the_prune_agree_and_the_file_stays() {
    let Some(bin) = cli() else {
        eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
        return;
    };
    let ws = tempfile::tempdir().unwrap();
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    seed(&store, "old", 40);
    seed(&store, "new", 1);
    let duckdb = bin.to_string_lossy().into_owned();
    let args = ["--metrics-days", "30", "--duckdb", duckdb.as_str()];

    let (code, preview, err) = prune(ws.path(), &[&args[..], &["--dry-run"]].concat());
    assert_eq!(code, 0, "{err}");
    assert_eq!((preview["metrics"]["runs"].clone(), preview["metrics"]["nodes"].clone()), (1.into(), 2.into()));
    assert_eq!(store.run_states().unwrap().len(), 2, "a dry run removes nothing");

    let (code, done, err) = prune(ws.path(), &args);
    assert_eq!(code, 0, "{err}");
    assert_eq!(done["metrics"]["runs"], preview["metrics"]["runs"]);
    assert_eq!(done["metrics"]["nodes"], preview["metrics"]["nodes"]);
    assert_eq!(done["metrics"]["events"], preview["metrics"]["events"]);
    let left: Vec<String> = store.run_states().unwrap().into_keys().collect();
    assert_eq!(left, ["new"]);
    assert!(store.db_path().is_file(), "the store's file is never deleted");
}

#[test]
fn metrics_retention_without_a_duckdb_says_so_and_does_nothing() {
    let ws = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(ws.path().join("logs")).unwrap();
    let (code, _, err) = prune(ws.path(), &["--metrics-days", "30", "--duckdb", "/no/such/duckdb"]);
    assert_eq!(code, 2);
    assert!(err.contains("--metrics-days needs the DuckDB CLI"), "{err}");
}

#[test]
fn a_prune_that_does_not_ask_about_metrics_reports_none() {
    let ws = tempfile::tempdir().unwrap();
    let (code, body, err) = prune(ws.path(), &["--dry-run"]);
    assert_eq!(code, 0, "{err}");
    assert!(body["metrics"].is_null(), "{body}");
}
