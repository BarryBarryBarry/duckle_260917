//! `duckle-runner work`, run as the real binary.

/// A worker runs its items in the workspace it prints here, and that same path
/// becomes DUCKLE_WORKSPACE and `${workspace}` for every item. On Windows
/// `canonicalize` prefixes it with `\\?\`; once a builder turns the backslashes
/// forward, DuckDB 2.0 refuses `//?/C:/...` outright ("cannot join incompatible
/// paths"), so a `${workspace}/...` path failed under `work` and nowhere else.
#[test]
fn a_worker_runs_in_the_workspace_without_the_windows_verbatim_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_duckle-runner"))
        .args(["work", "--check", "--workspace"])
        .arg(tmp.path())
        .output()
        .expect("the runner starts");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(
        said.contains("locks exclude correctly"),
        "the lock check did not pass: {said}; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!said.contains(r"\\?\"), "the workspace kept the verbatim prefix: {said}");
}
