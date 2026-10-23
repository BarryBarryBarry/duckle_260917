# Design: Scaling Duckle out, on DuckDB 2.0

Status: explored and measured 2026-10-23. Three fixes it turned up are shipped; the
scheduler claim proposed below is **not built yet**.

## The short version

- **Workers already scale out.** `duckle-runner work` pulls queued batch items and claims
  each one under a lock, on as many hosts as share the workspace, provided that storage's
  locks work. A worker tests that at start and refuses to run where they do not. Measured
  with three workers on one machine (12 items, none run twice); across two hosts it rests
  on the storage's locks, and `scripts/measure-multi-host-batch.sh` has not been run on
  two real hosts yet.
- **The console does not.** Two `serve` processes on one workspace fire every schedule
  twice. Measured on one machine, where locks work perfectly. This is the one thing that
  stops Duckle running as several replicas, and it is a scheduler change, not a DuckDB one.
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

E5's stand-in is a small Python server speaking HEAD and ranged GET, path style; DuckDB's
own S3 reader and Duckle's `src.minio` drove it. Directly on the CLI with 4 threads, 2.0
kept 16 requests in flight to 1.5.5's 4 (1.05 s against 3.16 s), and `read_ahead_depth=64`
took it to 67 in flight and 0.57 s. The automatic depth is about four requests per thread,
which is why a small worker gains the most from raising it.

## Where the shared state lives

What two processes on one workspace share, and what keeps them from tripping over it.

| State | Where | Guard between processes | Safe with two replicas? |
|---|---|---|---|
| When a schedule is due (`serve`) | In memory: `last_fired`, `cron_next` (`crates/duckle-runner/src/serve.rs:4937-4944`), decided at 5076-5094 and 5114-5141 | None | **No.** E1. |
| When a schedule is due (desktop) | In memory; `claim_due` picks due schedules from this process's copy, then writes the claim (`crates/scheduler/src/lib.rs:915-962`) | The write re-reads the store, the decision does not | **No**, same race |
| Occurrence ledger | `.duckle/occurrences.ndjson`, deterministic id per (schedule, instant) (`crates/duckdb-engine/src/occurrences.rs:90-115`) | Append-only; written best-effort after the decision (`serve.rs:4672-4697`), read only on catch-up | Records both firings, prevents neither |
| A pipeline running | `.duckle/locks/`, an OS advisory lock (`crates/scheduler/src/lib.rs:153-162`, `crates/duckdb-engine/src/runlock.rs`) | Exclusive while held | Stops two runs **overlapping**, not a second run after the first |
| Run history | `runs/<pipeline>.json` (`crates/duckdb-engine/src/history.rs:197-222`) | `lock_store`, read-modify-write under it | Yes |
| Schedules | `schedules.json`, `schedules::update` | Lock, re-read, apply, rename | Yes |
| Accepted async runs | In memory (`serve.rs:226-230`); `run_status` falls back to run history for finished runs only (`serve.rs:3282-3334`); cancel looks only in memory (`serve.rs:3007-3027`) | None | **No.** Behind a load balancer, a queued or running run is `404` on the other replica, and cancel only works on the one that took it |
| Accounts, sessions, API keys | `.duckle/console.db`, SQLite in WAL mode (`crates/duckle-runner/src/auth_store.rs:85-115`) | SQLite locking | One host: yes, since `f29d613`. Across hosts: **no**, because SQLite's WAL mode needs every process on one host |
| Queued batch items | `batches/`, claimed with `try_acquire_nested` (`runlock.rs:288`), ledger written after success | Exclusive lock per item; `work.rs:85` refuses storage whose locks do not exclude | Yes, at least once, on lock-capable storage |
| "Is that run still alive" | A pid, judged against this machine's processes (`runlock.rs:233-240`) | None across hosts | **No** across hosts (#360): a live run on another machine reads as dead |
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

## Proposed: claim each occurrence exactly once

The scheduler already knows what an occurrence is. The fix is to claim it, atomically and
before dispatch, so that only the replica that wins runs it.

1. **The key.** For cron, `occurrences::occurrence_id(schedule, due)`, which `serve` already
   computes for the ledger. For an interval, there is no shared instant today: `serve`
   counts from when each process first saw the schedule (`serve.rs:5124-5131`). It needs one,
   either a grid on wall-clock time (`floor(now / seconds)`) or the last recorded
   occurrence plus the interval. The grid is simpler and makes the firing times
   predictable, but it moves when the first run of a new schedule happens, which is a
   visible change.
2. **The claim.** Create `.duckle/occurrences/claims/<id>` with `create_new`, an exclusive
   create, which local disk guarantees and which NFSv4 (EFS) and SMB (Azure Files) offer
   as a protocol operation. That is the same kind of storage `duckle-runner work` already
   requires, and the two-host script is where to prove it. The winner records `fired` and
   dispatches. A loser skips without a word, because skipping is the correct outcome.
3. **Both schedulers.** `serve`'s tick loop and the desktop scheduler's `claim_due` take the
   same claim, so a laptop and a server on one workspace stop doubling up too.
4. **Later, a different store.** The same claim maps onto `INSERT ... ON CONFLICT DO
   NOTHING` in Postgres, a conditional `UPDATE` over Quack (E3), or a `PUT` with
   `If-None-Match: *` on object storage. That is the step that removes the shared
   filesystem, and the first version does not need it.

What several replicas need beyond the claim:

- **Run status that any replica can answer.** Write the accepted run to disk when it is
  accepted, not only when it finishes, and let cancel reach the owning replica through a
  flag it polls. Or route by run id at the load balancer.
- **Liveness that knows about hosts** (#360). Record the host with the pid and judge only
  this host's records; a record from another host is left alone and reported as theirs.
- **The account store on one host, or in Postgres.** SQLite in WAL mode is not safe across
  machines on network storage.

## Plan

| Phase | Scope | Proves it |
|---|---|---|
| 1 | Occurrence claims in both schedulers; durable async run status; host-aware liveness | E1 again: one run per occurrence with two replicas; then `scripts/measure-multi-host-batch.sh` across two real hosts |
| 2 | Stateless workers on object storage: scheduled runs handed to the worker queue, sinks in DuckLake on Postgres or a Quack-served database, the async settings sized for small workers | A worker fleet on S3 with no shared disk for data |
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
