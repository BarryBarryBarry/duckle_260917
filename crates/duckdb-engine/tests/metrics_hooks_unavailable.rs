//! Plan 003 Phase 2a: with metrics configured but the store unusable, the run
//! ledger and history behave exactly as they always have.

use duckle_duckdb_engine::history::{append_run_record, load_run_history, RunRecord};
use duckle_duckdb_engine::metrics_bus::{self, DeliveryMode};
use duckle_duckdb_engine::retry;
use std::collections::BTreeMap;

#[test]
fn a_store_without_its_cli_changes_nothing_about_a_run() {
    let ws = tempfile::tempdir().unwrap();
    metrics_bus::configure(ws.path().join("no-duckdb-here"), DeliveryMode::Direct);
    let mut receipt = retry::begin(ws.path(), "run-1", "manual", "orders", "/ws/pipelines/orders.json", "h", None);
    assert_eq!(receipt.state, retry::RUNNING);
    retry::enqueue(ws.path(), &mut receipt, "default", "resource_pool_capacity");
    retry::admitted(ws.path(), &mut receipt, 5);
    retry::finish(ws.path(), receipt, "error", BTreeMap::new());
    let rec = RunRecord {
        run_id: Some("run-1".into()),
        at: chrono::Utc::now().to_rfc3339(),
        status: "error".into(),
        trigger: "manual".into(),
        ..Default::default()
    };
    append_run_record(ws.path(), "orders", rec).expect("the history is still written");
    assert_eq!(load_run_history(ws.path(), "orders").len(), 1);
    let receipts = std::fs::read_dir(retry::dir(ws.path())).unwrap().count();
    assert_eq!(receipts, 1);
    assert!(!ws.path().join(".duckle").join("metrics.duckdb").exists());
    assert!(metrics_bus::flush(std::time::Duration::from_millis(10)));
}
