# Business continuity and disaster recovery

How to back up a Duckle deployment, what each part costs you if it is lost, and
how to prove the backup works before you need it.

Duckle is software you run on your own infrastructure, so recovery objectives
are yours to set - this document gives the facts needed to set them, the
procedure, and a drill that verifies the procedure rather than assuming it.

---

## 1. What a deployment consists of

Everything Duckle needs is a **workspace directory** plus the binary. There is
no external database and no vendor-side state, so recovery is a file-level
problem.

| Path | Contents | If you lose it |
| :--- | :--- | :--- |
| `.duckle/keys/` | The AES-256-GCM workspace key | **Unrecoverable.** Every encrypted connection and `secrets.enc` becomes permanently unreadable. Nothing can decrypt them, including us. |
| `.duckle/connections.duckdb` | Saved connection profiles, encrypted | Re-enter every credential by hand |
| `secrets.enc`, `secrets.env` | Workspace secrets | Re-enter every secret |
| `pipelines/` | Pipeline definitions | The work itself |
| `state/` | Watermarks, CDC snapshots, stream positions | See section 3 - this is the subtle one |
| `.duckle/settings.json`, `policy.yaml`, `oidc.json` | Configuration, security policy, SSO | Reconfigure; the policy gap is the risk |
| `schedules.json`, `plans.json` | What runs, and when | Schedules stop firing, silently |
| `runs/`, `logs/audit.ndjson` | Run receipts and the audit trail | Evidence, not operation. Often the longest retention requirement |
| `contexts/`, `routines/`, `manifests/` | Contexts, SQL routines, provenance manifests | Rebuild |
| `cache/` | Reusable stage outputs | Nothing. Safe to exclude |

**Back up `.duckle/keys/` separately and to different custody than the rest.**
A backup containing both the encrypted connections and the key that opens them
is a backup of your plaintext credentials.

---

## 2. Setting RTO and RPO

Duckle holds no live state of its own between runs, so the objectives are
determined almost entirely by two things: how fast you can restore a directory,
and how much re-processing you can tolerate.

| Objective | What drives it | Typical achievable |
| :--- | :--- | :--- |
| **RTO** | Time to provision a host, restore the workspace, start the service | Minutes. There is no schema migration, no cluster to rejoin, no cache to warm |
| **RPO** | Backup frequency of the workspace directory | Your snapshot interval |

Recovery is: install the binary, restore the workspace directory, restore the
key, start `duckle-runner serve`. A pipeline is a file; a schedule is a file.

The failure mode that actually costs time is not the restore. It is discovering
at restore time that the key was in the same lost volume, or that schedules came
back armed and immediately re-ran a month of work. Both are covered below.

---

## 3. The part that needs thought: incremental state

`state/` records how far each incremental source has read - watermarks, CDC
snapshot ids, Kafka offsets, stream positions. Restoring it **out of step with
your sinks** is the one way a correct-looking recovery produces wrong data.

| Situation | Result |
| :--- | :--- |
| `state/` older than the sink | Rows already written are read again. Harmless for an upsert sink keyed properly; **duplicates** for an append sink |
| `state/` newer than the sink | The rows between are never read again. **Silent gap** - no error, no row count anomaly |
| `state/` and sink from the same snapshot | Correct |

Therefore:

* **Snapshot the workspace and the destination together** where the destination
  is under your control, or
* **Prefer the older state** where they cannot be snapshotted together, and make
  the affected sinks idempotent (upsert on a key rather than append). Re-reading
  is recoverable; a gap is not, because nothing reports it.

After any restore where the two might disagree, use
`duckle-runner --list-watermarks` to see what the restored state claims, and set
a position deliberately with `--set-watermark` / `--set-snapshot` rather than
letting the first run decide.

---

## 4. Backup procedure

```bash
# 1. Quiesce: stop the service so nothing is mid-write.
systemctl stop duckle-runner

# 2. The workspace, excluding the reusable cache.
tar --exclude='cache' --exclude='.duckle/locks' \
    -czf "duckle-workspace-$(date +%F).tar.gz" -C /srv duckle-workspace

# 3. The key, to SEPARATE custody. Not beside the archive above.
tar -czf "duckle-keys-$(date +%F).tar.gz" -C /srv/duckle-workspace .duckle/keys

systemctl start duckle-runner
```

If the service cannot be stopped, snapshot at the filesystem or volume level so
the copy is point-in-time consistent. A `tar` of a live workspace can catch a
run receipt half-written; the run history is then inconsistent with the audit
log, which is exactly the thing an auditor asks about.

**Retention** should be at least as long as your audit retention requirement,
because `logs/audit.ndjson` is inside the workspace.

---

## 5. Restore procedure

```bash
# 1. Install the same version. Verify it before running it.
gh attestation verify duckle-runner-linux-x64 --repo slothflowlabs/duckle
sha256sum -c SHA256SUMS.txt --ignore-missing

# 2. Restore the workspace, then the key.
tar -xzf duckle-workspace-YYYY-MM-DD.tar.gz -C /srv
tar -xzf duckle-keys-YYYY-MM-DD.tar.gz -C /srv/duckle-workspace

# 3. Check what came back BEFORE anything runs.
duckle-runner validate --workspace /srv/duckle-workspace
duckle-runner --workspace /srv/duckle-workspace --list-watermarks
```

**Restore the same version you backed up.** A newer binary is usually fine, but
"restore under time pressure" is the wrong moment to also find out.

**Schedules come back armed.** A workspace restored on Monday with schedules
that last fired a month ago will start firing on its own. Decide before starting
the service whether that is what you want; if not, move `schedules.json` aside,
start, and re-arm deliberately.

---

## 6. The recovery drill

A backup that has never been restored is a hypothesis. Run this **at least
annually**, and after any change to the workspace layout or the backup job.

1. Restore the most recent backup to a **clean host**, never the live one.
2. Confirm the key restored to separate custody actually opens the connections:
   list them in the console and open one. A profile that will not decrypt fails
   here, quietly and safely, rather than during a real outage.
3. `duckle-runner validate` over every pipeline. This compiles them without
   opening a source or writing a sink, so it needs no production credentials.
4. Run **one** pipeline whose sink is a scratch destination, end to end.
5. Confirm `logs/audit.ndjson` and `runs/` are readable and cover the expected
   period.
6. Record the date, the backup restored, the wall-clock time taken, and anything
   that did not work. **The measured time is your real RTO** - the estimate in
   section 2 is not, until a drill agrees with it.

### What a drill has to be allowed to fail

The drill is worth running only if a failure changes something. The two failures
worth designing for:

* **The key was in the same backup as the data**, so the separation was
  theoretical. Fix the backup job, not the drill.
* **Nobody could find the runbook.** Recovery documentation stored only inside
  the system being recovered is not documentation.

---

## Related

* [Incident response runbooks](incident-handling-runbook.md)
* [Configure secrets management](configure-secrets-management.md)
* [Supply chain assurance](../explanation/supply-chain-assurance.md) - verifying
  a binary before you restore onto it
