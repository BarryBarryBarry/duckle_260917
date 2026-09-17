//! `duckle-runner retry`, run as the real binary.

/// A run killed under the CLI left its receipt `running` for good: only a
/// console starting up ever reconciled receipts, so a deployment that runs
/// pipelines from cron and never starts one showed the run in flight forever,
/// never exported its OpenLineage abort, and never let retention prune it.
/// `retry` is where an operator comes for that run, so it reconciles first.
#[test]
fn retry_reclaims_a_run_whose_process_is_gone() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path();
    let mut receipt = duckle_duckdb_engine::retry::begin(
        ws,
        "run-killed",
        "manual",
        "orders",
        &ws.join("pipelines").join("orders.json").display().to_string(),
        "hash",
        None,
    );
    // Owned by a pid that is never alive, on either platform.
    receipt.pid = Some(u32::MAX);
    duckle_duckdb_engine::retry::write(ws, &receipt).unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_duckle-runner"))
        .arg("retry")
        .arg("run-killed")
        .arg("--workspace")
        .arg(ws)
        .arg("--dry-run")
        .output()
        .expect("the runner starts");

    let state = duckle_duckdb_engine::retry::load(ws, "run-killed").unwrap().state;
    assert_eq!(
        state,
        duckle_duckdb_engine::retry::INTERRUPTED,
        "the killed run is still marked in flight; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
