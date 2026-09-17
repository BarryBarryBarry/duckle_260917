//! Coarse error categorization for run results, alerts, and logs.
//!
//! Connector and DuckDB failures all reach the run report as strings
//! (`EngineError::Query(msg)` mostly), which makes programmatic routing -
//! "retry network errors, fail fast on schema errors", alert payloads,
//! log filtering in Splunk - impossible without parsing prose. This module
//! buckets an error message into a small, stable set of categories by
//! pattern-matching the text. The mapping is heuristic by design: it only
//! has to be useful, not perfect, and `other` is always a safe answer.
//!
//! Categories (stable, lowercase - external tooling may key on them):
//! `auth`, `network`, `timeout`, `oom`, `disk`, `schema`, `syntax`,
//! `cancelled`, `other`.

/// Bucket an error message into a coarse category. Order matters: the
/// most specific signals are tested first so e.g. a "connection timed
/// out" lands in `timeout`, not `network`.
pub fn categorize_error(msg: &str) -> &'static str {
    let m = msg.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
    /// `needle` as a whole word, so a short one is not swallowed by a longer
    /// identifier. `_` counts as part of a word, since `timeout_ms` is one name
    /// rather than a message about a timeout.
    fn has_word(haystack: &str, needle: &str) -> bool {
        let bytes = haystack.as_bytes();
        let wordish = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        haystack.match_indices(needle).any(|(i, _)| {
            let before = i == 0 || !wordish(bytes[i - 1]);
            let end = i + needle.len();
            before && (end == bytes.len() || !wordish(bytes[end]))
        })
    }

    if has(&["cancelled", "canceled by user"]) {
        return "cancelled";
    }
    if has(&["timed out", "timeout", "deadline exceeded"]) {
        return "timeout";
    }
    if has(&["out of memory", "memory limit", "failed to allocate", "cannot allocate"])
        // "oom" only as a whole word. As a substring it is inside rooms,
        // zoom_level, bloom_filters and boomerang, so `Table with name rooms
        // does not exist` was reported as an out-of-memory failure - which is
        // the one category that sends somebody to look at the machine rather
        // than at their SQL. The other needles here are left as substrings
        // deliberately: driver exceptions arrive glued together, and matching
        // those is worth more than the collisions long words cannot have.
        || has_word(&m, "oom")
    {
        return "oom";
    }
    if has(&["no space left", "disk full", "too many open files", "quota exceeded"]) {
        return "disk";
    }
    if has(&[
        "authentication",
        "unauthorized",
        "forbidden",
        "access denied",
        "permission denied",
        "login failed",
        "invalid credentials",
        "password authentication failed",
        "jwt token is invalid",
        "token expired",
        "http 401",
        "http 403",
        "status 401",
        "status 403",
        "(401)",
        "(403)",
    ]) {
        return "auth";
    }
    // A local file that is not there is not a network problem, and calling it
    // one is actively harmful: the stated use of these categories is "retry
    // network errors, fail fast on schema errors", so a retry policy would sit
    // there re-reading a path that will never appear. DuckDB reports it as
    // "IO Error: No files found that match the pattern ...", which the generic
    // "io error" needle below would otherwise swallow. `other` rather than a
    // new category, because this set is documented as stable and external
    // tooling keys on it.
    // Deliberately narrow. A bare "does not exist" also appears in "Table
    // 'orders' does not exist", which is a schema error and must stay one, so
    // only file-specific wording counts here.
    if has(&["no files found", "no such file", "file not found", "cannot open file"]) {
        return "other";
    }
    if has(&[
        "connection refused",
        "connection reset",
        "connection closed",
        "could not connect",
        "failed to connect",
        "unable to connect",
        "broken pipe",
        "no such host",
        "name resolution",
        "dns error",
        "network unreachable",
        "host unreachable",
        "tls handshake",
        "certificate",
        "http 502",
        "http 503",
        "http 504",
        "status 502",
        "status 503",
        "status 504",
        "transport error",
        "io error",
    ]) {
        return "network";
    }
    // DuckDB prefixes reference/type problems as Binder / Catalog /
    // Conversion errors; connectors add their own "column ... not found"
    // style messages. All are schema-shaped: the data or references no
    // longer match what the pipeline expects.
    if has(&["syntax error", "parser error", "parse error"]) {
        return "syntax";
    }
    if has(&[
        "binder error",
        "catalog error",
        "conversion error",
        "could not convert",
        "cannot cast",
        "type mismatch",
        "schema mismatch",
        "does not exist",
        "not found in",
        "no such column",
        "no such table",
        "unknown column",
        "invalid input error",
    ]) {
        return "schema";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::categorize_error;

    #[test]
    fn buckets_common_messages() {
        let cases = [
            ("Connection refused (os error 111)", "network"),
            ("TLS handshake failed: bad certificate", "network"),
            // A missing local file used to land in `network` because DuckDB
            // words it as an IO Error, which meant a retry-network policy sat
            // there re-reading a path that was never going to appear.
            (
                "src: query: IO Error: No files found that match the pattern \"orders.csv\"",
                "other",
            ),
            ("IO Error: No such file or directory", "other"),
            // A genuine network IO error still belongs in `network`.
            ("IO Error: Connection reset by peer", "network"),
            ("connection timed out after 30000 ms", "timeout"),
            ("Out of Memory Error: failed to allocate block", "oom"),
            ("IO Error: No space left on device", "disk"),
            ("snowflake: JWT token is invalid (390144)", "auth"),
            ("ORA-01017: invalid username/password; logon denied. authentication failed", "auth"),
            ("Binder Error: column \"order_id\" not found", "schema"),
            ("Catalog Error: Table 'orders' does not exist", "schema"),
            ("Conversion Error: Could not convert string 'abc' to INT64", "schema"),
            ("Parser Error: syntax error at or near \"SELEC\"", "syntax"),
            ("run was cancelled", "cancelled"),
            ("something inexplicable happened", "other"),
        ];
        for (msg, want) in cases {
            assert_eq!(categorize_error(msg), want, "msg: {msg}");
        }
    }

    /// A table called `rooms` is not an out-of-memory failure.
    ///
    /// "oom" was matched as a bare substring, so rooms, zoom_level,
    /// bloom_filters and boomerang all landed in the one category that sends
    /// somebody to look at the machine instead of at their SQL. The genuine
    /// message never needed that needle: it matches "out of memory" and
    /// "failed to allocate" on its own.
    #[test]
    fn an_ordinary_name_containing_oom_is_not_an_out_of_memory_error() {
        for msg in [
            "Catalog Error: Table with name rooms does not exist!",
            "Binder Error: Referenced column \"zoom_level\" not found",
            "Catalog Error: Table with name bloom_filters does not exist!",
            "Parser Error: syntax error at or near \"boomerang\"",
        ] {
            assert_ne!(categorize_error(msg), "oom", "misread as out of memory: {msg}");
        }
        // And the real thing is still caught, spelled either way.
        assert_eq!(categorize_error("Out of Memory Error: failed to allocate 4GB"), "oom");
        assert_eq!(categorize_error("worker killed: OOM"), "oom");
        assert_eq!(categorize_error("process exited (oom-killer)"), "oom");
    }

    #[test]
    fn timeout_beats_network() {
        // "connection timed out" mentions both; timeout is the actionable bucket.
        assert_eq!(categorize_error("connection timed out"), "timeout");
    }
}
