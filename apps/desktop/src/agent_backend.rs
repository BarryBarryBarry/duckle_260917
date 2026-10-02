use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AgentLlm {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub workspace: PathBuf,
    pub agent_dir: PathBuf,
    pub session_dir: PathBuf,
    pub session_id: String,
    pub node_bin: PathBuf,
    pub pi_cli_js: PathBuf,
    pub mcp_bin: PathBuf,
    pub llm: AgentLlm,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionContext {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPayload {
    pub workspace: String,
    pub connection: Option<ConnectionContext>,
    #[serde(default)]
    pub selected_assets: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryMessage {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionReady {
        session_id: String,
        session_name: Option<String>,
    },
    HistoryLoaded {
        messages: Vec<AgentHistoryMessage>,
    },
    TextDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    ToolStart {
        id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolUpdate {
        id: String,
        partial: serde_json::Value,
    },
    ToolEnd {
        id: String,
        name: String,
        result: serde_json::Value,
        is_error: bool,
    },
    Subagent {
        id: String,
        task: String,
        status: SubagentStatus,
        result: Option<serde_json::Value>,
    },
    SkillUsed {
        name: String,
    },
    UiRequest {
        id: String,
        method: String,
        title: Option<String>,
        message: Option<String>,
        options: Option<Vec<String>>,
        placeholder: Option<String>,
        prefill: Option<String>,
        timeout_ms: Option<u64>,
    },
    UiNotify {
        method: String,
        payload: serde_json::Value,
    },
    /// One model reply finished. `usage` is Pi's token accounting for it
    /// (`input`, `output`, `cacheRead`, `totalTokens`, ...), when reported.
    MessageEnd {
        usage: Option<serde_json::Value>,
        /// The provider refused or failed the call (quota, auth, overload...).
        /// Pi may still retry; an abort the user asked for is not an error.
        error: Option<String>,
        /// The reply hit the model's output limit and was cut off; Pi does not
        /// continue on its own after that.
        truncated: bool,
    },
    Settled,
    CommandFailed {
        id: Option<String>,
        command: String,
        error: String,
    },
    Error {
        message: String,
    },
    Exited {
        code: Option<i32>,
    },
}

/// What reaches the frontend: an event plus the Pi session it came from. A
/// conversation switch stops one Pi process and starts another, and the old
/// one's last events (its exit included) must not be read as the new one's.
#[derive(Debug, Clone, Serialize)]
pub struct AgentEventEnvelope {
    pub session: String,
    #[serde(flatten)]
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiReplyDto {
    Value { value: String },
    Confirmed { confirmed: bool },
    Cancelled,
}

#[derive(Debug, Clone)]
pub enum UiReply {
    Value(String),
    Confirmed(bool),
    Cancelled,
}

impl From<UiReplyDto> for UiReply {
    fn from(value: UiReplyDto) -> Self {
        match value {
            UiReplyDto::Value { value } => Self::Value(value),
            UiReplyDto::Confirmed { confirmed } => Self::Confirmed(confirmed),
            UiReplyDto::Cancelled => Self::Cancelled,
        }
    }
}

pub trait AgentBackend: Send {
    fn start(
        &mut self,
        config: &AgentConfig,
        on_event: Box<dyn Fn(AgentEvent) + Send + Sync>,
    ) -> Result<(), String>;
    fn send_prompt(&mut self, prompt: &str, ctx: &ContextPayload) -> Result<(), String>;
    fn reply_ui(&mut self, request_id: &str, reply: UiReply) -> Result<(), String>;
    fn abort(&mut self) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
}
