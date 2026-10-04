use super::*;
use crate::metrics_model::{NodeStatus, PipelineEventKind};

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

fn store() -> Option<(tempfile::TempDir, MetricsStore)> {
    let bin = cli()?;
    let ws = tempfile::tempdir().ok()?;
    let s = MetricsStore::open(ws.path(), &bin).expect("opens");
    Some((ws, s))
}

macro_rules! store_or_skip {
    () => {
        match store() {
            Some(s) => s,
            None => {
                eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
                return;
            }
        }
    };
}

fn ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).expect("rfc3339").with_timezone(&Utc)
}

fn begun(run_key: &str, pipeline: &str, started_at: &str) -> PipelineRunPatch {
    PipelineRunPatch {
        run_key: run_key.into(),
        pipeline_id: Some(pipeline.into()),
        trigger: Some("manual".into()),
        status: Some(RunStatus::Running),
        started_at: Some(started_at.into()),
        ..Default::default()
    }
}

fn node(run_key: &str, node_id: &str, ordinal: Option<i64>, status: Option<NodeStatus>) -> NodeRunPatch {
    NodeRunPatch {
        run_key: run_key.into(),
        node_id: node_id.into(),
        ordinal,
        status,
        ..Default::default()
    }
}

fn one_run(s: &MetricsStore, run_key: &str) -> PipelineRunMetric {
    let q = RunQuery { run_key: Some(run_key.into()), limit: 1, ..Default::default() };
    s.query_runs(&q).expect("query").runs.pop().expect("the run exists")
}

fn nodes_of(s: &MetricsStore, run_key: &str) -> Vec<NodeRunMetric> {
    s.query_nodes(&[run_key.to_string()]).expect("query nodes")
}

fn temp_files(ws: &Path) -> Vec<String> {
    std::fs::read_dir(ws.join(".duckle").join("tmp"))
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

// ---- pure SQL helpers -------------------------------------------------------

#[test]
fn quoting_doubles_quotes_and_refuses_nul() {
    assert_eq!(sql_quote("it's").unwrap(), "'it''s'");
    assert_eq!(sql_quote("a\\b\nc").unwrap(), "'a\\b\nc'", "backslash and newline are literal in SQL strings");
    assert!(matches!(sql_quote("a\0b"), Err(MetricsError::InvalidArgument(_))));
}

#[test]
fn status_merge_only_moves_forward() {
    let c = col("status", "VARCHAR", Merge::Status(RUN_OPEN));
    let sql = merged(&c, "t", "n");
    assert_eq!(
        sql,
        "CASE WHEN n.status IS NULL THEN t.status \
         WHEN n.status IN ('queued', 'running') AND NOT t.status IN ('queued', 'running') THEN t.status \
         ELSE n.status END"
    );
    assert_eq!(merged(&col("x", "BIGINT", Merge::KeepFirst), "t", "n"), "COALESCE(t.x, n.x)");
    assert_eq!(merged(&col("x", "BIGINT", Merge::Overwrite), "t", "n"), "COALESCE(n.x, t.x)");
}

// ---- schema -----------------------------------------------------------------

#[test]
fn opening_creates_the_store_and_is_idempotent() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    assert!(!ws.path().join(".duckle").exists());
    let s = MetricsStore::open(ws.path(), &bin).expect("first open");
    assert!(ws.path().join(METRICS_DB_FILE).is_file());
    // Re-running the DDL against an existing store changes nothing.
    mark_schema_ready(s.db_path(), false);
    MetricsStore::open(ws.path(), &bin).expect("second open");
    assert!(s.query_runs(&RunQuery { limit: 5, ..Default::default() }).unwrap().runs.is_empty());
}

#[test]
fn the_schema_is_checked_once_per_process_per_store() {
    let (ws, s) = store_or_skip!();
    s.exec("DROP TABLE pipeline_run;", false).unwrap();
    let again = MetricsStore::open(ws.path(), &s.bin).expect("cached open");
    assert!(
        again.query_runs(&RunQuery { limit: 1, ..Default::default() }).is_err(),
        "a cached store must not have re-run its DDL"
    );
    mark_schema_ready(s.db_path(), false);
    let fresh = MetricsStore::open(ws.path(), &s.bin).expect("uncached open");
    assert!(fresh.query_runs(&RunQuery { limit: 1, ..Default::default() }).is_ok());
}

#[test]
fn a_newer_schema_is_refused() {
    let (ws, s) = store_or_skip!();
    s.exec("UPDATE metrics_meta SET value = '2' WHERE key = 'schema_version';", false).unwrap();
    mark_schema_ready(s.db_path(), false);
    match MetricsStore::open(ws.path(), &s.bin) {
        Err(MetricsError::SchemaTooNew { found: 2, supported: SCHEMA_VERSION }) => {}
        other => panic!("expected SchemaTooNew, got {other:?}"),
    }
    assert!(!schema_ready(s.db_path()), "a refused store is not marked ready");
}

// ---- upsert rules -----------------------------------------------------------

#[test]
fn created_at_stays_and_updated_at_moves_only_on_change() {
    let (_ws, s) = store_or_skip!();
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    let first = one_run(&s, "r1");
    std::thread::sleep(Duration::from_millis(20));
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    let replay = one_run(&s, "r1");
    assert_eq!(replay.updated_at, first.updated_at, "the same data again is not an update");
    std::thread::sleep(Duration::from_millis(20));
    s.apply_run_patch(&PipelineRunPatch { run_key: "r1".into(), rows: Some(5), ..Default::default() }).unwrap();
    let changed = one_run(&s, "r1");
    assert_eq!(changed.created_at, first.created_at);
    assert!(changed.updated_at > first.updated_at, "{} vs {}", changed.updated_at, first.updated_at);
}

#[test]
fn a_partial_patch_keeps_what_it_does_not_mention_and_started_at_is_written_once() {
    let (_ws, s) = store_or_skip!();
    let mut p = begun("r1", "orders", "2026-10-04T10:00:00Z");
    p.pipeline_name = Some("Orders".into());
    p.queue_ms = Some(250);
    s.apply_run_patch(&p).unwrap();
    s.apply_run_patch(&PipelineRunPatch {
        run_key: "r1".into(),
        pipeline_id: Some("orders".into()),
        status: Some(RunStatus::Ok),
        started_at: Some("2026-10-04T10:00:05Z".into()),
        duration_ms: Some(1500),
        rows: Some(42),
        ..Default::default()
    })
    .unwrap();
    let r = one_run(&s, "r1");
    assert_eq!(r.status, RunStatus::Ok);
    assert_eq!(r.started_at, "2026-10-04T10:00:00.000000Z", "started_at keeps its first value");
    assert_eq!((r.pipeline_name.as_deref(), r.queue_ms, r.trigger.as_deref()), (Some("Orders"), Some(250), Some("manual")));
    assert_eq!((r.duration_ms, r.rows), (Some(1500), Some(42)));
}

#[test]
fn values_come_back_typed_and_times_as_rfc3339_utc() {
    let (_ws, s) = store_or_skip!();
    let mut p = begun("r1", "orders", "2026-10-04T18:00:00.123456+08:00");
    p.rows = Some(9_007_199_254_740_993);
    p.unchanged = Some(true);
    s.apply_run_patch(&p).unwrap();
    let r = one_run(&s, "r1");
    assert_eq!(r.rows, Some(9_007_199_254_740_993), "BIGINT reads back as a number");
    assert_eq!(r.unchanged, Some(true));
    assert_eq!(r.started_at, "2026-10-04T10:00:00.123456Z");
    for t in [&r.started_at, &r.created_at, &r.updated_at] {
        assert!(t.ends_with('Z') && DateTime::parse_from_rfc3339(t).is_ok(), "{t}");
    }
}

#[test]
fn a_patch_without_identity_never_creates_a_run() {
    let (_ws, s) = store_or_skip!();
    s.apply_run_patch(&PipelineRunPatch { run_key: "ghost".into(), status: Some(RunStatus::Ok), ..Default::default() })
        .unwrap();
    assert!(s.run_states().unwrap().is_empty());
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    s.apply_run_patch(&PipelineRunPatch { run_key: "r1".into(), queue_ms: Some(7), ..Default::default() }).unwrap();
    assert_eq!(one_run(&s, "r1").queue_ms, Some(7), "but it updates one that exists");
}

#[test]
fn a_final_status_is_never_reopened() {
    let (_ws, s) = store_or_skip!();
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    s.apply_run_patch(&PipelineRunPatch { run_key: "r1".into(), status: Some(RunStatus::Queued), ..Default::default() })
        .unwrap();
    assert_eq!(one_run(&s, "r1").status, RunStatus::Queued, "a begun run may still wait for a permit");
    s.apply_run_patch(&PipelineRunPatch { run_key: "r1".into(), status: Some(RunStatus::Cancelled), ..Default::default() })
        .unwrap();
    s.apply_run_patch(&PipelineRunPatch { run_key: "r1".into(), status: Some(RunStatus::Running), ..Default::default() })
        .unwrap();
    assert_eq!(one_run(&s, "r1").status, RunStatus::Cancelled, "a late running does not undo an ending");

    s.apply_node_patches(&[node("r1", "a", Some(0), Some(NodeStatus::Ok))]).unwrap();
    s.apply_node_patches(&[node("r1", "a", None, None), node("r1", "b", Some(1), None)]).unwrap();
    s.apply_node_patches(&[node("r1", "a", None, Some(NodeStatus::Running))]).unwrap();
    let n = nodes_of(&s, "r1");
    assert_eq!(n[0].status, NodeStatus::Ok, "a placeholder or a late start does not undo a finish");
    assert_eq!(n[1].status, NodeStatus::Pending, "a node created without a status is pending");
    s.apply_node_patches(&[node("r1", "a", None, Some(NodeStatus::Unchanged))]).unwrap();
    assert_eq!(nodes_of(&s, "r1")[0].status, NodeStatus::Unchanged, "one final word may replace another");
}

#[test]
fn nodes_read_back_in_stage_order_and_a_repeated_node_keeps_the_last_patch() {
    let (_ws, s) = store_or_skip!();
    s.apply_node_patches(&[
        node("r1", "zeta", Some(0), None),
        node("r1", "alpha", None, None),
        node("r1", "mid", Some(1), None),
        NodeRunPatch { rows: Some(1), ..node("r1", "mid", Some(1), Some(NodeStatus::Running)) },
        NodeRunPatch { rows: Some(2), ..node("r1", "mid", Some(1), Some(NodeStatus::Ok)) },
    ])
    .unwrap();
    let n = nodes_of(&s, "r1");
    let ids: Vec<&str> = n.iter().map(|n| n.node_id.as_str()).collect();
    assert_eq!(ids, ["zeta", "mid", "alpha"], "ordinal first, unnumbered last");
    assert_eq!((n[1].status, n[1].rows), (NodeStatus::Ok, Some(2)));
}

#[test]
fn a_node_keeps_its_first_start() {
    let (_ws, s) = store_or_skip!();
    let mut p = node("r1", "a", Some(0), Some(NodeStatus::Running));
    p.started_at = Some("2026-10-04T10:00:01Z".into());
    s.apply_node_patches(&[p.clone()]).unwrap();
    p.started_at = Some("2026-10-04T10:00:09Z".into());
    p.status = Some(NodeStatus::Ok);
    s.apply_node_patches(&[p]).unwrap();
    assert_eq!(nodes_of(&s, "r1")[0].started_at.as_deref(), Some("2026-10-04T10:00:01.000000Z"));
}

// ---- finalize and events -----------------------------------------------------

#[test]
fn finalizing_closes_open_nodes_by_how_the_run_ended() {
    let (_ws, s) = store_or_skip!();
    for (run, ending, running_to) in [
        ("c", RunStatus::Cancelled, NodeStatus::Cancelled),
        ("i", RunStatus::Interrupted, NodeStatus::Interrupted),
        ("e", RunStatus::Error, NodeStatus::Error),
        ("o", RunStatus::Ok, NodeStatus::Ok),
    ] {
        s.apply_node_patches(&[
            node(run, "done", Some(0), Some(NodeStatus::Ok)),
            node(run, "busy", Some(1), Some(NodeStatus::Running)),
            node(run, "never", Some(2), None),
        ])
        .unwrap();
        s.finalize_nodes(run, ending).unwrap();
        let n: Vec<NodeStatus> = nodes_of(&s, run).iter().map(|n| n.status).collect();
        assert_eq!(n, [NodeStatus::Ok, running_to, NodeStatus::Skipped], "{ending}");
    }
    s.apply_node_patches(&[node("live", "x", Some(0), Some(NodeStatus::Running))]).unwrap();
    s.finalize_nodes("live", RunStatus::Running).unwrap();
    assert_eq!(nodes_of(&s, "live")[0].status, NodeStatus::Running, "an open run leaves its nodes alone");
}

#[test]
fn the_started_event_comes_from_the_run_row_once() {
    let (_ws, s) = store_or_skip!();
    s.ensure_run_started_event("nobody").unwrap();
    let mut p = begun("r1", "orders", "2026-10-04T10:00:00Z");
    p.queue_ms = Some(1500);
    p.pipeline_name = Some("Orders".into());
    s.apply_run_patch(&p).unwrap();
    s.ensure_run_started_event("r1").unwrap();
    s.ensure_run_started_event("r1").unwrap();
    let ev = s.query_events(&EventQuery { limit: 10, ..Default::default() }).unwrap();
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0].event_id, "r1:run_started");
    assert_eq!(ev[0].kind, PipelineEventKind::RunStarted);
    assert_eq!(ev[0].occurred_at, "2026-10-04T10:00:01.500000Z", "started_at + queue_ms");
    assert_eq!(ev[0].pipeline_name.as_deref(), Some("Orders"));
    let detail: serde_json::Value = serde_json::from_str(ev[0].detail.as_deref().unwrap()).unwrap();
    assert_eq!(detail, serde_json::json!({ "queue_ms": 1500 }));
}

#[test]
fn an_event_is_recorded_once_and_never_rewritten() {
    let (_ws, s) = store_or_skip!();
    let mut e = PipelineEventRecord {
        event_id: PipelineEventRecord::id_for("r1", PipelineEventKind::RunFinished),
        run_key: "r1".into(),
        pipeline_id: "orders".into(),
        pipeline_name: None,
        kind: PipelineEventKind::RunFinished,
        occurred_at: "2026-10-04T10:00:03Z".into(),
        trigger: Some("scheduled".into()),
        detail: Some(r#"{"status":"ok"}"#.into()),
        created_at: String::new(),
    };
    s.append_event(&e).unwrap();
    e.detail = Some(r#"{"status":"error"}"#.into());
    s.append_event(&e).unwrap();
    let ev = s.query_events(&EventQuery { limit: 10, ..Default::default() }).unwrap();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].detail.as_deref(), Some(r#"{"status":"ok"}"#));
    assert!(ev[0].created_at.ends_with('Z'));
}

// ---- queries ----------------------------------------------------------------

fn seed_runs(s: &MetricsStore) {
    let runs = [
        ("r1", "orders", RunStatus::Ok, "2026-10-01T10:00:00Z"),
        ("r2", "orders", RunStatus::Error, "2026-10-02T10:00:00Z"),
        ("r3", "billing", RunStatus::Ok, "2026-10-03T10:00:00Z"),
        ("r4", "billing", RunStatus::Running, "2026-10-04T10:00:00Z"),
        // Same start as r4: the key orders them.
        ("r5", "audit", RunStatus::Cancelled, "2026-10-04T10:00:00Z"),
    ];
    for (key, pipeline, status, at) in runs {
        s.apply_run_patch(&PipelineRunPatch { status: Some(status), ..begun(key, pipeline, at) }).unwrap();
    }
}

fn keys(page: &RunPage) -> Vec<&str> {
    page.runs.iter().map(|r| r.run_key.as_str()).collect()
}

#[test]
fn runs_filter_by_time_pipeline_and_status() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    let all = s.query_runs(&RunQuery { limit: 50, ..Default::default() }).unwrap();
    assert_eq!(keys(&all), ["r5", "r4", "r3", "r2", "r1"]);
    assert_eq!(all.total, None, "a cursor query does not count");

    let q = RunQuery { from: Some(ts("2026-10-02T10:00:00Z")), to: Some(ts("2026-10-04T10:00:00Z")), limit: 50, ..Default::default() };
    assert_eq!(keys(&s.query_runs(&q).unwrap()), ["r3", "r2"], "from is inclusive, to is exclusive");

    let q = RunQuery { pipelines: vec!["orders".into(), "audit".into()], limit: 50, ..Default::default() };
    assert_eq!(keys(&s.query_runs(&q).unwrap()), ["r5", "r2", "r1"]);

    let q = RunQuery { statuses: vec![RunStatus::Ok, RunStatus::Running], limit: 50, ..Default::default() };
    assert_eq!(keys(&s.query_runs(&q).unwrap()), ["r4", "r3", "r1"]);
}

#[test]
fn cursor_pages_neither_skip_nor_repeat_runs_that_started_together() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = s.query_runs(&RunQuery { limit: 2, cursor: cursor.clone(), ..Default::default() }).unwrap();
        let Some(last) = page.runs.last() else { break };
        cursor = Some(RunCursor { started_at: ts(&last.started_at), run_key: last.run_key.clone() });
        seen.extend(page.runs.iter().map(|r| r.run_key.clone()));
    }
    assert_eq!(seen, ["r5", "r4", "r3", "r2", "r1"]);
}

#[test]
fn numbered_pages_carry_the_total() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    let page = |n| s.query_runs(&RunQuery { limit: 2, page: Some(n), ..Default::default() }).unwrap();
    let (p1, p3, p9) = (page(1), page(3), page(9));
    assert_eq!((keys(&p1), p1.total), (vec!["r5", "r4"], Some(5)));
    assert_eq!((keys(&p3), p3.total), (vec!["r1"], Some(5)));
    assert_eq!((p9.runs.len(), p9.total), (0, Some(5)), "past the end is empty, the total still stands");

    let filtered = s
        .query_runs(&RunQuery { limit: 1, page: Some(1), pipelines: vec!["billing".into()], ..Default::default() })
        .unwrap();
    assert_eq!(filtered.total, Some(2), "the total follows the filters");
}

#[test]
fn contradictory_or_empty_queries_are_refused() {
    let (_ws, s) = store_or_skip!();
    let cursor = Some(RunCursor { started_at: Utc::now(), run_key: "x".into() });
    assert!(matches!(
        s.query_runs(&RunQuery { limit: 1, page: Some(1), cursor, ..Default::default() }),
        Err(MetricsError::InvalidArgument(_))
    ));
    assert!(matches!(s.query_runs(&RunQuery::default()), Err(MetricsError::InvalidArgument(_))));
    assert!(matches!(s.query_events(&EventQuery::default()), Err(MetricsError::InvalidArgument(_))));
}

#[test]
fn events_filter_and_page_by_cursor() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    for key in ["r1", "r2", "r3"] {
        s.ensure_run_started_event(key).unwrap();
    }
    let q = EventQuery { pipelines: vec!["orders".into()], kinds: vec![PipelineEventKind::RunStarted], limit: 1, ..Default::default() };
    let first = s.query_events(&q).unwrap();
    assert_eq!(first[0].run_key, "r2");
    let cursor = EventCursor { occurred_at: ts(&first[0].occurred_at), event_id: first[0].event_id.clone() };
    let next = s.query_events(&EventQuery { cursor: Some(cursor), ..q.clone() }).unwrap();
    assert_eq!(next[0].run_key, "r1");
    let none = s.query_events(&EventQuery { kinds: vec![PipelineEventKind::RunFinished], ..q }).unwrap();
    assert!(none.is_empty());
}

#[test]
fn run_states_list_every_run() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    let st = s.run_states().unwrap();
    assert_eq!(st.len(), 5);
    assert_eq!(st["r4"], RunStatus::Running);
}

// ---- hostile text -----------------------------------------------------------

#[test]
fn text_that_looks_like_sql_is_stored_and_matched_as_text() {
    let (_ws, s) = store_or_skip!();
    let nasty = "o'rders\\\n'; DROP TABLE pipeline_run; --";
    let mut p = begun("r'1", nasty, "2026-10-04T10:00:00Z");
    p.error = Some("Binder Error: column \"x\" isn't there\n\t'); DELETE FROM node_run; --".into());
    s.apply_run_patch(&p).unwrap();
    s.apply_node_patches(&[NodeRunPatch { error: p.error.clone(), ..node("r'1", nasty, Some(0), None) }]).unwrap();
    let q = RunQuery { pipelines: vec![nasty.into()], run_key: Some("r'1".into()), limit: 5, ..Default::default() };
    let found = s.query_runs(&q).unwrap();
    assert_eq!(found.runs.len(), 1, "the filter matched the literal text");
    assert_eq!(found.runs[0].pipeline_id, nasty);
    assert_eq!(found.runs[0].error, p.error);
    assert_eq!(nodes_of(&s, "r'1")[0].node_id, nasty);
    s.finalize_nodes("r'1", RunStatus::Error).unwrap();
    s.ensure_run_started_event("r'1").unwrap();
    assert_eq!(s.run_states().unwrap().len(), 1, "no table was dropped");
}

// ---- temp files, corruption, locking, a missing CLI ---------------------------

#[test]
fn row_files_are_removed_whether_the_write_works_or_not() {
    let (ws, s) = store_or_skip!();
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    assert!(temp_files(ws.path()).is_empty(), "{:?}", temp_files(ws.path()));
    let bad = begun("r2", "orders", "not a time");
    assert!(matches!(s.apply_run_patch(&bad), Err(MetricsError::Cli(_))));
    assert!(temp_files(ws.path()).is_empty(), "a failed write left {:?}", temp_files(ws.path()));
}

#[test]
fn stale_row_files_are_cleared_on_open_and_fresh_ones_kept() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let tmp = ws.path().join(".duckle").join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let stale = tmp.join("metrics-1-1.ndjson");
    let fresh = tmp.join("metrics-1-2.ndjson");
    let other = tmp.join("someone-else.ndjson");
    for f in [&stale, &fresh, &other] {
        std::fs::write(f, "{}").unwrap();
    }
    let old = SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
    std::fs::File::options().write(true).open(&other).unwrap().set_modified(old).unwrap();
    MetricsStore::open(ws.path(), &bin).unwrap();
    assert!(!stale.exists() && fresh.exists() && other.exists());
}

#[test]
fn the_corrupt_markers_match_what_the_cli_says() {
    let bin = cli_or_skip!();
    let dir = tempfile::tempdir().unwrap();
    let garbage = dir.path().join("garbage.duckdb");
    std::fs::write(&garbage, "this is not a database").unwrap();
    // A real store, cut short and scribbled on.
    let ws = tempfile::tempdir().unwrap();
    let s = MetricsStore::open(ws.path(), &bin).unwrap();
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    let bytes = std::fs::read(s.db_path()).unwrap();
    let short = dir.path().join("short.duckdb");
    std::fs::write(&short, &bytes[..4096]).unwrap();
    let scribbled = dir.path().join("scribbled.duckdb");
    let mut b = bytes.clone();
    b[8192..].iter_mut().for_each(|x| *x = 0xAB);
    std::fs::write(&scribbled, b).unwrap();
    for (file, marker) in [(&garbage, CORRUPT_MARKERS[0]), (&scribbled, CORRUPT_MARKERS[1]), (&short, CORRUPT_MARKERS[2])] {
        match run_cli(&bin, file, "SELECT * FROM pipeline_run;", true) {
            Err(MetricsError::Cli(msg)) => {
                assert!(msg.contains(marker), "{}: {msg}", file.display());
                assert!(is_corrupt(&msg));
            }
            other => panic!("{}: expected a CLI error, got {other:?}", file.display()),
        }
    }
}

#[test]
fn a_corrupt_store_is_moved_aside_rebuilt_and_flagged_for_backfill() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let db = ws.path().join(METRICS_DB_FILE);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    std::fs::write(&db, "this is not a database").unwrap();
    let s = MetricsStore::open(ws.path(), &bin).expect("rebuilt on open");
    let aside: Vec<String> = std::fs::read_dir(db.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("metrics.duckdb.corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert!(s.needs_backfill().unwrap(), "a rebuilt store must say it is empty");
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    s.set_needs_backfill(false).unwrap();
    assert!(!s.needs_backfill().unwrap());
}

#[test]
fn a_locked_store_is_busy_and_left_where_it_is() {
    let (ws, s) = store_or_skip!();
    s.apply_run_patch(&begun("r1", "orders", "2026-10-04T10:00:00Z")).unwrap();
    let held = crate::runlock::lock_store(ws.path(), STORE_LOCK).unwrap();
    let write = s.apply_run_patch(&begun("r2", "orders", "2026-10-04T10:00:00Z"));
    assert!(matches!(write, Err(MetricsError::Busy(_))), "{write:?}");
    // A read waits once more, so a holder that lets go in time is not an error.
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        drop(held);
    });
    let read = s.query_runs(&RunQuery { limit: 5, ..Default::default() });
    release.join().unwrap();
    assert_eq!(read.expect("the retried read succeeds").runs.len(), 1);
    assert!(s.db_path().is_file(), "busy is not corrupt: the file stays");
    assert!(!s.needs_backfill().unwrap());
}

#[test]
fn a_missing_cli_is_reported_and_one_that_appears_later_is_used() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let later = dir.path().join("duckdb");
    match MetricsStore::open(ws.path(), &later) {
        Err(MetricsError::EngineMissing(p)) => assert_eq!(p, later),
        other => panic!("expected EngineMissing, got {other:?}"),
    }
    std::fs::copy(&bin, &later).unwrap();
    MetricsStore::open(ws.path(), &later).expect("the same process picks it up");
}

// ---- retention ----------------------------------------------------------------

#[test]
fn deleting_before_a_horizon_takes_whole_runs_and_keeps_the_boundary() {
    let (_ws, s) = store_or_skip!();
    seed_runs(&s);
    for key in ["r1", "r2", "r3"] {
        s.apply_node_patches(&[
            node(key, "a", Some(0), Some(NodeStatus::Ok)),
            node(key, "b", Some(1), None),
            node(key, "c", Some(2), Some(NodeStatus::Skipped)),
        ])
        .unwrap();
        s.ensure_run_started_event(key).unwrap();
    }
    let horizon = ts("2026-10-03T10:00:00Z");
    let planned = s.count_before(horizon).unwrap();
    assert_eq!(planned, PurgeCounts { runs: 2, nodes: 6, events: 2 });
    let done = s.delete_before(horizon).unwrap();
    assert_eq!(done, planned, "the dry run and the real one agree");
    let left: Vec<String> = s.run_states().unwrap().into_keys().collect();
    assert_eq!(left.len(), 3, "{left:?}");
    assert!(left.contains(&"r3".to_string()), "a run exactly at the horizon stays");
    assert!(nodes_of(&s, "r1").is_empty() && nodes_of(&s, "r2").is_empty(), "pending and skipped nodes go with their run");
    assert_eq!(nodes_of(&s, "r3").len(), 3);
    assert_eq!(s.count_before(horizon).unwrap(), PurgeCounts::default());
}
