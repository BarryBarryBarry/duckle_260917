//! Plan 003: bring the metrics store up to date from what is already on disk.
//!
//! The JSON run history is the record of every run; the store is a view of it
//! that can fall behind - a process that was not keeping metrics, a queue that
//! did not drain before exit, a store rebuilt after corruption. A long-lived
//! process runs this once at start, after the run ledger has been reconciled:
//!
//! - every history record inside the horizon whose run the store does not
//!   hold, or holds as still open, is written from the record - a record
//!   written before run ids existed is keyed `legacy-…`, the same key every
//!   time, so running this twice changes nothing;
//! - a run the store still has open with no history record is settled from
//!   its receipt: finished there means finished here, a receipt that is gone
//!   or names a process that is no longer alive means interrupted, and a run
//!   a live process owns is left to it.
//!
//! One-shot CLI processes never run this: a cron of `--pipeline` would pay for
//! it on every invocation.

use crate::history::RunRecord;
use crate::metrics_bus::{self, MetricsEvent, RunIdentity};
use crate::metrics_model::{NodeRunPatch, PipelineEventRecord, PipelineRunPatch, RunStatus};
use crate::metrics_store::{MetricsError, MetricsStore, RunQuery};
use chrono::{DateTime, Utc};
use std::collections::HashSet;
use std::path::Path;

/// Records written per batch: three CLI calls each, however many runs.
const BATCH: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillReport {
    /// Runs written or completed from their history record.
    pub recorded: usize,
    /// Open runs settled from their receipt as finished.
    pub finished: usize,
    /// Open runs settled as interrupted.
    pub interrupted: usize,
    /// History files that could not be read and were skipped.
    pub unreadable_files: usize,
    /// Whether this was the full refill a rebuilt store asked for.
    pub was_rebuild: bool,
}

/// Backfill `workspace`'s store. `horizon` bounds which history records are
/// considered; a record that started before it is left out, as retention
/// would remove it anyway.
pub fn run(workspace: &Path, bin: &Path, horizon: Option<DateTime<Utc>>) -> Result<BackfillReport, MetricsError> {
    let store = MetricsStore::open(workspace, bin)?;
    let mut report = BackfillReport { was_rebuild: store.needs_backfill()?, ..Default::default() };
    let states = store.run_states()?;
    let mut batch = Batch::default();
    let mut settled: HashSet<String> = HashSet::new();
    for (pipeline_id, records) in history(workspace, &mut report) {
        for record in records {
            let key = record.run_id.clone().unwrap_or_else(|| metrics_bus::legacy_run_key(&pipeline_id, &record.at));
            let held = states.get(&key);
            if held.is_some_and(|s| s.is_terminal()) || settled.contains(&key) {
                continue;
            }
            let parts = metrics_bus::record_parts(&pipeline_id, &key, &record);
            if horizon.is_some_and(|h| parse(parts.run.started_at.as_deref()).is_some_and(|t| t < h)) {
                continue;
            }
            settled.insert(key);
            // A run the store has open may have stages the live stream placed
            // and never closed; one it never saw has only the record's nodes.
            batch.add(parts, held.is_some());
            report.recorded += 1;
            if batch.len() >= BATCH {
                batch.flush(&store)?;
            }
        }
    }
    batch.flush(&store)?;
    for (key, status) in &states {
        if status.is_terminal() || settled.contains(key) {
            continue;
        }
        match settle_open_run(workspace, bin, &store, key)? {
            Some(RunStatus::Interrupted) => report.interrupted += 1,
            Some(_) => report.finished += 1,
            None => {}
        }
    }
    if report.was_rebuild {
        store.set_needs_backfill(false)?;
    }
    Ok(report)
}

#[derive(Default)]
struct Batch {
    runs: Vec<PipelineRunPatch>,
    nodes: Vec<NodeRunPatch>,
    events: Vec<PipelineEventRecord>,
    reopened: Vec<(String, RunStatus)>,
}

impl Batch {
    fn add(&mut self, parts: metrics_bus::RecordParts, was_open: bool) {
        if was_open {
            self.reopened.push((parts.run.run_key.clone(), parts.status));
        }
        self.runs.push(parts.run);
        self.nodes.extend(parts.nodes);
        self.events.push(parts.started);
        self.events.push(parts.finished);
    }

    fn len(&self) -> usize {
        self.runs.len()
    }

    fn flush(&mut self, store: &MetricsStore) -> Result<(), MetricsError> {
        if self.runs.is_empty() {
            return Ok(());
        }
        store.apply_run_patches(&self.runs)?;
        store.apply_node_patches(&self.nodes)?;
        // A history record only lists the nodes it reached; any the live
        // stream had placed and never closed are closed by how the run ended.
        for (run_key, status) in &self.reopened {
            store.finalize_nodes(run_key, *status)?;
        }
        store.append_events(&self.events)?;
        *self = Batch::default();
        Ok(())
    }
}

/// Every pipeline's run history, oldest first. A file that cannot be read as
/// history is skipped and said so, rather than ending the backfill.
fn history(workspace: &Path, report: &mut BackfillReport) -> Vec<(String, Vec<RunRecord>)> {
    let Ok(entries) = std::fs::read_dir(workspace.join("runs")) else { return Vec::new() };
    let mut out = Vec::new();
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    paths.sort();
    for path in paths {
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Vec<RunRecord>>(&t).map_err(|e| e.to_string()));
        match parsed {
            Ok(records) => out.push((id, records)),
            Err(e) => {
                report.unreadable_files += 1;
                eprintln!("duckle: run history {} was not read into the metrics store: {e}", path.display());
            }
        }
    }
    out
}

/// What became of a run the store has open and the history never recorded.
fn settle_open_run(
    workspace: &Path,
    bin: &Path,
    store: &MetricsStore,
    run_key: &str,
) -> Result<Option<RunStatus>, MetricsError> {
    let receipt = crate::retry::load(workspace, run_key).ok();
    let now = Utc::now().to_rfc3339();
    let event = match &receipt {
        Some(r) if r.state == crate::retry::FINISHED => MetricsEvent::RunEnded {
            workspace: workspace.to_path_buf(),
            id: RunIdentity::of(r),
            status: r.status.clone(),
            ran_from: r.started_at.clone().unwrap_or_else(|| r.at.clone()),
            at: now,
            nodes: r
                .nodes
                .iter()
                .map(|(id, n)| metrics_bus::EndedNode {
                    node_id: id.clone(),
                    status: n.status.clone(),
                    stage_kind: n.kind.clone(),
                    rows: n.rows,
                    duration_ms: n.duration_ms,
                })
                .collect(),
        },
        Some(r) if owned_by_a_live_process(r) => return Ok(None),
        Some(r) => MetricsEvent::RunInterrupted { workspace: workspace.to_path_buf(), id: RunIdentity::of(r), at: now },
        None => match identity_from_store(store, run_key)? {
            Some(id) => MetricsEvent::RunInterrupted { workspace: workspace.to_path_buf(), id, at: now },
            None => return Ok(None),
        },
    };
    let status = match &event {
        MetricsEvent::RunEnded { status, .. } => RunStatus::from_result_status(status).0,
        _ => RunStatus::Interrupted,
    };
    metrics_bus::apply_now(bin, &event)?;
    Ok(Some(status))
}

fn owned_by_a_live_process(r: &crate::retry::RunReceipt) -> bool {
    (r.state == crate::retry::RUNNING || r.state == crate::retry::QUEUED)
        && r.pid.is_some_and(|pid| {
            crate::runlock::process_alive(pid) && !crate::runlock::started_by_a_previous_life(pid, &r.run_id)
        })
}

/// A run whose receipt is gone, as the store remembers it.
fn identity_from_store(store: &MetricsStore, run_key: &str) -> Result<Option<RunIdentity>, MetricsError> {
    let q = RunQuery { run_key: Some(run_key.to_string()), limit: 1, ..Default::default() };
    Ok(store.query_runs(&q)?.runs.pop().map(|r| RunIdentity {
        run_key: r.run_key,
        pipeline_id: r.pipeline_id,
        pipeline_name: r.pipeline_name,
        trigger: r.trigger.unwrap_or_default(),
        began_at: r.started_at,
    }))
}

fn parse(t: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(t?).ok().map(|t| t.with_timezone(&Utc))
}

/// Days of metrics a long-lived process keeps by default.
pub const DEFAULT_RETENTION_DAYS: u64 = 30;

/// `DUCKLE_METRICS_RETENTION_DAYS`, read the way every long-lived process
/// reads it: unset is the default, `0` keeps everything, and anything else
/// that is not a whole number is the default with a warning.
pub fn retention_days_from_env() -> Option<u64> {
    retention_days(std::env::var("DUCKLE_METRICS_RETENTION_DAYS").ok().as_deref())
}

fn retention_days(value: Option<&str>) -> Option<u64> {
    match value.map(str::trim) {
        None | Some("") => Some(DEFAULT_RETENTION_DAYS),
        Some("0") => None,
        Some(v) => match v.parse::<u64>() {
            Ok(n) => Some(n),
            Err(_) => {
                eprintln!(
                    "duckle: DUCKLE_METRICS_RETENTION_DAYS={v} is not a whole number of days; \
                     keeping {DEFAULT_RETENTION_DAYS} days of run metrics"
                );
                Some(DEFAULT_RETENTION_DAYS)
            }
        },
    }
}

/// The instant `days` ago.
pub fn horizon(days: u64) -> DateTime<Utc> {
    Utc::now() - chrono::Duration::days(i64::try_from(days).unwrap_or(i64::MAX / 86_400))
}

/// What a long-lived process does at start, on a thread of its own: backfill,
/// then - when `prune` - drop runs older than the retention horizon. Every
/// failure is reported and none is fatal.
pub fn at_startup(workspace: &Path, bin: &Path, prune: bool) {
    let days = retention_days_from_env();
    let limit = days.map(horizon);
    match run(workspace, bin, limit) {
        Ok(r) if r.recorded + r.finished + r.interrupted > 0 || r.was_rebuild => eprintln!(
            "duckle: run metrics for {} brought up to date: {} from history, {} finished, {} interrupted",
            workspace.display(),
            r.recorded,
            r.finished,
            r.interrupted
        ),
        Ok(_) => {}
        Err(MetricsError::EngineMissing(_)) => return,
        Err(e) => {
            eprintln!("duckle: run metrics for {} were not brought up to date: {e}", workspace.display());
            return;
        }
    }
    let (true, Some(days), Some(h)) = (prune, days, limit) else { return };
    match MetricsStore::open(workspace, bin).and_then(|s| s.delete_before(h)) {
        Ok(c) if c.runs + c.events > 0 => eprintln!(
            "duckle: run metrics for {} older than {days} days removed: {} run(s), {} node(s), {} event(s)",
            workspace.display(),
            c.runs,
            c.nodes,
            c.events
        ),
        Ok(_) => {}
        Err(e) => eprintln!("duckle: old run metrics for {} were not removed: {e}", workspace.display()),
    }
}

#[cfg(test)]
#[path = "metrics_backfill_tests.rs"]
mod tests;
