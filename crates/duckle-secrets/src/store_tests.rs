use super::*;
use serde_json::json;

fn cli_present() -> bool {
    std::env::var_os("DUCKLE_DUCKDB_BIN")
        .map(PathBuf::from)
        .is_some_and(|p| p.is_file())
}

macro_rules! cli_or_skip {
    () => {
        if !cli_present() {
            eprintln!("skipping: set DUCKLE_DUCKDB_BIN to a duckdb CLI to run");
            return;
        }
    };
}

fn raw_payload(ws: &Path, id: &str) -> String {
    let out = run(
        ws,
        &format!(
            "SELECT payload FROM connection WHERE id = {};",
            sql_quote(id).unwrap()
        ),
    )
    .unwrap();
    results(&out).unwrap().pop().unwrap_or_default()[0]["payload"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn ids_and_quotes_are_checked_before_sql_is_built() {
    assert!(valid_id("c_80960_1") && valid_id("a-b"));
    assert!(!valid_id("") && !valid_id("../x") && !valid_id("a b") && !valid_id("x'y"));
    assert_eq!(sql_quote("it's").unwrap(), "'it''s'");
    assert!(sql_quote("a\0b").is_err());
}

#[test]
fn a_saved_connection_round_trips_with_its_secrets_encrypted() {
    cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let payload = json!({ "kind": "mysql", "host": "db.local", "port": 3306, "database": "sales", "username": "etl", "password": "s3cret!" });
    save(ws.path(), "c1", "Sales O'Brien", &payload).unwrap();

    assert!(
        !raw_payload(ws.path(), "c1").contains("s3cret!"),
        "password stored in clear text"
    );
    let listed = list(ws.path()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].name.as_str(), listed[0].kind.as_str()),
        ("Sales O'Brien", "mysql")
    );
    assert!(!listed[0].created_at.is_empty());
    assert_eq!(decrypted(ws.path(), &listed[0])["password"], "s3cret!");
    assert!(redacted(&decrypted(ws.path(), &listed[0]))
        .get("password")
        .is_none());

    let loaded = crate::load_connection(ws.path(), "c1").unwrap();
    assert_eq!(
        (loaded["host"].as_str(), loaded["password"].as_str()),
        (Some("db.local"), Some("s3cret!"))
    );

    save(
        ws.path(),
        "c1",
        "Renamed",
        &json!({ "kind": "mysql", "host": "db2" }),
    )
    .unwrap();
    let again = get(ws.path(), "c1").unwrap().unwrap();
    assert_eq!(
        (again.name.as_str(), again.payload["host"].as_str()),
        ("Renamed", Some("db2"))
    );
    assert_eq!(
        list(ws.path()).unwrap().len(),
        1,
        "a save replaces, it does not add"
    );

    assert!(delete(ws.path(), "c1").unwrap());
    assert!(!delete(ws.path(), "c1").unwrap());
    assert!(get(ws.path(), "c1").unwrap().is_none());
    assert!(crate::load_connection(ws.path(), "c1")
        .unwrap_err()
        .contains("not found"));
}

#[test]
fn legacy_connection_files_are_imported_once_and_kept_aside() {
    cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    let dir = ws.path().join("connections");
    std::fs::create_dir_all(&dir).unwrap();
    // Sealed the way the editor wrote them, bound to the file's id.
    let sealed = crate::encrypt_payload_json(
        ws.path(),
        "c_80960_1",
        r#"{"kind":"mysql","host":"h","password":"pw"}"#,
    )
    .unwrap();
    std::fs::write(dir.join("c_80960_1.json"), &sealed).unwrap();
    std::fs::write(dir.join("other.json"), r#"{"kind":"postgres","host":"pg"}"#).unwrap();
    std::fs::write(
        ws.path().join("repository.json"),
        r#"[{"id":"c_80960_1","name":"duckle_accenture","type":"connection"}]"#,
    )
    .unwrap();

    let listed = list(ws.path()).unwrap();
    let names: Vec<_> = listed
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();
    assert_eq!(
        names,
        [("c_80960_1", "duckle_accenture"), ("other", "other")]
    );
    assert!(!dir.exists(), "the emptied folder is removed");
    assert!(
        ws.path()
            .join(IMPORTED_DIR)
            .join("c_80960_1.json")
            .is_file(),
        "the original is kept aside"
    );
    assert_eq!(
        crate::load_connection(ws.path(), "c_80960_1").unwrap()["password"],
        "pw"
    );

    // A file that reappears (a git pull, an older build) does not overwrite
    // what was edited since.
    save(
        ws.path(),
        "other",
        "Edited",
        &json!({ "kind": "postgres", "host": "new" }),
    )
    .unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("other.json"),
        r#"{"kind":"postgres","host":"stale"}"#,
    )
    .unwrap();
    assert_eq!(
        get(ws.path(), "other").unwrap().unwrap().payload["host"],
        "new"
    );
}

#[test]
fn a_pipeline_resolves_all_its_references_from_the_store() {
    cli_or_skip!();
    let ws = tempfile::tempdir().unwrap();
    save(ws.path(), "pg", "Warehouse", &json!({ "kind": "postgres", "host": "pg.local", "port": 5432, "database": "dw", "username": "u", "password": "p" })).unwrap();
    let mut doc = json!({ "nodes": [
        { "id": "a", "data": { "componentId": "src.postgres", "properties": { "connectionRef": "pg", "tableName": "t" } } },
        { "id": "b", "data": { "componentId": "snk.postgres", "properties": { "connectionRef": "pg" } } },
        { "id": "c", "data": { "componentId": "src.postgres", "properties": { "connectionRef": "gone", "host": "inline" } } },
    ] });
    crate::resolve_connection_refs_value(ws.path(), &mut doc).unwrap();
    assert_eq!(doc["nodes"][0]["data"]["properties"]["password"], "p");
    assert_eq!(doc["nodes"][1]["data"]["properties"]["host"], "pg.local");
    assert_eq!(
        doc["nodes"][2]["data"]["properties"]["host"], "inline",
        "a missing connection leaves the node's own props"
    );
}
