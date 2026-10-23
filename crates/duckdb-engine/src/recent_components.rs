//! The Components palette's "Recently used" list, kept per workspace in
//! `<workspace>/.duckle/recent-components.duckdb`.
//!
//! A file of its own rather than a table in the metrics store: that store has
//! schema versions, retention and a rebuild-from-history path this list has no
//! part in. It is driven the same way, through the DuckDB CLI under a store
//! lock, and holds at most [`MAX_ITEMS`] components used in the last
//! [`KEEP_DAYS`] days, newest first. Anything older or beyond the cap is
//! deleted from the file whenever the list is read or written.

use crate::metrics_store::{is_corrupt, run_cli, sql_quote, MetricsError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RECENT_DB_FILE: &str = ".duckle/recent-components.duckdb";
pub const MAX_ITEMS: usize = 20;
pub const KEEP_DAYS: u32 = 7;
const STORE_LOCK: &str = "recent-components";
/// Component ids are short (`src.csv`, `xf.filter`, external ids); anything
/// longer is not one.
const MAX_ID_LEN: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentComponent {
    pub component_id: String,
    /// When it was last used, as Unix milliseconds.
    pub used_at: i64,
}

fn schema_sql() -> &'static str {
    "CREATE TABLE IF NOT EXISTS recent_component (\
     component_id VARCHAR NOT NULL PRIMARY KEY, \
     used_at TIMESTAMPTZ NOT NULL, \
     use_count BIGINT NOT NULL DEFAULT 1);"
}

/// Drops what is too old, then everything past the newest [`MAX_ITEMS`].
fn prune_sql() -> String {
    format!(
        "DELETE FROM recent_component WHERE used_at < now() - INTERVAL {KEEP_DAYS} DAY;\n\
         DELETE FROM recent_component WHERE component_id NOT IN (\
         SELECT component_id FROM recent_component ORDER BY used_at DESC, component_id LIMIT {MAX_ITEMS});"
    )
}

fn select_sql() -> String {
    format!(
        "SELECT component_id AS \"componentId\", epoch_ms(used_at) AS \"usedAt\" \
         FROM recent_component ORDER BY used_at DESC, component_id LIMIT {MAX_ITEMS};"
    )
}

/// Every SELECT's rows in the CLI's `-json` output; a SELECT with no rows
/// prints nothing.
fn parse_rows(out: &str) -> Result<Vec<RecentComponent>, MetricsError> {
    let mut last = Vec::new();
    for result in serde_json::Deserializer::from_str(out).into_iter::<Vec<RecentComponent>>() {
        last = result.map_err(|e| MetricsError::Output(format!("{e}: {}", out.chars().take(200).collect::<String>())))?;
    }
    Ok(last)
}

fn check_id(component_id: &str) -> Result<(), MetricsError> {
    if component_id.trim().is_empty() || component_id.len() > MAX_ID_LEN {
        return Err(MetricsError::InvalidArgument(format!("not a component id: {component_id:?}")));
    }
    Ok(())
}

pub struct RecentComponents {
    workspace: PathBuf,
    bin: PathBuf,
    db: PathBuf,
}

impl RecentComponents {
    pub fn open(workspace: &Path, bin: &Path) -> Result<RecentComponents, MetricsError> {
        if !bin.is_file() {
            return Err(MetricsError::EngineMissing(bin.to_path_buf()));
        }
        let db = workspace.join(RECENT_DB_FILE);
        if let Some(dir) = db.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(RecentComponents { workspace: workspace.to_path_buf(), bin: bin.to_path_buf(), db })
    }

    /// The list, newest first, after dropping what has expired.
    pub fn list(&self) -> Result<Vec<RecentComponent>, MetricsError> {
        let sql = format!("{}\n{}\n{}", schema_sql(), prune_sql(), select_sql());
        parse_rows(&self.exec(&sql)?)
    }

    /// Marks `component_id` as used now and returns the updated list.
    pub fn record(&self, component_id: &str) -> Result<Vec<RecentComponent>, MetricsError> {
        check_id(component_id)?;
        let id = sql_quote(component_id)?;
        let sql = format!(
            "{}\nINSERT INTO recent_component (component_id, used_at, use_count) VALUES ({id}, now(), 1) \
             ON CONFLICT (component_id) DO UPDATE SET used_at = excluded.used_at, \
             use_count = recent_component.use_count + 1;\n{}\n{}",
            schema_sql(),
            prune_sql(),
            select_sql()
        );
        parse_rows(&self.exec(&sql)?)
    }

    /// One CLI call under the store lock. A busy store is tried once more; an
    /// unreadable file is set aside and the call made against a new one, since
    /// the list is only a convenience.
    fn exec(&self, sql: &str) -> Result<String, MetricsError> {
        let attempt = || -> Result<String, MetricsError> {
            let _lock = crate::runlock::lock_store(&self.workspace, STORE_LOCK).map_err(MetricsError::Busy)?;
            match run_cli(&self.bin, &self.db, sql, true) {
                Err(MetricsError::Cli(msg)) if is_corrupt(&msg) => {
                    self.set_aside()?;
                    run_cli(&self.bin, &self.db, sql, true)
                }
                other => other,
            }
        };
        match attempt() {
            Err(MetricsError::Busy(_)) => attempt(),
            other => other,
        }
    }

    fn set_aside(&self) -> Result<(), MetricsError> {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let name = |suffix: &str| self.db.with_file_name(format!("recent-components.duckdb{suffix}"));
        std::fs::rename(&self.db, name(&format!(".corrupt-{secs}")))?;
        let wal = name(".wal");
        if wal.exists() {
            std::fs::rename(&wal, name(&format!(".corrupt-{secs}.wal")))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli() -> Option<PathBuf> {
        std::env::var_os("DUCKLE_DUCKDB_BIN").map(PathBuf::from).filter(|p| p.is_file())
    }

    macro_rules! store_or_skip {
        () => {{
            let Some(bin) = cli() else {
                eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
                return;
            };
            let ws = tempfile::tempdir().unwrap();
            let store = RecentComponents::open(ws.path(), &bin).unwrap();
            (ws, store)
        }};
    }

    fn ids(list: &[RecentComponent]) -> Vec<&str> {
        list.iter().map(|r| r.component_id.as_str()).collect()
    }

    #[test]
    fn empty_until_something_is_used() {
        let (_ws, s) = store_or_skip!();
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn newest_first_and_a_reuse_moves_to_the_front() {
        let (_ws, s) = store_or_skip!();
        s.record("src.csv").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        s.record("xf.filter").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let list = s.record("src.csv").unwrap();
        assert_eq!(ids(&list), ["src.csv", "xf.filter"]);
        assert!(list[0].used_at >= list[1].used_at);
        assert_eq!(ids(&s.list().unwrap()), ["src.csv", "xf.filter"]);
    }

    #[test]
    fn keeps_only_the_newest_twenty_in_the_file() {
        let (_ws, s) = store_or_skip!();
        for i in 0..25 {
            s.record(&format!("xf.c{i:02}")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let list = s.list().unwrap();
        assert_eq!(list.len(), MAX_ITEMS);
        assert_eq!(list[0].component_id, "xf.c24");
        assert_eq!(list[MAX_ITEMS - 1].component_id, "xf.c05");
        let left = run_cli(&s.bin, &s.db, "SELECT count(*) AS n FROM recent_component;", true).unwrap();
        assert!(left.contains("\"n\":20"), "rows left in the file: {left}");
    }

    #[test]
    fn drops_what_was_last_used_over_seven_days_ago() {
        let (_ws, s) = store_or_skip!();
        s.record("src.csv").unwrap();
        s.record("xf.filter").unwrap();
        run_cli(
            &s.bin,
            &s.db,
            "UPDATE recent_component SET used_at = now() - INTERVAL 8 DAY WHERE component_id = 'src.csv';",
            false,
        )
        .unwrap();
        assert_eq!(ids(&s.list().unwrap()), ["xf.filter"]);
        let left = run_cli(&s.bin, &s.db, "SELECT count(*) AS n FROM recent_component;", true).unwrap();
        assert!(left.contains("\"n\":1"), "rows left in the file: {left}");
    }

    #[test]
    fn an_id_is_a_value_not_sql() {
        let (_ws, s) = store_or_skip!();
        let odd = "x'); DROP TABLE recent_component; --";
        assert_eq!(ids(&s.record(odd).unwrap()), [odd]);
        assert!(s.record("").is_err());
        assert!(s.record(&"a".repeat(MAX_ID_LEN + 1)).is_err());
    }

    #[test]
    fn an_unreadable_file_is_set_aside_and_started_over() {
        let (ws, s) = store_or_skip!();
        std::fs::write(ws.path().join(RECENT_DB_FILE), b"not a database").unwrap();
        assert_eq!(ids(&s.record("src.csv").unwrap()), ["src.csv"]);
        let aside = std::fs::read_dir(ws.path().join(".duckle"))
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("recent-components.duckdb.corrupt-"));
        assert!(aside);
    }
}
