//! SAP HANA (on-premise and HANA Cloud) through the pure-Rust `hdbconnect`
//! driver: no SAP HANA Client to install, TLS through rustls.
//!
//! The source writes each cell as text and casts every column to the DuckDB type
//! the server reported, as the ODBC sources do. The sink creates a missing target
//! as a column table and writes through a prepared statement in batches, each
//! value converted to the type the server declared for its parameter: HANA has
//! no multi-row VALUES, so batch binding is what keeps a load from paying one
//! round trip per row.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use hdbconnect::{Connection, ConnectParams, HdbValue, ParameterDescriptor, ServerCerts, TypeId};
use serde_json::Value as JsonValue;

use crate::connectors::{unique_column_name, with_deadline, CONNECT_TIMEOUT};
use crate::plan::{self, HanaConnSpec, HanaSinkSpec, HanaSourceSpec};
use crate::{describe_columns, DuckdbEngine, EngineError, JsonLinesWriter};

/// rustls has both the ring and the aws-lc-rs provider compiled in through other
/// connectors, so it cannot pick one by itself, and hdbconnect builds its TLS
/// configuration from the process default. Install ring - the provider the
/// engine's own TLS uses - unless something already installed one.
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Open a connection, giving up after [`CONNECT_TIMEOUT`]: the driver has no
/// connect timeout, so a host that never answers would hold the run forever.
pub(crate) fn hana_connect(conn: &HanaConnSpec) -> Result<Connection, String> {
    install_crypto_provider();
    let mut builder = ConnectParams::builder();
    builder
        .hostname(&conn.host)
        .port(conn.port)
        .dbuser(&conn.user)
        .password(&conn.password);
    if let Some(db) = conn.database.as_deref() {
        builder.dbname(db);
    }
    if conn.encrypt {
        if conn.trust_cert {
            builder.tls_without_server_verification();
        } else {
            builder.tls_with(ServerCerts::RootCertificates);
        }
    }
    let params = builder.build().map_err(|e| e.to_string())?;
    let (host, port) = (conn.host.clone(), conn.port);
    with_deadline(
        CONNECT_TIMEOUT,
        move || {
            format!(
                "{host}:{port} did not complete the logon within {}s",
                CONNECT_TIMEOUT.as_secs()
            )
        },
        move || Connection::new(params).map_err(|e| e.to_string()),
    )
}

fn connect_error(conn: &HanaConnSpec, e: String) -> EngineError {
    EngineError::Query(format!("hana: connect to {}:{}: {}", conn.host, conn.port, e))
}

/// The DuckDB type a result column is cast to, or None to keep it as text.
fn duckdb_type_for(t: TypeId, precision: i16, scale: i16) -> Option<String> {
    use TypeId as T;
    Some(match t {
        // HANA's TINYINT is unsigned (0..255), wider than DuckDB's.
        T::TINYINT | T::SMALLINT => "SMALLINT".into(),
        T::INT => "INTEGER".into(),
        T::BIGINT => "BIGINT".into(),
        T::DECIMAL | T::FIXED8 | T::FIXED12 | T::FIXED16 => {
            // A floating-point DECIMAL (declared without precision) reports a
            // scale outside 0..=precision; DOUBLE is the closest DuckDB has.
            if (1..=38).contains(&precision) && (0..=precision).contains(&scale) {
                format!("DECIMAL({precision},{scale})")
            } else {
                "DOUBLE".into()
            }
        }
        T::REAL => "REAL".into(),
        T::DOUBLE => "DOUBLE".into(),
        T::BOOLEAN => "BOOLEAN".into(),
        T::DAYDATE => "DATE".into(),
        T::SECONDTIME => "TIME".into(),
        T::LONGDATE | T::SECONDDATE => "TIMESTAMP".into(),
        T::BINARY | T::VARBINARY | T::BSTRING | T::BLOB | T::BINTEXT | T::BLOCATOR => "BLOB".into(),
        _ => return None,
    })
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// One cell as the text its column's cast reads. Dates and times are written in
/// the one shape DuckDB parses; a LONGDATE's seven fractional digits are cut to
/// the six a DuckDB TIMESTAMP holds.
fn cell_text(value: HdbValue<'static>) -> Result<Option<String>, String> {
    Ok(Some(match value {
        HdbValue::NULL => return Ok(None),
        HdbValue::TINYINT(n) => n.to_string(),
        HdbValue::SMALLINT(n) => n.to_string(),
        HdbValue::INT(n) => n.to_string(),
        HdbValue::BIGINT(n) => n.to_string(),
        HdbValue::DECIMAL(d) => d.to_plain_string(),
        HdbValue::REAL(f) => f.to_string(),
        HdbValue::DOUBLE(f) => f.to_string(),
        HdbValue::BOOLEAN(b) => b.to_string(),
        HdbValue::STRING(s) => s,
        HdbValue::STR(s) => s.to_string(),
        HdbValue::DBSTRING(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        HdbValue::BINARY(bytes) | HdbValue::GEOMETRY(bytes) | HdbValue::POINT(bytes) => hex(&bytes),
        HdbValue::SYNC_CLOB(clob) => clob.into_string().map_err(|e| e.to_string())?,
        HdbValue::SYNC_NCLOB(nclob) => nclob.into_string().map_err(|e| e.to_string())?,
        HdbValue::SYNC_BLOB(blob) => hex(&blob.into_bytes().map_err(|e| e.to_string())?),
        HdbValue::LONGDATE(d) => {
            let mut s = d.to_string().replacen('T', " ", 1);
            // YYYY-MM-DD HH:MM:SS.fffffff -> microseconds.
            s.truncate(26);
            s
        }
        HdbValue::SECONDDATE(d) => d.to_string().replacen('T', " ", 1),
        HdbValue::DAYDATE(d) => d.to_string(),
        HdbValue::SECONDTIME(t) => t.to_string(),
        other => other.to_string(),
    }))
}

/// A value bound to a parameter of type `d`: numbers, decimals and text through
/// the driver's own conversion for that type, which leaves dates and LOBs as
/// text for the server to convert.
fn bind_value(v: &JsonValue, d: &ParameterDescriptor) -> Result<HdbValue<'static>, String> {
    use TypeId as T;
    let t = d.type_id();
    match (v, t) {
        (JsonValue::Null, _) => return Ok(HdbValue::NULL),
        (_, T::BOOLEAN) => {
            return Ok(HdbValue::BOOLEAN(match v {
                JsonValue::Bool(b) => *b,
                JsonValue::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
                other => {
                    let s = other.as_str().map(str::trim).unwrap_or_default().to_ascii_lowercase();
                    matches!(s.as_str(), "true" | "t" | "1" | "yes" | "y")
                }
            }))
        }
        (_, T::BINARY | T::VARBINARY | T::BSTRING | T::BLOB | T::BINTEXT) => {
            let text = match v {
                JsonValue::String(s) => s.clone(),
                other => other.to_string(),
            };
            return Ok(HdbValue::BINARY(text.into_bytes()));
        }
        _ => {}
    }
    let numeric = matches!(
        t,
        T::TINYINT | T::SMALLINT | T::INT | T::BIGINT | T::REAL | T::DOUBLE | T::DECIMAL | T::FIXED8 | T::FIXED12 | T::FIXED16
    );
    let text = match v {
        JsonValue::Bool(b) if numeric => if *b { "1" } else { "0" }.to_string(),
        JsonValue::String(s) => s.clone(),
        other => other.to_string(),
    };
    d.parse_value(&text).map_err(|e| e.to_string())
}

/// The HANA type a missing target column is created as.
fn hana_type_for(duck: &str) -> String {
    let up = duck.trim().to_ascii_uppercase();
    if up.starts_with("DECIMAL") || up.starts_with("NUMERIC") {
        return up.replacen("NUMERIC", "DECIMAL", 1);
    }
    match up.as_str() {
        "BOOLEAN" | "BOOL" => "BOOLEAN",
        "TINYINT" | "UTINYINT" | "SMALLINT" | "INT2" => "SMALLINT",
        "USMALLINT" | "INTEGER" | "INT" | "INT4" => "INTEGER",
        "UINTEGER" | "BIGINT" | "INT8" => "BIGINT",
        "UBIGINT" => "DECIMAL(20,0)",
        "HUGEINT" | "UHUGEINT" => "DECIMAL(38,0)",
        "REAL" | "FLOAT" | "FLOAT4" => "REAL",
        "DOUBLE" | "FLOAT8" => "DOUBLE",
        "DATE" => "DATE",
        "TIME" => "TIME",
        // A TIMESTAMPTZ arrives as its UTC wall-clock time (see run_hana_sink).
        "TIMESTAMP" | "DATETIME" | "TIMESTAMP_NS" | "TIMESTAMP_MS" | "TIMESTAMP_S"
        | "TIMESTAMP WITH TIME ZONE" | "TIMESTAMPTZ" => "TIMESTAMP",
        "UUID" => "NVARCHAR(36)",
        "BLOB" | "BYTEA" | "BINARY" | "VARBINARY" => "VARBINARY(5000)",
        _ => "NVARCHAR(5000)",
    }
    .to_string()
}

fn is_timestamptz(duck: &str) -> bool {
    matches!(
        duck.trim().to_ascii_uppercase().as_str(),
        "TIMESTAMP WITH TIME ZONE" | "TIMESTAMPTZ"
    )
}

fn sql_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The first column of each row, as text.
fn first_column(conn: &Connection, sql: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for row in conn.query(sql).map_err(|e| e.to_string())? {
        let mut row = row.map_err(|e| e.to_string())?;
        if let Some(text) = row.next_value().map(cell_text).transpose()?.flatten() {
            out.push(text);
        }
    }
    Ok(out)
}

/// The target table's columns in order, or None when it does not exist.
fn table_columns(conn: &Connection, schema: Option<&str>, table: &str) -> Result<Option<Vec<String>>, String> {
    let schema_expr = match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => sql_text(&plan::hana_name(s)),
        None => "CURRENT_SCHEMA".to_string(),
    };
    let cols = first_column(
        conn,
        &format!(
            "SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = {} AND TABLE_NAME = {} ORDER BY POSITION",
            schema_expr,
            sql_text(&plan::hana_name(table))
        ),
    )?;
    Ok(if cols.is_empty() { None } else { Some(cols) })
}

/// The target column each upstream column writes: an existing table's own
/// column of that name (exact, else ignoring case, since HANA folds unquoted
/// names to upper case), or the folded name of a column about to be created.
fn target_columns(upstream: &[&String], existing: Option<&[String]>) -> Result<Vec<String>, String> {
    let Some(existing) = existing else {
        return Ok(upstream.iter().map(|c| plan::hana_ident(c)).collect());
    };
    let mut out = Vec::with_capacity(upstream.len());
    let mut missing = Vec::new();
    for c in upstream {
        let found = existing
            .iter()
            .find(|e| e.as_str() == c.as_str())
            .or_else(|| existing.iter().find(|e| e.eq_ignore_ascii_case(c)));
        match found {
            Some(name) => out.push(format!("\"{}\"", name.replace('"', "\"\""))),
            None => missing.push(c.as_str()),
        }
    }
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(format!(
            "the target table has no column {} (it has {})",
            missing.join(", "),
            existing.join(", ")
        ))
    }
}

impl DuckdbEngine {
    /// src.hana: run the query and materialize its rows into the node's table,
    /// each column typed as HANA reported it.
    pub(crate) fn run_hana_source(&self, db: &Path, spec: &HanaSourceSpec) -> Result<String, EngineError> {
        let conn = hana_connect(&spec.conn).map_err(|e| connect_error(&spec.conn, e))?;
        let rs = conn
            .query(&spec.query)
            .map_err(|e| EngineError::Query(format!("hana: query failed: {}", e)))?;
        let meta = rs.metadata();
        let mut used = HashSet::new();
        let mut names = Vec::with_capacity(meta.len());
        let mut columns_spec = Vec::with_capacity(meta.len());
        let mut select = Vec::with_capacity(meta.len());
        for field in meta.iter() {
            let name = unique_column_name(field.displayname(), &mut used);
            let ident = plan::quote_ident(&name);
            columns_spec.push(format!("'{}': 'VARCHAR'", name.replace('\'', "''")));
            select.push(match duckdb_type_for(field.type_id(), field.precision(), field.scale()) {
                Some(ty) if ty == "BLOB" => format!("from_hex({ident}) AS {ident}"),
                Some(ty) => format!("CAST({ident} AS {ty}) AS {ident}"),
                None => format!("{ident} AS {ident}"),
            });
            names.push(name);
        }
        let columns_spec = columns_spec.join(", ");
        let mut writer = JsonLinesWriter::open(&spec.node_id)?;
        let mut count = 0usize;
        for row in rs {
            if count % 1000 == 0 {
                self.check_cancelled()?;
            }
            let row = row.map_err(|e| EngineError::Query(format!("hana: fetch: {}", e)))?;
            let mut obj = serde_json::Map::with_capacity(names.len());
            for (name, value) in names.iter().zip(row) {
                let text = cell_text(value)
                    .map_err(|e| EngineError::Query(format!("hana: read column {}: {}", name, e)))?;
                obj.insert(name.clone(), text.map(JsonValue::String).unwrap_or(JsonValue::Null));
            }
            writer.write_row(&JsonValue::Object(obj))?;
            count += 1;
        }
        drop(conn);
        writer.finalize_typed(self.binary(), db, &spec.node_id, &columns_spec, &select.join(", "))?;
        Ok(format!("hana: materialized {} rows into {}", count, spec.node_id))
    }

    /// snk.hana: create the target when it is missing, empty it for
    /// "truncate", then insert - or, with upsert keys, UPSERT ... WHERE on them,
    /// deleting by key the rows the delete flag marks.
    pub(crate) fn run_hana_sink(&self, db: &Path, spec: &HanaSinkSpec) -> Result<String, EngineError> {
        let target = plan::hana_qualified(spec.schema.as_deref(), &spec.table);
        let fail = |what: &str, e: String| EngineError::Query(format!("hana: {} {}: {}", what, target, e));
        let described = describe_columns(self, db, &spec.from_view);
        if described.is_empty() {
            return Ok(format!("hana: 0 columns to write into {}", target));
        }
        let cols: Vec<String> = described.iter().map(|(n, _)| n.clone()).collect();
        let col_types: HashMap<&str, &str> = described.iter().map(|(n, t)| (n.as_str(), t.as_str())).collect();

        let is_upsert = !spec.upsert_keys.is_empty();
        let delete_col = if is_upsert { spec.delete_column.as_deref() } else { None };
        for key in spec.upsert_keys.iter().map(String::as_str).chain(delete_col) {
            if !cols.iter().any(|c| c == key) {
                return Err(EngineError::Config(format!(
                    "snk.hana: column {:?} is not among the upstream columns ({})",
                    key,
                    cols.join(", ")
                )));
            }
        }
        let data_cols: Vec<&String> = cols.iter().filter(|c| Some(c.as_str()) != delete_col).collect();

        // A TIMESTAMPTZ goes over as its UTC wall-clock time: HANA's TIMESTAMP
        // has no zone, and the text DuckDB writes for one carries an offset it
        // would not parse.
        let projection = described
            .iter()
            .map(|(n, t)| {
                let q = plan::quote_ident(n);
                if is_timestamptz(t) {
                    format!("timezone('UTC', {q}) AS {q}")
                } else {
                    q
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let rows = self.run_rows(
            Some(db),
            &format!("SELECT {} FROM {}", projection, plan::quote_ident(&spec.from_view)),
        )?;

        let conn = hana_connect(&spec.conn).map_err(|e| connect_error(&spec.conn, e))?;
        let existing = table_columns(&conn, spec.schema.as_deref(), &spec.table)
            .map_err(|e| fail("look up", e))?;
        let targets = target_columns(&data_cols, existing.as_deref()).map_err(|e| fail("write into", e))?;
        if existing.is_none() {
            let defs = data_cols
                .iter()
                .zip(&targets)
                .map(|(c, t)| format!("{} {}", t, hana_type_for(col_types.get(c.as_str()).copied().unwrap_or("VARCHAR"))))
                .collect::<Vec<_>>()
                .join(", ");
            conn.exec(format!("CREATE COLUMN TABLE {} ({})", target, defs))
                .map_err(|e| fail("create", e.to_string()))?;
        }
        if !is_upsert && spec.mode == "truncate" {
            conn.exec(format!("TRUNCATE TABLE {}", target))
                .map_err(|e| fail("truncate", e.to_string()))?;
        }
        if rows.is_empty() {
            return Ok(format!("hana: 0 rows to write into {}", target));
        }

        let target_of: HashMap<&str, &str> = data_cols
            .iter()
            .zip(&targets)
            .map(|(c, t)| (c.as_str(), t.as_str()))
            .collect();
        let key_match = spec
            .upsert_keys
            .iter()
            .map(|k| format!("{} = ?", target_of[k.as_str()]))
            .collect::<Vec<_>>()
            .join(" AND ");
        let marks = vec!["?"; data_cols.len()].join(", ");
        let write_sql = if is_upsert {
            format!("UPSERT {} ({}) VALUES ({}) WHERE {}", target, targets.join(", "), marks, key_match)
        } else {
            format!("INSERT INTO {} ({}) VALUES ({})", target, targets.join(", "), marks)
        };
        let mut write = conn.prepare(&write_sql).map_err(|e| fail("prepare a write into", e.to_string()))?;
        let write_params = write.parameter_descriptors();
        let write_params: Vec<&ParameterDescriptor> = write_params.iter_in().collect();
        let mut delete = match delete_col {
            Some(_) => Some(
                conn.prepare(format!("DELETE FROM {} WHERE {}", target, key_match))
                    .map_err(|e| fail("prepare a delete from", e.to_string()))?,
            ),
            None => None,
        };
        let delete_params = delete.as_ref().map(|d| d.parameter_descriptors());
        let delete_params: Vec<&ParameterDescriptor> =
            delete_params.as_ref().map(|p| p.iter_in().collect()).unwrap_or_default();

        // Upsert parameters are the row's values, then its keys again for WHERE.
        let mut order: Vec<&str> = data_cols.iter().map(|c| c.as_str()).collect();
        order.extend(spec.upsert_keys.iter().map(String::as_str));
        let keys: Vec<&str> = spec.upsert_keys.iter().map(String::as_str).collect();
        let is_deleted = |row: &JsonValue| {
            delete_col.is_some_and(|dc| match row.get(dc) {
                Some(JsonValue::String(s)) => s == &spec.delete_value,
                Some(JsonValue::Null) | None => false,
                Some(other) => other.to_string() == spec.delete_value,
            })
        };
        let bind = |row: &JsonValue, names: &[&str], params: &[&ParameterDescriptor]| {
            names
                .iter()
                .zip(params)
                .map(|(name, p)| {
                    bind_value(row.get(*name).unwrap_or(&JsonValue::Null), p)
                        .map_err(|e| format!("column {}: {}", name, e))
                })
                .collect::<Result<Vec<_>, String>>()
        };

        let (mut written, mut deleted) = (0usize, 0usize);
        for chunk in rows.chunks(spec.batch_size.max(1)) {
            self.check_cancelled()?;
            for row in chunk {
                if is_deleted(row) {
                    if let Some(d) = delete.as_mut() {
                        d.add_row_to_batch(bind(row, &keys, &delete_params).map_err(|e| fail("delete from", e))?)
                            .map_err(|e| fail("delete from", e.to_string()))?;
                        deleted += 1;
                    }
                    continue;
                }
                let names: &[&str] = if is_upsert { &order } else { &order[..data_cols.len()] };
                write
                    .add_row_to_batch(bind(row, names, &write_params).map_err(|e| fail("write into", e))?)
                    .map_err(|e| fail("write into", e.to_string()))?;
                written += 1;
            }
            // Deletes first: a key deleted and re-added in one batch ends present.
            if let Some(d) = delete.as_mut().filter(|d| d.current_batch_size() > 0) {
                d.execute_batch().map_err(|e| fail("delete from", e.to_string()))?;
            }
            if write.current_batch_size() > 0 {
                write.execute_batch().map_err(|e| fail("write into", e.to_string()))?;
            }
        }
        Ok(if is_upsert {
            format!("hana: upserted {} rows and deleted {} from {}", written, deleted, target)
        } else {
            format!("hana: inserted {} rows into {}", written, target)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_types_map_to_duckdb() {
        assert_eq!(duckdb_type_for(TypeId::TINYINT, 3, 0).as_deref(), Some("SMALLINT"));
        assert_eq!(duckdb_type_for(TypeId::INT, 10, 0).as_deref(), Some("INTEGER"));
        assert_eq!(duckdb_type_for(TypeId::DECIMAL, 15, 2).as_deref(), Some("DECIMAL(15,2)"));
        assert_eq!(duckdb_type_for(TypeId::FIXED16, 38, 0).as_deref(), Some("DECIMAL(38,0)"));
        // A floating-point DECIMAL has no fixed scale.
        assert_eq!(duckdb_type_for(TypeId::DECIMAL, 34, 32767).as_deref(), Some("DOUBLE"));
        assert_eq!(duckdb_type_for(TypeId::LONGDATE, 27, 7).as_deref(), Some("TIMESTAMP"));
        assert_eq!(duckdb_type_for(TypeId::DAYDATE, 10, 0).as_deref(), Some("DATE"));
        assert_eq!(duckdb_type_for(TypeId::SECONDTIME, 8, 0).as_deref(), Some("TIME"));
        assert_eq!(duckdb_type_for(TypeId::VARBINARY, 16, 0).as_deref(), Some("BLOB"));
        assert_eq!(duckdb_type_for(TypeId::NVARCHAR, 100, 0), None);
        assert_eq!(duckdb_type_for(TypeId::NCLOB, 0, 0), None);
    }

    #[test]
    fn cells_are_written_in_the_shape_their_cast_reads() {
        let text = |v: HdbValue<'static>| cell_text(v).unwrap();
        assert_eq!(text(HdbValue::NULL), None);
        assert_eq!(text(HdbValue::INT(-7)).as_deref(), Some("-7"));
        assert_eq!(text(HdbValue::BOOLEAN(true)).as_deref(), Some("true"));
        assert_eq!(text(HdbValue::STRING("x".repeat(20_000))).map(|s| s.len()), Some(20_000));
        assert_eq!(text(HdbValue::BINARY(vec![0x00, 0xab, 0x10])).as_deref(), Some("00ab10"));
    }

    #[test]
    fn missing_tables_get_hana_types() {
        assert_eq!(hana_type_for("DECIMAL(18,3)"), "DECIMAL(18,3)");
        assert_eq!(hana_type_for("BIGINT"), "BIGINT");
        assert_eq!(hana_type_for("TINYINT"), "SMALLINT");
        assert_eq!(hana_type_for("HUGEINT"), "DECIMAL(38,0)");
        assert_eq!(hana_type_for("TIMESTAMP WITH TIME ZONE"), "TIMESTAMP");
        assert_eq!(hana_type_for("VARCHAR"), "NVARCHAR(5000)");
        assert_eq!(hana_type_for("STRUCT(a INTEGER)"), "NVARCHAR(5000)");
        assert!(is_timestamptz("timestamptz") && !is_timestamptz("TIMESTAMP"));
    }

    #[test]
    fn upstream_columns_find_an_existing_tables_columns() {
        let up = ["order_id".to_string(), "Amount".to_string(), "note".to_string()];
        let up: Vec<&String> = up.iter().collect();
        // A new table folds plain names, as an unquoted HANA identifier would.
        assert_eq!(target_columns(&up, None).unwrap(), ["\"ORDER_ID\"", "\"AMOUNT\"", "\"NOTE\""]);
        // An existing table's own spelling wins, exact before case-insensitive.
        let existing = ["ORDER_ID".to_string(), "Amount".to_string(), "note".to_string()];
        assert_eq!(
            target_columns(&up, Some(&existing)).unwrap(),
            ["\"ORDER_ID\"", "\"Amount\"", "\"note\""]
        );
        let err = target_columns(&up, Some(&existing[..2])).unwrap_err();
        assert!(err.contains("no column note"), "{err}");
    }

    #[test]
    fn a_connection_that_cannot_be_reached_fails_without_hanging() {
        let conn = HanaConnSpec {
            host: "127.0.0.1".into(),
            port: 1,
            user: "U".into(),
            password: "p".into(),
            database: None,
            encrypt: true,
            trust_cert: false,
        };
        assert!(hana_connect(&conn).is_err());
    }
}
