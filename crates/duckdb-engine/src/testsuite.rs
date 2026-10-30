//! The test suite behind a pipeline's Tests tab.
//!
//! The editor reads and writes `tests/<pipeline>.test.json`, the file `duckle test` runs, and
//! it runs that file through the same harness rather than a second one. So a case written in
//! the editor and a case run in CI cannot come to mean different things.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Where a pipeline's suite lives. The id becomes a file name, so it has to be one.
pub fn path(workspace: &Path, pipeline_id: &str) -> Result<PathBuf, String> {
    let plain = !pipeline_id.is_empty()
        && pipeline_id != "."
        && pipeline_id != ".."
        && !pipeline_id.contains(['/', '\\', ':', '\0']);
    if !plain {
        return Err(format!("{pipeline_id:?} is not a pipeline id"));
    }
    Ok(workspace.join("tests").join(format!("{pipeline_id}.test.json")))
}

/// The suite as written, or None for a pipeline that has no tests yet.
pub fn load(workspace: &Path, pipeline_id: &str) -> Result<Option<Value>, String> {
    let file = path(workspace, pipeline_id)?;
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", file.display())),
    };
    serde_json::from_str(crate::format::strip_bom(&text))
        .map(Some)
        .map_err(|e| format!("{}: not valid JSON: {e}", file.display()))
}

/// Write the suite. The pipeline it names is set here rather than taken from the caller: a
/// suite runs whatever it points at, and only this pipeline's own file belongs there.
pub fn save(workspace: &Path, pipeline_id: &str, suite: &Value) -> Result<(), String> {
    let file = path(workspace, pipeline_id)?;
    let mut suite = suite.clone();
    let doc = suite.as_object_mut().ok_or("a test suite is a JSON object")?;
    doc.insert("pipeline".into(), json!(format!("../pipelines/{pipeline_id}.json")));
    let mut text = serde_json::to_string_pretty(&suite).map_err(|e| e.to_string())?;
    text.push('\n');
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // Beside the suite, so the rename stays on one filesystem and a crash leaves the old file.
    let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| format!("{}: {e}", temp.display()))?;
    std::fs::rename(&temp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("{}: {e}", file.display())
    })
}

/// Run a suite through the harness and return each case's result.
///
/// `record` first writes what each node produces as its expected rows, then runs the suite
/// that now stands, so what comes back is the result of the file on disk. `case` runs one.
/// `runner` is the `duckle-runner` binary, which is what carries the harness.
pub fn run(
    runner: &Path,
    duckdb: &Path,
    workspace: &Path,
    pipeline_id: &str,
    record: bool,
    case: Option<&str>,
) -> Result<Value, String> {
    let file = path(workspace, pipeline_id)?;
    let harness = |flags: &[&str]| -> Result<Output, String> {
        let mut cmd = Command::new(runner);
        cmd.arg("test")
            .args(flags)
            .arg("--workspace")
            .arg(workspace)
            .arg(&file)
            .current_dir(workspace)
            .env("DUCKLE_DUCKDB_BIN", duckdb);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.output().map_err(|e| format!("running {}: {e}", runner.display()))
    };
    if record {
        // Exit 1 is a case that could not run, which the run below reports by name.
        let out = harness(&["--update-golden"])?;
        if out.status.code() == Some(2) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    let mut flags = vec!["--json"];
    if let Some(name) = case {
        flags.extend(["--case", name]);
    }
    let out = harness(&flags)?;
    // Exit 1 is a failed assertion, which is a result rather than an error: it is what the
    // caller came for. Anything else that printed no report did not run.
    let report: Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        format!(
            "the test harness returned nothing readable (exit {}): {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })?;
    let suite = if record { load(workspace, pipeline_id)? } else { None };
    Ok(json!({ "results": report["results"], "suite": suite }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipeline_id_cannot_walk_out_of_the_tests_folder() {
        let ws = Path::new("/w");
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "c:x"] {
            assert!(path(ws, bad).is_err(), "{bad:?}");
        }
        assert!(path(ws, "orders").unwrap().ends_with("tests/orders.test.json"));
    }

    #[test]
    fn a_saved_suite_can_only_name_its_own_pipeline() {
        let tmp = tempfile::tempdir().unwrap();
        let hostile = json!({ "pipeline": "../../elsewhere/secret.json", "cases": [] });
        save(tmp.path(), "orders", &hostile).unwrap();
        let back = load(tmp.path(), "orders").unwrap().unwrap();
        assert_eq!(back["pipeline"], json!("../pipelines/orders.json"));
    }

    #[test]
    fn a_pipeline_with_no_tests_has_no_suite() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path(), "orders").unwrap(), None);
    }
}
