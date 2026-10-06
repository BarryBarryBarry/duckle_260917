use super::*;
use crate::metrics_model::{NodeRunPatch, NodeStatus, PipelineRunPatch};
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

fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn bad(r: Result<Value, QueryError>) -> String {
    match r {
        Err(QueryError::BadRequest(m)) => m,
        other => panic!("expected a bad request, got {other:?}"),
    }
}

// ---- parsing, with no store behind it ------------------------------------------------

#[test]
fn bad_parameters_are_refused_before_the_store_is_touched() {
    // A CLI that does not exist: reaching the store would answer Unavailable.
    let ws = tempfile::tempdir().unwrap();
    let nowhere = ws.path().join("no-duckdb");
    let runs = |p: &[(&str, &str)]| runs(ws.path(), &nowhere, &params(p));
    assert!(bad(runs(&[("from", "yesterday")])).contains("from"));
    assert!(bad(runs(&[("status", "ok,'; DROP TABLE pipeline_run; --")])).contains("unknown status"));
    assert!(bad(runs(&[("pipeline", "orders,../etc")])).contains("../etc"));
    assert!(bad(runs(&[("pipeline", "a\\b")])).contains("not a pipeline id"));
    assert!(bad(runs(&[("cursor", "not-base64!")])).contains("cursor"));
    assert!(bad(runs(&[("cursor", &URL_SAFE_NO_PAD.encode("2026-10-04T10:00:00Z"))])).contains("cursor"));
    assert!(bad(runs(&[("limit", "0")])).contains("limit"));
    assert!(bad(runs(&[("limit", "-5")])).contains("limit"));
    assert!(bad(runs(&[("includeNodes", "yes")])).contains("includeNodes"));
    assert!(bad(runs(&[("page", "1"), ("cursor", &encode_cursor("2026-10-04T10:00:00Z", "r1"))])).contains("cursor"));
    let many: Vec<String> = (0..51).map(|i| format!("p{i}")).collect();
    assert!(bad(runs(&[("pipeline", &many.join(","))])).contains("at most"));
    let events = |p: &[(&str, &str)]| events(ws.path(), &nowhere, &params(p));
    assert!(bad(events(&[("kind", "run_paused")])).contains("unknown kind"));
    assert!(!ws.path().join(".duckle").exists(), "nothing was opened");
}

#[test]
fn limits_are_capped_and_paging_is_chosen_by_what_was_asked() {
    let r = parse_runs(&params(&[("limit", "9999")])).unwrap();
    assert_eq!((r.limit, r.include_nodes), (MAX_LIMIT_WITH_NODES, true));
    let r = parse_runs(&params(&[("limit", "9999"), ("includeNodes", "false")])).unwrap();
    assert_eq!(r.limit, MAX_LIMIT);
    let r = parse_runs(&params(&[("pageSize", "500")])).unwrap();
    assert_eq!(r.paging, Paging::Page { number: 1, size: MAX_PAGE_SIZE });
    let r = parse_runs(&params(&[("page", "3")])).unwrap();
    assert_eq!(r.paging, Paging::Page { number: 3, size: DEFAULT_PAGE_SIZE });
    let r = parse_runs(&params(&[("runKey", "run-1"), ("includeNodes", "false")])).unwrap();
    assert!(r.include_nodes, "one run's detail always comes with its nodes");
    let r = parse_runs(&params(&[("status", "pending,ok"), ("pipeline", " a , b ")])).unwrap();
    assert_eq!((r.pending, r.statuses.clone(), r.pipelines.clone()), (true, vec![RunStatus::Ok], vec!["a".to_string(), "b".to_string()]));
}

#[test]
fn editor_arguments_become_the_same_parameters() {
    let p = params_from_json(&json!({
        "pipeline": ["a", "b"], "status": "ok", "page": 2, "includeNodes": false, "ignored": { "x": 1 }
    }));
    assert_eq!(p["pipeline"], "a,b");
    assert_eq!((p["page"].as_str(), p["includeNodes"].as_str(), p.get("ignored")), ("2", "false", None));
}

#[test]
fn cursors_round_trip_and_detail_keys_become_camel_case() {
    let (at, key) = decode_cursor(&encode_cursor("2026-10-04T10:00:00.123456Z", "run|with|bars")).unwrap();
    assert_eq!((at.to_rfc3339(), key.as_str()), ("2026-10-04T10:00:00.123456+00:00".to_string(), "run|with|bars"));
    assert_eq!(camel_keys(json!({ "duration_ms": 1, "queue_ms": null, "status": "ok" })), json!({ "durationMs": 1, "queueMs": null, "status": "ok" }));
}

// ---- answers from a real store --------------------------------------------------------

fn seed(bin: &Path, ws: &Path) {
    let pipelines = ws.join("pipelines");
    std::fs::create_dir_all(&pipelines).unwrap();
    for (id, declared) in [("orders", "Orders file"), ("billing", ""), ("audit", "Audit"), ("idle", ""), ("zz_idle", "A idle")] {
        let body = if declared.is_empty() { json!({ "nodes": [], "edges": [] }) } else { json!({ "name": declared, "nodes": [], "edges": [] }) };
        std::fs::write(pipelines.join(format!("{id}.json")), body.to_string()).unwrap();
    }
    std::fs::write(ws.join("repository.json"), r#"[{"id":"orders","name":"Orders (repo)"}]"#).unwrap();
    let s = MetricsStore::open(ws, bin).unwrap();
    let runs = [
        ("r1", "orders", RunStatus::Ok, "2026-10-01T10:00:00Z", Some("Orders run")),
        ("r2", "orders", RunStatus::Error, "2026-10-02T10:00:00Z", None),
        ("r3", "billing", RunStatus::Ok, "2026-10-03T10:00:00Z", Some("Billing (draft)")),
        ("legacy-0011223344556677", "audit", RunStatus::Ok, "2026-10-04T10:00:00Z", None),
    ];
    for (key, pipeline, status, at, name) in runs {
        s.apply_run_patch(&PipelineRunPatch {
            run_key: key.into(),
            pipeline_id: Some(pipeline.into()),
            pipeline_name: name.map(str::to_string),
            status: Some(status),
            started_at: Some(at.into()),
            duration_ms: Some(1500),
            ..Default::default()
        })
        .unwrap();
    }
    s.apply_node_patches(&[
        NodeRunPatch { run_key: "r1".into(), node_id: "b".into(), ordinal: Some(1), status: Some(NodeStatus::Ok), ..Default::default() },
        NodeRunPatch { run_key: "r1".into(), node_id: "a".into(), ordinal: Some(0), status: Some(NodeStatus::Ok), rows: Some(7), ..Default::default() },
    ])
    .unwrap();
    s.ensure_run_started_event("r1").unwrap();
    s.ensure_run_started_event("r2").unwrap();
}

fn keys(v: &Value) -> Vec<String> {
    v["runs"].as_array().unwrap().iter().map(|r| r["runKey"].as_str().unwrap().to_string()).collect()
}

#[test]
fn runs_come_back_named_with_their_nodes_and_a_cursor() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    seed(&bin, ws.path());
    let v = runs(ws.path(), &bin, &params(&[("limit", "2")])).unwrap();
    assert_eq!(v["schemaVersion"], 1);
    assert_eq!(keys(&v), ["legacy-0011223344556677", "r3"]);
    let first = &v["runs"][0];
    assert_eq!((first["runId"].clone(), first["pipelineName"].clone()), (Value::Null, json!("Audit")), "a legacy key is no run id");
    assert_eq!(v["runs"][1]["pipelineName"], "Billing (draft)", "no declared name: what it was started as");
    assert_eq!(v["runs"][1]["runId"], "r3");
    let next = v["nextCursor"].as_str().expect("a full page has a next cursor").to_string();
    let v2 = runs(ws.path(), &bin, &params(&[("limit", "2"), ("cursor", &next)])).unwrap();
    assert_eq!(keys(&v2), ["r2", "r1"]);
    let r1 = &v2["runs"][1];
    assert_eq!(r1["pipelineName"], "Orders (repo)", "repository.json names it first");
    let nodes: Vec<&str> = r1["nodes"].as_array().unwrap().iter().map(|n| n["nodeId"].as_str().unwrap()).collect();
    assert_eq!(nodes, ["a", "b"], "in stage order");
    assert_eq!((r1["nodes"][0]["rows"].clone(), r1["durationMs"].clone(), r1["startedAt"].clone()), (json!(7), json!(1500), json!("2026-10-01T10:00:00.000000Z")));
    let v3 = runs(ws.path(), &bin, &params(&[("limit", "2"), ("cursor", v2["nextCursor"].as_str().unwrap())])).unwrap();
    assert!(keys(&v3).is_empty() && v3["nextCursor"].is_null());
}

#[test]
fn filters_narrow_and_nodes_can_be_left_out() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    seed(&bin, ws.path());
    let v = runs(ws.path(), &bin, &params(&[("pipeline", "orders,billing"), ("status", "ok"), ("includeNodes", "false")])).unwrap();
    assert_eq!(keys(&v), ["r3", "r1"]);
    assert!(v["runs"][0].get("nodes").is_none());
    let v = runs(ws.path(), &bin, &params(&[("from", "2026-10-02T00:00:00Z"), ("to", "2026-10-03T00:00:00Z")])).unwrap();
    assert_eq!(keys(&v), ["r2"]);
    let v = runs(ws.path(), &bin, &params(&[("runKey", "r1"), ("page", "4")])).unwrap();
    assert_eq!(keys(&v), Vec::<String>::new(), "a run key on a page that does not exist");
    let v = runs(ws.path(), &bin, &params(&[("runKey", "r1")])).unwrap();
    assert_eq!(v["runs"][0]["nodes"].as_array().unwrap().len(), 2);
}

#[test]
fn never_run_pipelines_appear_only_when_pending_is_asked_for() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    seed(&bin, ws.path());
    let v = runs(ws.path(), &bin, &params(&[])).unwrap();
    assert!(!keys(&v).iter().any(|k| k.starts_with("never-run:")));

    let v = runs(ws.path(), &bin, &params(&[("status", "pending")])).unwrap();
    assert_eq!(keys(&v), ["never-run:zz_idle", "never-run:idle"], "only never-run pipelines, by display name");
    assert_eq!((v["runs"][0]["status"].clone(), v["runs"][0]["pipelineName"].clone()), (json!("pending"), json!("A idle")));
    assert_eq!(v["runs"][0]["nodes"], json!([]));
    assert!(v["runs"][0]["startedAt"].is_null());

    let v = runs(ws.path(), &bin, &params(&[("status", "pending,error"), ("from", "2030-01-01T00:00:00Z")])).unwrap();
    assert_eq!(keys(&v), ["never-run:zz_idle", "never-run:idle"], "a time range does not hide a pipeline that never ran");
    let v = runs(ws.path(), &bin, &params(&[("status", "pending,error"), ("pipeline", "idle,orders")])).unwrap();
    assert_eq!(keys(&v), ["r2", "never-run:idle"]);
    let cursor = encode_cursor("2026-10-02T10:00:00Z", "r2");
    let v = runs(ws.path(), &bin, &params(&[("status", "pending,error"), ("cursor", &cursor)])).unwrap();
    assert!(keys(&v).is_empty(), "a later page does not repeat them");
}

#[test]
fn numbered_pages_count_never_run_pipelines_after_the_runs() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    seed(&bin, ws.path());
    let page = |n: &str| runs(ws.path(), &bin, &params(&[("status", "pending,ok,error"), ("page", n), ("pageSize", "2")])).unwrap();
    let (p1, p2, p3, p4) = (page("1"), page("2"), page("3"), page("4"));
    assert_eq!((p1["total"].clone(), p1["page"].clone(), p1["pageSize"].clone()), (json!(6), json!(1), json!(2)));
    assert_eq!(keys(&p1), ["legacy-0011223344556677", "r3"]);
    assert_eq!(keys(&p2), ["r2", "r1"]);
    assert_eq!(keys(&p3), ["never-run:zz_idle", "never-run:idle"]);
    assert!(keys(&p4).is_empty());
    assert!(p1.get("nextCursor").is_none(), "a numbered page has no cursor");
    let only = runs(ws.path(), &bin, &params(&[("status", "pending"), ("page", "1"), ("pageSize", "1")])).unwrap();
    assert_eq!((keys(&only), only["total"].clone()), (vec!["never-run:zz_idle".to_string()], json!(2)));
}

#[test]
fn events_come_back_in_api_case_and_page_by_cursor() {
    let bin = cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    seed(&bin, ws.path());
    let v = events(ws.path(), &bin, &params(&[("limit", "1"), ("kind", "run_started")])).unwrap();
    let e = &v["events"][0];
    assert_eq!((e["runKey"].clone(), e["pipelineName"].clone(), e["kind"].clone()), (json!("r2"), json!("Orders (repo)"), json!("run_started")));
    assert_eq!(e["detail"], json!({ "queueMs": null }));
    let next = events(ws.path(), &bin, &params(&[("limit", "1"), ("kind", "run_started"), ("cursor", v["nextCursor"].as_str().unwrap())])).unwrap();
    assert_eq!(next["events"][0]["runKey"], "r1");
}

#[test]
fn an_unusable_store_is_unavailable_not_a_bad_request() {
    let ws = tempfile::tempdir().unwrap();
    let err = runs(ws.path(), &ws.path().join("no-duckdb"), &params(&[])).unwrap_err();
    assert_eq!(err.status(), "503 Service Unavailable");
    assert!(err.body()["reason"].as_str().unwrap().contains("not found"), "{}", err.body());
}

#[test]
fn the_pipeline_list_is_every_pipeline_by_display_name() {
    let ws = tempfile::tempdir().unwrap();
    let p = ws.path().join("pipelines");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("b.json"), r#"{"name":"Beta","nodes":[],"edges":[]}"#).unwrap();
    std::fs::write(p.join("a.json"), r#"{"nodes":[],"edges":[]}"#).unwrap();
    std::fs::write(p.join("not-a-pipeline.json"), r#"{"hello":1}"#).unwrap();
    std::fs::write(ws.path().join("repository.json"), r#"[{"id":"a","name":"Zed"}]"#).unwrap();
    assert_eq!(
        pipelines(ws.path()),
        json!({ "schemaVersion": 1, "pipelines": [
            { "pipelineId": "b", "pipelineName": "Beta" },
            { "pipelineId": "a", "pipelineName": "Zed" },
        ]})
    );
}
