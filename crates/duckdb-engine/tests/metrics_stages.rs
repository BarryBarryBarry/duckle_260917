//! Plan 003 Phase 3: a run reports its stages to the metrics store as they
//! happen - placeholders when it starts, each stage as it runs and ends - and
//! nothing else that executes reports as if it were the run.

use duckle_duckdb_engine::history::{append_run_record, RunRecord};
use duckle_duckdb_engine::metrics_bus::{self, DeliveryMode};
use duckle_duckdb_engine::metrics_model::{NodeRunMetric, NodeStatus, PipelineRunMetric, RunStatus};
use duckle_duckdb_engine::metrics_store::{MetricsStore, RunQuery};
use duckle_duckdb_engine::{retry, DuckdbEngine, PipelineDoc, PipelineEvent, RunResult};
use serde_json::{json, Value};
use std::cell::RefCell;
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

fn node(id: &str, component: &str, props: Value) -> Value {
    json!({ "id": id, "position": { "x": 0, "y": 0 }, "data": { "label": id, "componentId": component, "properties": props } })
}

fn edge(id: &str, from: &str, to: &str) -> Value {
    json!({ "id": id, "source": from, "target": to })
}

fn doc(nodes: Value, edges: Value) -> PipelineDoc {
    serde_json::from_value(json!({ "nodes": nodes, "edges": edges })).unwrap()
}

fn path_of(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().replace('\\', "/")
}

/// source -> filter -> sink, with the filter's predicate supplied.
fn three_nodes(dir: &Path, predicate: &str) -> PipelineDoc {
    std::fs::write(dir.join("in.csv"), "id,email\n1,a@x.io\n2,\n3,c@x.io\n").unwrap();
    doc(
        json!([
            node("s", "src.csv", json!({ "path": path_of(dir, "in.csv"), "hasHeader": true })),
            node("f", "xf.filter", json!({ "predicate": predicate })),
            node("k", "snk.csv", json!({ "path": path_of(dir, "out.csv"), "hasHeader": true })),
        ]),
        json!([edge("e1", "s", "f"), edge("e2", "f", "k")]),
    )
}

/// One run the way every surface does it: ledger begin, engine under the
/// receipt's id, ledger finish, history record.
fn tracked(
    bin: &Path,
    ws: &Path,
    run_key: &str,
    d: &PipelineDoc,
    target: Option<&str>,
    on_event: impl FnMut(PipelineEvent, &DuckdbEngine),
) -> RunResult {
    let receipt = retry::begin(ws, run_key, "manual", "orders", &path_of(ws, "pipelines/orders.json"), "h", None);
    let engine = DuckdbEngine::new(bin.to_path_buf()).with_run_id(run_key);
    let mut on_event = on_event;
    let r = engine.execute_pipeline_with_events(d, target, Some("orders"), |e| on_event(e, &engine));
    retry::finish(ws, receipt, &r.status, retry::nodes_of(&r));
    let mut record = RunRecord::from_result_in(ws, "orders", &r, "manual");
    record.run_id = Some(run_key.to_string());
    append_run_record(ws, "orders", record).unwrap();
    r
}

fn store(bin: &Path, ws: &Path) -> MetricsStore {
    MetricsStore::open(ws, bin).expect("store")
}

fn nodes(bin: &Path, ws: &Path, run_key: &str) -> Vec<NodeRunMetric> {
    store(bin, ws).query_nodes(&[run_key.to_string()]).unwrap()
}

fn run_row(bin: &Path, ws: &Path, run_key: &str) -> PipelineRunMetric {
    let q = RunQuery { run_key: Some(run_key.into()), limit: 1, ..Default::default() };
    store(bin, ws).query_runs(&q).unwrap().runs.pop().expect("the run is stored")
}

fn statuses(n: &[NodeRunMetric]) -> Vec<(&str, NodeStatus)> {
    n.iter().map(|n| (n.node_id.as_str(), n.status)).collect()
}

#[test]
fn stages_are_placed_then_run_one_by_one_on_both_paths() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-stages_are_placed_then_run_one_by_one_on_both_paths";
    for (path, target) in [("batched", None), ("per-stage", Some("k"))] {
        let ws = tempfile::tempdir().unwrap();
        let d = three_nodes(ws.path(), "id > 0");
        let seen = RefCell::new(Vec::<String>::new());
        let r = tracked(&bin, ws.path(), key, &d, target, |e, _| match e {
            PipelineEvent::Started { .. } => {
                let n = nodes(&bin, ws.path(), key);
                seen.borrow_mut().push(format!("placed {:?}", statuses(&n)));
            }
            PipelineEvent::StageStarted { node_id, .. } => {
                let n = nodes(&bin, ws.path(), key);
                let st = n.iter().find(|n| n.node_id == node_id).map(|n| n.status);
                seen.borrow_mut().push(format!("{node_id} {st:?}"));
            }
            _ => {}
        });
        assert_eq!(r.status, "ok", "{path}: {:?}", r.error);
        let seen = seen.into_inner();
        assert_eq!(
            seen[0],
            format!("placed {:?}", [("s", NodeStatus::Pending), ("f", NodeStatus::Pending), ("k", NodeStatus::Pending)]),
            "{path}"
        );
        for id in ["s", "f", "k"] {
            assert!(seen.contains(&format!("{id} Some(Running)")), "{path}: {id} was never seen running: {seen:?}");
        }
        let n = nodes(&bin, ws.path(), key);
        assert_eq!(statuses(&n), [("s", NodeStatus::Ok), ("f", NodeStatus::Ok), ("k", NodeStatus::Ok)], "{path}");
        let kinds: Vec<Option<&str>> = n.iter().map(|n| n.kind.as_deref()).collect();
        assert_eq!(kinds, [Some("source"), Some("transform"), Some("sink")], "{path}: catalog kinds");
        assert_eq!(n.iter().map(|n| n.ordinal).collect::<Vec<_>>(), [Some(0), Some(1), Some(2)], "{path}");
        for n in &n {
            assert!(n.started_at.is_some() && n.duration_ms.is_some(), "{path}: {n:?}");
        }
        assert_eq!(n[2].rows, Some(3), "{path}: the sink's rows");
        assert_eq!(run_row(&bin, ws.path(), key).status, RunStatus::Ok);
    }
}

#[test]
fn a_failing_stage_is_an_error_and_what_follows_it_was_skipped() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-a_failing_stage_is_an_error_and_what_follows_it_was_skipped";
    for (path, target) in [("batched", None), ("per-stage", Some("k"))] {
        let ws = tempfile::tempdir().unwrap();
        let d = three_nodes(ws.path(), "no_such_column > 1");
        let r = tracked(&bin, ws.path(), key, &d, target, |_, _| {});
        assert_eq!(r.status, "error", "{path}");
        let n = nodes(&bin, ws.path(), key);
        assert_eq!(statuses(&n), [("s", NodeStatus::Ok), ("f", NodeStatus::Error), ("k", NodeStatus::Skipped)], "{path}");
        assert!(n[1].error.as_deref().is_some_and(|e| !e.is_empty()), "{path}: the error is kept");
        assert_eq!(run_row(&bin, ws.path(), key).status, RunStatus::Error, "{path}");
    }
}

#[test]
fn a_cancelled_run_cancels_the_stage_in_flight_and_skips_the_rest() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-a_cancelled_run_cancels_the_stage_in_flight_and_skips_the_rest";
    let ws = tempfile::tempdir().unwrap();
    let d = three_nodes(ws.path(), "id > 0");
    let r = tracked(&bin, ws.path(), key, &d, Some("k"), |e, engine| {
        if matches!(&e, PipelineEvent::StageStarted { node_id, .. } if node_id == "f") {
            engine.request_cancel();
        }
    });
    assert_eq!(r.status, "cancelled");
    let n = nodes(&bin, ws.path(), key);
    assert_eq!(statuses(&n), [("s", NodeStatus::Ok), ("f", NodeStatus::Cancelled), ("k", NodeStatus::Skipped)]);
    assert_eq!(run_row(&bin, ws.path(), key).status, RunStatus::Cancelled);
}

#[test]
fn a_quality_check_reports_what_it_rejected() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-a_quality_check_reports_what_it_rejected";
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("in.csv"), "id,email\n1,a@x.io\n2,\n3,\n").unwrap();
    let d = doc(
        json!([
            node("s", "src.csv", json!({ "path": path_of(ws.path(), "in.csv"), "hasHeader": true })),
            node("q", "qa.notnull", json!({ "columns": ["email"] })),
            node("k", "snk.csv", json!({ "path": path_of(ws.path(), "out.csv"), "hasHeader": true })),
        ]),
        json!([edge("e1", "s", "q"), edge("e2", "q", "k")]),
    );
    tracked(&bin, ws.path(), key, &d, None, |_, _| {});
    let n = nodes(&bin, ws.path(), key);
    let q = n.iter().find(|n| n.node_id == "q").unwrap();
    assert_eq!((q.kind.as_deref(), q.rejected_rows), (Some("quality"), Some(2)));
    assert_eq!(run_row(&bin, ws.path(), key).rejected_rows, Some(2));
}

#[test]
fn a_partial_run_places_only_the_stages_it_runs() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-a_partial_run_places_only_the_stages_it_runs";
    let ws = tempfile::tempdir().unwrap();
    let d = three_nodes(ws.path(), "id > 0");
    tracked(&bin, ws.path(), key, &d, Some("f"), |_, _| {});
    let n = nodes(&bin, ws.path(), key);
    assert_eq!(statuses(&n), [("s", NodeStatus::Ok), ("f", NodeStatus::Ok)]);
}

#[test]
fn runs_without_a_ledger_entry_report_nothing() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let d = three_nodes(ws.path(), "id > 0");
    // No run id at all, and a run id this process never began.
    DuckdbEngine::new(bin.clone()).execute_pipeline(&d);
    DuckdbEngine::new(bin.clone()).with_run_id("run-runs_without_a_ledger_entry_report_nothing").execute_pipeline(&d);
    assert!(!ws.path().join(".duckle").join("metrics.duckdb").exists());
}

#[test]
fn a_called_job_does_not_report_as_the_run() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-a_called_job_does_not_report_as_the_run";
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("in.csv"), "id\n1\n2\n").unwrap();
    let child = json!({
        "nodes": [
            node("cs", "src.csv", json!({ "path": path_of(ws.path(), "in.csv"), "hasHeader": true })),
            node("ck", "snk.csv", json!({ "path": path_of(ws.path(), "child.csv"), "hasHeader": true })),
        ],
        "edges": [edge("ce", "cs", "ck")]
    });
    std::fs::write(ws.path().join("child.json"), child.to_string()).unwrap();
    let parent = doc(
        json!([
            node("s", "src.csv", json!({ "path": path_of(ws.path(), "in.csv"), "hasHeader": true })),
            node("rj", "ctl.runjob", json!({ "pipelineRef": path_of(ws.path(), "child.json") })),
        ]),
        json!([edge("e1", "s", "rj")]),
    );
    let r = tracked(&bin, ws.path(), key, &parent, None, |_, _| {});
    assert_eq!(r.status, "ok", "{:?}", r.error);
    let ids: Vec<String> = nodes(&bin, ws.path(), key).into_iter().map(|n| n.node_id).collect();
    assert!(!ids.iter().any(|i| i == "cs" || i == "ck"), "the child's stages were reported as the run's: {ids:?}");
    assert!(ids.contains(&"rj".to_string()), "{ids:?}");
}

/// What the engine says is the same with the metrics store listening or not.
#[test]
fn reporting_changes_nothing_about_the_run() {
    let bin = cli_or_skip!();
    // Run ids are unique in life; tests running side by side must not share one.
    let key = "run-reporting_changes_nothing_about_the_run";
    let shape = |e: &PipelineEvent| match e {
        PipelineEvent::Started { total_stages } => format!("started {total_stages}"),
        PipelineEvent::StageStarted { node_id, kind, .. } => format!("start {node_id} {kind}"),
        PipelineEvent::StageFinished { node_id, status, rows, .. } => format!("finish {node_id} {status} {rows:?}"),
        PipelineEvent::Log { node_id, message, .. } => format!("log {node_id} {message}"),
        PipelineEvent::Cancelled => "cancelled".into(),
        PipelineEvent::Finished { status, .. } => format!("finished {status}"),
    };
    let ws = tempfile::tempdir().unwrap();
    let d = three_nodes(ws.path(), "id > 1");
    let mut with = Vec::new();
    let r1 = tracked(&bin, ws.path(), key, &d, None, |e, _| with.push(shape(&e)));
    let mut without = Vec::new();
    let r2 = DuckdbEngine::new(bin.clone()).execute_pipeline_with_events(&d, None, Some("orders"), |e| without.push(shape(&e)));
    assert_eq!(with, without);
    assert_eq!((r1.status.as_str(), r1.nodes.len()), (r2.status.as_str(), r2.nodes.len()));
    for (id, n) in &r1.nodes {
        assert_eq!((n.status.as_str(), n.rows), (r2.nodes[id].status.as_str(), r2.nodes[id].rows), "{id}");
    }
}
