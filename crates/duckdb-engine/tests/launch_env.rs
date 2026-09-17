//! Settings that override the process environment hand it back when cleared.
//!
//! Its own test binary, with one test, because it rewrites process-wide
//! environment variables: sharing a binary with tests that read them would make
//! both flaky, which is how a leaked DUCKLE_POLICY_FILE once wedged the suite.

use duckle_duckdb_engine::{launch_env, tls};

#[test]
fn a_cleared_setting_restores_the_environment_the_process_was_launched_with() {
    for key in [
        "DUCKLE_HTTPS_PROXY",
        "DUCKLE_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "http_proxy",
        "HTTP_PROXY",
        "DUCKLE_MEMORY_LIMIT",
    ] {
        std::env::remove_var(key);
    }
    // As if the app had been started from a shell with a corporate proxy.
    std::env::set_var("HTTPS_PROXY", "http://launch.example:3128");

    // Settings sets a proxy, then the person clears it again.
    tls::set_proxy(Some("http://settings.example:8080".into()));
    assert_eq!(tls::current_proxy().as_deref(), Some("http://settings.example:8080"));
    tls::set_proxy(None);
    assert_eq!(
        tls::current_proxy().as_deref(),
        Some("http://launch.example:3128"),
        "clearing the Settings proxy left the copied value in HTTPS_PROXY, so it stayed in effect"
    );
    assert_eq!(
        std::env::var_os("HTTP_PROXY"),
        None,
        "HTTP_PROXY was not set at launch and must not outlive the setting"
    );

    // A workspace memory cap, then a workspace without one.
    launch_env::set_or_restore("DUCKLE_MEMORY_LIMIT", Some("512MB"));
    assert_eq!(std::env::var("DUCKLE_MEMORY_LIMIT").as_deref(), Ok("512MB"));
    launch_env::set_or_restore("DUCKLE_MEMORY_LIMIT", None);
    assert_eq!(
        std::env::var_os("DUCKLE_MEMORY_LIMIT"),
        None,
        "the previous workspace's cap was carried into one that sets none"
    );
}
