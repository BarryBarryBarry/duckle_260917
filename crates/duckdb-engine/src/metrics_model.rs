//! Plan 003: the vocabulary of the run metrics store.
//!
//! One `pipeline_run` row per run, one `node_run` row per stage of it, and an
//! append-only `pipeline_event` log of runs starting and finishing. Rows are
//! written in pieces as a run progresses, so every write is a patch: a field
//! left `None` keeps whatever the row already holds.
//!
//! Status words are snake_case in storage and on the wire and UpperCamelCase
//! in Rust. The run record's own `status` (`ok/error/cancelled/interrupted`)
//! maps onto [`RunStatus`] through [`RunStatus::from_result_status`].

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// A word the store does not know, from a filter or a stored row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownStatus(pub String);

impl fmt::Display for UnknownStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown status '{}'", self.0)
    }
}

impl std::error::Error for UnknownStatus {}

macro_rules! status_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $word:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $word),+
                }
            }
        }

        impl FromStr for $name {
            type Err = UnknownStatus;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($word => Ok($name::$variant),)+
                    other => Err(UnknownStatus(other.to_string())),
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

status_enum! {
    /// Where a run is. `Queued` and `Running` are the only non-final states.
    RunStatus {
        Queued => "queued",
        Running => "running",
        Ok => "ok",
        Error => "error",
        Cancelled => "cancelled",
        Interrupted => "interrupted",
    }
}

status_enum! {
    /// Where one stage of a run is. `Pending` and `Running` are the only
    /// non-final states; `Cancelled` and `Interrupted` exist only here, never
    /// in the engine's own node status.
    NodeStatus {
        Pending => "pending",
        Running => "running",
        Ok => "ok",
        Unchanged => "unchanged",
        Skipped => "skipped",
        Error => "error",
        Cancelled => "cancelled",
        Interrupted => "interrupted",
    }
}

status_enum! {
    /// The two things the event log records about a run.
    PipelineEventKind {
        RunStarted => "run_started",
        RunFinished => "run_finished",
    }
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, RunStatus::Queued | RunStatus::Running)
    }

    /// A run record's status, as the store names it.
    ///
    /// The record's vocabulary is closed today, but a newer writer could add a
    /// word. Rather than refuse the record, an unknown word becomes `Error`
    /// and the second value carries the original, for the row's `error`.
    pub fn from_result_status(s: &str) -> (RunStatus, Option<String>) {
        match s {
            "ok" => (RunStatus::Ok, None),
            "error" => (RunStatus::Error, None),
            "cancelled" => (RunStatus::Cancelled, None),
            "interrupted" => (RunStatus::Interrupted, None),
            other => (RunStatus::Error, Some(format!("unrecognised run status '{other}'"))),
        }
    }
}

impl NodeStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, NodeStatus::Pending | NodeStatus::Running)
    }
}

/// A `pipeline_run` row as read back. Times are RFC3339 UTC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineRunMetric {
    pub run_key: String,
    pub pipeline_id: String,
    pub pipeline_name: Option<String>,
    pub trigger: Option<String>,
    pub status: RunStatus,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub rows: Option<i64>,
    pub rejected_rows: Option<i64>,
    pub node_count: Option<i64>,
    pub unchanged: Option<bool>,
    pub incomplete: Option<bool>,
    pub incomplete_reason: Option<String>,
    pub queue_ms: Option<i64>,
    pub error: Option<String>,
    pub category: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A `node_run` row as read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeRunMetric {
    pub run_key: String,
    pub node_id: String,
    /// Position in the compiled stage order, from 0. Absent for rows filled
    /// from a record that did not say.
    pub ordinal: Option<i64>,
    pub component: Option<String>,
    /// Catalog kind (`source`, `transform`, ...), not the stage's sink/view.
    pub kind: Option<String>,
    pub status: NodeStatus,
    pub started_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub rows: Option<i64>,
    pub rejected_rows: Option<i64>,
    pub error: Option<String>,
    pub category: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A `pipeline_event` row. `detail` is JSON text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineEventRecord {
    pub event_id: String,
    pub run_key: String,
    pub pipeline_id: String,
    pub pipeline_name: Option<String>,
    pub kind: PipelineEventKind,
    pub occurred_at: String,
    pub trigger: Option<String>,
    pub detail: Option<String>,
    /// Set by the store; ignored on write.
    #[serde(default)]
    pub created_at: String,
}

impl PipelineEventRecord {
    /// One event of each kind per run, so the id is derived, not invented.
    pub fn id_for(run_key: &str, kind: PipelineEventKind) -> String {
        format!("{run_key}:{}", kind.as_str())
    }
}

/// A partial write to one `pipeline_run` row.
///
/// A row is only created by a patch that carries `pipeline_id` and
/// `started_at`, the two columns a run cannot exist without; any other patch
/// updates an existing row and is a no-op when there is none. `started_at` is
/// written once and never moved, and a status never steps back from a final
/// state to `queued`/`running`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PipelineRunPatch {
    pub run_key: String,
    pub pipeline_id: Option<String>,
    pub pipeline_name: Option<String>,
    pub trigger: Option<String>,
    pub status: Option<RunStatus>,
    pub started_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub rows: Option<i64>,
    pub rejected_rows: Option<i64>,
    pub node_count: Option<i64>,
    pub unchanged: Option<bool>,
    pub incomplete: Option<bool>,
    pub incomplete_reason: Option<String>,
    pub queue_ms: Option<i64>,
    pub error: Option<String>,
    pub category: Option<String>,
}

/// A partial write to one `node_run` row. A new row with no status starts as
/// `pending`; `started_at` keeps the first value it is given.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NodeRunPatch {
    pub run_key: String,
    pub node_id: String,
    pub ordinal: Option<i64>,
    pub component: Option<String>,
    pub kind: Option<String>,
    pub status: Option<NodeStatus>,
    pub started_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub rows: Option<i64>,
    pub rejected_rows: Option<i64>,
    pub error: Option<String>,
    pub category: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_status_word_round_trips() {
        for s in RunStatus::ALL {
            assert_eq!(s.as_str().parse::<RunStatus>(), Ok(*s));
            assert_eq!(serde_json::to_string(s).unwrap(), format!("\"{}\"", s.as_str()));
        }
        for s in NodeStatus::ALL {
            assert_eq!(s.as_str().parse::<NodeStatus>(), Ok(*s));
            let back: NodeStatus = serde_json::from_str(&format!("\"{s}\"")).unwrap();
            assert_eq!(back, *s);
        }
        for k in PipelineEventKind::ALL {
            assert_eq!(k.as_str().parse::<PipelineEventKind>(), Ok(*k));
        }
    }

    #[test]
    fn unknown_words_are_refused_not_guessed() {
        assert_eq!("Ok".parse::<RunStatus>(), Err(UnknownStatus("Ok".into())));
        assert!("pending".parse::<RunStatus>().is_err(), "pending is a node word, not a run word");
        assert!("queued".parse::<NodeStatus>().is_err());
        assert!("".parse::<PipelineEventKind>().is_err());
    }

    #[test]
    fn a_record_status_maps_and_an_unknown_one_is_kept_as_an_error() {
        assert_eq!(RunStatus::from_result_status("ok"), (RunStatus::Ok, None));
        assert_eq!(RunStatus::from_result_status("interrupted"), (RunStatus::Interrupted, None));
        let (s, note) = RunStatus::from_result_status("paused");
        assert_eq!(s, RunStatus::Error);
        assert!(note.unwrap_or_default().contains("'paused'"));
    }

    #[test]
    fn only_queued_and_running_are_open() {
        let open: Vec<_> = RunStatus::ALL.iter().filter(|s| !s.is_terminal()).collect();
        assert_eq!(open, [&RunStatus::Queued, &RunStatus::Running]);
        let open: Vec<_> = NodeStatus::ALL.iter().filter(|s| !s.is_terminal()).collect();
        assert_eq!(open, [&NodeStatus::Pending, &NodeStatus::Running]);
    }

    #[test]
    fn event_ids_are_one_per_run_and_kind() {
        assert_eq!(PipelineEventRecord::id_for("run-1", PipelineEventKind::RunFinished), "run-1:run_finished");
    }
}
