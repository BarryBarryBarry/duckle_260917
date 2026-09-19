//! One streamed harness event that the desktop bridge forwards to the
//! frontend over a Tauri `Channel<HarnessEvent>` or `app.emit(...)`.
//!
//! Tagged as `{ "kind": "token", ... }` etc. to match the shape used by
//! `apps/desktop/src/llama_chat::ChatEvent`, so the frontend renderer
//! can share a single reducer.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HarnessEvent {
    /// Round-trip counter. Fired before each LLM call.
    TurnStart { round: u32 },

    /// One text chunk from the assistant.
    Token { text: String },

    /// The model requested a tool call. Fired once the streaming
    /// aggregation for a tool call has resolved a full JSON blob.
    ToolCallStart {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },

    /// The MCP server replied to a tool call.
    ToolCallEnd {
        id: String,
        ok: bool,
        content: serde_json::Value,
    },

    /// The ACP session's currently selected provider/model route.
    ModelSelected { provider: String, model: String },

    /// A tool wrote a pipeline file the GUI should reload and focus.
    PipelinePersisted { id: String, action: String },

    /// Terminal success. `reason` is the model's finish_reason, or
    /// `"max_rounds"` if the loop hit its bound.
    Done { reason: String },

    /// Terminal failure. Surface to the user as an error toast.
    Error { message: String },
}
