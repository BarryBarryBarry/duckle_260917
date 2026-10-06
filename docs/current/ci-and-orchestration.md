# CI/CD and External Orchestrators

Two related questions, answered separately because they have different answers:

1. **"We use GitHub Actions. How do pipelines get from a merge onto a server?"** That works today, and there are templates to copy.
2. **"We already run Airflow / Dagster / Temporal. Can they run Duckle pipelines?"** Yes, through a documented CLI and HTTP surface. There are no provider packages yet, and this page is honest about what you would be writing yourself.

---

## Part 1: From a merge to a server

Duckle pipelines are plain JSON files, so they live in your repository and travel through the same review you already use. Two jobs cover it.

### The two jobs

| Job | When | Touches your data? | Needs a credential? |
| --- | --- | --- | --- |
| **Validate** | every commit, every fork | No | No |
| **Deploy** | merges to your default branch only | No | Yes, an `admin` key |

**Validate** compiles every pipeline to SQL. It opens no source, writes no sink, and needs no DuckDB binary, no credentials and no network, which is why it is safe to run on pull requests from forks.

**Deploy** installs those pipelines onto a running Duckle server.

### Templates to copy

| File | For |
| --- | --- |
| [`docs/ci/github-actions.yml`](../ci/github-actions.yml) | validate only |
| [`docs/ci/github-actions-deploy.yml`](../ci/github-actions-deploy.yml) | validate on PRs, deploy on merge |
| [`docs/ci/gitlab-ci.yml`](../ci/gitlab-ci.yml) | validate only |
| [`docs/ci/gitlab-ci-deploy.yml`](../ci/gitlab-ci-deploy.yml) | validate, then deploy |

### Step 1. Mint a key for the robot

On the server:

```bash
duckle-runner console key-add github-actions --role admin --expires-days 90
```

It prints the key **once** and stores only a hash. Deploying needs `admin`, because a deployed pipeline runs shell and SQL on that host.

> Keys use the base64url alphabet, so they can contain `-` and `_`. If you pipe one through a script, do not assume it is alphanumeric.

### Step 2. Store two secrets

| Secret | Value |
| --- | --- |
| `DUCKLE_URL` | `https://duckle.internal` (no trailing slash) |
| `DUCKLE_KEY` | the key from step 1 |

On GitLab, mark `DUCKLE_KEY` **masked and protected** so it is only exposed to protected branches.

### Step 3. Copy the template in

That is the whole setup. The deploy job posts each pipeline to `/api/deploy`:

```bash
curl --fail-with-body -sS -X POST "$DUCKLE_URL/api/deploy" \
  -H "Authorization: Bearer $DUCKLE_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -c --arg n "$name" '{name: $n, pipeline: .}' "$f")"
```

A success looks like this:

```json
{"deployed":"orders_etl","replaced":false,"schedule":{"saved":true,"enabled":false}}
```

`replaced` tells you whether this overwrote an existing pipeline of that name.

### What the design buys you

**A deployed schedule always arrives switched off.** Send a schedule with a pipeline and the server forces `enabled: false`. A cadence that someone merged cannot start firing the moment it lands; turning it on is a separate act by a person.

**Shipping code and starting it need different roles.** Deploying is `admin`; enabling a schedule is `operator`. So a CI key can ship without being able to start anything:

| Role | `/api/run` | `/api/deploy` |
| --- | --- | --- |
| `viewer` | 403 | 403 |
| `operator` | 200 | 403 |
| `admin` | 200 | 200 |

A refusal explains itself: a mis-scoped key gets `{"error":"this needs the admin role; you have viewer"}`, which is why the templates use `curl --fail-with-body`.

**A deploy is atomic.** The server writes through a temporary file and renames it into place, so a scheduler tick on the far end can never read half a pipeline.

### What the templates deliberately do not do

* **Turn schedules on.** See above.
* **Run your pipelines.** A green deploy means the file is installed, not that it works against production data.
* **Roll back.** The previous version is whatever is in git; redeploy the earlier commit.

---

## Part 2: Driving Duckle from an orchestrator

**There are no Airflow, Dagster, Temporal or Prefect provider packages today.** If you want a `DuckleRunOperator`, you would be writing it. The good news is that it is thin, because the two surfaces underneath are stable and documented.

### The two ways in

**A. The command line** - for a `BashOperator`, a `KubernetesPodOperator`, or a Temporal activity.

```bash
duckle-runner --pipeline pipelines/orders_etl.json
```

The binary is a static musl executable with no shared-library dependencies, so it runs on any base image with no packages installed. Exit codes are stable and documented:

| Code | Means |
| --- | --- |
| `0` | success |
| `1` | the work ran and reported failure. A real finding. |
| `2` | the runner could not start the work: bad usage, unreadable file, missing engine. Not a finding about your data. |

That `1` versus `2` split is the useful part: a task can retry on `2` and alert on `1`.

**B. The HTTP API** - for an `HttpOperator` or a Dagster resource, against a running console.

```bash
curl -X POST "$DUCKLE_URL/api/run" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"file":"orders_etl.json"}'
```

`file` is a path inside the server's workspace, and is required - the canonical form is `pipelines/<id>.json`. `params` is optional and supplies values for `${...}` placeholders. Needs the `operator` role.

> ### Read this before writing an operator
>
> **A failed pipeline still answers `HTTP 200`.** The failure is only in the body:
>
> ```json
> {"id":"orders_etl","status":"error","durationMs":41,
>  "error":"DuckDB engine isn't installed yet. Open Setup to install it.","nodes":{}}
> ```
>
> An operator that trusts the HTTP status alone - `resp.raise_for_status()` and nothing
> else - will mark failed loads as **successful**, and nobody will find out until the
> downstream numbers are wrong.
>
> **Check `status` yourself.** It is one of `"ok"`, `"error"` or `"cancelled"`; treat
> anything that is not `"ok"` as a failure.
>
> A non-2xx status means the run could not be *started* at all: `400` for a missing or
> unreadable file, `401`/`403` for a credential problem. Both cases need handling, and
> they are not the same case.

The response has exactly five keys - `id`, `status`, `durationMs`, `error`, `nodes` -
and `error` is present as `null` on success rather than omitted.

### Four things that will shape your operator

**It is fully synchronous.** The connection stays open for the whole run and returns when
it finishes. There is no run id and nothing to poll, so any client, proxy or load-balancer
timeout in front of it must be longer than your slowest pipeline, or you will lose the
result of a run that actually succeeded.

**One run at a time, by default.** The console serialises runs; raise it with
`DUCKLE_MAX_CONCURRENT_RUNS`. Two tasks firing together queue rather than fail, and the
wait is unbounded - so that client timeout matters here too.

**This route does not take the cross-process run lock.** The scheduler does, but a manual
`/api/run` does not, so a run triggered here can overlap a run of the same pipeline
started from a desktop app on the same workspace. If two things might trigger one
pipeline, let one of them own it.

**An empty string parameter is dropped, not sent.** `{"params":{"month":""}}` falls
through to the workspace default rather than overriding it with blank. If `params` is not
a JSON object it is ignored silently.

### Choosing between them

This is the part that decides your design, and it is not obvious:

| | CLI (`--pipeline`) | HTTP (`/api/run`) |
| --- | --- | --- |
| Needs a running server | No | Yes |
| Records run history | Yes | Yes |
| Updates the metrics file | Yes | Yes |
| Records run metrics (`/api/metrics/*`) | Yes | Yes |
| Visible in the console | Yes, from its history | Yes |
| Alerts fire | **No** | Yes |

**A headless CLI run records itself but does not alert.** Since #309 it appends to the pipeline's run history like every other surface, so it appears in the console's Runs tab and refreshes the Prometheus textfile, and it writes its run metrics as it goes. It never raises an alert: alerting belongs to the process that owns the schedule. That is fine if your orchestrator is your source of truth for what failed; it is not fine if you expected Duckle to page you.

If you want your orchestrator to own the schedule *and* Duckle to alert on it, use the HTTP route against a console.

### A note on overlap

If Airflow owns the schedule, Duckle's own scheduler and Plans are redundant, and you should leave them switched off rather than run both. Two schedulers pointed at one workspace will not corrupt anything - every run takes a lock on its pipeline, and the second is refused rather than doubled - but you will have two places that believe they decide when things run, and only one of them will be right.

---

## Part 3: Monitoring

### Prometheus / OpenMetrics

Every recorded run rewrites a textfile at:

```text
<workspace>/logs/duckle_metrics.prom
```

It is written atomically, so a scrape never reads a half-written file. Point node_exporter's textfile collector or Grafana Alloy at it; there is no HTTP server and no agent inside Duckle, which keeps headless and air-gapped deployments covered.

| Metric | Type | Meaning |
| --- | --- | --- |
| `duckle_run_last_status` | gauge | 1 when the most recent run succeeded, 0 when it failed or was cancelled |
| `duckle_run_last_unchanged` | gauge | 1 when the most recent run checked its sources, found nothing changed and wrote nothing. Such a run IS a success, so `duckle_run_last_status` is 1 for it too - this is what separates a poll that is working and finding nothing from one that is ingesting. |
| `duckle_run_last_duration_seconds` | gauge | how long the most recent run took |
| `duckle_run_last_rows` | gauge | rows the most recent run wrote |
| `duckle_run_last_timestamp_seconds` | gauge | when the most recent run finished. Its HELP text says "started"; the value has always been the time the run was recorded, which is when it finished |
| `duckle_node_last_duration_seconds` | gauge | how long each node of the most recent run took, labelled by `node` and `component` (`src.rest`, `xf.filter`, ...) - this is what turns "the run got slower" into "the extract stage got slower" |
| `duckle_node_last_rows` | gauge | rows each node of the most recent run reported, same labels. A node the run never reached emits nothing - absent is not zero |
| `duckle_runs_window` | gauge | how many runs are in the retained window |

> **These are windowed, not lifetime, counters.** All series are derived from the retained run history, which is a rolling window per pipeline, so `duckle_runs_window` is a count of what is retained rather than everything that has ever run. The metric names say so deliberately.

> It is written when a run is **recorded**, which means console runs, scheduled runs, desktop runs and headless `duckle-runner --pipeline` runs. See the table above.

### The API

For a dashboard of your own, the console exposes `GET /api/runs`, `GET /api/schedules`, `GET /api/summary`, `GET /api/catalog` and the run metrics below, all with the `viewer` role. That is the right role for a monitoring integration: it can read everything and start nothing.

### Run metrics store and `/api/metrics/*`

The textfile above answers "how is each pipeline doing now". To ask "what ran between Monday and Wednesday, which of it failed, and which node" Duckle keeps every run, and every node of it, in a DuckDB file of its own:

```text
<workspace>/.duckle/metrics.duckdb
```

It is written through the same DuckDB CLI the engine runs pipelines with, so it adds nothing to install. A run appears there the moment it is begun - before any work - with each of its stages `pending`; each stage turns `running` and then final as it happens; and the run's own history record settles the figures when it ends. `/metrics` and `duckle_metrics.prom` are unchanged by any of this.

| Table | One row per | Key |
| --- | --- | --- |
| `pipeline_run` | run | `run_key` (the run id; `legacy-…` for history written before run ids existed) |
| `node_run` | stage of a run, in stage order (`ordinal`) | `run_key`, `node_id` |
| `pipeline_event` | `run_started` / `run_finished` of a run | `event_id` |

**Status words.** A run is `queued`, `running`, `ok`, `error`, `cancelled` or `interrupted`. A node is `pending`, `running`, `ok`, `unchanged`, `skipped`, `error`, `cancelled` or `interrupted`. A cancelled run cancels the stage in flight and skips the rest; a run whose process died (found at the next start) is `interrupted`, its stage in flight `interrupted` and the rest `skipped`. Whether a run was a quiet poll is the `unchanged` flag, not a status.

**`startedAt`** is when the run was begun, including any wait for a resource-pool permit; `queueMs` is that wait. A node's `kind` is its catalog kind (`source`, `transform`, `sink`, `quality`, `control`, `custom`). `rejectedRows` is what reject-splitting quality checks turned away - `0` when a check rejected nothing, absent when no check reported.

**`GET /api/metrics/runs`** - runs, newest first:

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | RFC3339; `from <= startedAt < to` |
| `pipeline` | one or more pipeline ids, comma-separated (at most 50) |
| `status` | one or more statuses, comma-separated. `pending` adds every pipeline in the workspace that has never run, after the runs and regardless of `from`/`to` |
| `includeNodes` | `true` (default) or `false` |
| `limit`, `cursor` | page by cursor: `limit` defaults to 50 (100 with nodes, 500 without); pass back `nextCursor` for the next page |
| `page`, `pageSize` | or page by number: `pageSize` defaults to 20, at most 100, and the answer carries `total`. Not combinable with `cursor` |
| `runKey` | one run, with its nodes |

```json
{ "schemaVersion": 1, "nextCursor": null, "runs": [{
  "runKey": "run-scheduled-orders-1790769600000", "runId": "run-scheduled-orders-1790769600000",
  "pipelineId": "orders", "pipelineName": "Orders", "status": "ok", "trigger": "scheduled",
  "startedAt": "2026-09-30T12:00:00.000000Z", "durationMs": 3120, "rows": 1000000, "rejectedRows": null,
  "unchanged": false, "incomplete": false, "incompleteReason": null, "nodeCount": 2, "queueMs": 0,
  "error": null, "category": null, "createdAt": "…", "updatedAt": "…",
  "nodes": [{ "nodeId": "extract", "ordinal": 0, "component": "src.postgres", "kind": "source", "status": "ok",
              "startedAt": "…", "durationMs": 1800, "rows": 1000000, "rejectedRows": null,
              "error": null, "category": null, "createdAt": "…", "updatedAt": "…" }] }] }
```

**`GET /api/metrics/events`** - `run_started` / `run_finished` events, newest first, filtered by `from`, `to`, `pipeline`, `kind`, paged by `limit` (at most 500) and `cursor`. A `run_finished` event's `detail` carries `status`, `durationMs`, `rows` and the first 200 characters of `error`.

A bad parameter is `400`. If the store cannot be used - no DuckDB CLI yet, another process holding it, a store written by a newer Duckle - the answer is `503` with the `reason`; `/metrics` and `/api/runs` are unaffected. The web editor and the desktop read the same answers through their `metrics_runs` and `metrics_pipelines` commands, behind the **Run metrics** page: the activity icon at the end of the left sidebar's tabs. It filters by start and end time, pipelines and statuses, pages by number, shows each run's node count as `+N`, and opens a run's stages - in order, with their node type (`fetch`, `convert`, `insert`, `check`, `control`, `custom` for the catalog kinds) - when you click its pipeline name.

**Who records.** The console and web editor (every run they start, scheduled and plan runs included), the desktop and its scheduler, `duckle-runner --pipeline` and `retry`, and `follow` - whose passes are recorded once they have done work, without per-stage detail. The MCP server and the `backfill` subcommand do not record run metrics yet; their runs reach the store from run history the next time a console or the desktop starts.

**Catching up.** When a console or the desktop starts it brings the store up to date from run history: a run the store never saw is added, and one it still has open is settled - from its history record, or from its receipt, or as `interrupted` if the process that ran it is gone. A store that turns out to be corrupt is moved aside as `metrics.duckdb.corrupt-<time>`, rebuilt, and refilled the same way.

**Retention.** A console keeps `DUCKLE_METRICS_RETENTION_DAYS` days of run metrics, 30 if it is not set; `0` keeps everything. It prunes once at start. To prune on your own schedule:

```bash
duckle-runner retention prune --workspace /srv/duckle --metrics-days 30 [--duckdb /path/to/duckdb] [--dry-run] [--json]
```

A run goes with all of its nodes. Deleting rows does **not** make `metrics.duckdb` smaller - DuckDB reuses the space - so retention bounds what the store answers with, not the disk it takes; the file itself is never deleted.

---

## What we would build next, and in what order

If you want native integrations, this is the honest ranking by effort against reach:

1. **A GitHub Actions deploy template.** Done - it is in `docs/ci/`.
2. **An Airflow provider** (`DuckleRunOperator`). A few hundred lines of Python over the CLI or the HTTP API, publishable to PyPI alongside the existing `pip install duckle`. Biggest installed base.
3. **A Dagster resource.** Same shape, smaller audience.
4. **A Temporal activity.** Thinnest of the three, because Temporal expects you to write the activity anyway.

None of these need changes inside Duckle. The reason they are cheap is that the CLI has stable exit codes and the HTTP API already exists, which was the hard part.

---

## Next steps

* [Running Duckle on a Server](server-deployment.md) - standing a server up and connecting the studio to it
* [Scheduler & Automation](scheduler.md) - Duckle's own scheduler, if you are not bringing one
* Full cloud recipes: <https://duckle.org/deploy.html>
