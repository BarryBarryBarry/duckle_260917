//! Plan 003: the run metrics store, `<workspace>/.duckle/metrics.duckdb`.
//!
//! Driven through the DuckDB CLI the engine already ships with, so the store
//! adds no dependency: every call is one CLI process, SQL on stdin, results as
//! JSON on stdout. Values never travel inside SQL text. Rows to write go
//! through a throwaway NDJSON file read with `read_json`, and the few filter
//! values a query needs are quoted by [`sql_quote`] after being parsed into
//! typed values first.
//!
//! Every call holds the workspace's `metrics-db` store lock, so the console,
//! the desktop and a one-off CLI run never open the file at once. A file the
//! CLI reports as corrupt is moved aside and rebuilt, and the rebuilt store is
//! flagged `needs_backfill` so a long-lived process refills it from the JSON
//! run history.

use crate::metrics_model::{
    NodeRunMetric, NodeRunPatch, PipelineEventKind, PipelineEventRecord, PipelineRunMetric,
    PipelineRunPatch, RunStatus,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// Where the store lives, relative to the workspace.
pub const METRICS_DB_FILE: &str = ".duckle/metrics.duckdb";
/// The schema this build writes and understands.
pub const SCHEMA_VERSION: i64 = 1;
const STORE_LOCK: &str = "metrics-db";
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// Leftover NDJSON older than this belongs to a call that died.
const STALE_TEMP: Duration = Duration::from_secs(600);
const TS_FORMAT: &str = "%Y-%m-%dT%H:%M:%S.%fZ";

/// What the DuckDB CLI says about a database file it cannot read as one.
/// Matched as substrings of its stderr; a test pins each against the CLI.
pub(crate) const CORRUPT_MARKERS: &[&str] = &[
    "not a valid DuckDB database file",
    "Corrupt database file",
    "Could not read enough bytes from file",
];
/// What it says when another process has the file open.
const LOCKED_MARKERS: &[&str] = &["Could not set lock on file", "Conflicting lock is held"];

#[derive(Debug, thiserror::Error)]
pub enum MetricsError {
    #[error("the DuckDB CLI was not found at {0}")]
    EngineMissing(PathBuf),
    #[error("the metrics store is busy: {0}")]
    Busy(String),
    #[error("the metrics store did not answer within {0} seconds")]
    Timeout(u64),
    #[error("the metrics store has schema version {found}, newer than the {supported} this Duckle understands")]
    SchemaTooNew { found: i64, supported: i64 },
    #[error("the metrics store refused the statement: {0}")]
    Cli(String),
    #[error("metrics store i/o: {0}")]
    Io(#[from] std::io::Error),
    #[error("the metrics store answered with output that could not be read: {0}")]
    Output(String),
    #[error("invalid metrics query: {0}")]
    InvalidArgument(String),
}

/// Runs, newest first. `total` is set only for page-numbered queries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunPage {
    pub runs: Vec<PipelineRunMetric>,
    pub total: Option<u64>,
}

/// Position after the last run of a previous page.
#[derive(Debug, Clone, PartialEq)]
pub struct RunCursor {
    pub started_at: DateTime<Utc>,
    pub run_key: String,
}

/// Filters for [`MetricsStore::query_runs`]. Times are half-open:
/// `from <= started_at < to`. `cursor` and `page` are exclusive.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub pipelines: Vec<String>,
    pub statuses: Vec<RunStatus>,
    pub run_key: Option<String>,
    pub limit: u32,
    pub cursor: Option<RunCursor>,
    /// 1-based page number; `limit` is the page size.
    pub page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventCursor {
    pub occurred_at: DateTime<Utc>,
    pub event_id: String,
}

/// Filters for [`MetricsStore::query_events`], newest first.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub pipelines: Vec<String>,
    pub kinds: Vec<PipelineEventKind>,
    pub limit: u32,
    pub cursor: Option<EventCursor>,
}

/// Rows a retention pass would remove, or did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurgeCounts {
    pub runs: u64,
    pub nodes: u64,
    pub events: u64,
}

#[derive(Debug, Clone)]
pub struct MetricsStore {
    workspace: PathBuf,
    bin: PathBuf,
    db: PathBuf,
}

/// Stores whose schema this process has already checked. Cleared for a path
/// whose file had to be rebuilt.
static SCHEMA_READY: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn schema_ready(db: &Path) -> bool {
    let guard = SCHEMA_READY.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().is_some_and(|s| s.contains(db))
}

fn mark_schema_ready(db: &Path, ready: bool) {
    let mut guard = SCHEMA_READY.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    if ready {
        set.insert(db.to_path_buf());
    } else {
        set.remove(db);
    }
}

impl MetricsStore {
    /// Open the workspace's store, creating it and its schema on first use.
    ///
    /// Whether the CLI exists is decided here on every call and never
    /// remembered: the desktop downloads it on first run, after which the same
    /// process must find the store usable.
    pub fn open(workspace: &Path, bin: &Path) -> Result<MetricsStore, MetricsError> {
        let store = MetricsStore {
            workspace: workspace.to_path_buf(),
            bin: bin.to_path_buf(),
            db: workspace.join(METRICS_DB_FILE),
        };
        if !store.bin.is_file() {
            return Err(MetricsError::EngineMissing(store.bin));
        }
        std::fs::create_dir_all(store.temp_dir())?;
        remove_stale_temp(&store.temp_dir());
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn db_path(&self) -> &Path {
        &self.db
    }

    fn temp_dir(&self) -> PathBuf {
        self.workspace.join(".duckle").join("tmp")
    }

    fn ensure_schema(&self) -> Result<(), MetricsError> {
        if schema_ready(&self.db) {
            return Ok(());
        }
        let sql = format!("{}\nSELECT value FROM metrics_meta WHERE key = 'schema_version';", schema_sql());
        let out = self.exec(&sql, true)?;
        let rows: Vec<MetaValue> = last_result(&out)?;
        let found = rows
            .first()
            .and_then(|r| r.value.parse::<i64>().ok())
            .ok_or_else(|| MetricsError::Output(format!("no usable schema_version in {out}")))?;
        if found > SCHEMA_VERSION {
            return Err(MetricsError::SchemaTooNew { found, supported: SCHEMA_VERSION });
        }
        mark_schema_ready(&self.db, true);
        Ok(())
    }

    /// One CLI call under the store lock. A file the CLI calls corrupt is
    /// moved aside, rebuilt empty and flagged for backfill, and the call is
    /// made once more against the new file.
    fn exec(&self, sql: &str, json: bool) -> Result<String, MetricsError> {
        crate::policy::refuse_unsafe_sql(sql).map_err(MetricsError::InvalidArgument)?;
        let _lock = crate::runlock::lock_store(&self.workspace, STORE_LOCK).map_err(MetricsError::Busy)?;
        match run_cli(&self.bin, &self.db, sql, json) {
            Err(MetricsError::Cli(msg)) if is_corrupt(&msg) => {
                self.quarantine(&msg)?;
                let rebuild = format!("{}\n{}", schema_sql(), set_backfill_sql(true));
                run_cli(&self.bin, &self.db, &rebuild, false)?;
                run_cli(&self.bin, &self.db, sql, json)
            }
            other => other,
        }
    }

    /// A read that meets a busy store waits for the lock once more before
    /// giving up, since the holder is usually a single short write.
    fn read(&self, sql: &str) -> Result<String, MetricsError> {
        match self.exec(sql, true) {
            Err(MetricsError::Busy(_)) => self.exec(sql, true),
            other => other,
        }
    }

    fn quarantine(&self, reason: &str) -> Result<(), MetricsError> {
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let aside = self.db.with_file_name(format!("metrics.duckdb.corrupt-{secs}"));
        eprintln!(
            "duckle: the metrics store {} is unreadable ({}); moved to {} and rebuilt. \
             It will be refilled from run history.",
            self.db.display(),
            reason.lines().next().unwrap_or(reason),
            aside.display()
        );
        std::fs::rename(&self.db, &aside)?;
        // A write-ahead log belongs to the file it was written against.
        let wal = self.db.with_file_name("metrics.duckdb.wal");
        if wal.exists() {
            std::fs::rename(&wal, aside.with_file_name(format!("metrics.duckdb.corrupt-{secs}.wal")))?;
        }
        Ok(())
    }

    /// Create or update one run. See [`PipelineRunPatch`] for the rules.
    pub fn apply_run_patch(&self, patch: &PipelineRunPatch) -> Result<(), MetricsError> {
        require_key("run_key", &patch.run_key)?;
        let rows = TempNdjson::write(&self.temp_dir(), std::slice::from_ref(patch))?;
        let creates = patch.pipeline_id.is_some() && patch.started_at.is_some();
        let sql = if creates {
            upsert_sql("pipeline_run", &["run_key"], RUN_COLS, &rows.path, "'queued'")
        } else {
            update_sql("pipeline_run", "run_key", RUN_COLS, &rows.path)
        };
        self.exec(&sql, false).map(|_| ())
    }

    /// Create or update nodes. A node patched twice in one call keeps the
    /// later patch only, since one statement cannot update a row twice.
    pub fn apply_node_patches(&self, patches: &[NodeRunPatch]) -> Result<(), MetricsError> {
        let mut seen = HashSet::new();
        let mut unique: Vec<&NodeRunPatch> = Vec::with_capacity(patches.len());
        for p in patches.iter().rev() {
            require_key("run_key", &p.run_key)?;
            require_key("node_id", &p.node_id)?;
            if seen.insert((p.run_key.as_str(), p.node_id.as_str())) {
                unique.push(p);
            }
        }
        if unique.is_empty() {
            return Ok(());
        }
        unique.reverse();
        let rows = TempNdjson::write(&self.temp_dir(), &unique)?;
        let sql = upsert_sql("node_run", &["run_key", "node_id"], NODE_COLS, &rows.path, "'pending'");
        self.exec(&sql, false).map(|_| ())
    }

    /// Close out a run's open nodes once the run itself has ended: what never
    /// started is `skipped`, and what was mid-flight takes the run's ending.
    /// A run that has not ended leaves its nodes alone.
    pub fn finalize_nodes(&self, run_key: &str, status: RunStatus) -> Result<(), MetricsError> {
        let running_to = match status {
            RunStatus::Queued | RunStatus::Running => return Ok(()),
            RunStatus::Ok => "ok",
            RunStatus::Error => "error",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
        };
        let sql = format!(
            "UPDATE node_run SET status = CASE WHEN status = 'pending' THEN 'skipped' ELSE '{running_to}' END, \
             updated_at = now() WHERE run_key = {} AND status IN ('pending', 'running');",
            sql_quote(run_key)?
        );
        self.exec(&sql, false).map(|_| ())
    }

    /// Record an event. An event already recorded is left as it was.
    pub fn append_event(&self, event: &PipelineEventRecord) -> Result<(), MetricsError> {
        require_key("event_id", &event.event_id)?;
        let rows = TempNdjson::write(&self.temp_dir(), std::slice::from_ref(event))?;
        let sql = format!(
            "INSERT INTO pipeline_event (event_id, run_key, pipeline_id, pipeline_name, kind, occurred_at, trigger, detail) \
             SELECT event_id, run_key, pipeline_id, pipeline_name, kind, occurred_at, trigger, detail \
             FROM read_json({}, format = 'newline_delimited', columns = {}) ON CONFLICT DO NOTHING;",
            sql_quote(&rows.path.to_string_lossy())?,
            json_columns(EVENT_COLS)
        );
        self.exec(&sql, false).map(|_| ())
    }

    /// Record that a run started, from the run's own row: it began at
    /// `started_at`, and did work `queue_ms` later. Idempotent, and a no-op
    /// for a run the store has no row for.
    pub fn ensure_run_started_event(&self, run_key: &str) -> Result<(), MetricsError> {
        let sql = format!(
            "INSERT INTO pipeline_event (event_id, run_key, pipeline_id, pipeline_name, kind, occurred_at, trigger, detail) \
             SELECT run_key || ':run_started', run_key, pipeline_id, pipeline_name, 'run_started', \
             started_at + to_milliseconds(COALESCE(queue_ms, 0)), trigger, \
             json_object('queue_ms', queue_ms)::VARCHAR \
             FROM pipeline_run WHERE run_key = {} ON CONFLICT DO NOTHING;",
            sql_quote(run_key)?
        );
        self.exec(&sql, false).map(|_| ())
    }

    pub fn query_runs(&self, q: &RunQuery) -> Result<RunPage, MetricsError> {
        if q.limit == 0 {
            return Err(MetricsError::InvalidArgument("limit must be at least 1".into()));
        }
        if q.cursor.is_some() && q.page.is_some() {
            return Err(MetricsError::InvalidArgument("cursor and page cannot be combined".into()));
        }
        let mut conds = time_conditions("started_at", q.from, q.to);
        in_condition(&mut conds, "pipeline_id", q.pipelines.iter().map(String::as_str))?;
        in_condition(&mut conds, "status", q.statuses.iter().map(|s| s.as_str()))?;
        if let Some(k) = &q.run_key {
            conds.push(format!("run_key = {}", sql_quote(k)?));
        }
        let filter = where_clause(&conds);
        let mut page_conds = conds.clone();
        if let Some(c) = &q.cursor {
            let ts = ts_literal(c.started_at);
            let key = sql_quote(&c.run_key)?;
            page_conds.push(format!("(started_at < {ts} OR (started_at = {ts} AND run_key < {key}))"));
        }
        let offset = q.page.map(|p| u64::from(p.max(1) - 1) * u64::from(q.limit)).unwrap_or(0);
        let select = format!(
            "SELECT {} FROM pipeline_run{} ORDER BY started_at DESC, run_key DESC LIMIT {} OFFSET {offset};",
            select_list(RUN_COLS, ROW_AUDIT),
            where_clause(&page_conds),
            q.limit
        );
        let count = format!("SELECT COUNT(*) AS total FROM pipeline_run{filter};");
        let sql = if q.page.is_some() { format!("{count}\n{select}") } else { select };
        let out = self.read(&sql)?;
        let results = json_results(&out)?;
        let total = match q.page {
            Some(_) => results
                .first()
                .and_then(|r| r.get(0))
                .and_then(|r| r.get("total"))
                .and_then(|t| t.as_u64()),
            None => None,
        };
        let runs = decode(results.last().cloned().unwrap_or_default())?;
        Ok(RunPage { runs, total })
    }

    /// The nodes of these runs, each run's in stage order.
    pub fn query_nodes(&self, run_keys: &[String]) -> Result<Vec<NodeRunMetric>, MetricsError> {
        if run_keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut conds = Vec::new();
        in_condition(&mut conds, "run_key", run_keys.iter().map(String::as_str))?;
        let sql = format!(
            "SELECT {} FROM node_run{} ORDER BY run_key, ordinal NULLS LAST, node_id;",
            select_list(NODE_COLS, ROW_AUDIT),
            where_clause(&conds)
        );
        last_result(&self.read(&sql)?)
    }

    pub fn query_events(&self, q: &EventQuery) -> Result<Vec<PipelineEventRecord>, MetricsError> {
        if q.limit == 0 {
            return Err(MetricsError::InvalidArgument("limit must be at least 1".into()));
        }
        let mut conds = time_conditions("occurred_at", q.from, q.to);
        in_condition(&mut conds, "pipeline_id", q.pipelines.iter().map(String::as_str))?;
        in_condition(&mut conds, "kind", q.kinds.iter().map(|k| k.as_str()))?;
        if let Some(c) = &q.cursor {
            let ts = ts_literal(c.occurred_at);
            let id = sql_quote(&c.event_id)?;
            conds.push(format!("(occurred_at < {ts} OR (occurred_at = {ts} AND event_id < {id}))"));
        }
        let sql = format!(
            "SELECT {} FROM pipeline_event{} ORDER BY occurred_at DESC, event_id DESC LIMIT {};",
            select_list(EVENT_COLS, &["created_at"]),
            where_clause(&conds),
            q.limit
        );
        last_result(&self.read(&sql)?)
    }

    /// Every run the store holds and where it stands, for backfill.
    pub fn run_states(&self) -> Result<HashMap<String, RunStatus>, MetricsError> {
        #[derive(Deserialize)]
        struct State {
            run_key: String,
            status: RunStatus,
        }
        let states: Vec<State> = last_result(&self.read("SELECT run_key, status FROM pipeline_run;")?)?;
        Ok(states.into_iter().map(|s| (s.run_key, s.status)).collect())
    }

    /// The pipelines the store holds at least one run of.
    pub fn pipelines_with_runs(&self) -> Result<HashSet<String>, MetricsError> {
        #[derive(Deserialize)]
        struct Id {
            pipeline_id: String,
        }
        let ids: Vec<Id> = last_result(&self.read("SELECT DISTINCT pipeline_id FROM pipeline_run;")?)?;
        Ok(ids.into_iter().map(|i| i.pipeline_id).collect())
    }

    /// What [`MetricsStore::delete_before`] would remove for this horizon.
    pub fn count_before(&self, horizon: DateTime<Utc>) -> Result<PurgeCounts, MetricsError> {
        last_result::<PurgeCounts>(&self.read(&count_before_sql(horizon))?)?
            .into_iter()
            .next()
            .ok_or_else(|| MetricsError::Output("no counts returned".into()))
    }

    /// Remove runs that started before `horizon`, with all of their nodes
    /// whatever state those are in, and events that occurred before it. Rows
    /// exactly at the horizon stay. The file does not shrink.
    pub fn delete_before(&self, horizon: DateTime<Utc>) -> Result<PurgeCounts, MetricsError> {
        let h = ts_literal(horizon);
        let sql = format!(
            "BEGIN TRANSACTION;\n{}\n\
             DELETE FROM node_run WHERE run_key IN (SELECT run_key FROM pipeline_run WHERE started_at < {h});\n\
             DELETE FROM pipeline_run WHERE started_at < {h};\n\
             DELETE FROM pipeline_event WHERE occurred_at < {h};\nCOMMIT;",
            count_before_sql(horizon)
        );
        last_result::<PurgeCounts>(&self.exec(&sql, true)?)?
            .into_iter()
            .next()
            .ok_or_else(|| MetricsError::Output("no counts returned".into()))
    }

    /// Whether the store was rebuilt and still has to be refilled.
    pub fn needs_backfill(&self) -> Result<bool, MetricsError> {
        let rows: Vec<MetaValue> =
            last_result(&self.read("SELECT value FROM metrics_meta WHERE key = 'needs_backfill';")?)?;
        Ok(rows.first().is_some_and(|r| r.value == "1"))
    }

    pub fn set_needs_backfill(&self, needed: bool) -> Result<(), MetricsError> {
        self.exec(&set_backfill_sql(needed), false).map(|_| ())
    }
}

#[derive(Deserialize)]
struct MetaValue {
    value: String,
}

fn schema_sql() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS pipeline_run (\
         run_key VARCHAR NOT NULL PRIMARY KEY, pipeline_id VARCHAR NOT NULL, pipeline_name VARCHAR, \
         trigger VARCHAR, status VARCHAR NOT NULL, started_at TIMESTAMPTZ NOT NULL, duration_ms BIGINT, \
         rows BIGINT, rejected_rows BIGINT, node_count BIGINT, unchanged BOOLEAN, incomplete BOOLEAN, \
         incomplete_reason VARCHAR, queue_ms BIGINT, error VARCHAR, category VARCHAR, \
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());\n\
         CREATE TABLE IF NOT EXISTS node_run (\
         run_key VARCHAR NOT NULL, node_id VARCHAR NOT NULL, ordinal BIGINT, component VARCHAR, kind VARCHAR, \
         status VARCHAR NOT NULL, started_at TIMESTAMPTZ, duration_ms BIGINT, rows BIGINT, rejected_rows BIGINT, \
         error VARCHAR, category VARCHAR, \
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), \
         PRIMARY KEY (run_key, node_id));\n\
         CREATE TABLE IF NOT EXISTS pipeline_event (\
         event_id VARCHAR NOT NULL PRIMARY KEY, run_key VARCHAR NOT NULL, pipeline_id VARCHAR NOT NULL, \
         pipeline_name VARCHAR, kind VARCHAR NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, trigger VARCHAR, \
         detail VARCHAR, created_at TIMESTAMPTZ NOT NULL DEFAULT now());\n\
         CREATE TABLE IF NOT EXISTS metrics_meta (key VARCHAR NOT NULL PRIMARY KEY, value VARCHAR NOT NULL);\n\
         INSERT INTO metrics_meta VALUES ('schema_version', '{SCHEMA_VERSION}') ON CONFLICT DO NOTHING;"
    )
}

fn set_backfill_sql(needed: bool) -> String {
    format!(
        "INSERT INTO metrics_meta VALUES ('needs_backfill', '{}') \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value;",
        if needed { 1 } else { 0 }
    )
}

fn count_before_sql(horizon: DateTime<Utc>) -> String {
    let h = ts_literal(horizon);
    format!(
        "SELECT (SELECT COUNT(*) FROM pipeline_run WHERE started_at < {h}) AS runs, \
         (SELECT COUNT(*) FROM node_run WHERE run_key IN \
         (SELECT run_key FROM pipeline_run WHERE started_at < {h})) AS nodes, \
         (SELECT COUNT(*) FROM pipeline_event WHERE occurred_at < {h}) AS events;"
    )
}

/// How a patch column combines with what the row holds.
#[derive(Clone, Copy, PartialEq)]
enum Merge {
    /// Part of the key; never updated.
    Key,
    /// A new value replaces the old; `NULL` keeps the old.
    Overwrite,
    /// The first value written stays.
    KeepFirst,
    /// Moves forward only: an open state never replaces a final one.
    Status(&'static [&'static str]),
}

#[derive(Clone, Copy)]
struct Col {
    name: &'static str,
    ty: &'static str,
    merge: Merge,
    timestamp: bool,
}

const fn col(name: &'static str, ty: &'static str, merge: Merge) -> Col {
    Col { name, ty, merge, timestamp: false }
}

const fn ts_col(name: &'static str, merge: Merge) -> Col {
    Col { name, ty: "TIMESTAMPTZ", merge, timestamp: true }
}

const RUN_OPEN: &[&str] = &["queued", "running"];
const NODE_OPEN: &[&str] = &["pending", "running"];

const RUN_COLS: &[Col] = &[
    col("run_key", "VARCHAR", Merge::Key),
    col("pipeline_id", "VARCHAR", Merge::Overwrite),
    col("pipeline_name", "VARCHAR", Merge::Overwrite),
    col("trigger", "VARCHAR", Merge::Overwrite),
    col("status", "VARCHAR", Merge::Status(RUN_OPEN)),
    ts_col("started_at", Merge::KeepFirst),
    col("duration_ms", "BIGINT", Merge::Overwrite),
    col("rows", "BIGINT", Merge::Overwrite),
    col("rejected_rows", "BIGINT", Merge::Overwrite),
    col("node_count", "BIGINT", Merge::Overwrite),
    col("unchanged", "BOOLEAN", Merge::Overwrite),
    col("incomplete", "BOOLEAN", Merge::Overwrite),
    col("incomplete_reason", "VARCHAR", Merge::Overwrite),
    col("queue_ms", "BIGINT", Merge::Overwrite),
    col("error", "VARCHAR", Merge::Overwrite),
    col("category", "VARCHAR", Merge::Overwrite),
];

const NODE_COLS: &[Col] = &[
    col("run_key", "VARCHAR", Merge::Key),
    col("node_id", "VARCHAR", Merge::Key),
    col("ordinal", "BIGINT", Merge::Overwrite),
    col("component", "VARCHAR", Merge::Overwrite),
    col("kind", "VARCHAR", Merge::Overwrite),
    col("status", "VARCHAR", Merge::Status(NODE_OPEN)),
    ts_col("started_at", Merge::KeepFirst),
    col("duration_ms", "BIGINT", Merge::Overwrite),
    col("rows", "BIGINT", Merge::Overwrite),
    col("rejected_rows", "BIGINT", Merge::Overwrite),
    col("error", "VARCHAR", Merge::Overwrite),
    col("category", "VARCHAR", Merge::Overwrite),
];

const EVENT_COLS: &[Col] = &[
    col("event_id", "VARCHAR", Merge::Key),
    col("run_key", "VARCHAR", Merge::Overwrite),
    col("pipeline_id", "VARCHAR", Merge::Overwrite),
    col("pipeline_name", "VARCHAR", Merge::Overwrite),
    col("kind", "VARCHAR", Merge::Overwrite),
    ts_col("occurred_at", Merge::Overwrite),
    col("trigger", "VARCHAR", Merge::Overwrite),
    col("detail", "VARCHAR", Merge::Overwrite),
];

/// The value a column ends with when `new` (the patch) meets `old` (the row).
fn merged(c: &Col, old: &str, new: &str) -> String {
    let (o, n) = (format!("{old}.{}", c.name), format!("{new}.{}", c.name));
    match c.merge {
        Merge::Key => o,
        Merge::Overwrite => format!("COALESCE({n}, {o})"),
        Merge::KeepFirst => format!("COALESCE({o}, {n})"),
        Merge::Status(open) => {
            // Open states replace each other freely (a run is begun as
            // running and may then be queued for a permit); only a final
            // state is sticky against an open one.
            let words: Vec<String> = open.iter().map(|s| format!("'{s}'")).collect();
            let is_open = |x: &str| format!("{x} IN ({})", words.join(", "));
            format!("CASE WHEN {n} IS NULL THEN {o} WHEN {} AND NOT {} THEN {o} ELSE {n} END", is_open(&n), is_open(&o))
        }
    }
}

/// `SET` and change-detecting `WHERE` for an update of `table` from `new`.
fn set_and_changed(table: &str, cols: &[Col], new: &str) -> (String, String) {
    let updatable: Vec<&Col> = cols.iter().filter(|c| c.merge != Merge::Key).collect();
    let set: Vec<String> =
        updatable.iter().map(|c| format!("{} = {}", c.name, merged(c, table, new))).collect();
    let old: Vec<String> = updatable.iter().map(|c| format!("{table}.{}", c.name)).collect();
    let new_vals: Vec<String> = updatable.iter().map(|c| merged(c, table, new)).collect();
    (
        format!("{}, updated_at = now()", set.join(", ")),
        format!("({}) IS DISTINCT FROM ({})", old.join(", "), new_vals.join(", ")),
    )
}

/// Insert-or-merge every row of an NDJSON file. `updated_at` moves only when
/// the merged row differs from the stored one.
fn upsert_sql(table: &str, keys: &[&str], cols: &[Col], src: &Path, status_default: &str) -> String {
    let names: Vec<&str> = cols.iter().map(|c| c.name).collect();
    let select: Vec<String> = cols
        .iter()
        .map(|c| match c.merge {
            Merge::Status(_) => format!("COALESCE({}, {status_default})", c.name),
            _ => c.name.to_string(),
        })
        .collect();
    let (set, changed) = set_and_changed(table, cols, "excluded");
    format!(
        "INSERT INTO {table} ({}) SELECT {} FROM read_json({}, format = 'newline_delimited', columns = {}) \
         ON CONFLICT ({}) DO UPDATE SET {set} WHERE {changed};",
        names.join(", "),
        select.join(", "),
        path_literal(src),
        json_columns(cols),
        keys.join(", ")
    )
}

/// Merge NDJSON rows into existing rows only; rows that do not exist are
/// not created.
fn update_sql(table: &str, key: &str, cols: &[Col], src: &Path) -> String {
    let (set, changed) = set_and_changed(table, cols, "p");
    format!(
        "UPDATE {table} SET {set} FROM (SELECT * FROM read_json({}, format = 'newline_delimited', columns = {})) AS p \
         WHERE {table}.{key} = p.{key} AND {changed};",
        path_literal(src),
        json_columns(cols)
    )
}

fn json_columns(cols: &[Col]) -> String {
    let parts: Vec<String> = cols.iter().map(|c| format!("{}: '{}'", c.name, c.ty)).collect();
    format!("{{{}}}", parts.join(", "))
}

/// Columns as read back, plus the store-maintained `audit` timestamps; every
/// timestamp as RFC3339 UTC text.
fn select_list(cols: &[Col], audit: &[&str]) -> String {
    let parts: Vec<String> = cols
        .iter()
        .map(|c| if c.timestamp { format!("strftime({0}, '{TS_FORMAT}') AS {0}", c.name) } else { c.name.to_string() })
        .chain(audit.iter().map(|n| format!("strftime({n}, '{TS_FORMAT}') AS {n}")))
        .collect();
    parts.join(", ")
}

const ROW_AUDIT: &[&str] = &["created_at", "updated_at"];

fn time_conditions(col: &str, from: Option<DateTime<Utc>>, to: Option<DateTime<Utc>>) -> Vec<String> {
    let mut conds = Vec::new();
    if let Some(f) = from {
        conds.push(format!("{col} >= {}", ts_literal(f)));
    }
    if let Some(t) = to {
        conds.push(format!("{col} < {}", ts_literal(t)));
    }
    conds
}

fn in_condition<'a>(
    conds: &mut Vec<String>,
    col: &str,
    values: impl Iterator<Item = &'a str>,
) -> Result<(), MetricsError> {
    let quoted = values.map(sql_quote).collect::<Result<Vec<_>, _>>()?;
    if !quoted.is_empty() {
        conds.push(format!("{col} IN ({})", quoted.join(", ")));
    }
    Ok(())
}

fn where_clause(conds: &[String]) -> String {
    if conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conds.join(" AND "))
    }
}

fn ts_literal(t: DateTime<Utc>) -> String {
    format!("TIMESTAMPTZ '{}'", t.to_rfc3339_opts(SecondsFormat::Micros, true))
}

fn path_literal(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "''"))
}

/// A SQL string literal. A NUL cannot be represented and is refused.
pub(crate) fn sql_quote(s: &str) -> Result<String, MetricsError> {
    if s.contains('\0') {
        return Err(MetricsError::InvalidArgument("a value contains a NUL character".into()));
    }
    Ok(format!("'{}'", s.replace('\'', "''")))
}

fn require_key(name: &str, value: &str) -> Result<(), MetricsError> {
    if value.is_empty() {
        return Err(MetricsError::InvalidArgument(format!("{name} is empty")));
    }
    Ok(())
}

fn is_corrupt(msg: &str) -> bool {
    CORRUPT_MARKERS.iter().any(|m| msg.contains(m))
}

/// Each SELECT's result, in statement order.
fn json_results(out: &str) -> Result<Vec<Vec<serde_json::Value>>, MetricsError> {
    serde_json::Deserializer::from_str(out)
        .into_iter::<Vec<serde_json::Value>>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| MetricsError::Output(format!("{e}: {}", out.chars().take(200).collect::<String>())))
}

fn decode<T: DeserializeOwned>(rows: Vec<serde_json::Value>) -> Result<Vec<T>, MetricsError> {
    serde_json::from_value(serde_json::Value::Array(rows)).map_err(|e| MetricsError::Output(e.to_string()))
}

fn last_result<T: DeserializeOwned>(out: &str) -> Result<Vec<T>, MetricsError> {
    decode(json_results(out)?.pop().unwrap_or_default())
}

/// Rows for one statement, in a file of their own that is removed however
/// the call ends.
struct TempNdjson {
    path: PathBuf,
}

impl TempNdjson {
    fn write<T: Serialize>(dir: &Path, rows: &[T]) -> Result<TempNdjson, MetricsError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(dir)?;
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let file = TempNdjson { path: dir.join(format!("metrics-{}-{seq}.ndjson", std::process::id())) };
        let mut text = String::new();
        for row in rows {
            let line = serde_json::to_string(row).map_err(|e| MetricsError::Output(e.to_string()))?;
            text.push_str(&line);
            text.push('\n');
        }
        std::fs::write(&file.path, text)?;
        Ok(file)
    }
}

impl Drop for TempNdjson {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn remove_stale_temp(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("metrics-") && name.ends_with(".ndjson")) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_TEMP);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// One DuckDB CLI process: `sql` on stdin, stdout returned. Deliberately not
/// `DuckdbEngine::run`, which a run's cancel flag can stop mid-write.
fn run_cli(bin: &Path, db: &Path, sql: &str, json: bool) -> Result<String, MetricsError> {
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.arg(db).args(["-storage-version", "v1.5.0", "-no-init", "-bail"]);
    if json {
        cmd.arg("-json");
    }
    let mut child = match cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(MetricsError::EngineMissing(bin.to_path_buf()))
        }
        Err(e) => return Err(e.into()),
    };
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    if let Some(mut stdin) = child.stdin.take() {
        // A CLI that exits early (bad SQL under -bail) closes the pipe; its
        // stderr says why, so a failed write is not the error to report.
        let _ = stdin.write_all(format!("SET TimeZone = 'UTC';\n{sql}\n").as_bytes());
    }
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(MetricsError::Timeout(CLI_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    let err = err.trim();
    if !status.success() || err.contains("Error") {
        if LOCKED_MARKERS.iter().any(|m| err.contains(m)) {
            return Err(MetricsError::Busy(err.to_string()));
        }
        return Err(MetricsError::Cli(err.chars().take(2000).collect()));
    }
    Ok(out)
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_string(&mut text);
        }
        text
    })
}

#[cfg(test)]
#[path = "metrics_store_tests.rs"]
mod tests;
