//! Plan 003: what the metrics store answers to the console API, the web
//! editor and the desktop, in one place so the three cannot drift.
//!
//! Every surface hands over its parameters as a string map (camelCase keys,
//! lists comma-separated). They are parsed and checked here before the store
//! is opened, so a bad request costs no CLI call. Answers are camelCase JSON
//! carrying `schemaVersion`.
//!
//! Two things the store does not know are filled in on the way out: a
//! pipeline's display name (from `repository.json`, else the pipeline file's
//! own `name`, else what the run was started as, else its id), and - when the
//! status filter asks for `pending` - one entry per pipeline in the workspace
//! that has never run.

use crate::metrics_model::{NodeRunMetric, PipelineEventKind, PipelineEventRecord, PipelineRunMetric, RunStatus};
use crate::metrics_store::{EventCursor, EventQuery, MetricsError, MetricsStore, RunCursor, RunQuery};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

/// The response shape's version, independent of the store's.
pub const RESPONSE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT_WITH_NODES: u32 = 100;
const MAX_LIMIT: u32 = 500;
const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_PIPELINE_FILTERS: usize = 50;
/// The status word for a pipeline that has never run. Not a run status: no
/// run has it, so it is answered from the workspace rather than the store.
pub const PENDING: &str = "pending";

/// Why a query was not answered.
#[derive(Debug, thiserror::Error)]
pub enum QueryError {
    #[error("{0}")]
    BadRequest(String),
    #[error("the run metrics store is unavailable: {0}")]
    Unavailable(String),
}

impl QueryError {
    /// The HTTP status line for this error.
    pub fn status(&self) -> &'static str {
        match self {
            QueryError::BadRequest(_) => "400 Bad Request",
            QueryError::Unavailable(_) => "503 Service Unavailable",
        }
    }

    pub fn body(&self) -> Value {
        match self {
            QueryError::BadRequest(m) => json!({ "error": m }),
            QueryError::Unavailable(reason) => json!({
                "error": "the run metrics store is unavailable",
                "reason": reason,
            }),
        }
    }
}

impl From<MetricsError> for QueryError {
    fn from(e: MetricsError) -> QueryError {
        match e {
            MetricsError::InvalidArgument(m) => QueryError::BadRequest(m),
            other => QueryError::Unavailable(other.to_string()),
        }
    }
}

/// Parameters as a string map, from an editor command's JSON arguments.
/// Lists become comma-separated, numbers and booleans their text.
pub fn params_from_json(args: &Value) -> HashMap<String, String> {
    let Some(obj) = args.as_object() else { return HashMap::new() };
    obj.iter()
        .filter_map(|(k, v)| {
            let text = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                Value::Array(items) => {
                    items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect::<Vec<_>>().join(",")
                }
                _ => return None,
            };
            Some((k.clone(), text))
        })
        .collect()
}

/// A value that may name a pipeline file: not empty, not `.`/`..`, and no
/// separator, drive colon or NUL.
pub fn plain_id(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', ':', '\0'])
}

// ---- parsing ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Paging {
    Cursor(Option<RunCursor>),
    Page { number: u32, size: u32 },
}

#[derive(Debug, Clone, PartialEq)]
struct RunsRequest {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    pipelines: Vec<String>,
    statuses: Vec<RunStatus>,
    pending: bool,
    run_key: Option<String>,
    include_nodes: bool,
    limit: u32,
    paging: Paging,
}

fn get<'a>(p: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    p.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn time_param(p: &HashMap<String, String>, key: &str) -> Result<Option<DateTime<Utc>>, QueryError> {
    get(p, key)
        .map(|s| {
            DateTime::parse_from_rfc3339(s)
                .map(|t| t.with_timezone(&Utc))
                .map_err(|_| QueryError::BadRequest(format!("{key} must be an RFC3339 time, got '{s}'")))
        })
        .transpose()
}

fn list_param(p: &HashMap<String, String>, key: &str) -> Vec<String> {
    get(p, key)
        .map(|s| s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn pipelines_param(p: &HashMap<String, String>) -> Result<Vec<String>, QueryError> {
    let ids = list_param(p, "pipeline");
    if ids.len() > MAX_PIPELINE_FILTERS {
        return Err(QueryError::BadRequest(format!("at most {MAX_PIPELINE_FILTERS} pipelines can be filtered on")));
    }
    match ids.iter().find(|id| !plain_id(id)) {
        Some(bad) => Err(QueryError::BadRequest(format!("'{bad}' is not a pipeline id"))),
        None => Ok(ids),
    }
}

fn number_param(p: &HashMap<String, String>, key: &str) -> Result<Option<u32>, QueryError> {
    get(p, key)
        .map(|s| match s.parse::<u32>() {
            Ok(n) if n > 0 => Ok(n),
            _ => Err(QueryError::BadRequest(format!("{key} must be a positive whole number, got '{s}'"))),
        })
        .transpose()
}

fn bool_param(p: &HashMap<String, String>, key: &str, default: bool) -> Result<bool, QueryError> {
    match get(p, key) {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(other) => Err(QueryError::BadRequest(format!("{key} must be true or false, got '{other}'"))),
    }
}

fn encode_cursor(at: &str, key: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{at}|{key}"))
}

fn decode_cursor(text: &str) -> Result<(DateTime<Utc>, String), QueryError> {
    let bad = || QueryError::BadRequest("cursor is not one this server issued".into());
    let raw = URL_SAFE_NO_PAD.decode(text).map_err(|_| bad())?;
    let raw = String::from_utf8(raw).map_err(|_| bad())?;
    let (at, key) = raw.split_once('|').ok_or_else(bad)?;
    let at = DateTime::parse_from_rfc3339(at).map_err(|_| bad())?.with_timezone(&Utc);
    if key.is_empty() {
        return Err(bad());
    }
    Ok((at, key.to_string()))
}

fn parse_runs(p: &HashMap<String, String>) -> Result<RunsRequest, QueryError> {
    let mut statuses = Vec::new();
    let mut pending = false;
    for word in list_param(p, "status") {
        if word == PENDING {
            pending = true;
            continue;
        }
        let s = word.parse::<RunStatus>().map_err(|_| QueryError::BadRequest(format!("unknown status '{word}'")))?;
        statuses.push(s);
    }
    let run_key = get(p, "runKey").map(str::to_string);
    if run_key.as_deref().is_some_and(|k| k.contains('\0')) {
        return Err(QueryError::BadRequest("runKey contains a NUL character".into()));
    }
    // One run's detail is always wanted with its nodes.
    let include_nodes = run_key.is_some() || bool_param(p, "includeNodes", true)?;
    let cursor = get(p, "cursor").map(decode_cursor).transpose()?;
    let (page, page_size) = (number_param(p, "page")?, number_param(p, "pageSize")?);
    let paging = if page.is_some() || page_size.is_some() {
        if cursor.is_some() {
            return Err(QueryError::BadRequest("cursor cannot be combined with page or pageSize".into()));
        }
        Paging::Page { number: page.unwrap_or(1), size: page_size.unwrap_or(DEFAULT_PAGE_SIZE).min(MAX_PAGE_SIZE) }
    } else {
        Paging::Cursor(cursor.map(|(started_at, run_key)| RunCursor { started_at, run_key }))
    };
    let ceiling = if include_nodes { MAX_LIMIT_WITH_NODES } else { MAX_LIMIT };
    Ok(RunsRequest {
        from: time_param(p, "from")?,
        to: time_param(p, "to")?,
        pipelines: pipelines_param(p)?,
        statuses,
        pending,
        run_key,
        include_nodes,
        limit: number_param(p, "limit")?.unwrap_or(DEFAULT_LIMIT).min(ceiling),
        paging,
    })
}

// ---- answering runs --------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeDto {
    node_id: String,
    ordinal: Option<i64>,
    component: Option<String>,
    kind: Option<String>,
    status: String,
    started_at: Option<String>,
    duration_ms: Option<i64>,
    rows: Option<i64>,
    rejected_rows: Option<i64>,
    error: Option<String>,
    category: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunDto {
    run_key: String,
    run_id: Option<String>,
    pipeline_id: String,
    pipeline_name: String,
    status: String,
    trigger: Option<String>,
    started_at: Option<String>,
    duration_ms: Option<i64>,
    rows: Option<i64>,
    rejected_rows: Option<i64>,
    unchanged: Option<bool>,
    incomplete: Option<bool>,
    incomplete_reason: Option<String>,
    node_count: Option<i64>,
    queue_ms: Option<i64>,
    error: Option<String>,
    category: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nodes: Option<Vec<NodeDto>>,
}

fn node_dto(n: NodeRunMetric) -> NodeDto {
    NodeDto {
        node_id: n.node_id,
        ordinal: n.ordinal,
        component: n.component,
        kind: n.kind,
        status: n.status.as_str().to_string(),
        started_at: n.started_at,
        duration_ms: n.duration_ms,
        rows: n.rows,
        rejected_rows: n.rejected_rows,
        error: n.error,
        category: n.category,
        created_at: n.created_at,
        updated_at: n.updated_at,
    }
}

fn run_dto(r: PipelineRunMetric, names: &Names, nodes: Option<Vec<NodeDto>>) -> RunDto {
    let pipeline_name = names.display(&r.pipeline_id, r.pipeline_name.as_deref());
    RunDto {
        run_id: (!r.run_key.starts_with("legacy-")).then(|| r.run_key.clone()),
        run_key: r.run_key,
        pipeline_id: r.pipeline_id,
        pipeline_name,
        status: r.status.as_str().to_string(),
        trigger: r.trigger,
        started_at: Some(r.started_at),
        duration_ms: r.duration_ms,
        rows: r.rows,
        rejected_rows: r.rejected_rows,
        unchanged: r.unchanged,
        incomplete: r.incomplete,
        incomplete_reason: r.incomplete_reason,
        node_count: r.node_count,
        queue_ms: r.queue_ms,
        error: r.error,
        category: r.category,
        created_at: Some(r.created_at),
        updated_at: Some(r.updated_at),
        nodes,
    }
}

/// A pipeline that has never run, as an entry in a run list.
fn never_run(pipeline_id: &str, names: &Names, include_nodes: bool) -> RunDto {
    RunDto {
        run_key: format!("never-run:{pipeline_id}"),
        run_id: None,
        pipeline_id: pipeline_id.to_string(),
        pipeline_name: names.display(pipeline_id, None),
        status: PENDING.to_string(),
        trigger: None,
        started_at: None,
        duration_ms: None,
        rows: None,
        rejected_rows: None,
        unchanged: None,
        incomplete: None,
        incomplete_reason: None,
        node_count: None,
        queue_ms: None,
        error: None,
        category: None,
        created_at: None,
        updated_at: None,
        nodes: include_nodes.then(Vec::new),
    }
}

/// Answer `GET /api/metrics/runs` (and the editors' `metrics_runs`).
pub fn runs(workspace: &Path, bin: &Path, params: &HashMap<String, String>) -> Result<Value, QueryError> {
    let req = parse_runs(params)?;
    let store = MetricsStore::open(workspace, bin)?;
    let names = Names::load(workspace);
    // Only `pending` asked for: the store holds no such run, and an empty
    // status list would mean "every status" to it.
    let query_store = !(req.pending && req.statuses.is_empty());
    let (limit, page) = match &req.paging {
        Paging::Cursor(_) => (req.limit, None),
        Paging::Page { number, size } => (*size, Some(*number)),
    };
    let query = RunQuery {
        from: req.from,
        to: req.to,
        pipelines: req.pipelines.clone(),
        statuses: req.statuses.clone(),
        run_key: req.run_key.clone(),
        limit,
        cursor: match &req.paging {
            Paging::Cursor(c) => c.clone(),
            Paging::Page { .. } => None,
        },
        page,
    };
    let found = if query_store { store.query_runs(&query)? } else { Default::default() };
    let never = if req.pending && req.run_key.is_none() { never_run_ids(workspace, &store, &req.pipelines, &names)? } else { Vec::new() };
    let mut node_map = nodes_by_run(&store, &found.runs, req.include_nodes)?;
    let next_cursor = match &req.paging {
        Paging::Cursor(_) if found.runs.len() as u32 == limit => {
            found.runs.last().map(|r| encode_cursor(&r.started_at, &r.run_key))
        }
        _ => None,
    };
    let stored_count = found.runs.len();
    let mut out: Vec<RunDto> = found
        .runs
        .into_iter()
        .map(|r| {
            let nodes = node_map.remove(&r.run_key).map(|n| n.into_iter().map(node_dto).collect());
            let nodes = if req.include_nodes { Some(nodes.unwrap_or_default()) } else { None };
            run_dto(r, &names, nodes)
        })
        .collect();
    let mut body = json!({ "schemaVersion": RESPONSE_SCHEMA_VERSION });
    match req.paging {
        Paging::Cursor(cursor) => {
            // Never-run pipelines follow the runs, on the first page only.
            if cursor.is_none() {
                out.extend(never.iter().map(|id| never_run(id, &names, req.include_nodes)));
            }
            body["nextCursor"] = json!(next_cursor);
        }
        Paging::Page { number, size } => {
            let stored_total = found.total.unwrap_or(stored_count as u64);
            let offset = u64::from(number - 1) * u64::from(size);
            let skip = offset.saturating_sub(stored_total) as usize;
            let room = (size as usize).saturating_sub(out.len());
            out.extend(never.iter().skip(skip).take(room).map(|id| never_run(id, &names, req.include_nodes)));
            body["total"] = json!(stored_total + never.len() as u64);
            body["page"] = json!(number);
            body["pageSize"] = json!(size);
        }
    }
    body["runs"] = serde_json::to_value(&out).unwrap_or_else(|_| json!([]));
    Ok(body)
}

fn nodes_by_run(
    store: &MetricsStore,
    runs: &[PipelineRunMetric],
    wanted: bool,
) -> Result<HashMap<String, Vec<NodeRunMetric>>, QueryError> {
    if !wanted || runs.is_empty() {
        return Ok(HashMap::new());
    }
    let keys: Vec<String> = runs.iter().map(|r| r.run_key.clone()).collect();
    let mut map: HashMap<String, Vec<NodeRunMetric>> = HashMap::new();
    for n in store.query_nodes(&keys)? {
        map.entry(n.run_key.clone()).or_default().push(n);
    }
    Ok(map)
}

/// Pipelines in the workspace with no run in the store, in display-name order.
fn never_run_ids(
    workspace: &Path,
    store: &MetricsStore,
    only: &[String],
    names: &Names,
) -> Result<Vec<String>, QueryError> {
    let ran = store.pipelines_with_runs()?;
    let mut ids: Vec<String> = discover(workspace)
        .into_keys()
        .filter(|id| !ran.contains(id))
        .filter(|id| only.is_empty() || only.contains(id))
        .collect();
    ids.sort_by_key(|id| (names.display(id, None).to_lowercase(), id.clone()));
    Ok(ids)
}

// ---- events ------------------------------------------------------------------------

/// Answer `GET /api/metrics/events`.
pub fn events(workspace: &Path, bin: &Path, params: &HashMap<String, String>) -> Result<Value, QueryError> {
    let mut kinds = Vec::new();
    for word in list_param(params, "kind") {
        kinds.push(word.parse::<PipelineEventKind>().map_err(|_| QueryError::BadRequest(format!("unknown kind '{word}'")))?);
    }
    let cursor = get(params, "cursor")
        .map(decode_cursor)
        .transpose()?
        .map(|(occurred_at, event_id)| EventCursor { occurred_at, event_id });
    let limit = number_param(params, "limit")?.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let query = EventQuery {
        from: time_param(params, "from")?,
        to: time_param(params, "to")?,
        pipelines: pipelines_param(params)?,
        kinds,
        limit,
        cursor,
    };
    let store = MetricsStore::open(workspace, bin)?;
    let names = Names::load(workspace);
    let found = store.query_events(&query)?;
    let next_cursor = (found.len() as u32 == limit)
        .then(|| found.last().map(|e| encode_cursor(&e.occurred_at, &e.event_id)))
        .flatten();
    let events: Vec<Value> = found.into_iter().map(|e| event_json(e, &names)).collect();
    Ok(json!({ "schemaVersion": RESPONSE_SCHEMA_VERSION, "events": events, "nextCursor": next_cursor }))
}

fn event_json(e: PipelineEventRecord, names: &Names) -> Value {
    // Stored with the store's snake_case keys; answered in the API's case.
    let detail = e.detail.as_deref().and_then(|d| serde_json::from_str::<Value>(d).ok()).map(camel_keys);
    json!({
        "eventId": e.event_id,
        "runKey": e.run_key,
        "pipelineId": e.pipeline_id,
        "pipelineName": names.display(&e.pipeline_id, e.pipeline_name.as_deref()),
        "kind": e.kind.as_str(),
        "occurredAt": e.occurred_at,
        "trigger": e.trigger,
        "detail": detail,
        "createdAt": e.created_at,
    })
}

fn camel_keys(v: Value) -> Value {
    let Value::Object(map) = v else { return v };
    map.into_iter()
        .map(|(k, v)| {
            let mut out = String::with_capacity(k.len());
            let mut upper = false;
            for c in k.chars() {
                match (c, upper) {
                    ('_', _) => upper = true,
                    (c, true) => {
                        out.extend(c.to_uppercase());
                        upper = false;
                    }
                    (c, false) => out.push(c),
                }
            }
            (out, v)
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

// ---- pipelines and their names ---------------------------------------------------------

/// Pipeline id -> the `name` its own file declares (empty when it has none),
/// for every pipeline file in the workspace.
fn discover(workspace: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for path in crate::catalog::discover_pipeline_files(workspace) {
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { continue };
        if v.get("nodes").and_then(Value::as_array).is_none() {
            continue;
        }
        let name = v.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        out.insert(id, name);
    }
    out
}

/// Display names for pipeline ids.
struct Names {
    repository: HashMap<String, String>,
    declared: BTreeMap<String, String>,
}

impl Names {
    fn load(workspace: &Path) -> Names {
        Names { repository: repository_names(workspace), declared: discover(workspace) }
    }

    /// `repository.json`, then the file's own `name`, then what the run was
    /// started as, then the id.
    fn display(&self, id: &str, started_as: Option<&str>) -> String {
        self.repository
            .get(id)
            .cloned()
            .or_else(|| self.declared.get(id).filter(|n| !n.is_empty()).cloned())
            .or_else(|| started_as.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string))
            .unwrap_or_else(|| id.to_string())
    }
}

/// Repo item id -> human name, from `<workspace>/repository.json`. The same
/// reading the console's dashboard does; a missing or unreadable file names
/// nothing.
fn repository_names(workspace: &Path) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(workspace.join("repository.json")) else { return HashMap::new() };
    let items: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
    items
        .iter()
        .filter_map(|it| {
            let id = it.get("id")?.as_str()?;
            let name = it.get("name")?.as_str()?;
            (!name.trim().is_empty()).then(|| (id.to_string(), name.to_string()))
        })
        .collect()
}

/// Answer the editors' `metrics_pipelines`: every pipeline in the workspace
/// with the name it is shown under, in name order.
pub fn pipelines(workspace: &Path) -> Value {
    let names = Names::load(workspace);
    let mut list: Vec<(String, String)> =
        names.declared.keys().map(|id| (names.display(id, None), id.clone())).collect();
    list.sort_by_key(|(name, id)| (name.to_lowercase(), id.clone()));
    let items: Vec<Value> =
        list.into_iter().map(|(name, id)| json!({ "pipelineId": id, "pipelineName": name })).collect();
    json!({ "schemaVersion": RESPONSE_SCHEMA_VERSION, "pipelines": items })
}

#[cfg(test)]
#[path = "metrics_query_tests.rs"]
mod tests;
