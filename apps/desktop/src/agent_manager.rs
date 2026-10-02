use crate::agent_backend::{
    AgentBackend, AgentConfig, AgentEvent, AgentEventEnvelope, AgentHistoryMessage, AgentLlm,
    ConnectionContext, ContextPayload, SubagentStatus, UiReply,
};
use crate::{app_settings, engine_manager};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const AGENT_EVENT_NAME: &str = "agent_event";
const SYSTEM_PROMPT: &str = include_str!("agent_assets/SYSTEM.md");
const DUCKLE_SKILL: &str = include_str!("agent_assets/skills/duckle-etl/SKILL.md");
const DUCKLE_BRIDGE_EXTENSION: &str = include_str!("agent_assets/duckle-bridge.ts");
/// Subagent definitions for the bridge's `duckle_subagent` tool, by file name.
const SUBAGENT_DEFINITIONS: &[(&str, &str)] = &[
    (
        "pipeline-checker.md",
        include_str!("agent_assets/agents/pipeline-checker.md"),
    ),
    (
        "run-debugger.md",
        include_str!("agent_assets/agents/run-debugger.md"),
    ),
];
/// The bridge extension's delegation tool (see agent_assets/duckle-bridge.ts).
const SUBAGENT_TOOL: &str = "duckle_subagent";
/// Pi's own tools the agent must not have: Duckle work goes through MCP.
const EXCLUDED_TOOLS: &str = "bash,edit,write";

#[derive(Default)]
struct RuntimeState {
    running: bool,
    next_request_id: u64,
    pending: HashMap<String, mpsc::Sender<JsonValue>>,
}

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
    stdout_thread: Option<std::thread::JoinHandle<()>>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
    runtime: Arc<Mutex<RuntimeState>>,
}

pub struct PiBackend {
    process: Option<PiProcess>,
}

impl PiBackend {
    fn new() -> Self {
        Self { process: None }
    }
}

static AGENT: Mutex<Option<PiBackend>> = Mutex::new(None);

impl AgentBackend for PiBackend {
    fn start(
        &mut self,
        config: &AgentConfig,
        on_event: Box<dyn Fn(AgentEvent) + Send + Sync>,
    ) -> Result<(), String> {
        self.stop()?;
        let runtime = Arc::new(Mutex::new(RuntimeState::default()));
        let mut cmd = Command::new(&config.node_bin);
        cmd.arg(&config.pi_cli_js)
            .args([
                "--mode",
                "rpc",
                "--session-dir",
                config.session_dir.to_string_lossy().as_ref(),
                "--session-id",
                &config.session_id,
                "--exclude-tools",
                EXCLUDED_TOOLS,
            ])
            .current_dir(&config.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PI_CODING_AGENT_DIR", &config.agent_dir)
            .env("PI_OFFLINE", "1")
            .env("PI_TELEMETRY", "0");
        if let Some(parent) = config.node_bin.parent() {
            let path_var = std::env::var_os("PATH").unwrap_or_default();
            let joined = std::env::join_paths(
                std::iter::once(parent.to_path_buf()).chain(std::env::split_paths(&path_var)),
            )
            .map_err(|e| e.to_string())?;
            cmd.env("PATH", joined);
        }
        if config.llm.api_key.is_some() {
            cmd.env(
                "DUCKLE_AGENT_API_KEY",
                config.llm.api_key.as_deref().unwrap_or_default(),
            );
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn pi agent: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "pi agent stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "pi agent stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "pi agent stderr unavailable".to_string())?;
        let on_event = Arc::<dyn Fn(AgentEvent) + Send + Sync>::from(on_event);
        let stdout_runtime = Arc::clone(&runtime);
        let stdout_events = Arc::clone(&on_event);
        let stdout_thread = std::thread::spawn(move || {
            read_stdout_loop(stdout, stdout_runtime, stdout_events);
        });
        let stderr_thread = std::thread::spawn(move || {
            read_stderr_loop(stderr);
        });
        self.process = Some(PiProcess {
            child,
            stdin,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
            runtime,
        });
        if let Some(proc) = self.process.as_mut() {
            bootstrap_session(proc, &on_event)?;
        }
        Ok(())
    }

    fn send_prompt(&mut self, prompt: &str, ctx: &ContextPayload) -> Result<(), String> {
        let proc = self
            .process
            .as_mut()
            .ok_or_else(|| "agent is not running".to_string())?;
        let req_id = {
            let mut state = proc
                .runtime
                .lock()
                .map_err(|_| "agent state lock poisoned".to_string())?;
            state.next_request_id += 1;
            let id = state.next_request_id;
            let running = state.running;
            (id, running)
        };
        let mut payload = json!({
            "id": format!("prompt-{}", req_id.0),
            "type": "prompt",
            "message": build_prompt_message(ctx, prompt),
        });
        if req_id.1 {
            payload["streamingBehavior"] = json!("followUp");
        }
        write_json_line(&mut proc.stdin, &payload)
    }

    fn reply_ui(&mut self, request_id: &str, reply: UiReply) -> Result<(), String> {
        let proc = self
            .process
            .as_mut()
            .ok_or_else(|| "agent is not running".to_string())?;
        let payload = match reply {
            UiReply::Value(value) => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "value": value,
            }),
            UiReply::Confirmed(confirmed) => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "confirmed": confirmed,
            }),
            UiReply::Cancelled => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": true,
            }),
        };
        write_json_line(&mut proc.stdin, &payload)
    }

    fn abort(&mut self) -> Result<(), String> {
        let proc = self
            .process
            .as_mut()
            .ok_or_else(|| "agent is not running".to_string())?;
        let running = proc
            .runtime
            .lock()
            .map_err(|_| "agent state lock poisoned".to_string())?
            .running;
        if !running {
            return Ok(());
        }
        write_json_line(&mut proc.stdin, &json!({ "id": "abort", "type": "abort" }))
    }

    fn stop(&mut self) -> Result<(), String> {
        let Some(mut proc) = self.process.take() else {
            return Ok(());
        };
        drop(proc.stdin);
        let wait_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match proc.child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None if std::time::Instant::now() >= wait_deadline => {
                    proc.child.kill().map_err(|e| e.to_string())?;
                    break;
                }
                None => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
        if let Some(handle) = proc.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = proc.stderr_thread.take() {
            let _ = handle.join();
        }
        Ok(())
    }
}

/// Start the agent for one conversation. Each conversation is its own Pi
/// session, so switching back to an earlier one resumes its context.
pub fn agent_start_sync(
    app: tauri::AppHandle,
    workspace: String,
    conversation_id: String,
) -> Result<(), String> {
    if workspace.trim().is_empty() {
        return Err("Open or create a workspace first".to_string());
    }
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !engine_manager::nodejs_installed(&app_data) {
        return Err("nodejs_not_installed".to_string());
    }
    if !engine_manager::pi_installed(&app_data) {
        return Err("pi_not_installed".to_string());
    }
    let cfg = resolve_agent_config(&app, &workspace, &conversation_id)?;
    write_pi_config(&cfg)?;
    let emit_app = app.clone();
    let session = cfg.session_id.clone();
    let on_event = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope {
            session: session.clone(),
            event,
        };
        let _ = emit_app.emit(AGENT_EVENT_NAME, envelope);
    });
    let mut guard = AGENT
        .lock()
        .map_err(|_| "agent lock poisoned".to_string())?;
    let backend = guard.get_or_insert_with(PiBackend::new);
    backend.start(&cfg, on_event)
}

pub fn agent_send_prompt_sync(prompt: String, ctx: ContextPayload) -> Result<(), String> {
    let mut guard = AGENT
        .lock()
        .map_err(|_| "agent lock poisoned".to_string())?;
    let backend = guard
        .as_mut()
        .ok_or_else(|| "agent is not running".to_string())?;
    backend.send_prompt(&prompt, &ctx)
}

pub fn agent_abort_sync() -> Result<(), String> {
    let mut guard = AGENT
        .lock()
        .map_err(|_| "agent lock poisoned".to_string())?;
    let backend = guard
        .as_mut()
        .ok_or_else(|| "agent is not running".to_string())?;
    backend.abort()
}

pub fn agent_stop_sync() -> Result<(), String> {
    let mut guard = AGENT
        .lock()
        .map_err(|_| "agent lock poisoned".to_string())?;
    if let Some(backend) = guard.as_mut() {
        backend.stop()?;
    }
    *guard = None;
    Ok(())
}

pub fn agent_check_installed_sync(app_data: &Path) -> bool {
    engine_manager::nodejs_installed(app_data) && engine_manager::pi_installed(app_data)
}

pub fn agent_ui_reply_sync(request_id: String, reply: UiReply) -> Result<(), String> {
    let mut guard = AGENT
        .lock()
        .map_err(|_| "agent lock poisoned".to_string())?;
    let backend = guard
        .as_mut()
        .ok_or_else(|| "agent is not running".to_string())?;
    backend.reply_ui(&request_id, reply)
}

/// The names the user gave saved connections. They live on the connection's
/// entry in `repository.json` (what the project tree shows), not in the
/// connection file itself.
fn repository_names(workspace: &Path) -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(workspace.join("repository.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
        .and_then(|repo| repo.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            let name = item.get("name")?.as_str()?.trim();
            (!name.is_empty()).then(|| (id.to_string(), name.to_string()))
        })
        .collect()
}

pub fn list_connections_sync(workspace: &str) -> Result<Vec<ConnectionContext>, String> {
    let mut out = Vec::new();
    let names = repository_names(Path::new(workspace));
    let dir = Path::new(workspace).join("connections");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let json = match serde_json::from_str::<JsonValue>(&text) {
            Ok(json) => json,
            Err(_) => continue,
        };
        // The repository name, else one in the file, else the database it
        // points at; the generated id is the last resort.
        let field = |key: &str| {
            json.get(key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let name = names
            .get(&id)
            .cloned()
            .or_else(|| field("name"))
            .or_else(|| field("database"))
            .unwrap_or_else(|| id.clone());
        out.push(ConnectionContext {
            id: id.clone(),
            name,
            kind: json
                .get("kind")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            host: json
                .get("host")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            port: json.get("port").and_then(|v| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(str::to_string))
            }),
            database: json
                .get("database")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            schema: json
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

fn resolve_agent_config(
    app: &tauri::AppHandle,
    workspace: &str,
    conversation_id: &str,
) -> Result<AgentConfig, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let agent_dir = app_data.join("agent").join("pi");
    let session_id = conversation_session_id(conversation_id)?;
    let session_dir = agent_dir.join("sessions");
    let (mcp_bin, _runner) = crate::stage_mcp(&app_data)?;
    Ok(AgentConfig {
        workspace: PathBuf::from(workspace),
        agent_dir,
        session_dir,
        session_id,
        node_bin: engine_manager::nodejs_path(&app_data),
        pi_cli_js: engine_manager::pi_cli_js(&app_data),
        mcp_bin,
        llm: resolve_agent_llm(workspace)?,
    })
}

fn resolve_agent_llm(workspace: &str) -> Result<AgentLlm, String> {
    let cfg = app_settings::agent_llm_config(workspace)
        .ok_or_else(|| "agent_llm_not_configured".to_string())?;
    Ok(AgentLlm {
        provider: "duckle".to_string(),
        base_url: crate::llama_chat::openai_api_root(&cfg.base_url),
        model: cfg.model,
        api_key: cfg.api_key,
    })
}

fn write_pi_config(config: &AgentConfig) -> Result<(), String> {
    std::fs::create_dir_all(&config.agent_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config.session_dir).map_err(|e| e.to_string())?;
    write_models_config(config)?;
    write_mcp_config(config)?;
    write_settings_config(config)?;
    write_system_prompt(config)?;
    write_duckle_skill(config)?;
    write_duckle_bridge(&config.agent_dir)?;
    write_subagent_definitions(&config.agent_dir)?;
    Ok(())
}

fn write_models_config(config: &AgentConfig) -> Result<(), String> {
    let path = config.agent_dir.join("models.json");
    let mut root = read_json_object(&path)?;
    let providers = ensure_object(&mut root, "providers");
    providers.insert(
        config.llm.provider.clone(),
        json!({
            "baseUrl": config.llm.base_url,
            "api": "openai-completions",
            "apiKey": if config.llm.api_key.is_some() { "$DUCKLE_AGENT_API_KEY" } else { "duckle" },
            "models": [{ "id": config.llm.model }],
        }),
    );
    write_json_atomic(&path, &root)
}

fn write_mcp_config(config: &AgentConfig) -> Result<(), String> {
    let path = config.agent_dir.join("mcp.json");
    let mut root = read_json_object(&path)?;
    let servers = ensure_object(&mut root, "mcpServers");
    servers.insert(
        "duckle".to_string(),
        json!({
            "command": config.mcp_bin.to_string_lossy().into_owned(),
            "args": [],
            "exposure": "direct",
            "description": "Duckle ETL pipeline tools",
        }),
    );
    write_json_atomic(&path, &root)
}

fn write_settings_config(config: &AgentConfig) -> Result<(), String> {
    let path = config.agent_dir.join("settings.json");
    let mut root = read_json_object(&path)?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;
    object.insert("defaultProvider".to_string(), json!(config.llm.provider));
    object.insert("defaultModel".to_string(), json!(config.llm.model));
    write_json_atomic(&path, &root)
}

fn write_system_prompt(config: &AgentConfig) -> Result<(), String> {
    std::fs::write(config.agent_dir.join("SYSTEM.md"), SYSTEM_PROMPT).map_err(|e| e.to_string())
}

fn write_duckle_skill(config: &AgentConfig) -> Result<(), String> {
    let skill_dir = config.agent_dir.join("skills").join("duckle-etl");
    std::fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    std::fs::write(skill_dir.join("SKILL.md"), DUCKLE_SKILL).map_err(|e| e.to_string())
}

fn write_duckle_bridge(agent_dir: &Path) -> Result<(), String> {
    let ext_dir = agent_dir.join("extensions").join("duckle-bridge");
    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("index.ts"), DUCKLE_BRIDGE_EXTENSION).map_err(|e| e.to_string())
}

fn write_subagent_definitions(agent_dir: &Path) -> Result<(), String> {
    let agents_dir = agent_dir.join("agents");
    std::fs::create_dir_all(&agents_dir).map_err(|e| e.to_string())?;
    for (file, body) in SUBAGENT_DEFINITIONS {
        std::fs::write(agents_dir.join(file), body).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pi session ids take letters, digits, `.`, `_` and `-`, and must start and
/// end with a letter or digit. Conversation ids are generated by the panel
/// (`c-<time>-<rand>`); anything else is refused rather than passed to Pi.
fn conversation_session_id(conversation_id: &str) -> Result<String, String> {
    let ok = !conversation_id.is_empty()
        && conversation_id.len() <= 80
        && conversation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && conversation_id
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric());
    if ok {
        Ok(format!("duckle-{conversation_id}"))
    } else {
        Err(format!("invalid conversation id: {conversation_id:?}"))
    }
}

fn read_json_object(path: &Path) -> Result<JsonValue, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("read {}: {e}", path.display()))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

fn ensure_object<'a>(
    root: &'a mut JsonValue,
    key: &str,
) -> &'a mut serde_json::Map<String, JsonValue> {
    if !root.is_object() {
        *root = json!({});
    }
    let object = root.as_object_mut().expect("object set above");
    object
        .entry(key.to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("object inserted above")
}

fn write_json_atomic(path: &Path, value: &JsonValue) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

const CONTEXT_OPEN: &str = "[Duckle Context]\n";
const CONTEXT_CLOSE: &str = "\n[/Duckle Context]\n\n";

/// The user's own words from a prompt written by [`build_prompt_message`].
fn strip_context_block(text: &str) -> &str {
    text.strip_prefix(CONTEXT_OPEN)
        .and_then(|rest| rest.split_once(CONTEXT_CLOSE))
        .map(|(_, prompt)| prompt)
        .unwrap_or(text)
}

fn build_prompt_message(ctx: &ContextPayload, prompt: &str) -> String {
    format!(
        "{CONTEXT_OPEN}{}{CONTEXT_CLOSE}{}",
        serde_json::to_string(&json!({
            "workspace": ctx.workspace,
            "connection": ctx.connection,
            "selectedAssets": ctx.selected_assets,
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        prompt
    )
}

fn write_json_line(stdin: &mut ChildStdin, value: &JsonValue) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn request_json(
    process: &mut PiProcess,
    payload: JsonValue,
    timeout: Duration,
) -> Result<JsonValue, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "request id is required".to_string())?
        .to_string();
    let (tx, rx) = mpsc::channel();
    {
        let mut state = process
            .runtime
            .lock()
            .map_err(|_| "agent state lock poisoned".to_string())?;
        state.pending.insert(id.clone(), tx);
    }
    if let Err(err) = write_json_line(&mut process.stdin, &payload) {
        let mut state = process
            .runtime
            .lock()
            .map_err(|_| "agent state lock poisoned".to_string())?;
        state.pending.remove(&id);
        return Err(err);
    }
    rx.recv_timeout(timeout).map_err(|_| {
        if let Ok(mut state) = process.runtime.lock() {
            state.pending.remove(&id);
        }
        format!(
            "pi agent timed out waiting for {}",
            payload
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("response")
        )
    })
}

fn bootstrap_session(
    process: &mut PiProcess,
    on_event: &Arc<dyn Fn(AgentEvent) + Send + Sync>,
) -> Result<(), String> {
    let state = request_json(
        process,
        json!({ "id": "bootstrap-state", "type": "get_state" }),
        Duration::from_secs(10),
    )?;
    if state.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Err(state
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to get Pi session state")
            .to_string());
    }
    let data = state.get("data").cloned().unwrap_or(JsonValue::Null);
    let session_id = data
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let session_name = data
        .get("sessionName")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    on_event(AgentEvent::SessionReady {
        session_id,
        session_name,
    });

    let messages = request_json(
        process,
        json!({ "id": "bootstrap-messages", "type": "get_messages" }),
        Duration::from_secs(10),
    )?;
    if messages.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(());
    }
    let restored = messages
        .get("data")
        .and_then(|v| v.get("messages"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(history_message_from_pi)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !restored.is_empty() {
        on_event(AgentEvent::HistoryLoaded { messages: restored });
    }
    Ok(())
}

fn history_message_from_pi(message: &JsonValue) -> Option<AgentHistoryMessage> {
    let role = message.get("role").and_then(|v| v.as_str())?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let text = flatten_message_text(message.get("content")?)?;
    let trimmed = strip_context_block(&text).trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(AgentHistoryMessage {
        role: role.to_string(),
        text: trimmed.to_string(),
    })
}

fn flatten_message_text(content: &JsonValue) -> Option<String> {
    match content {
        JsonValue::String(text) => Some(text.clone()),
        JsonValue::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                let ty = item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match ty {
                    "text" | "thinking" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.trim().is_empty() {
                                parts.push(text.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

fn deliver_pending_response(record: &JsonValue, runtime: &Arc<Mutex<RuntimeState>>) -> bool {
    let Some(id) = record.get("id").and_then(|v| v.as_str()) else {
        return false;
    };
    let sender = runtime
        .lock()
        .ok()
        .and_then(|mut state| state.pending.remove(id));
    if let Some(sender) = sender {
        let _ = sender.send(record.clone());
        true
    } else {
        false
    }
}

fn read_stdout_loop(
    stdout: ChildStdout,
    runtime: Arc<Mutex<RuntimeState>>,
    on_event: Arc<dyn Fn(AgentEvent) + Send + Sync>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => {
                if let Ok(mut state) = runtime.lock() {
                    state.running = false;
                }
                on_event(AgentEvent::Exited { code: None });
                break;
            }
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                if buf.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<JsonValue>(&buf) {
                    Ok(record) => {
                        if record.get("type").and_then(|v| v.as_str()) == Some("response")
                            && deliver_pending_response(&record, &runtime)
                        {
                            continue;
                        }
                        for event in map_pi_record(&record, &runtime) {
                            on_event(event);
                        }
                    }
                    Err(err) => {
                        on_event(AgentEvent::Error {
                            message: format!("parse pi record: {err}"),
                        });
                    }
                }
            }
            Err(err) => {
                if let Ok(mut state) = runtime.lock() {
                    state.running = false;
                }
                on_event(AgentEvent::Error {
                    message: format!("read pi stdout: {err}"),
                });
                on_event(AgentEvent::Exited { code: None });
                break;
            }
        }
    }
}

fn read_stderr_loop(mut stderr: ChildStderr) {
    let mut reader = BufReader::new(&mut stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => tracing::debug!("pi stderr: {}", line.trim_end()),
            Err(err) => {
                tracing::debug!("pi stderr read failed: {}", err);
                break;
            }
        }
    }
}

fn map_pi_record(record: &JsonValue, runtime: &Arc<Mutex<RuntimeState>>) -> Vec<AgentEvent> {
    let ty = record
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    match ty {
        "agent_start" => {
            if let Ok(mut state) = runtime.lock() {
                state.running = true;
            }
            Vec::new()
        }
        "agent_settled" => {
            if let Ok(mut state) = runtime.lock() {
                state.running = false;
            }
            vec![AgentEvent::Settled]
        }
        "message_update" => map_message_update(record),
        "tool_execution_start" => map_tool_start(record),
        "tool_execution_update" => vec![AgentEvent::ToolUpdate {
            id: record
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            partial: record
                .get("partialResult")
                .cloned()
                .unwrap_or(JsonValue::Null),
        }],
        "tool_execution_end" => map_tool_end(record),
        "extension_ui_request" => map_ui_request(record),
        "message_end" => record
            .get("message")
            .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
            .map(|m| {
                let error =
                    (m.get("stopReason").and_then(|v| v.as_str()) == Some("error")).then(|| {
                        m.get("errorMessage")
                            .and_then(|v| v.as_str())
                            .unwrap_or("the model call failed")
                            .to_string()
                    });
                vec![AgentEvent::MessageEnd {
                    usage: m.get("usage").cloned(),
                    error,
                    truncated: m.get("stopReason").and_then(|v| v.as_str()) == Some("length"),
                }]
            })
            .unwrap_or_default(),
        "response" => {
            if record.get("success").and_then(|v| v.as_bool()) == Some(false) {
                vec![AgentEvent::CommandFailed {
                    id: record
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    command: record
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    error: record
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error")
                        .to_string(),
                }]
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

fn map_message_update(record: &JsonValue) -> Vec<AgentEvent> {
    let Some(event) = record.get("assistantMessageEvent") else {
        return Vec::new();
    };
    match event
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
    {
        "text_delta" => vec![AgentEvent::TextDelta {
            delta: event
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        "thinking_delta" => vec![AgentEvent::ThinkingDelta {
            delta: event
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        }],
        _ => Vec::new(),
    }
}

fn map_tool_start(record: &JsonValue) -> Vec<AgentEvent> {
    let id = record
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let name = record
        .get("toolName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let args = record.get("args").cloned().unwrap_or(JsonValue::Null);
    let mut out = vec![AgentEvent::ToolStart {
        id: id.clone(),
        name: name.clone(),
        args: args.clone(),
    }];
    if name == SUBAGENT_TOOL {
        out.push(AgentEvent::Subagent {
            id,
            task: subagent_label(&args),
            status: SubagentStatus::Running,
            result: None,
        });
    }
    if name == "read" {
        if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
            if path.ends_with("/SKILL.md") || path.ends_with("\\SKILL.md") {
                if let Some(skill_name) = Path::new(path)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                {
                    out.push(AgentEvent::SkillUsed {
                        name: skill_name.to_string(),
                    });
                }
            }
        }
    }
    out
}

/// "agent: task" for a `duckle_subagent` call, from its arguments or result details.
fn subagent_label(value: &JsonValue) -> String {
    let agent = value
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("subagent");
    match value.get("task").and_then(|v| v.as_str()) {
        Some(task) if !task.trim().is_empty() => format!("{agent}: {}", task.trim()),
        _ => agent.to_string(),
    }
}

fn map_tool_end(record: &JsonValue) -> Vec<AgentEvent> {
    let id = record
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let name = record
        .get("toolName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let result = record.get("result").cloned().unwrap_or(JsonValue::Null);
    let is_error = record
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = vec![AgentEvent::ToolEnd {
        id: id.clone(),
        name: name.clone(),
        result: result.clone(),
        is_error,
    }];
    if name == SUBAGENT_TOOL {
        let task = subagent_label(result.get("details").unwrap_or(&JsonValue::Null));
        out.push(AgentEvent::Subagent {
            id,
            task,
            status: if is_error {
                SubagentStatus::Failed
            } else {
                SubagentStatus::Done
            },
            result: Some(result),
        });
    }
    out
}

fn map_ui_request(record: &JsonValue) -> Vec<AgentEvent> {
    let method = record
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    match method.as_str() {
        "select" | "confirm" | "input" | "editor" => vec![AgentEvent::UiRequest {
            id: record
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            method,
            title: record
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            message: record
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            options: record.get("options").and_then(|v| {
                v.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
            }),
            placeholder: record
                .get("placeholder")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            prefill: record
                .get("prefill")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            timeout_ms: record.get("timeout").and_then(|v| v.as_u64()),
        }],
        "setStatus" => {
            if record.get("statusKey").and_then(|v| v.as_str()) == Some("duckle.subagent") {
                if let Some(text) = record.get("statusText").and_then(|v| v.as_str()) {
                    if let Ok(status) = serde_json::from_str::<JsonValue>(text) {
                        let event = status
                            .get("event")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let data = status.get("data").cloned().unwrap_or(JsonValue::Null);
                        let status = match event {
                            "completed" => SubagentStatus::Done,
                            "failed" => SubagentStatus::Failed,
                            _ => SubagentStatus::Running,
                        };
                        let id = data
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let task = data
                            .get("description")
                            .or_else(|| data.get("task"))
                            .or_else(|| data.get("type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Subagent task")
                            .to_string();
                        return vec![AgentEvent::Subagent {
                            id,
                            task,
                            status,
                            result: Some(data),
                        }];
                    }
                }
            }
            vec![AgentEvent::UiNotify {
                method,
                payload: record.clone(),
            }]
        }
        _ => vec![AgentEvent::UiNotify {
            method,
            payload: record.clone(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_block_round_trips_out_of_history() {
        let ctx = ContextPayload {
            workspace: "/ws".into(),
            connection: None,
            selected_assets: vec![json!({ "type": "table", "name": "orders" })],
        };
        let message = build_prompt_message(&ctx, "build it\nplease");
        assert!(message.starts_with("[Duckle Context]\n{"));
        assert_eq!(strip_context_block(&message), "build it\nplease");
        assert_eq!(strip_context_block("plain text"), "plain text");
    }

    #[test]
    fn each_conversation_gets_its_own_pi_session() {
        assert_eq!(
            conversation_session_id("c-lx2k-ab12").unwrap(),
            "duckle-c-lx2k-ab12"
        );
        for bad in ["", "c-", "../x", "a b", "c.1"] {
            assert!(conversation_session_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn connections_are_listed_by_their_repository_name() {
        let ws = tempfile::tempdir().unwrap();
        let conns = ws.path().join("connections");
        std::fs::create_dir_all(&conns).unwrap();
        let mysql =
            r#"{"kind":"mysql","host":"localhost","database":"duckle_accenture","password":"x"}"#;
        std::fs::write(conns.join("c_1.json"), mysql).unwrap();
        std::fs::write(
            conns.join("c_2.json"),
            r#"{"kind":"mysql","database":"duckle_marriott"}"#,
        )
        .unwrap();
        std::fs::write(conns.join("c_3.json"), r#"{"kind":"s3"}"#).unwrap();
        std::fs::write(
            ws.path().join("repository.json"),
            r#"[{"id":"c_1","name":"Accenture MySQL","type":"connection"}]"#,
        )
        .unwrap();
        let list = list_connections_sync(&ws.path().to_string_lossy()).unwrap();
        let names: Vec<(&str, &str)> = list
            .iter()
            .map(|c| (c.id.as_str(), c.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("c_1", "Accenture MySQL"),
                ("c_3", "c_3"),
                ("c_2", "duckle_marriott")
            ]
        );
        assert_eq!(list[0].host.as_deref(), Some("localhost"));
    }

    #[test]
    fn events_reach_the_frontend_tagged_with_their_session() {
        let envelope = AgentEventEnvelope {
            session: "duckle-c-1".into(),
            event: AgentEvent::Exited { code: None },
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(
            json,
            json!({ "session": "duckle-c-1", "kind": "exited", "code": null })
        );
    }

    #[test]
    fn assistant_message_end_carries_usage() {
        let runtime = Arc::new(Mutex::new(RuntimeState::default()));
        let events = map_pi_record(
            &json!({ "type": "message_end", "message": { "role": "assistant", "usage": { "input": 120, "output": 30 } } }),
            &runtime,
        );
        assert!(
            matches!(&events[..], [AgentEvent::MessageEnd { usage: Some(u), error: None, truncated: false }] if u["input"] == 120)
        );
        // The 403 from the session that ran out of free quota.
        let failed = map_pi_record(
            &json!({ "type": "message_end", "message": { "role": "assistant", "stopReason": "error",
                "errorMessage": "403: {\"code\":\"insufficient_quota\"}", "usage": { "input": 0 } } }),
            &runtime,
        );
        assert!(
            matches!(&failed[..], [AgentEvent::MessageEnd { error: Some(e), .. }] if e.contains("insufficient_quota"))
        );
        let aborted = map_pi_record(
            &json!({ "type": "message_end", "message": { "role": "assistant", "stopReason": "aborted", "errorMessage": "Request aborted" } }),
            &runtime,
        );
        assert!(matches!(
            &aborted[..],
            [AgentEvent::MessageEnd { error: None, .. }]
        ));
        let cut = map_pi_record(
            &json!({ "type": "message_end", "message": { "role": "assistant", "stopReason": "length" } }),
            &runtime,
        );
        assert!(matches!(
            &cut[..],
            [AgentEvent::MessageEnd {
                truncated: true,
                error: None,
                ..
            }]
        ));
        let user = map_pi_record(
            &json!({ "type": "message_end", "message": { "role": "user" } }),
            &runtime,
        );
        assert!(user.is_empty());
    }

    #[test]
    fn subagent_tool_maps_to_subagent_events() {
        let start = map_tool_start(&json!({
            "toolCallId": "t1",
            "toolName": SUBAGENT_TOOL,
            "args": { "agent": "pipeline-checker", "task": "check p1" },
        }));
        assert!(matches!(
            &start[1],
            AgentEvent::Subagent { id, task, status: SubagentStatus::Running, .. }
                if id == "t1" && task == "pipeline-checker: check p1"
        ));
        let end = map_tool_end(&json!({
            "toolCallId": "t1",
            "toolName": SUBAGENT_TOOL,
            "result": { "content": [], "details": { "agent": "pipeline-checker", "task": "check p1" } },
            "isError": true,
        }));
        assert!(matches!(
            &end[1],
            AgentEvent::Subagent {
                status: SubagentStatus::Failed,
                ..
            }
        ));
    }

    #[test]
    fn config_merge_keeps_foreign_keys_and_never_writes_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("mcp.json"),
            r#"{"mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"packages":["npm:foo@1"],"defaultModel":"old"}"#,
        )
        .unwrap();
        let cfg = AgentConfig {
            workspace: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            session_dir: agent_dir.join("sessions"),
            session_id: "duckle-test".into(),
            node_bin: PathBuf::from("node"),
            pi_cli_js: PathBuf::from("cli.js"),
            mcp_bin: PathBuf::from("/bin/duckle-mcp"),
            llm: AgentLlm {
                provider: "duckle".into(),
                base_url: "http://127.0.0.1:1/v1".into(),
                model: "m1".into(),
                api_key: Some("sk-secret".into()),
            },
        };
        write_pi_config(&cfg).unwrap();
        let read = |f: &str| -> JsonValue {
            serde_json::from_str(&std::fs::read_to_string(agent_dir.join(f)).unwrap()).unwrap()
        };
        let mcp = read("mcp.json");
        assert_eq!(mcp["mcpServers"]["other"]["command"], "x");
        assert_eq!(mcp["mcpServers"]["duckle"]["exposure"], "direct");
        let settings = read("settings.json");
        assert_eq!(settings["packages"][0], "npm:foo@1");
        assert_eq!(settings["defaultModel"], "m1");
        let models = std::fs::read_to_string(agent_dir.join("models.json")).unwrap();
        assert!(!models.contains("sk-secret"));
        assert!(agent_dir.join("extensions/duckle-bridge/index.ts").exists());
        assert!(agent_dir.join("agents/pipeline-checker.md").exists());
        assert!(agent_dir.join("skills/duckle-etl/SKILL.md").exists());
    }
}

/// Real end-to-end run: installs Node.js + Pi with Duckle's own installer,
/// drives `PiBackend` against a real duckle-mcp and a scripted OpenAI-compatible
/// server. Needs the network for the first install.
///
/// DUCKLE_AGENT_E2E_MCP=/path/to/duckle-mcp \
/// DUCKLE_AGENT_E2E_APPDATA=/tmp/duckle-agent-e2e \
///   cargo test -p duckle-desktop --lib agent_e2e -- --ignored --nocapture
#[cfg(test)]
mod agent_e2e {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::Instant;

    const CHECKER_MARK: &str = "You are a Duckle pipeline checker";

    fn system_text(body: &JsonValue) -> String {
        body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| matches!(m["role"].as_str(), Some("system" | "developer")))
            .map(|m| m["content"].to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn sse(chunks: Vec<JsonValue>) -> String {
        let mut out = String::new();
        for delta_finish in chunks {
            let chunk = json!({
                "id": "c1", "object": "chat.completion.chunk", "model": "fake-model",
                "choices": [{ "index": 0, "delta": delta_finish["delta"], "finish_reason": delta_finish["finish"] }],
            });
            out.push_str(&format!("data: {chunk}\n\n"));
        }
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn text_reply(text: &str) -> String {
        sse(vec![
            json!({ "delta": { "role": "assistant", "content": text }, "finish": null }),
            json!({ "delta": {}, "finish": "stop" }),
        ])
    }

    fn tool_reply(name: &str, args: JsonValue) -> String {
        sse(vec![
            json!({ "delta": { "role": "assistant", "tool_calls": [{ "index": 0, "id": format!("call_{name}"), "type": "function", "function": { "name": name, "arguments": args.to_string() } }] }, "finish": null }),
            json!({ "delta": {}, "finish": "tool_calls" }),
        ])
    }

    /// Scripted model: the main agent delegates or runs, the checker subagent
    /// calls list_pipelines and echoes what the MCP tool returned.
    fn respond(body: &JsonValue, ws: &Path) -> String {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let last = messages.last().cloned().unwrap_or(JsonValue::Null);
        let is_checker = system_text(body).contains(CHECKER_MARK);
        if last["role"] == "tool" {
            let content = last["content"].to_string();
            return if is_checker {
                text_reply(&format!(
                    "CHILD_RESULT: {}",
                    &content[..content.len().min(300)]
                ))
            } else {
                text_reply("PARENT_DONE")
            };
        }
        let user = last["content"].to_string();
        let pipelines = ws.join("pipelines");
        if is_checker {
            tool_reply(
                "mcp__duckle__list_pipelines",
                json!({ "directory": pipelines }),
            )
        } else if user.contains("delegate") {
            tool_reply(
                SUBAGENT_TOOL,
                json!({ "agent": "pipeline-checker", "task": format!("List the pipelines in {}", ws.display()) }),
            )
        } else if user.contains("run it") {
            tool_reply(
                "mcp__duckle__run_pipeline",
                json!({ "workspace": ws, "path": pipelines.join("demo.json") }),
            )
        } else {
            text_reply("HELLO")
        }
    }

    fn spawn_fake_llm(ws: PathBuf) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let ws = ws.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let header_end = loop {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while buf.len() < header_end + len {
                        let n = stream.read(&mut chunk).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let body: JsonValue =
                        serde_json::from_slice(&buf[header_end..]).unwrap_or(JsonValue::Null);
                    let payload = respond(&body, &ws);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
                    );
                });
            }
        });
        format!("http://{addr}/v1")
    }

    struct Events {
        seen: Arc<Mutex<Vec<AgentEvent>>>,
    }

    impl Events {
        fn wait_for(&self, what: &str, pred: impl Fn(&AgentEvent) -> bool) -> AgentEvent {
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                if let Some(e) = self.seen.lock().unwrap().iter().find(|e| pred(e)) {
                    return e.clone();
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {what}: {:#?}",
                    self.seen.lock().unwrap()
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        fn clear(&self) {
            self.seen.lock().unwrap().clear();
        }
    }

    fn start(backend: &mut PiBackend, cfg: &AgentConfig) -> Events {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        backend
            .start(cfg, Box::new(move |e| sink.lock().unwrap().push(e)))
            .expect("pi agent starts");
        Events { seen }
    }

    #[test]
    #[ignore = "downloads Node.js and Pi; set DUCKLE_AGENT_E2E_MCP"]
    fn pi_agent_end_to_end() {
        let mcp_bin = PathBuf::from(
            std::env::var("DUCKLE_AGENT_E2E_MCP")
                .expect("DUCKLE_AGENT_E2E_MCP=/path/to/duckle-mcp"),
        );
        let tmp_app = tempfile::tempdir().unwrap();
        let app_data = std::env::var("DUCKLE_AGENT_E2E_APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| tmp_app.path().to_path_buf());
        if !engine_manager::nodejs_installed(&app_data) {
            engine_manager::install_nodejs(&app_data, |_| {}).expect("install Node.js");
        }
        assert!(engine_manager::nodejs_installed(&app_data));
        if !engine_manager::pi_installed(&app_data) {
            engine_manager::install_pi(&app_data, |_| {}).expect("install Pi");
        }
        assert!(engine_manager::pi_installed(&app_data));

        let ws_dir = tempfile::tempdir().unwrap();
        let ws = ws_dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(ws.join("pipelines")).unwrap();
        let agent_dir = tempfile::tempdir().unwrap();
        let cfg = AgentConfig {
            workspace: ws.clone(),
            agent_dir: agent_dir.path().to_path_buf(),
            session_dir: agent_dir.path().join("sessions"),
            session_id: conversation_session_id("c-e2e-1").unwrap(),
            node_bin: engine_manager::nodejs_path(&app_data),
            pi_cli_js: engine_manager::pi_cli_js(&app_data),
            mcp_bin,
            llm: AgentLlm {
                provider: "duckle".into(),
                base_url: spawn_fake_llm(ws.clone()),
                model: "fake-model".into(),
                api_key: Some("sk-test".into()),
            },
        };
        write_pi_config(&cfg).unwrap();
        let ctx = ContextPayload {
            workspace: ws.to_string_lossy().into_owned(),
            connection: None,
            selected_assets: vec![],
        };

        let mut backend = PiBackend::new();
        let events = start(&mut backend, &cfg);
        events.wait_for("session_ready", |e| {
            matches!(e, AgentEvent::SessionReady { .. })
        });

        // 1. Delegation: the subagent process must reach the Duckle MCP tools.
        backend
            .send_prompt("please delegate the check", &ctx)
            .unwrap();
        events.wait_for("settled", |e| matches!(e, AgentEvent::Settled));
        let end = events.wait_for(
            "subagent tool end",
            |e| matches!(e, AgentEvent::ToolEnd { name, .. } if name == SUBAGENT_TOOL),
        );
        let AgentEvent::ToolEnd {
            result, is_error, ..
        } = end
        else {
            unreachable!()
        };
        let text = result.to_string();
        println!("subagent result: {text}");
        assert!(!is_error, "subagent failed: {text}");
        assert!(text.contains("CHILD_RESULT"), "{text}");
        assert!(
            !text.contains("not found") && !text.contains("Validation failed"),
            "{text}"
        );
        events.wait_for("subagent done", |e| {
            matches!(
                e,
                AgentEvent::Subagent {
                    status: SubagentStatus::Done,
                    ..
                }
            )
        });
        events.wait_for(
            "parent text",
            |e| matches!(e, AgentEvent::TextDelta { delta } if delta.contains("PARENT_DONE")),
        );

        // 2. Running a pipeline asks the user; a "no" blocks the tool.
        events.clear();
        backend.send_prompt("please run it", &ctx).unwrap();
        let request = events.wait_for(
            "confirm request",
            |e| matches!(e, AgentEvent::UiRequest { method, .. } if method == "confirm"),
        );
        let AgentEvent::UiRequest { id, title, .. } = request else {
            unreachable!()
        };
        assert_eq!(title.as_deref(), Some("运行 pipeline「demo」？"));
        backend.reply_ui(&id, UiReply::Confirmed(false)).unwrap();
        let end = events.wait_for("run tool end", |e| {
            matches!(e, AgentEvent::ToolEnd { name, .. } if name == "mcp__duckle__run_pipeline")
        });
        let AgentEvent::ToolEnd {
            result, is_error, ..
        } = end
        else {
            unreachable!()
        };
        assert!(
            is_error && result.to_string().contains("declined"),
            "{result}"
        );
        events.wait_for("settled", |e| matches!(e, AgentEvent::Settled));

        // 3. A restart restores the conversation without the context block.
        backend.stop().unwrap();
        let events = start(&mut backend, &cfg);
        let history = events.wait_for("history", |e| matches!(e, AgentEvent::HistoryLoaded { .. }));
        let AgentEvent::HistoryLoaded { messages } = history else {
            unreachable!()
        };
        assert!(
            messages
                .iter()
                .any(|m| m.role == "user" && m.text == "please delegate the check"),
            "{messages:#?}"
        );
        assert!(messages
            .iter()
            .any(|m| m.role == "assistant" && m.text.contains("PARENT_DONE")));
        backend.stop().unwrap();
    }
}
