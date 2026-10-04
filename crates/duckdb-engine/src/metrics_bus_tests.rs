use super::*;
use crate::history::NodeMetric;
use crate::metrics_store::{EventQuery, RunQuery};
use crate::metrics_model::PipelineRunMetric;

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

fn id(run_key: &str) -> RunIdentity {
    RunIdentity {
        run_key: run_key.into(),
        pipeline_id: "orders".into(),
        pipeline_name: Some("Orders".into()),
        trigger: "manual".into(),
        began_at: "2026-10-04T10:00:00Z".into(),
    }
}

fn begun(ws: &Path, run_key: &str) -> MetricsEvent {
    MetricsEvent::RunBegun { workspace: ws.into(), id: id(run_key) }
}

fn admitted(ws: &Path, run_key: &str) -> MetricsEvent {
    MetricsEvent::RunAdmitted { workspace: ws.into(), id: id(run_key), queue_ms: 500 }
}

fn ended(ws: &Path, run_key: &str, status: &str) -> MetricsEvent {
    MetricsEvent::RunEnded {
        workspace: ws.into(),
        id: id(run_key),
        status: status.into(),
        ran_from: "2026-10-04T10:00:00.500Z".into(),
        at: "2026-10-04T10:00:02.500Z".into(),
        nodes: vec![
            EndedNode { node_id: "src".into(), status: "ok".into(), stage_kind: Some("view".into()), rows: Some(9), duration_ms: Some(5) },
            EndedNode { node_id: "out".into(), status: "ok".into(), stage_kind: Some("sink".into()), rows: Some(7), duration_ms: Some(6) },
        ],
    }
}

fn recorded(ws: &Path, run_key: &str, pipeline_id: &str) -> MetricsEvent {
    let record = RunRecord {
        run_id: Some(run_key.into()),
        at: "2026-10-04T10:00:03Z".into(),
        started_at: Some("2026-10-04T10:00:01Z".into()),
        status: "ok".into(),
        duration_ms: 2000,
        rows: 7,
        node_count: 2,
        trigger: "manual".into(),
        nodes: vec![
            NodeMetric { node: "out".into(), component: Some("snk.csv".into()), kind: Some("sink".into()), status: Some("ok".into()), rows: Some(7), ..Default::default() },
            NodeMetric { node: "src".into(), component: Some("src.csv".into()), kind: Some("source".into()), status: Some("unchanged".into()), rows: Some(9), ..Default::default() },
        ],
        ..Default::default()
    };
    MetricsEvent::RunRecorded { workspace: ws.into(), pipeline_id: pipeline_id.into(), record }
}

fn run(bin: &Path, ws: &Path, run_key: &str) -> Option<PipelineRunMetric> {
    let s = MetricsStore::open(ws, bin).expect("store");
    s.query_runs(&RunQuery { run_key: Some(run_key.into()), limit: 1, ..Default::default() }).unwrap().runs.pop()
}

fn node_states(bin: &Path, ws: &Path, run_key: &str) -> Vec<(String, NodeStatus)> {
    let s = MetricsStore::open(ws, bin).expect("store");
    s.query_nodes(&[run_key.to_string()]).unwrap().into_iter().map(|n| (n.node_id, n.status)).collect()
}

fn events(bin: &Path, ws: &Path) -> Vec<String> {
    let s = MetricsStore::open(ws, bin).expect("store");
    let mut ids: Vec<String> =
        s.query_events(&EventQuery { limit: 50, ..Default::default() }).unwrap().into_iter().map(|e| e.event_id).collect();
    ids.sort();
    ids
}

#[test]
fn a_run_in_order_ends_as_one_final_row() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::new(bin.clone(), DeliveryMode::Direct);
    for e in [begun(ws.path(), "r1"), admitted(ws.path(), "r1"), ended(ws.path(), "r1", "ok"), recorded(ws.path(), "r1", "orders")] {
        bus.publish(e);
    }
    let r = run(&bin, ws.path(), "r1").expect("one row");
    assert_eq!(r.status, RunStatus::Ok);
    assert_eq!(r.started_at, "2026-10-04T10:00:00.000000Z", "the begin, not the record's guess");
    assert_eq!((r.duration_ms, r.rows, r.queue_ms), (Some(2000), Some(7), Some(500)), "the record's figures win");
    assert_eq!(r.pipeline_name.as_deref(), Some("Orders"));
    assert_eq!(
        node_states(&bin, ws.path(), "r1"),
        [("out".to_string(), NodeStatus::Ok), ("src".to_string(), NodeStatus::Unchanged)]
    );
    assert_eq!(events(&bin, ws.path()), ["r1:run_finished", "r1:run_started"]);
}

#[test]
fn replaying_events_out_of_order_lands_in_the_same_place() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::new(bin.clone(), DeliveryMode::Direct);
    for e in [
        recorded(ws.path(), "r1", "orders"),
        ended(ws.path(), "r1", "ok"),
        begun(ws.path(), "r1"),
        begun(ws.path(), "r1"),
        admitted(ws.path(), "r1"),
        recorded(ws.path(), "r1", "orders"),
    ] {
        bus.publish(e);
    }
    let s = MetricsStore::open(ws.path(), &bin).unwrap();
    assert_eq!(s.run_states().unwrap().len(), 1);
    let r = run(&bin, ws.path(), "r1").unwrap();
    assert_eq!(r.status, RunStatus::Ok, "a late begin does not reopen a finished run");
    assert_eq!(r.started_at, "2026-10-04T10:00:01.000000Z", "whoever created the row set the start");
    assert_eq!(events(&bin, ws.path()), ["r1:run_finished", "r1:run_started"]);
}

#[test]
fn a_full_queue_drops_stage_detail_but_never_the_ending() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::with_limits(bin.clone(), DeliveryMode::Queued, 2, BREAKER_THRESHOLD, BREAKER_COOLDOWN);
    bus.publish(begun(ws.path(), "r1"));
    for i in 0..30 {
        bus.publish(MetricsEvent::StageStarted {
            workspace: ws.path().into(),
            run_key: "r1".into(),
            node_id: format!("n{i}"),
            at: "2026-10-04T10:00:01Z".into(),
        });
    }
    bus.publish(ended(ws.path(), "r1", "error"));
    bus.publish(recorded(ws.path(), "r1", "orders"));
    assert!(bus.flush(Duration::from_secs(60)), "the queue drains");
    assert!(bus.shared.dropped.load(Ordering::Relaxed) > 0, "some stage events were dropped");
    assert_eq!(run(&bin, ws.path(), "r1").unwrap().status, RunStatus::Ok, "the ending and the record both arrived");
}

#[test]
fn queued_delivery_keeps_one_runs_events_in_order() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::new(bin.clone(), DeliveryMode::Queued);
    bus.publish(begun(ws.path(), "r1"));
    bus.publish(MetricsEvent::StagesPlanned {
        workspace: ws.path().into(),
        run_key: "r1".into(),
        stages: vec![
            PlannedStage { node_id: "a".into(), component: Some("src.csv".into()), kind: Some("source".into()), ordinal: 0 },
            PlannedStage { node_id: "b".into(), component: None, kind: None, ordinal: 1 },
        ],
    });
    bus.publish(MetricsEvent::StageStarted { workspace: ws.path().into(), run_key: "r1".into(), node_id: "a".into(), at: "2026-10-04T10:00:01Z".into() });
    bus.publish(MetricsEvent::StageFinished {
        workspace: ws.path().into(),
        run_key: "r1".into(),
        node_id: "a".into(),
        status: NodeStatus::Ok,
        rows: Some(3),
        duration_ms: Some(4),
        error: None,
    });
    assert!(bus.flush(Duration::from_secs(30)));
    let s = MetricsStore::open(ws.path(), &bin).unwrap();
    let n = s.query_nodes(&["r1".to_string()]).unwrap();
    assert_eq!((n[0].node_id.as_str(), n[0].status, n[0].rows, n[0].ordinal), ("a", NodeStatus::Ok, Some(3), Some(0)));
    assert_eq!(n[0].started_at.as_deref(), Some("2026-10-04T10:00:01.000000Z"));
    assert_eq!(n[0].kind.as_deref(), Some("source"));
    assert_eq!((n[1].node_id.as_str(), n[1].status), ("b", NodeStatus::Pending));
}

#[test]
fn an_interrupted_run_is_closed_by_its_interruption_not_its_placeholder_record() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::new(bin.clone(), DeliveryMode::Direct);
    bus.publish(begun(ws.path(), "r1"));
    bus.publish(MetricsEvent::StagesPlanned {
        workspace: ws.path().into(),
        run_key: "r1".into(),
        stages: vec![
            PlannedStage { node_id: "a".into(), component: None, kind: None, ordinal: 0 },
            PlannedStage { node_id: "b".into(), component: None, kind: None, ordinal: 1 },
        ],
    });
    bus.publish(MetricsEvent::StageStarted { workspace: ws.path().into(), run_key: "r1".into(), node_id: "a".into(), at: "2026-10-04T10:00:01Z".into() });
    bus.publish(MetricsEvent::RunInterrupted { workspace: ws.path().into(), id: id("r1"), at: "2026-10-04T11:00:00Z".into() });
    // What `reconcile` appends to the history right after.
    let placeholder = RunRecord {
        run_id: Some("r1".into()),
        at: "2026-10-04T10:00:00Z".into(),
        status: crate::retry::INTERRUPTED.into(),
        trigger: "manual".into(),
        ..Default::default()
    };
    bus.publish(MetricsEvent::RunRecorded { workspace: ws.path().into(), pipeline_id: "orders".into(), record: placeholder });
    let r = run(&bin, ws.path(), "r1").unwrap();
    assert_eq!(r.status, RunStatus::Interrupted);
    assert_eq!((r.duration_ms, r.rows, r.node_count), (None, None, None), "zeros from the placeholder are not figures");
    assert_eq!(
        node_states(&bin, ws.path(), "r1"),
        [("a".to_string(), NodeStatus::Interrupted), ("b".to_string(), NodeStatus::Skipped)]
    );
    assert_eq!(events(&bin, ws.path()), ["r1:run_finished", "r1:run_started"]);
}

#[test]
fn an_interruption_records_a_run_the_store_never_saw_begin() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    Bus::new(bin.clone(), DeliveryMode::Direct)
        .publish(MetricsEvent::RunInterrupted { workspace: ws.path().into(), id: id("r1"), at: "2026-10-04T11:00:00Z".into() });
    let r = run(&bin, ws.path(), "r1").expect("created from the identity");
    assert_eq!((r.status, r.pipeline_id.as_str()), (RunStatus::Interrupted, "orders"));
}

#[test]
fn the_history_file_name_is_the_pipeline_id_whatever_the_run_was_called() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let receipt = crate::retry::begin(ws.path(), "r1", "web", "Orders (draft)", "/ws/pipelines/orders.json", "h", None);
    let ident = RunIdentity::of(&receipt);
    assert_eq!((ident.pipeline_id.as_str(), ident.pipeline_name.as_deref()), ("orders", Some("Orders (draft)")));
    let bus = Bus::new(bin.clone(), DeliveryMode::Direct);
    bus.publish(MetricsEvent::RunBegun { workspace: ws.path().into(), id: RunIdentity { pipeline_id: "Orders (draft)".into(), ..ident } });
    bus.publish(recorded(ws.path(), "r1", "orders"));
    let r = run(&bin, ws.path(), "r1").unwrap();
    assert_eq!(r.pipeline_id, "orders", "the record's id replaces the ledger's guess");
    assert_eq!(r.pipeline_name.as_deref(), Some("Orders (draft)"));
}

#[test]
fn an_ended_run_takes_its_duration_from_when_it_was_admitted() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    Bus::new(bin.clone(), DeliveryMode::Direct).publish(ended(ws.path(), "r1", "cancelled"));
    let r = run(&bin, ws.path(), "r1").unwrap();
    assert_eq!((r.status, r.duration_ms, r.rows, r.node_count), (RunStatus::Cancelled, Some(2000), Some(7), Some(2)));
}

#[test]
fn an_unknown_status_is_kept_as_an_error_with_the_word() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    Bus::new(bin.clone(), DeliveryMode::Direct).publish(ended(ws.path(), "r1", "paused"));
    let r = run(&bin, ws.path(), "r1").unwrap();
    assert_eq!(r.status, RunStatus::Error);
    assert!(r.error.unwrap_or_default().contains("'paused'"));
}

#[cfg(unix)]
fn failing_cli(dir: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let count = dir.join("calls");
    let bin = dir.join("duckdb");
    std::fs::write(&bin, format!("#!/bin/sh\necho x >> '{}'\necho 'IO Error: disk full' >&2\nexit 1\n", count.display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    (bin, count)
}

#[cfg(unix)]
fn calls(count: &Path) -> usize {
    std::fs::read_to_string(count).map(|s| s.lines().count()).unwrap_or(0)
}

#[cfg(unix)]
#[test]
fn a_failing_store_is_paused_and_tried_again_after_the_cooldown() {
    let dir = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let (bin, count) = failing_cli(dir.path());
    let bus = Bus::with_limits(bin, DeliveryMode::Direct, MAX_QUEUED_STAGE_EVENTS, 3, Duration::from_millis(400));
    for i in 0..6 {
        bus.publish(begun(ws.path(), &format!("r{i}")));
    }
    assert_eq!(calls(&count), 3, "after three failures the CLI is left alone");
    assert!(bus.shared.breaker.is_open());
    std::thread::sleep(Duration::from_millis(450));
    bus.publish(begun(ws.path(), "late"));
    assert_eq!(calls(&count), 4, "and tried again once the pause is over");
}

#[cfg(unix)]
#[test]
fn a_paused_queue_still_attempts_endings_but_skips_stage_detail() {
    let dir = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let (bin, count) = failing_cli(dir.path());
    let bus = Bus::with_limits(bin, DeliveryMode::Queued, MAX_QUEUED_STAGE_EVENTS, 1, Duration::from_secs(60));
    bus.publish(begun(ws.path(), "r1"));
    assert!(bus.flush(Duration::from_secs(10)));
    assert!(bus.shared.breaker.is_open());
    bus.publish(MetricsEvent::StageStarted { workspace: ws.path().into(), run_key: "r1".into(), node_id: "a".into(), at: "x".into() });
    bus.publish(ended(ws.path(), "r1", "ok"));
    assert!(bus.flush(Duration::from_secs(10)));
    assert_eq!(calls(&count), 2, "the ending was tried, the stage event was not");
}

#[test]
fn a_missing_cli_skips_the_event_without_pausing() {
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::with_limits(PathBuf::from("/no/such/duckdb"), DeliveryMode::Direct, 8, 1, Duration::from_secs(60));
    for i in 0..3 {
        bus.publish(begun(ws.path(), &format!("r{i}")));
    }
    assert!(!bus.shared.breaker.is_open(), "a CLI that is not there yet is not a failing store");
    assert!(bus.shared.missing_warned.load(Ordering::Relaxed));
    assert!(!ws.path().join(".duckle").exists());
}

#[test]
fn a_run_is_known_by_workspace_only_while_it_runs() {
    let ws = tempfile::tempdir().unwrap();
    let bus = Bus::with_limits(PathBuf::from("/no/such/duckdb"), DeliveryMode::Direct, 8, 3, BREAKER_COOLDOWN);
    bus.publish(begun(ws.path(), "r1"));
    assert_eq!(bus.workspace_of("r1").as_deref(), Some(ws.path()));
    bus.publish(ended(ws.path(), "r1", "ok"));
    assert_eq!(bus.workspace_of("r1"), None);
}

#[test]
fn an_unconfigured_process_publishes_nothing() {
    // Unit tests never configure the process-wide bus.
    assert!(!enabled());
    publish_with(|| panic!("an event was built although metrics are off"));
    assert!(flush(Duration::from_millis(1)));
    assert_eq!(workspace_of("anything"), None);
}

#[test]
fn legacy_keys_are_stable_and_distinct() {
    let a = legacy_run_key("orders", "2026-10-04T10:00:00Z");
    assert_eq!(a, legacy_run_key("orders", "2026-10-04T10:00:00Z"));
    assert_ne!(a, legacy_run_key("orders", "2026-10-04T10:00:01Z"));
    assert!(a.starts_with("legacy-") && a.len() == "legacy-".len() + 16, "{a}");
}

#[test]
fn the_stage_tap_places_once_and_reports_only_what_a_stage_stream_can_know() {
    let ws = PathBuf::from("/ws");
    let planned = vec![PlannedStage { node_id: "a".into(), component: None, kind: None, ordinal: 0 }];
    let mut tap = StageTap::new(ws, "r1".into(), planned);
    let now = chrono::Utc::now();
    let started = crate::PipelineEvent::Started { total_stages: 1 };
    assert!(matches!(tap.translate(&started, now), Some(MetricsEvent::StagesPlanned { stages, .. }) if stages.len() == 1));
    assert!(tap.translate(&started, now).is_none(), "placed once per run");

    let finished = |status: &str, error: Option<String>| crate::PipelineEvent::StageFinished {
        node_id: "a".into(),
        kind: "view".into(),
        status: status.into(),
        rows: Some(2),
        duration_ms: 7,
        error,
        sql: None,
    };
    let status_of = |e: Option<MetricsEvent>| match e {
        Some(MetricsEvent::StageFinished { status, .. }) => Some(status),
        _ => None,
    };
    assert_eq!(status_of(tap.translate(&finished("ok", None), now)), Some(NodeStatus::Ok));
    assert_eq!(status_of(tap.translate(&finished("unchanged", None), now)), Some(NodeStatus::Ok), "the record says unchanged");
    assert_eq!(status_of(tap.translate(&finished("skipped", None), now)), Some(NodeStatus::Skipped));
    assert_eq!(status_of(tap.translate(&finished("mystery", None), now)), None);
    match tap.translate(&finished("error", Some("x".repeat(5000))), now) {
        Some(MetricsEvent::StageFinished { status: NodeStatus::Error, error: Some(e), duration_ms: Some(7), .. }) => {
            assert_eq!(e.chars().count(), STAGE_ERROR_MAX_CHARS)
        }
        other => panic!("{other:?}"),
    }
    let start = crate::PipelineEvent::StageStarted { node_id: "a".into(), label: "a".into(), kind: "view".into() };
    assert!(matches!(tap.translate(&start, now), Some(MetricsEvent::StageStarted { at, .. }) if at == now.to_rfc3339()));
    assert!(tap.translate(&crate::PipelineEvent::Cancelled, now).is_none(), "the ledger reports how a run ended");
}
