//! Put right what a killed process left marked as in flight.
//!
//! A run receipt and a backfill slice are marked `running` when work starts and
//! only moved on when it ends, so a process that is killed or quit leaves them
//! claiming work is happening forever. The reconcilers that fix that had one
//! caller - a console starting up - so anything run from the CLI, the desktop
//! app or MCP on a workspace no console serves stayed "running": the Runs tab
//! showed it in flight, OpenLineage never got its abort, and retention would
//! not prune it. Every surface that opens a workspace can call this; liveness is
//! an OS check, so a run another process is still doing is left alone.

use std::path::Path;

/// Mark as interrupted the runs and backfill slices whose process is gone, and
/// say so on stderr. Returns (run ids, backfill ids) that were reclaimed.
pub fn reclaim_abandoned(workspace: &Path) -> (Vec<String>, Vec<String>) {
    let alive = &crate::runlock::process_alive;
    // #259: anything still marked `running` whose process has gone was not
    // finished. `interrupted` is deliberately distinct from `error`: the run did
    // not fail, it stopped being observed, and a caller that conflates them
    // retries work that may well have completed.
    let runs = crate::retry::reconcile(workspace, alive);
    if !runs.is_empty() {
        eprintln!(
            "duckle: {} run(s) were still marked running and are now interrupted: {}",
            runs.len(),
            runs.join(", ")
        );
    }
    // #295: a slice left `running` by a killed process is not claimable and
    // `retry` only moves `failed` and `interrupted`, so nothing could pick it up.
    let backfills = crate::backfill::reconcile(workspace, alive);
    if !backfills.is_empty() {
        eprintln!(
            "duckle: {} backfill(s) had slices still marked running and are now interrupted: {}",
            backfills.len(),
            backfills.join(", ")
        );
    }
    (runs, backfills)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_processes_run_is_reclaimed_and_a_live_one_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        for (id, pid) in [("run-dead", u32::MAX), ("run-live", std::process::id())] {
            let mut r = crate::retry::begin(ws, id, "manual", "orders", "orders.json", "h", None);
            r.pid = Some(pid);
            crate::retry::write(ws, &r).unwrap();
        }
        let def = crate::partition::PartitionDef::Time {
            cadence: crate::partition::Cadence::Day,
            timezone: "UTC".into(),
            parameter_start: "window_start".into(),
            parameter_end: "window_end".into(),
        };
        std::fs::create_dir_all(ws.join("pipelines")).unwrap();
        std::fs::write(
            ws.join("pipelines").join("daily.json"),
            serde_json::json!({ "partition": def, "nodes": [], "edges": [] }).to_string(),
        )
        .unwrap();
        let mut plan = crate::backfill_exec::plan_for(ws, &ws.join("pipelines").join("daily.json"), "2026-09-01", "2026-09-01", 1, None)
            .unwrap();
        plan.pid = Some(u32::MAX);
        plan.partitions[0].state = crate::backfill::State::Running;
        crate::backfill::save(ws, &plan).unwrap();

        let (runs, backfills) = reclaim_abandoned(ws);
        assert_eq!(runs, vec!["run-dead".to_string()]);
        assert_eq!(crate::retry::load(ws, "run-live").unwrap().state, crate::retry::RUNNING);
        assert_eq!(backfills, vec![plan.id.clone()]);
        assert_eq!(
            crate::backfill::load(ws, &plan.id).unwrap().partitions[0].state,
            crate::backfill::State::Interrupted
        );
    }
}
