use super::*;
use crate::metrics_model::NodeStatus;
use crate::metrics_store::RunQuery;
use std::path::PathBuf;

fn cli() -> Option<PathBuf> {
    std::env::var_os("DUCKLE_DUCKDB_BIN").map(PathBuf::from).filter(|p| p.is_file())
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

fn record(run_id: Option<&str>, at: &str, status: &str) -> RunRecord {
    RunRecord {
        run_id: run_id.map(str::to_string),
        at: at.into(),
        status: status.into(),
        duration_ms: 1000,
        rows: 5,
        node_count: 1,
        trigger: "scheduled".into(),
        nodes: vec![crate::history::NodeMetric {
            node: "a".into(),
            status: Some("ok".into()),
            rows: Some(5),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn open_run(store: &MetricsStore, key: &str) {
    store
        .apply_run_patch(&PipelineRunPatch {
            run_key: key.into(),
            pipeline_id: Some("orders".into()),
            trigger: Some("manual".into()),
            status: Some(RunStatus::Running),
            started_at: Some(Utc::now().to_rfc3339()),
            ..Default::default()
        })
        .unwrap();
    store
        .apply_node_patches(&[NodeRunPatch { run_key: key.into(), node_id: "placed".into(), ..Default::default() }])
        .unwrap();
}

fn status_of(store: &MetricsStore, key: &str) -> Option<RunStatus> {
    store.run_states().unwrap().get(key).copied()
}

fn recent(secs_ago: i64) -> String {
    (Utc::now() - chrono::Duration::seconds(secs_ago)).to_rfc3339()
}

#[test]
fn history_fills_an_empty_store_once() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let (old_at, new_at) = (recent(120), recent(60));
    crate::history::append_run_record(ws.path(), "orders", record(None, &old_at, "ok")).unwrap();
    crate::history::append_run_record(ws.path(), "orders", record(Some("run-2"), &new_at, "error")).unwrap();
    let r = run(ws.path(), &bin, None).unwrap();
    assert_eq!((r.recorded, r.finished, r.interrupted), (2, 0, 0));

    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    let legacy = metrics_bus::legacy_run_key("orders", &old_at);
    assert_eq!(status_of(&store, &legacy), Some(RunStatus::Ok), "a record without an id gets a stable key");
    assert_eq!(status_of(&store, "run-2"), Some(RunStatus::Error));
    let nodes = |k: &str| store.query_nodes(&[k.to_string()]).unwrap();
    assert!(nodes(&legacy).is_empty(), "the history keeps node detail on its newest record only");
    assert_eq!(nodes("run-2")[0].status, NodeStatus::Ok);
    let events = store.query_events(&crate::metrics_store::EventQuery { limit: 10, ..Default::default() }).unwrap();
    assert_eq!(events.len(), 4, "a start and a finish for each run");

    let before = store.query_runs(&RunQuery { limit: 10, ..Default::default() }).unwrap().runs;
    let again = run(ws.path(), &bin, None).unwrap();
    assert_eq!(again.recorded, 0, "a run already final is not written again");
    let after = store.query_runs(&RunQuery { limit: 10, ..Default::default() }).unwrap().runs;
    assert_eq!(before, after, "nothing changed, updated_at included");
}

#[test]
fn records_older_than_the_horizon_are_left_out() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let ancient = (Utc::now() - chrono::Duration::days(40)).to_rfc3339();
    crate::history::append_run_record(ws.path(), "orders", record(Some("old"), &ancient, "ok")).unwrap();
    crate::history::append_run_record(ws.path(), "orders", record(Some("new"), &recent(5), "ok")).unwrap();
    let r = run(ws.path(), &bin, Some(horizon(30))).unwrap();
    assert_eq!(r.recorded, 1);
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    assert_eq!(status_of(&store, "old"), None);
}

#[test]
fn an_open_run_is_closed_by_its_history_record() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    open_run(&store, "run-1");
    crate::history::append_run_record(ws.path(), "orders", record(Some("run-1"), &recent(1), "ok")).unwrap();
    let r = run(ws.path(), &bin, None).unwrap();
    assert_eq!(r.recorded, 1);
    assert_eq!(status_of(&store, "run-1"), Some(RunStatus::Ok));
    let nodes = store.query_nodes(&["run-1".to_string()]).unwrap();
    let placed = nodes.iter().find(|n| n.node_id == "placed").unwrap();
    assert_eq!(placed.status, NodeStatus::Skipped, "a stage the record never reached is closed");
}

#[test]
fn an_open_run_with_no_record_is_settled_from_its_receipt() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    // Finished in the ledger, never recorded.
    let done = crate::retry::begin(ws.path(), "run-done", "manual", "orders", "/ws/pipelines/orders.json", "h", None);
    crate::retry::finish(ws.path(), done, "cancelled", Default::default());
    // Its process is gone.
    let mut dead = crate::retry::begin(ws.path(), "run-dead", "manual", "orders", "/ws/pipelines/orders.json", "h", None);
    dead.pid = Some(4_000_000);
    crate::retry::write(ws.path(), &dead).unwrap();
    // This process is running it.
    crate::retry::begin(ws.path(), "run-live", "manual", "orders", "/ws/pipelines/orders.json", "h", None);
    for key in ["run-done", "run-dead", "run-live", "run-noreceipt"] {
        open_run(&store, key);
    }
    let r = run(ws.path(), &bin, None).unwrap();
    assert_eq!((r.finished, r.interrupted), (1, 2));
    assert_eq!(status_of(&store, "run-done"), Some(RunStatus::Cancelled));
    assert_eq!(status_of(&store, "run-dead"), Some(RunStatus::Interrupted));
    assert_eq!(status_of(&store, "run-noreceipt"), Some(RunStatus::Interrupted));
    assert_eq!(status_of(&store, "run-live"), Some(RunStatus::Running), "a live process's run is its own");
}

#[test]
fn a_rebuilt_store_is_refilled_and_the_flag_cleared() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    crate::history::append_run_record(ws.path(), "orders", record(Some("run-1"), &recent(1), "ok")).unwrap();
    let db = ws.path().join(crate::metrics_store::METRICS_DB_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    std::fs::write(&db, "not a database").unwrap();
    let r = run(ws.path(), &bin, None).unwrap();
    assert!(r.was_rebuild);
    assert_eq!(r.recorded, 1);
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    assert!(!store.needs_backfill().unwrap());
    assert!(!run(ws.path(), &bin, None).unwrap().was_rebuild);
}

#[test]
fn an_unreadable_history_file_is_skipped_not_fatal() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    crate::history::append_run_record(ws.path(), "orders", record(Some("run-1"), &recent(1), "ok")).unwrap();
    std::fs::write(ws.path().join("runs").join("broken.json"), "{ not json").unwrap();
    let r = run(ws.path(), &bin, None).unwrap();
    assert_eq!((r.recorded, r.unreadable_files), (1, 1));
}

#[test]
fn startup_prunes_past_the_default_horizon() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let store = MetricsStore::open(ws.path(), &bin).unwrap();
    store
        .apply_run_patch(&PipelineRunPatch {
            run_key: "ancient".into(),
            pipeline_id: Some("orders".into()),
            status: Some(RunStatus::Ok),
            started_at: Some((Utc::now() - chrono::Duration::days(45)).to_rfc3339()),
            ..Default::default()
        })
        .unwrap();
    at_startup(ws.path(), &bin, false);
    assert_eq!(status_of(&store, "ancient"), Some(RunStatus::Ok), "no pruning when not asked to");
    at_startup(ws.path(), &bin, true);
    assert_eq!(status_of(&store, "ancient"), None);
}

#[test]
fn the_retention_setting_reads_as_documented() {
    assert_eq!(retention_days(None), Some(DEFAULT_RETENTION_DAYS));
    assert_eq!(retention_days(Some("")), Some(DEFAULT_RETENTION_DAYS));
    assert_eq!(retention_days(Some("0")), None, "0 keeps everything");
    assert_eq!(retention_days(Some(" 7 ")), Some(7));
    assert_eq!(retention_days(Some("a week")), Some(DEFAULT_RETENTION_DAYS));
    assert_eq!(retention_days(Some("-3")), Some(DEFAULT_RETENTION_DAYS));
}
