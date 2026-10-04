//! Plan 003: carry run lifecycle into the metrics store without slowing runs.
//!
//! The run ledger (`retry::begin/enqueue/admitted/finish/reconcile`), the run
//! history (`history::append_run_record`) and, from the engine, each stage
//! publish a [`MetricsEvent`] here. Nothing is published until a process says
//! where its DuckDB CLI is with [`configure`]: until then every `publish` is a
//! silent no-op that touches no file, which is what tests and processes that
//! do not keep metrics (MCP, one-off CLI subcommands) get.
//!
//! Two deliveries. [`DeliveryMode::Queued`], for long-lived processes, sends
//! to one consumer thread so a run only pays for a channel send; events of one
//! run are applied in the order they were published. [`DeliveryMode::Direct`],
//! for a one-shot CLI that would exit before a queue drained, writes in the
//! caller.
//!
//! Losing a stage event costs detail the final record restores; losing a
//! lifecycle event would leave a run `running` for ever. So only stage events
//! are ever dropped - when the queue is deep, or while the store keeps failing
//! - and lifecycle events are always attempted.

use crate::history::RunRecord;
use crate::metrics_model::{
    NodeRunPatch, NodeStatus, PipelineEventKind, PipelineEventRecord, PipelineRunPatch, RunStatus,
};
use crate::metrics_store::{MetricsError, MetricsStore};
use crate::retry::RunReceipt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Stage events beyond this many waiting are dropped.
const MAX_QUEUED_STAGE_EVENTS: usize = 1024;
/// Failures in a row that pause the store, and for how long.
const BREAKER_THRESHOLD: u32 = 3;
const BREAKER_COOLDOWN: Duration = Duration::from_secs(60);
/// Log one dropped stage event in this many.
const DROP_LOG_EVERY: u64 = 100;
/// How much of an error a `run_finished` event keeps.
const EVENT_ERROR_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryMode {
    Queued,
    Direct,
}

/// Who a run is, as every lifecycle event carries it, so whichever of them
/// arrives first can create the run's row.
#[derive(Debug, Clone, PartialEq)]
pub struct RunIdentity {
    pub run_key: String,
    /// The pipeline file's stem: the id run history and the API key on.
    pub pipeline_id: String,
    /// What the run was started as, which for an editor run is the name the
    /// browser shows rather than the id.
    pub pipeline_name: Option<String>,
    pub trigger: String,
    /// When the run was begun (the receipt's `at`), queueing included.
    pub began_at: String,
}

impl RunIdentity {
    pub fn of(receipt: &RunReceipt) -> RunIdentity {
        let pipeline_id = Path::new(&receipt.pipeline_path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| receipt.pipeline_name.clone());
        RunIdentity {
            run_key: receipt.run_id.clone(),
            pipeline_id,
            pipeline_name: Some(receipt.pipeline_name.clone()).filter(|n| !n.is_empty()),
            trigger: receipt.trigger.clone(),
            began_at: receipt.at.clone(),
        }
    }
}

/// One node of a finished run, as the run ledger reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct EndedNode {
    pub node_id: String,
    pub status: String,
    /// The stage's `sink`/`view`, used only to total the rows written.
    pub stage_kind: Option<String>,
    pub rows: Option<u64>,
    pub duration_ms: Option<u64>,
}

/// A stage as compiled, before it runs.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedStage {
    pub node_id: String,
    pub component: Option<String>,
    /// Catalog kind.
    pub kind: Option<String>,
    pub ordinal: i64,
}

/// Everything the store learns about runs. Every time is taken when the event
/// is published, on the run's own thread, never when it is applied.
#[derive(Debug, Clone)]
pub enum MetricsEvent {
    RunBegun { workspace: PathBuf, id: RunIdentity },
    RunQueued { workspace: PathBuf, id: RunIdentity },
    RunAdmitted { workspace: PathBuf, id: RunIdentity, queue_ms: u64 },
    /// `ran_from` is when execution began: admission for a queued run, the
    /// begin otherwise, so a run's duration does not include its wait.
    RunEnded { workspace: PathBuf, id: RunIdentity, status: String, ran_from: String, at: String, nodes: Vec<EndedNode> },
    /// The run history's record: the final word on a run's figures.
    /// `pipeline_id` is what the history was filed under, which is
    /// authoritative over the ledger's guess.
    RunRecorded { workspace: PathBuf, pipeline_id: String, record: RunRecord },
    RunInterrupted { workspace: PathBuf, id: RunIdentity, at: String },
    StagesPlanned { workspace: PathBuf, run_key: String, stages: Vec<PlannedStage> },
    StageStarted { workspace: PathBuf, run_key: String, node_id: String, at: String },
    StageFinished {
        workspace: PathBuf,
        run_key: String,
        node_id: String,
        status: NodeStatus,
        rows: Option<u64>,
        duration_ms: Option<u64>,
        error: Option<String>,
    },
}

impl MetricsEvent {
    pub fn workspace(&self) -> &Path {
        match self {
            MetricsEvent::RunBegun { workspace, .. }
            | MetricsEvent::RunQueued { workspace, .. }
            | MetricsEvent::RunAdmitted { workspace, .. }
            | MetricsEvent::RunEnded { workspace, .. }
            | MetricsEvent::RunRecorded { workspace, .. }
            | MetricsEvent::RunInterrupted { workspace, .. }
            | MetricsEvent::StagesPlanned { workspace, .. }
            | MetricsEvent::StageStarted { workspace, .. }
            | MetricsEvent::StageFinished { workspace, .. } => workspace,
        }
    }

    pub fn run_key(&self) -> &str {
        match self {
            MetricsEvent::RunBegun { id, .. }
            | MetricsEvent::RunQueued { id, .. }
            | MetricsEvent::RunAdmitted { id, .. }
            | MetricsEvent::RunEnded { id, .. }
            | MetricsEvent::RunInterrupted { id, .. } => &id.run_key,
            MetricsEvent::RunRecorded { record, .. } => record.run_id.as_deref().unwrap_or(""),
            MetricsEvent::StagesPlanned { run_key, .. }
            | MetricsEvent::StageStarted { run_key, .. }
            | MetricsEvent::StageFinished { run_key, .. } => run_key,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            MetricsEvent::RunBegun { .. } => "run_begun",
            MetricsEvent::RunQueued { .. } => "run_queued",
            MetricsEvent::RunAdmitted { .. } => "run_admitted",
            MetricsEvent::RunEnded { .. } => "run_ended",
            MetricsEvent::RunRecorded { .. } => "run_recorded",
            MetricsEvent::RunInterrupted { .. } => "run_interrupted",
            MetricsEvent::StagesPlanned { .. } => "stages_planned",
            MetricsEvent::StageStarted { .. } => "stage_started",
            MetricsEvent::StageFinished { .. } => "stage_finished",
        }
    }

    /// Detail the final record restores, so the only kind ever dropped.
    pub fn is_stage(&self) -> bool {
        matches!(
            self,
            MetricsEvent::StagesPlanned { .. } | MetricsEvent::StageStarted { .. } | MetricsEvent::StageFinished { .. }
        )
    }
}

// ---- the bus ------------------------------------------------------------------

/// Consecutive store failures, and the pause they cause.
struct Breaker {
    threshold: u32,
    cooldown: Duration,
    failures: AtomicU32,
    open_until: Mutex<Option<Instant>>,
}

impl Breaker {
    fn new(threshold: u32, cooldown: Duration) -> Breaker {
        Breaker { threshold, cooldown, failures: AtomicU32::new(0), open_until: Mutex::new(None) }
    }

    fn is_open(&self) -> bool {
        let guard = self.open_until.lock().unwrap_or_else(|e| e.into_inner());
        guard.is_some_and(|until| Instant::now() < until)
    }

    fn success(&self) {
        self.failures.store(0, Ordering::Relaxed);
    }

    fn failure(&self) {
        if self.failures.fetch_add(1, Ordering::Relaxed) + 1 < self.threshold {
            return;
        }
        self.failures.store(0, Ordering::Relaxed);
        *self.open_until.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + self.cooldown);
        eprintln!(
            "duckle: the metrics store failed {} times in a row; pausing metrics writes for {}s. \
             Runs are not affected and their history is still kept.",
            self.threshold,
            self.cooldown.as_secs()
        );
    }
}

/// What is shared between the publishing side and the consumer thread.
struct Shared {
    bin: PathBuf,
    mode: DeliveryMode,
    breaker: Breaker,
    depth: AtomicUsize,
    dropped: AtomicU64,
    missing_warned: AtomicBool,
}

pub struct Bus {
    shared: Arc<Shared>,
    tx: Option<Sender<MetricsEvent>>,
    max_stage_depth: usize,
    /// Which workspace a running run belongs to, for stage events published
    /// by an engine that only knows the run id.
    workspaces: Mutex<HashMap<String, PathBuf>>,
}

impl Bus {
    pub fn new(bin: PathBuf, mode: DeliveryMode) -> Bus {
        Bus::with_limits(bin, mode, MAX_QUEUED_STAGE_EVENTS, BREAKER_THRESHOLD, BREAKER_COOLDOWN)
    }

    fn with_limits(bin: PathBuf, mode: DeliveryMode, max_stage_depth: usize, threshold: u32, cooldown: Duration) -> Bus {
        let shared = Arc::new(Shared {
            bin,
            mode,
            breaker: Breaker::new(threshold, cooldown),
            depth: AtomicUsize::new(0),
            dropped: AtomicU64::new(0),
            missing_warned: AtomicBool::new(false),
        });
        let tx = (mode == DeliveryMode::Queued).then(|| spawn_consumer(Arc::clone(&shared))).flatten();
        Bus { shared, tx, max_stage_depth, workspaces: Mutex::new(HashMap::new()) }
    }

    pub fn publish(&self, event: MetricsEvent) {
        self.track_workspace(&event);
        if event.is_stage() && !self.room_for_stage_event() {
            self.note_dropped(&event);
            return;
        }
        match &self.tx {
            Some(tx) => {
                self.shared.depth.fetch_add(1, Ordering::SeqCst);
                if let Err(unsent) = tx.send(event) {
                    self.shared.depth.fetch_sub(1, Ordering::SeqCst);
                    eprintln!("duckle: metrics consumer has stopped; {} event dropped", unsent.0.name());
                }
            }
            None => deliver(&self.shared, event),
        }
    }

    fn room_for_stage_event(&self) -> bool {
        !self.shared.breaker.is_open() && self.shared.depth.load(Ordering::SeqCst) < self.max_stage_depth
    }

    fn note_dropped(&self, event: &MetricsEvent) {
        let n = self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        if n % DROP_LOG_EVERY == 0 {
            eprintln!(
                "duckle: metrics {} for run {} dropped (queue full or store paused; {} dropped so far). \
                 The run's final record still reaches the store.",
                event.name(),
                event.run_key(),
                n + 1
            );
        }
    }

    fn track_workspace(&self, event: &MetricsEvent) {
        let mut map = self.workspaces.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            MetricsEvent::RunBegun { workspace, id } => {
                map.insert(id.run_key.clone(), workspace.clone());
            }
            MetricsEvent::RunEnded { id, .. } | MetricsEvent::RunInterrupted { id, .. } => {
                map.remove(&id.run_key);
            }
            _ => {}
        }
    }

    pub fn workspace_of(&self, run_key: &str) -> Option<PathBuf> {
        self.workspaces.lock().unwrap_or_else(|e| e.into_inner()).get(run_key).cloned()
    }

    /// Wait until every queued event has been applied, or `timeout` passes.
    /// Returns whether the queue drained. Direct delivery has nothing to wait for.
    pub fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.shared.depth.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }
}

fn spawn_consumer(shared: Arc<Shared>) -> Option<Sender<MetricsEvent>> {
    let (tx, rx) = channel::<MetricsEvent>();
    let spawned = std::thread::Builder::new().name("duckle-metrics".into()).spawn(move || {
        while let Ok(event) = rx.recv() {
            deliver(&shared, event);
            shared.depth.fetch_sub(1, Ordering::SeqCst);
        }
    });
    match spawned {
        Ok(_) => Some(tx),
        Err(e) => {
            eprintln!("duckle: could not start the metrics thread ({e}); run metrics will not be stored");
            None
        }
    }
}

/// Apply one event, containing every failure. While the breaker is open a
/// stage event is skipped, and so is everything in direct mode, where a
/// failing store would otherwise be waited on by every run.
fn deliver(shared: &Shared, event: MetricsEvent) {
    if shared.breaker.is_open() && (event.is_stage() || shared.mode == DeliveryMode::Direct) {
        return;
    }
    let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| apply(&shared.bin, &event)));
    match applied {
        Ok(Ok(())) => shared.breaker.success(),
        Ok(Err(MetricsError::EngineMissing(bin))) => {
            if !shared.missing_warned.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "duckle: run metrics are not stored until the DuckDB CLI is available at {}",
                    bin.display()
                );
            }
        }
        Ok(Err(e)) => {
            log_failure(&event, &e.to_string());
            shared.breaker.failure();
        }
        Err(_) => {
            log_failure(&event, "panicked");
            shared.breaker.failure();
        }
    }
}

fn log_failure(event: &MetricsEvent, why: &str) {
    eprintln!(
        "duckle: metrics {} for run {} in {} was not stored: {why}",
        event.name(),
        event.run_key(),
        event.workspace().display()
    );
}

// ---- applying events ------------------------------------------------------------

fn apply(bin: &Path, event: &MetricsEvent) -> Result<(), MetricsError> {
    if let MetricsEvent::RunRecorded { record, .. } = event {
        // `reconcile` writes a placeholder record with zeroed figures for an
        // interrupted run; RunInterrupted already said all there is to say.
        if record.status == crate::retry::INTERRUPTED || record.run_id.is_none() {
            return Ok(());
        }
    }
    let store = MetricsStore::open(event.workspace(), bin)?;
    match event {
        MetricsEvent::RunBegun { id, .. } => store.apply_run_patch(&identity_patch(id, RunStatus::Running)),
        MetricsEvent::RunQueued { id, .. } => store.apply_run_patch(&identity_patch(id, RunStatus::Queued)),
        MetricsEvent::RunAdmitted { id, queue_ms, .. } => {
            let patch = PipelineRunPatch { queue_ms: Some(to_i64(*queue_ms)), ..identity_patch(id, RunStatus::Running) };
            store.apply_run_patch(&patch)?;
            store.ensure_run_started_event(&id.run_key)
        }
        MetricsEvent::RunEnded { id, status, ran_from, at, nodes, .. } => {
            apply_ended(&store, id, status, (ran_from.as_str(), at.as_str()), nodes)
        }
        MetricsEvent::RunRecorded { pipeline_id, record, .. } => apply_recorded(&store, pipeline_id, record),
        MetricsEvent::RunInterrupted { id, at, .. } => {
            store.apply_run_patch(&identity_patch(id, RunStatus::Interrupted))?;
            close_run(&store, &id.run_key, RunStatus::Interrupted)?;
            store.append_event(&finished_event(id, at, RunStatus::Interrupted, None, None, None))
        }
        MetricsEvent::StagesPlanned { run_key, stages, .. } => {
            let patches: Vec<NodeRunPatch> = stages
                .iter()
                .map(|s| NodeRunPatch {
                    run_key: run_key.clone(),
                    node_id: s.node_id.clone(),
                    ordinal: Some(s.ordinal),
                    component: s.component.clone(),
                    kind: s.kind.clone(),
                    status: Some(NodeStatus::Pending),
                    ..Default::default()
                })
                .collect();
            store.apply_node_patches(&patches)
        }
        MetricsEvent::StageStarted { run_key, node_id, at, .. } => store.apply_node_patches(&[NodeRunPatch {
            run_key: run_key.clone(),
            node_id: node_id.clone(),
            status: Some(NodeStatus::Running),
            started_at: Some(at.clone()),
            ..Default::default()
        }]),
        MetricsEvent::StageFinished { run_key, node_id, status, rows, duration_ms, error, .. } => {
            store.apply_node_patches(&[NodeRunPatch {
                run_key: run_key.clone(),
                node_id: node_id.clone(),
                status: Some(*status),
                rows: rows.map(to_i64),
                duration_ms: duration_ms.map(to_i64),
                error: error.clone(),
                ..Default::default()
            }])
        }
    }
}

fn identity_patch(id: &RunIdentity, status: RunStatus) -> PipelineRunPatch {
    PipelineRunPatch {
        run_key: id.run_key.clone(),
        pipeline_id: Some(id.pipeline_id.clone()),
        pipeline_name: id.pipeline_name.clone(),
        trigger: Some(id.trigger.clone()),
        status: Some(status),
        started_at: Some(id.began_at.clone()),
        ..Default::default()
    }
}

/// Final node states, then the run's start (if it was never admitted
/// through a queue) - both idempotent.
fn close_run(store: &MetricsStore, run_key: &str, status: RunStatus) -> Result<(), MetricsError> {
    store.finalize_nodes(run_key, status)?;
    store.ensure_run_started_event(run_key)
}

fn apply_ended(
    store: &MetricsStore,
    id: &RunIdentity,
    status: &str,
    (ran_from, at): (&str, &str),
    nodes: &[EndedNode],
) -> Result<(), MetricsError> {
    let (status, unknown) = RunStatus::from_result_status(status);
    let duration_ms = elapsed_ms(ran_from, at);
    let sinks: Vec<u64> =
        nodes.iter().filter(|n| n.stage_kind.as_deref() == Some("sink")).filter_map(|n| n.rows).collect();
    let rows = (!sinks.is_empty()).then(|| to_i64(sinks.iter().sum()));
    store.apply_run_patch(&PipelineRunPatch {
        duration_ms,
        rows,
        node_count: Some(to_i64(nodes.len() as u64)),
        error: unknown.clone(),
        ..identity_patch(id, status)
    })?;
    let patches: Vec<NodeRunPatch> = nodes
        .iter()
        .map(|n| NodeRunPatch {
            run_key: id.run_key.clone(),
            node_id: n.node_id.clone(),
            status: n.status.parse().ok(),
            rows: n.rows.map(to_i64),
            duration_ms: n.duration_ms.map(to_i64),
            ..Default::default()
        })
        .collect();
    store.apply_node_patches(&patches)?;
    close_run(store, &id.run_key, status)?;
    store.append_event(&finished_event(id, at, status, duration_ms, rows, unknown.as_deref()))
}

fn apply_recorded(store: &MetricsStore, pipeline_id: &str, r: &RunRecord) -> Result<(), MetricsError> {
    let Some(run_key) = r.run_id.clone() else { return Ok(()) };
    let (status, unknown) = RunStatus::from_result_status(&r.status);
    let started_at = r.started_at.clone().or_else(|| minus_ms(&r.at, r.duration_ms)).unwrap_or_else(|| r.at.clone());
    let error = match (&r.error, unknown) {
        (Some(e), Some(u)) => Some(format!("{u}: {e}")),
        (e, u) => e.clone().or(u),
    };
    let patch = PipelineRunPatch {
        run_key: run_key.clone(),
        pipeline_id: Some(pipeline_id.to_string()),
        trigger: Some(r.trigger.clone()),
        status: Some(status),
        started_at: Some(started_at.clone()),
        duration_ms: Some(to_i64(r.duration_ms)),
        rows: Some(to_i64(r.rows)),
        rejected_rows: r.rejected_rows.map(to_i64),
        node_count: Some(to_i64(r.node_count as u64)),
        unchanged: Some(r.unchanged),
        incomplete: Some(r.incomplete),
        incomplete_reason: r.incomplete_reason.clone(),
        error: error.clone(),
        category: r.category.clone(),
        ..Default::default()
    };
    store.apply_run_patch(&patch)?;
    let nodes: Vec<NodeRunPatch> = r
        .nodes
        .iter()
        .map(|n| NodeRunPatch {
            run_key: run_key.clone(),
            node_id: n.node.clone(),
            component: n.component.clone(),
            kind: n.kind.clone(),
            status: n.status.as_deref().and_then(|s| s.parse().ok()),
            started_at: n.started_at.clone(),
            duration_ms: n.duration_ms.map(to_i64),
            rows: n.rows.map(to_i64),
            rejected_rows: n.rejected_rows.map(to_i64),
            error: n.error.clone(),
            category: n.category.clone(),
            ..Default::default()
        })
        .collect();
    store.apply_node_patches(&nodes)?;
    close_run(store, &run_key, status)?;
    let id = RunIdentity {
        run_key,
        pipeline_id: pipeline_id.to_string(),
        pipeline_name: None,
        trigger: r.trigger.clone(),
        began_at: started_at,
    };
    let (duration, rows) = (Some(to_i64(r.duration_ms)), Some(to_i64(r.rows)));
    store.append_event(&finished_event(&id, &r.at, status, duration, rows, error.as_deref()))
}

fn finished_event(
    id: &RunIdentity,
    at: &str,
    status: RunStatus,
    duration_ms: Option<i64>,
    rows: Option<i64>,
    error: Option<&str>,
) -> PipelineEventRecord {
    let detail = serde_json::json!({
        "status": status.as_str(),
        "duration_ms": duration_ms,
        "rows": rows,
        "error": error.map(|e| e.chars().take(EVENT_ERROR_MAX_CHARS).collect::<String>()),
    });
    PipelineEventRecord {
        event_id: PipelineEventRecord::id_for(&id.run_key, PipelineEventKind::RunFinished),
        run_key: id.run_key.clone(),
        pipeline_id: id.pipeline_id.clone(),
        pipeline_name: id.pipeline_name.clone(),
        kind: PipelineEventKind::RunFinished,
        occurred_at: at.to_string(),
        trigger: Some(id.trigger.clone()),
        detail: Some(detail.to_string()),
        created_at: String::new(),
    }
}

fn to_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn parse_utc(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&chrono::Utc))
}

fn elapsed_ms(from: &str, to: &str) -> Option<i64> {
    let ms = (parse_utc(to)? - parse_utc(from)?).num_milliseconds();
    (ms >= 0).then_some(ms)
}

fn minus_ms(at: &str, ms: u64) -> Option<String> {
    let delta = chrono::TimeDelta::try_milliseconds(i64::try_from(ms).ok()?)?;
    parse_utc(at)?.checked_sub_signed(delta).map(|t| t.to_rfc3339())
}

/// The store key for a run recorded before run ids existed: stable for the
/// same record, so backfilling it twice finds the same row.
pub fn legacy_run_key(pipeline_id: &str, at: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{pipeline_id}|{at}").as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("legacy-{hex}")
}

// ---- the process-wide bus ---------------------------------------------------------

static BUS: OnceLock<Bus> = OnceLock::new();

/// Start keeping run metrics in this process. The first call wins; a later
/// one with different settings is ignored. Only the path is kept: whether the
/// CLI is there is asked again on every write.
pub fn configure(bin: PathBuf, mode: DeliveryMode) {
    let mut fresh = false;
    let bus = BUS.get_or_init(|| {
        fresh = true;
        Bus::new(bin.clone(), mode)
    });
    if !fresh && (bus.shared.bin != bin || bus.shared.mode != mode) {
        eprintln!(
            "duckle: run metrics are already kept with {} ({:?}); ignoring {} ({:?})",
            bus.shared.bin.display(),
            bus.shared.mode,
            bin.display(),
            mode
        );
    }
}

pub fn enabled() -> bool {
    BUS.get().is_some()
}

/// Publish an event, building it only when metrics are being kept.
pub fn publish_with(build: impl FnOnce() -> MetricsEvent) {
    if let Some(bus) = BUS.get() {
        bus.publish(build());
    }
}

/// The workspace of a run begun in this process and not yet ended.
pub fn workspace_of(run_key: &str) -> Option<PathBuf> {
    BUS.get().and_then(|b| b.workspace_of(run_key))
}

/// Best effort before a long-lived process exits.
pub fn flush(timeout: Duration) -> bool {
    BUS.get().is_none_or(|b| b.flush(timeout))
}

#[cfg(test)]
#[path = "metrics_bus_tests.rs"]
mod tests;
