//! Plan 003 Phase 2a: the run ledger and run history reach the metrics store
//! through the process-wide bus, configured here once for direct delivery.

use duckle_duckdb_engine::history::{append_run_record, load_run_history, RunRecord};
use duckle_duckdb_engine::metrics_bus::{self, DeliveryMode};
use duckle_duckdb_engine::metrics_model::{NodeStatus, RunStatus};
use duckle_duckdb_engine::metrics_store::{EventQuery, MetricsStore, RunQuery};
use duckle_duckdb_engine::retry::{self, ReceiptNode};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn cli() -> Option<PathBuf> {
    let bin = std::env::var_os("DUCKLE_DUCKDB_BIN").map(PathBuf::from).filter(|p| p.is_file())?;
    metrics_bus::configure(bin.clone(), DeliveryMode::Direct);
    Some(bin)
}

macro_rules! cli_or_skip {
    () => {
        match cli() {
            Some(c) => c,
            None => {
                eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
                return;
            }
        }
    };
}

fn node(status: &str, kind: &str, rows: u64) -> ReceiptNode {
    ReceiptNode { status: status.into(), kind: Some(kind.into()), output_cache_key: None, rows: Some(rows), duration_ms: Some(3) }
}

fn store(bin: &Path, ws: &Path) -> MetricsStore {
    MetricsStore::open(ws, bin).expect("store")
}

#[test]
fn a_queued_run_goes_from_begin_to_its_record_through_the_ledger() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let mut receipt = retry::begin(ws.path(), "run-1", "scheduled", "Orders", "/ws/pipelines/orders.json", "h", None);
    let s = store(&bin, ws.path());
    assert_eq!(s.run_states().unwrap()["run-1"], RunStatus::Running, "begin is in the store before any work");
    assert_eq!(metrics_bus::workspace_of("run-1").as_deref(), Some(ws.path()));

    retry::enqueue(ws.path(), &mut receipt, "default", "resource_pool_capacity");
    assert_eq!(s.run_states().unwrap()["run-1"], RunStatus::Queued);
    retry::admitted(ws.path(), &mut receipt, 250);
    let nodes = BTreeMap::from([("src".to_string(), node("ok", "view", 9)), ("out".to_string(), node("ok", "sink", 7))]);
    retry::finish(ws.path(), receipt, "ok", nodes);
    assert_eq!(metrics_bus::workspace_of("run-1"), None);

    let mut record = RunRecord {
        run_id: Some("run-1".into()),
        at: chrono::Utc::now().to_rfc3339(),
        status: "ok".into(),
        duration_ms: 1234,
        rows: 7,
        node_count: 2,
        trigger: "scheduled".into(),
        ..Default::default()
    };
    record.rejected_rows = Some(0);
    append_run_record(ws.path(), "orders", record).expect("history written");
    assert_eq!(load_run_history(ws.path(), "orders").len(), 1, "the history is unchanged by the hook");

    let r = s.query_runs(&RunQuery { run_key: Some("run-1".into()), limit: 1, ..Default::default() }).unwrap().runs;
    let r = &r[0];
    assert_eq!((r.status, r.pipeline_id.as_str(), r.pipeline_name.as_deref()), (RunStatus::Ok, "orders", Some("Orders")));
    assert_eq!((r.queue_ms, r.duration_ms, r.rows, r.rejected_rows), (Some(250), Some(1234), Some(7), Some(0)));
    let n = s.query_nodes(&["run-1".to_string()]).unwrap();
    assert!(n.iter().all(|n| n.status == NodeStatus::Ok), "{n:?}");
    let ev = s.query_events(&EventQuery { limit: 10, ..Default::default() }).unwrap();
    let kinds: Vec<&str> = ev.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds.len(), 2, "{ev:?}");
    assert!(kinds.contains(&"run_started") && kinds.contains(&"run_finished"));
}

#[test]
fn a_record_without_a_run_id_is_not_published() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let record = RunRecord { at: chrono::Utc::now().to_rfc3339(), status: "ok".into(), trigger: "manual".into(), ..Default::default() };
    append_run_record(ws.path(), "orders", record).unwrap();
    assert!(!ws.path().join(".duckle").join("metrics.duckdb").exists(), "nothing to key it by, so nothing written");
    let _ = bin;
}

#[test]
fn reconcile_closes_an_abandoned_run_as_interrupted() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let receipt = retry::begin(ws.path(), "run-dead", "manual", "orders", "/ws/pipelines/orders.json", "h", None);
    drop(receipt);
    // Nothing is alive, so the receipt this process just wrote reads as abandoned.
    let changed = retry::reconcile(ws.path(), &|_| false);
    assert_eq!(changed, ["run-dead"]);
    let s = store(&bin, ws.path());
    let r = s.query_runs(&RunQuery { run_key: Some("run-dead".into()), limit: 1, ..Default::default() }).unwrap().runs;
    assert_eq!(r[0].status, RunStatus::Interrupted);
    assert_eq!((r[0].duration_ms, r[0].rows), (None, None), "the zeroed history record did not overwrite it");
    assert_eq!(load_run_history(ws.path(), "orders")[0].status, "interrupted", "the history still gets its record");
}
