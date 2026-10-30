# Design: Scaling Duckle out, on DuckDB 2.0

Status: explored and measured 2026-10-23. **Phase 1 is built** (2026-10-30): several `serve`
replicas can share a workspace on one host. Across hosts the account store is what is left,
and nothing here has been measured on two real hosts yet.

## The short version

- **Workers already scale out.** `duckle-runner work` pulls queued batch items and claims
  each one under a lock, on as many hosts as share the workspace, provided that storage's
  locks work. A worker tests that at start and refuses to run where they do not. Measured
  with three workers on one machine (12 items, none run twice); across two hosts it rests
  on the storage's locks, and `scripts/measure-multi-host-batch.sh` has not been run on
  two real hosts yet.
- **The console does, on one host.** Two `serve` processes on one workspace used to fire
  every schedule twice. Each occurrence is now claimed, so it runs once, and any replica can
  answer for and cancel a run another one is doing. What stops replicas spreading across
  hosts is the account store, which is SQLite in WAL mode. These were scheduler changes,
  not DuckDB ones.
- **DuckDB 2.0 changes the data side, not the scheduling side.** Its asynchronous I/O
  makes object storage fast for small stateless workers (3 to 6 times through Duckle, see
  below), Quack lets many processes write one DuckDB database, and DuckLake with a Postgres
  catalog gives many writers one table. None of it decides who runs a schedule.
- **DuckDB still runs a query on one machine.** 2.0 does not split a query across a
  cluster, so Duckle's model stays what it is: distribute tasks, never queries.

## What was measured

All on one Windows machine (20 cores), DuckDB 2.0.0 and 1.5.5 CLIs, the debug runner.

| # | Experiment | Result |
|---|---|---|
| E1 | Two `serve` replicas on one workspace, a schedule every 20 s and one every minute, 150 s | Interval: **16 runs** where one replica makes 7 or 8, in pairs 3 s apart. Cron: **every occurrence ran twice** (13:18:00 and 13:18:01, 13:19:00 and 13:19:01); the occurrence ledger has 7 records for 3 occurrences. The run lock never refused one: each run was over before the other replica started its copy. |
| E1b | The same two replicas started together | The second **died at start with "database is locked"**. Fixed in `f29d613`. |
| E2 | A DuckDB 2.0 database served with Quack; 4 client processes each send 50 single-row INSERTs at once | All 200 rows, no errors, 0.9 s. A plain `.duckdb` file admits one writing process. |
| E3 | 8 client processes race to claim 50 jobs: `UPDATE claims SET owner = w WHERE id = i AND owner IS NULL RETURNING id` | Every job claimed **exactly once**. A loser gets `TransactionContext Error: Conflict on tuple deletion!` (38 of them), never a silent double claim. |
| E4 | A DuckLake catalog kept in a Quack-served DuckDB (`ATTACH 'ducklake:quack:host:port'`), 4 writers x 10 commits x 1,000 rows | Correct: 40,000 rows, 43 snapshots. But **27.6 s**, against 2.9 s for one writer's 10 commits, so contention lowered total throughput. A SQLite catalog took 1.8 s for the same 4 x 10. |
| E5 | 104 MB of a 24M-row Parquet file (196 row groups) from an S3 stand-in that answers every request after 50 ms, through `duckle-runner run`, 2 threads | 1.5.5: **6.4 s**. 2.0: **2.1 s**. 2.0 with `DUCKLE_ASYNC_THREADS=32` and `DUCKLE_READ_AHEAD_DEPTH=32` (`c5cb57a`): **1.1 s**. Depth 0: 6.4 s again. |

E1 again after Phase 1, the same two replicas and schedules for 150 s: the interval ran **8
times**, once per instant on its grid, the cron ran **3 times**, and the ledger holds **3
records for 3 occurrences**. Both replicas did work, 7 runs on one and 4 on the other, and
neither died starting up beside the other. A run accepted by one replica read as `running`
through the other, where it used to be a `404`, and a cancel sent to the other stopped it in
1.4 s.

E5's stand-in is a small Python server speaking HEAD and ranged GET, path style; DuckDB's
own S3 reader and Duckle's `src.minio` drove it. Directly on the CLI with 4 threads, 2.0
kept 16 requests in flight to 1.5.5's 4 (1.05 s against 3.16 s), and `read_ahead_depth=64`
took it to 67 in flight and 0.57 s. The automatic depth is about four requests per thread,
which is why a small worker gains the most from raising it.

## Where the shared state lives

What two processes on one workspace share, and what keeps them from tripping over it.

| State | Where | Guard between processes | Safe with two replicas? |
|---|---|---|---|
| When a schedule is due (`serve`) | Each process works it out, and takes it with `occurrences::claim` | `.duckle/claims/`, one claimed-through instant per schedule, written under the store lock | Yes. E1 again |
| When a schedule is due (desktop) | The same claim, in `claim_due`, under the schedule's own id | The same | Yes, and a laptop and a server agree too |
| Occurrence ledger | `.duckle/occurrences.ndjson`, deterministic id per (schedule, instant) (`crates/duckdb-engine/src/occurrences.rs`) | Written by whoever won the claim | Yes: one record per occurrence |
| Catching up a schedule | Decided over the ledger | One replica at a time, under a lock held for the whole catch-up | Yes |
| Publications owed to subscribers | `pump_deliveries`, from the delivery ledger | One replica at a time, under a lock held for the pump | Yes |
| A pipeline running | `.duckle/locks/`, an OS advisory lock (`crates/scheduler/src/lib.rs:153-162`, `crates/duckdb-engine/src/runlock.rs`) | Exclusive while held | Stops two runs **overlapping**, not a second run after the first |
| Run history | `runs/<pipeline>.json` (`crates/duckdb-engine/src/history.rs:197-222`) | `lock_store`, read-modify-write under it | Yes |
| Schedules | `schedules.json`, `schedules::update` | Lock, re-read, apply, rename | Yes |
| Accepted async runs | The run's receipt, written before the caller hears its id (`retry::accept`) and read by `run_status`; a cancel for another replica's run leaves a flag beside the receipt and the owner polls for it | Receipts are written temp-then-rename | Yes |
| Accounts, sessions, API keys | `.duckle/console.db`, SQLite in WAL mode (`crates/duckle-runner/src/auth_store.rs`) | SQLite locking | One host: yes, since `f29d613`. Across hosts: **no**, because SQLite's WAL mode needs every process on one host. This is what is left |
| Queued batch items | `batches/`, claimed with `try_acquire_nested` (`runlock.rs:288`), ledger written after success | Exclusive lock per item; `work.rs:85` refuses storage whose locks do not exclude | Yes, at least once, on lock-capable storage |
| "Is that run still alive" | A witness lock held for as long as the work lasts (`runlock::owner_alive`), with the pid only for a record older than witnesses | The OS lets go when the holder dies, on any host | Yes, on storage whose locks work (#360) |
| Concurrent runs | `RunGate`, per process (`serve.rs:119-139`) | Per replica | Yes. N replicas is N times `DUCKLE_MAX_CONCURRENT_RUNS`, which is the point |
| An upsert's staging table | In the TARGET Postgres or MySQL database (`crates/duckdb-engine/src/connectors.rs`, `run_upsert`) | Named per execution since `a610577` | Yes since then. Before, it was named after the upstream node alone, so concurrent upserts whose upstream nodes shared an id (any two workers running one child pipeline) emptied each other's staging rows and reported ok |

## What DuckDB 2.0 adds, and what it does not

**Asynchronous I/O** (on by default). Parquet, DuckDB files and uncompressed CSV over
object storage are read on a pool of I/O threads separate from the query threads, 4 per
core, with a read-ahead queue inside the memory limit. JSON and compressed CSV stay
synchronous. For scaling out this is the important one: a fleet of small stateless workers
reading S3 is no longer bound by its thread count (E5). The two knobs are in
`resource_pragmas`; a fixed read-ahead depth is outside DuckDB's memory budget, so depth
times the row-group size has to fit.

**Quack** (polished in 2.0). A DuckDB process serves its databases over HTTP, and clients
`ATTACH 'quack:host:port'` with a token. Many processes, on many hosts, can then write one
DuckDB database (E2), and a conditional update is an exactly-once claim (E3). Duckle
already reads and writes Quack (`src.quack`, `snk.quack`). Limits: client and server must
both be 2.0 (1.5 and 2.0 cannot talk to each other), the server is a single point of
failure, and TLS belongs on a reverse proxy in front of it.

**DuckLake 1.1.** Many writers, one table, with data files in object storage and the
catalog in a database. The catalog decides how it behaves under load: Postgres is the
multi-host answer DuckLake documents, SQLite works on one host, and a Quack-served DuckDB
works but resolves contention by retrying (E4). The DuckLake extension also upgrades a
DuckDB-file catalog on its first write, after which 1.x cannot attach it.

**Not added: distributed execution.** One query still runs in one process. Work that is too
big for a machine goes to pushdown, or is split by Duckle into tasks (`ctl.foreach` with
`dispatch: "queue"`).

## Built: each occurrence is claimed exactly once

The scheduler already knew what an occurrence is. It is now claimed, atomically and before
dispatch, and only the replica that wins runs it.

1. **The key.** A cron occurrence is its instant. An interval had no shared instant, because
   `serve` counted from when each process first saw the schedule, so an interval now runs on
   a grid of wall-clock time: `floor(now / seconds)`, in UTC. This changes when every
   interval schedule fires, on one console as much as on several: every 15 minutes means
   :00, :15, :30 and :45, and every 24 hours means midnight UTC. The other choice was the
   last recorded occurrence plus the interval, which keeps today's rhythm and has to read
   shared state on every tick. The grid is simpler and the times are predictable.
2. **The claim.** `occurrences::claim` keeps one instant per schedule, "claimed through",
   and an occurrence at or before it is taken. The proposal here was one file per occurrence
   made with an exclusive create. That would have left half a million files a year for a
   minutely schedule, and pruning them brings back the race it was meant to remove.
   Occurrences come in order, so one instant says everything, and a replica whose clock runs
   behind cannot take what a faster one already ran. It goes under the store lock, which
   asks of the storage what `duckle-runner work` already asks. If a claim cannot be made at
   all the schedule fires anyway: a full disk must not silently stop every schedule.
3. **Both schedulers.** `serve`'s tick and the desktop scheduler's `claim_due` take the same
   claim under the schedule's id, so a laptop and a server on one workspace agree too.
4. **Catching up, and deliveries.** Taking occurrences one at a time is not enough for these.
   A second replica would take the next overdue occurrence while the first was still running
   this one, and the run lock would then refuse it, already claimed. So one replica catches
   a schedule up, and one pumps deliveries, each under a lock held for the whole job. The OS
   lets go if that replica dies, and the work stays owed to the next tick. Catch-up also
   leaves anything younger than a live scheduler's longest gap alone, so a replica starting
   up does not record as skipped an occurrence another replica is about to run. One cost: a
   schedule more frequent than that gap can lose an occurrence missed just before a restart.
5. **Later, a different store.** The same claim maps onto a conditional `UPDATE` in Postgres
   or over Quack (E3), or a `PUT` with `If-Match` on object storage. That is the step that
   removes the shared filesystem, and this version does not need it.

Beside the claim:

- **Run status that any replica can answer.** Run receipts already said queued, running or
  interrupted on disk, so a replica now reads them. The receipt is written before the caller
  hears the run id, and a cancel for another replica's run leaves a flag the owner polls.
- **Liveness that knows about hosts** (#360). Not by recording the host, which is what this
  document proposed: a replaced container has a new hostname, so its dead runs would have
  stayed `running` for ever. The owner holds a witness lock for as long as the work lasts. A
  held witness means alive, on any host. A free one means the owner has gone, whatever has
  that pid now, which covers a container's PID 1 as well. There is no heartbeat to tune.
- **Still open: the account store.** SQLite in WAL mode is not safe across machines on
  network storage, and every `serve` opens it. That is why replicas stay on one host for now.

## Plan

| Phase | Scope | Proves it |
|---|---|---|
| 1, **built** | Occurrence claims in both schedulers; durable async run status; host-aware liveness | E1 again: one run per occurrence with two replicas, done. `scripts/measure-multi-host-batch.sh` across two real hosts is **not done** |
| 2 | The account store off the workspace, so replicas can cross hosts. Stateless workers on object storage: scheduled runs handed to the worker queue, sinks in DuckLake on Postgres or a Quack-served database, the async settings sized for small workers | Two replicas on two hosts, and a worker fleet on S3 with no shared disk for data |
| 3 | No shared filesystem at all: claims, ledgers and run records in Postgres, or on object storage with conditional writes | Replicas with nothing mounted in common |

## Shipped while exploring

- `76128e9` settings as `SET`: DuckDB 2.0 printed a deprecation warning per setting, per
  stage, on stdout; `enable_object_cache` (a no-op since 1.5) is gone.
- `c5cb57a` `DUCKLE_ASYNC_THREADS` and `DUCKLE_READ_AHEAD_DEPTH` (E5).
- `f29d613` the second server's `database is locked` at start (E1b).
- `a610577` each upsert stages in a table of its own: six concurrent upserts whose upstream
  nodes shared an id failed with "relation already exists", and CI had caught the silent
  form, an upsert that reported ok and wrote nothing. An upstream node with a capital letter
  could not upsert into Postgres at all.
