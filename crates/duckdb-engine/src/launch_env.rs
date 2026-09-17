//! Process environment that a setting overrides and later hands back.
//!
//! The desktop app mirrors per-workspace settings into the environment variables
//! the engine reads: a memory cap, unsigned extensions, a proxy. Setting one was
//! never the problem. Clearing was: a workspace with no value left the previous
//! workspace's value in place, so opening a second workspace kept the first
//! one's unsigned-extension opt-in, and clearing the proxy in Settings left the
//! copied value in HTTPS_PROXY where it stayed in effect. Removing the variable
//! outright would be wrong the other way, dropping a value the app was launched
//! with. So the value a variable had before any setting touched it is kept, and
//! "no value" puts that back.

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{Mutex, OnceLock};

/// Each variable's value from before the first `set_or_restore` touched it.
fn launch_values() -> &'static Mutex<HashMap<String, Option<OsString>>> {
    static LAUNCH: OnceLock<Mutex<HashMap<String, Option<OsString>>>> = OnceLock::new();
    LAUNCH.get_or_init(Default::default)
}

/// Set `name` to `value`, or back to its launch value when `value` is None.
pub fn set_or_restore(name: &str, value: Option<&str>) {
    let mut launch = launch_values().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let original = launch
        .entry(name.to_string())
        .or_insert_with(|| std::env::var_os(name))
        .clone();
    match (value, original) {
        (Some(v), _) => std::env::set_var(name, v),
        (None, Some(v)) => std::env::set_var(name, v),
        (None, None) => std::env::remove_var(name),
    }
}
