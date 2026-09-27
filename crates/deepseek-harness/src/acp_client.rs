use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::event::HarnessEvent;

const ACP_PROTOCOL_VERSION: u32 = 1;
const ACP_MODEL_CONFIG_ID: &str = "model";
/// How long to wait for DSH to write a finished turn to its session log.
const SESSION_LOG_WAIT: Duration = Duration::from_millis(1500);
/// Upper bound for requests that do not run an agent turn (initialize,
/// session/new, set_config_option, ...).
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// `session/close` runs on drop, so a wedged DSH must not stall it.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });
/// Default for how long a `session/prompt` turn may go without DSH sending
/// anything at all. A turn only answers once every tool call has finished, so
/// the limit is on silence, not on the turn's total length. Generous because
/// a long-running tool (e.g. a pipeline run over bash) can be quiet for a while.
pub const DEFAULT_PROMPT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// After an idle timeout, how long DSH gets to honour `session/cancel` before
/// its process is stopped.
const CANCEL_GRACE: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 15 });
const IDLE_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct DshLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AcpModelOverride {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct AcpSelectedModel {
    pub provider: String,
    pub model: String,
}

impl DshLaunchSpec {
    pub fn new(command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
        }
    }
}

#[derive(Debug)]
pub struct AcpSession {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    state: Arc<ClientState>,
    remote_session_id: String,
    resumed: bool,
    selected_model: Mutex<Option<AcpSelectedModel>>,
    prompt_idle_timeout: Mutex<Option<Duration>>,
}

#[derive(Debug)]
struct ClientState {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<Value>>>>,
    prompt_sink: Mutex<Option<PromptSink>>,
    /// When DSH last wrote anything to stdout; drives the prompt idle timeout.
    last_activity: Mutex<Instant>,
    /// Set when Duckle stops DSH on purpose, so the resulting EOF is not
    /// reported to the turn as a second, misleading "process exited" error.
    stopping: AtomicBool,
}

impl ClientState {
    fn touch(&self) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
    }

    fn idle_for(&self) -> Duration {
        self.last_activity
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or_default()
    }

    fn forget_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }
}

#[derive(Debug)]
struct PromptSink {
    tx: mpsc::Sender<HarnessEvent>,
    tool_calls: HashMap<String, ToolCallMeta>,
}

#[derive(Debug, Clone)]
struct ToolCallMeta {
    name: String,
    arguments: Value,
}

impl AcpSession {
    pub fn start(
        launch: DshLaunchSpec,
        workspace: &Path,
        mcp_bin: &Path,
        model_override: Option<AcpModelOverride>,
    ) -> Result<Self> {
        Self::start_or_resume(launch, workspace, mcp_bin, model_override, None)
    }

    /// Like [`AcpSession::start`], but first tries ACP `session/resume` with
    /// `resume_session_id` so an earlier conversation keeps its agent-side
    /// context. When the agent refuses (unknown id, pruned session, no resume
    /// capability) it falls back to `session/new`; [`AcpSession::resumed`]
    /// reports which one happened.
    pub fn start_or_resume(
        launch: DshLaunchSpec,
        workspace: &Path,
        mcp_bin: &Path,
        model_override: Option<AcpModelOverride>,
        resume_session_id: Option<&str>,
    ) -> Result<Self> {
        let mut cmd = Command::new(&launch.command);
        cmd.args(&launch.args)
            .arg("--profile")
            .arg("acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd.spawn().map_err(|e| {
            Error::Transport(format!("spawn {} --profile acp: {e}", launch.command))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Transport("dsh ACP stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Transport("dsh ACP stdout unavailable".into()))?;

        let stdin = Arc::new(Mutex::new(stdin));
        let state = Arc::new(ClientState {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            prompt_sink: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            stopping: AtomicBool::new(false),
        });
        spawn_reader_thread(Arc::clone(&state), Arc::clone(&stdin), stdout);

        let mut session = Self {
            child: Mutex::new(child),
            stdin,
            state,
            remote_session_id: String::new(),
            resumed: false,
            selected_model: Mutex::new(None),
            prompt_idle_timeout: Mutex::new(Some(DEFAULT_PROMPT_IDLE_TIMEOUT)),
        };

        let init = session.request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {},
            }),
        )?;

        let mcp_servers = json!([
            {
                "name": "duckle",
                "command": mcp_bin.to_string_lossy(),
                "args": ["--workspace", workspace.to_string_lossy()],
                "env": [],
            }
        ]);

        let resume_id = resume_session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .filter(|_| supports_resume(&init));
        let resumed = resume_id.and_then(|id| {
            session
                .request(
                    "session/resume",
                    json!({
                        "sessionId": id,
                        "cwd": workspace.to_string_lossy(),
                        "mcpServers": mcp_servers.clone(),
                    }),
                )
                .ok()
                .map(|remote| (id.to_string(), remote))
        });

        let (remote_session_id, remote) = match resumed {
            Some(pair) => {
                session.resumed = true;
                pair
            }
            None => {
                let remote = session.request(
                    "session/new",
                    json!({
                        "cwd": workspace.to_string_lossy(),
                        "mcpServers": mcp_servers,
                    }),
                )?;
                let id = remote
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        Error::Transport("ACP session/new returned no sessionId".into())
                    })?
                    .to_string();
                (id, remote)
            }
        };
        session.remote_session_id = remote_session_id;
        session.capture_selected_model(&remote);
        if let Some(model_override) = model_override {
            session.set_model(model_override)?;
        }
        Ok(session)
    }

    pub fn prompt(
        &self,
        prompt: &str,
        mut on_event: impl FnMut(HarnessEvent) + Send + 'static,
    ) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        {
            let mut guard = self
                .state
                .prompt_sink
                .lock()
                .map_err(|_| Error::Transport("prompt sink poisoned".into()))?;
            if guard.is_some() {
                return Err(Error::Transport(
                    "an ACP prompt is already in flight".into(),
                ));
            }
            *guard = Some(PromptSink {
                tx,
                tool_calls: HashMap::new(),
            });
        }

        let relay = thread::spawn(move || {
            while let Ok(evt) = rx.recv() {
                on_event(evt);
            }
        });

        let idle_timeout = self.prompt_idle_timeout.lock().ok().and_then(|t| *t);
        self.state.touch();
        let request_result = self
            .send_request(
                "session/prompt",
                json!({
                    "sessionId": self.remote_session_id,
                    "prompt": [
                        {
                            "type": "text",
                            "text": prompt,
                        }
                    ],
                }),
            )
            .and_then(|(id, rx)| self.await_prompt(id, &rx, idle_timeout));

        match &request_result {
            Ok(resp) => {
                // DSH answers with a bare stopReason, so fall back to its own
                // session log for the turn's real consumption.
                let usage = parse_usage(resp).or_else(|| {
                    crate::session_log::turn_usage_for_session(
                        &self.remote_session_id,
                        SESSION_LOG_WAIT,
                    )
                    .map(|u| HarnessEvent::Usage {
                        input_tokens: Some(u.input_tokens),
                        output_tokens: Some(u.output_tokens),
                        total_tokens: Some(u.total_tokens),
                        cache_read_tokens: u.cache_read_tokens,
                        model_calls: Some(u.model_calls),
                    })
                });
                if let Some(usage) = usage {
                    on_send_prompt_event(&self.state, usage);
                }
                let reason = resp
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .to_string();
                on_send_prompt_event(&self.state, HarnessEvent::Done { reason });
            }
            Err(err) => {
                on_send_prompt_event(
                    &self.state,
                    HarnessEvent::Error {
                        message: err.to_string(),
                    },
                );
            }
        }

        {
            let mut guard = self
                .state
                .prompt_sink
                .lock()
                .map_err(|_| Error::Transport("prompt sink poisoned".into()))?;
            *guard = None;
        }
        let _ = relay.join();

        request_result.map(|_| ())
    }

    pub fn cancel(&self) -> Result<()> {
        self.notify(
            "session/cancel",
            json!({
                "sessionId": self.remote_session_id,
            }),
        )
    }

    pub fn close(&self) -> Result<()> {
        let _ = self.request_with_timeout(
            "session/close",
            json!({
                "sessionId": self.remote_session_id,
            }),
            CLOSE_TIMEOUT,
        );
        Ok(())
    }

    pub fn set_model(&self, model_override: AcpModelOverride) -> Result<()> {
        let value = serde_json::to_string(&vec![model_override.provider, model_override.model])
            .map_err(|e| Error::Json(e.to_string()))?;
        let result = self.request(
            "session/set_config_option",
            json!({
                "sessionId": self.remote_session_id,
                "configId": ACP_MODEL_CONFIG_ID,
                "value": value,
            }),
        )?;
        self.capture_selected_model(&result);
        Ok(())
    }

    pub fn selected_model(&self) -> Option<AcpSelectedModel> {
        self.selected_model.lock().ok().and_then(|m| m.clone())
    }

    /// The agent-side session id; persist it to resume the conversation later.
    pub fn remote_session_id(&self) -> &str {
        &self.remote_session_id
    }

    /// True when this session continued an earlier one via `session/resume`.
    pub fn resumed(&self) -> bool {
        self.resumed
    }

    /// True while a `session/prompt` turn is in flight.
    pub fn is_busy(&self) -> bool {
        self.state
            .prompt_sink
            .lock()
            .map(|sink| sink.is_some())
            .unwrap_or(true)
    }

    /// False once the DSH process has exited (or was stopped after a turn
    /// went silent), meaning this session can no longer take prompts.
    pub fn is_alive(&self) -> bool {
        self.child
            .lock()
            .map(|mut child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false)
    }

    /// How long a `session/prompt` turn may go without any message from DSH
    /// before it is cancelled. `None` waits indefinitely (DSH exiting still
    /// ends the turn). Defaults to [`DEFAULT_PROMPT_IDLE_TIMEOUT`].
    pub fn set_prompt_idle_timeout(&self, timeout: Option<Duration>) {
        if let Ok(mut current) = self.prompt_idle_timeout.lock() {
            *current = timeout.filter(|t| !t.is_zero());
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, CONTROL_REQUEST_TIMEOUT)
    }

    fn request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let (id, rx) = self.send_request(method, params)?;
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.state.forget_pending(id);
                Err(Error::Timeout(format!(
                    "ACP request timed out after {}s: {method}",
                    timeout.as_secs()
                )))
            }
        }
    }

    fn send_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(u64, mpsc::Receiver<Result<Value>>)> {
        let id = self.state.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        self.state
            .pending
            .lock()
            .map_err(|_| Error::Transport("pending map poisoned".into()))?
            .insert(id, tx);

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        if let Err(e) = self.write_json(&req) {
            self.state.forget_pending(id);
            return Err(e);
        }
        Ok((id, rx))
    }

    /// Wait for a `session/prompt` answer for as long as DSH keeps talking;
    /// only `idle_timeout` of total silence abandons the turn.
    fn await_prompt(
        &self,
        id: u64,
        rx: &mpsc::Receiver<Result<Value>>,
        idle_timeout: Option<Duration>,
    ) -> Result<Value> {
        loop {
            match rx.recv_timeout(IDLE_POLL) {
                Ok(result) => return result,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Error::Transport("ACP response channel closed".into()));
                }
                Err(RecvTimeoutError::Timeout) => {
                    let Some(limit) = idle_timeout else { continue };
                    if self.state.idle_for() >= limit {
                        return Err(self.abandon_prompt(id, rx, limit));
                    }
                }
            }
        }
    }

    /// Cancel a silent turn so DSH does not keep working unseen, and stop the
    /// process if it does not acknowledge the cancel.
    fn abandon_prompt(
        &self,
        id: u64,
        rx: &mpsc::Receiver<Result<Value>>,
        limit: Duration,
    ) -> Error {
        let acknowledged = self.cancel().is_ok() && rx.recv_timeout(CANCEL_GRACE).is_ok();
        self.state.forget_pending(id);
        let outcome = if acknowledged {
            "the turn was cancelled"
        } else {
            self.stop_process();
            "DSH did not respond to cancel and was stopped"
        };
        Error::Timeout(format!(
            "session/prompt idle timeout: no activity from DSH for {}s; {outcome}",
            limit.as_secs()
        ))
    }

    fn stop_process(&self) {
        self.state.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write_json(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write_json(&self, value: &Value) -> Result<()> {
        let mut writer = self
            .stdin
            .lock()
            .map_err(|_| Error::Transport("ACP stdin poisoned".into()))?;
        writeln!(writer, "{value}")
            .map_err(|e| Error::Transport(format!("write ACP request: {e}")))?;
        writer
            .flush()
            .map_err(|e| Error::Transport(format!("flush ACP request: {e}")))
    }

    fn capture_selected_model(&self, result: &Value) {
        let Some(route) = parse_selected_model(result) else {
            return;
        };
        if let Ok(mut selected) = self.selected_model.lock() {
            *selected = Some(route);
        }
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        if self.is_alive() {
            let _ = self.close();
        }
        self.stop_process();
    }
}

fn spawn_reader_thread(
    state: Arc<ClientState>,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: ChildStdout,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            let read = match reader.read_line(&mut line) {
                Ok(n) => n,
                Err(e) => {
                    fail_all_pending(&state, Error::Transport(format!("read ACP output: {e}")));
                    return;
                }
            };
            if read == 0 {
                fail_all_pending(&state, Error::Transport("ACP process exited".into()));
                return;
            }
            state.touch();
            let msg: Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                if msg.get("method").is_some() {
                    if let Err(e) = handle_server_request(&stdin, &msg, id) {
                        fail_all_pending(&state, e);
                        return;
                    }
                    continue;
                }
                fulfill_pending(&state, id, msg);
                continue;
            }
            handle_server_notification(&state, &msg);
        }
    });
}

fn handle_server_request(stdin: &Arc<Mutex<ChildStdin>>, msg: &Value, id: u64) -> Result<()> {
    match msg.get("method").and_then(Value::as_str) {
        Some("session/request_permission") => {
            let options = msg
                .pointer("/params/options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let allow = options.iter().find(|opt| {
                matches!(
                    opt.get("kind").and_then(Value::as_str),
                    Some("allow_once") | Some("allow_always")
                )
            });
            let result = if let Some(option) = allow {
                json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": option.get("optionId").and_then(Value::as_str).unwrap_or("allow-once"),
                    }
                })
            } else {
                json!({
                    "outcome": {
                        "outcome": "cancelled",
                    }
                })
            };
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            });
            let mut writer = stdin
                .lock()
                .map_err(|_| Error::Transport("ACP stdin poisoned".into()))?;
            writeln!(writer, "{response}")
                .map_err(|e| Error::Transport(format!("write ACP permission response: {e}")))?;
            writer
                .flush()
                .map_err(|e| Error::Transport(format!("flush ACP permission response: {e}")))?;
        }
        Some(other) => {
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("unsupported method: {other}"),
                },
            });
            let mut writer = stdin
                .lock()
                .map_err(|_| Error::Transport("ACP stdin poisoned".into()))?;
            writeln!(writer, "{response}")
                .map_err(|e| Error::Transport(format!("write ACP error response: {e}")))?;
            writer
                .flush()
                .map_err(|e| Error::Transport(format!("flush ACP error response: {e}")))?;
        }
        None => {}
    }
    Ok(())
}

fn handle_server_notification(state: &Arc<ClientState>, msg: &Value) {
    if msg.get("method").and_then(Value::as_str) != Some("session/update") {
        return;
    }
    let Some(update) = msg
        .pointer("/params/event")
        .or_else(|| msg.pointer("/params/update"))
    else {
        return;
    };
    let kind = update
        .get("type")
        .or_else(|| update.get("sessionUpdate"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update
                .pointer("/delta/text")
                .or_else(|| update.pointer("/content/text"))
                .and_then(Value::as_str)
            {
                on_send_prompt_event(
                    state,
                    HarnessEvent::Token {
                        text: text.to_string(),
                    },
                );
            }
        }
        "tool_call" => {
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let arguments = update.get("rawInput").cloned().unwrap_or(Value::Null);
            if let Ok(mut guard) = state.prompt_sink.lock() {
                if let Some(sink) = guard.as_mut() {
                    sink.tool_calls.insert(
                        id.clone(),
                        ToolCallMeta {
                            name: name.clone(),
                            arguments: arguments.clone(),
                        },
                    );
                    let _ = sink.tx.send(HarnessEvent::ToolCallStart {
                        id,
                        name,
                        arguments,
                    });
                }
            }
        }
        "tool_call_update" => {
            let id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let ok = update.get("status").and_then(Value::as_str) != Some("failed");
            let content = tool_result_payload(update.get("content"));
            let mut pipeline_evt = None;
            if let Ok(mut guard) = state.prompt_sink.lock() {
                if let Some(sink) = guard.as_mut() {
                    let meta = sink.tool_calls.get(&id).cloned();
                    let _ = sink.tx.send(HarnessEvent::ToolCallEnd {
                        id: id.clone(),
                        ok,
                        content: content.clone(),
                    });
                    if let Some(meta) = meta {
                        pipeline_evt = pipeline_event_from_tool(&meta, &content);
                    }
                }
            }
            if let Some(evt) = pipeline_evt {
                on_send_prompt_event(state, evt);
            }
            if let Some(request) = content.get("needsCredentials").filter(|v| v.is_object()) {
                on_send_prompt_event(
                    state,
                    HarnessEvent::CredentialsRequired {
                        request: request.clone(),
                    },
                );
            }
        }
        _ => {
            if kind.contains("usage") {
                if let Some(usage) = parse_usage(update) {
                    on_send_prompt_event(state, usage);
                }
            }
        }
    }
}

fn pipeline_event_from_tool(meta: &ToolCallMeta, content: &Value) -> Option<HarnessEvent> {
    let action = match meta.name.as_str() {
        "create_pipeline" => "created",
        "update_pipeline" => "updated",
        _ => return None,
    };
    if let Some(id) = content.get("id").and_then(Value::as_str) {
        return Some(HarnessEvent::PipelinePersisted {
            id: id.to_string(),
            action: action.to_string(),
        });
    }
    if let Some(id) = meta.arguments.get("id").and_then(Value::as_str) {
        return Some(HarnessEvent::PipelinePersisted {
            id: id.to_string(),
            action: action.to_string(),
        });
    }
    meta.arguments
        .get("path")
        .and_then(Value::as_str)
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .map(|id| HarnessEvent::PipelinePersisted {
            id: id.to_string(),
            action: action.to_string(),
        })
}

fn tool_result_payload(content: Option<&Value>) -> Value {
    let blocks = content
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let texts: Vec<String> = blocks
        .iter()
        .filter_map(|entry| entry.pointer("/content/text").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    if texts.is_empty() {
        return Value::Array(blocks);
    }
    if texts.len() == 1 {
        let first = texts[0].trim();
        if let Ok(parsed) = serde_json::from_str(first) {
            return parsed;
        }
        return Value::String(texts[0].clone());
    }
    Value::Array(texts.into_iter().map(Value::String).collect())
}

fn on_send_prompt_event(state: &Arc<ClientState>, event: HarnessEvent) {
    if let Ok(guard) = state.prompt_sink.lock() {
        if let Some(sink) = guard.as_ref() {
            let _ = sink.tx.send(event);
        }
    }
}

fn fulfill_pending(state: &Arc<ClientState>, id: u64, msg: Value) {
    let tx = state
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    if let Some(tx) = tx {
        let result = if let Some(error) = msg.get("error") {
            Err(Error::Transport(error.to_string()))
        } else {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = tx.send(result);
    }
}

fn fail_all_pending(state: &Arc<ClientState>, error: Error) {
    if let Ok(mut pending) = state.pending.lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(Error::Transport(error.to_string())));
        }
    }
    if state.stopping.load(Ordering::SeqCst) {
        return;
    }
    on_send_prompt_event(
        state,
        HarnessEvent::Error {
            message: error.to_string(),
        },
    );
}

fn parse_usage(value: &Value) -> Option<HarnessEvent> {
    // ACP has shipped usage under a few shapes, so accept the common nestings
    // rather than pinning one and silently reporting no tokens.
    let usage = value
        .get("usage")
        .or_else(|| value.get("tokenUsage"))
        .or_else(|| value.pointer("/meta/usage"))
        .unwrap_or(value);
    let input = read_token_count(usage, &["inputTokens", "input_tokens", "promptTokens"]);
    let output = read_token_count(
        usage,
        &["outputTokens", "output_tokens", "completionTokens"],
    );
    let total = read_token_count(usage, &["totalTokens", "total_tokens"]).or_else(|| {
        match (input, output) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        }
    });
    if input.is_none() && output.is_none() && total.is_none() {
        return None;
    }
    Some(HarnessEvent::Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cache_read_tokens: read_token_count(usage, &["cacheReadTokens", "cachedReadTokens", "cache_read_tokens"]),
        model_calls: None,
    })
}

fn read_token_count(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_u64)
}

/// Whether the agent's `initialize` result advertises ACP `session/resume`.
fn supports_resume(init: &Value) -> bool {
    init.pointer("/agentCapabilities/sessionCapabilities/resume")
        .is_some_and(|v| !v.is_null())
}

fn parse_selected_model(result: &Value) -> Option<AcpSelectedModel> {
    let options = result.get("configOptions")?.as_array()?;
    let model_option = options
        .iter()
        .find(|opt| opt.get("id").and_then(Value::as_str) == Some(ACP_MODEL_CONFIG_ID))?;
    let current = model_option.get("currentValue")?.as_str()?;
    let parsed: Vec<String> = serde_json::from_str(current).ok()?;
    let [provider, model]: [String; 2] = parsed.try_into().ok()?;
    Some(AcpSelectedModel { provider, model })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_text_from_modern_event_shape() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "event": {
                    "type": "agent_message_chunk",
                    "content": { "text": "Hello world" },
                    "delta": { "text": "world" }
                }
            }
        });

        let update = msg.pointer("/params/event").unwrap();
        let kind = update
            .get("type")
            .or_else(|| update.get("sessionUpdate"))
            .and_then(Value::as_str);
        let text = update
            .pointer("/delta/text")
            .or_else(|| update.pointer("/content/text"))
            .and_then(Value::as_str);

        assert_eq!(kind, Some("agent_message_chunk"));
        assert_eq!(text, Some("world"));
    }

    #[test]
    fn parses_stream_text_from_legacy_update_shape() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "Hello" }
                }
            }
        });

        let update = msg
            .pointer("/params/event")
            .or_else(|| msg.pointer("/params/update"));
        let kind = update
            .and_then(|u| u.get("type").or_else(|| u.get("sessionUpdate")))
            .and_then(Value::as_str);
        let text = update
            .and_then(|u| {
                u.pointer("/delta/text")
                    .or_else(|| u.pointer("/content/text"))
            })
            .and_then(Value::as_str);

        assert_eq!(kind, Some("agent_message_chunk"));
        assert_eq!(text, Some("Hello"));
    }

    #[test]
    fn parses_usage_from_nested_shape() {
        let resp = json!({
            "stopReason": "end_turn",
            "usage": { "inputTokens": 1200, "outputTokens": 340 }
        });

        match parse_usage(&resp) {
            Some(HarnessEvent::Usage {
                input_tokens,
                output_tokens,
                total_tokens,
                ..
            }) => {
                assert_eq!(input_tokens, Some(1200));
                assert_eq!(output_tokens, Some(340));
                assert_eq!(total_tokens, Some(1540));
            }
            other => panic!("expected usage event, got {other:?}"),
        }
    }

    #[test]
    fn ignores_payloads_without_usage() {
        assert!(parse_usage(&json!({ "stopReason": "end_turn" })).is_none());
    }

    #[test]
    fn detects_resume_capability() {
        let dsh = json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
            }
        });
        assert!(supports_resume(&dsh));
        assert!(!supports_resume(&json!({ "agentCapabilities": {} })));
        assert!(!supports_resume(&json!({
            "agentCapabilities": { "sessionCapabilities": { "resume": null } }
        })));
    }
    /// A stand-in for `dsh --profile acp`: answers initialize and session/new,
    /// then runs `turn` once the prompt arrives.
    #[cfg(unix)]
    fn fake_dsh(turn: &str) -> AcpSession {
        let script = format!(
            "read l; echo '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":1}}}}'\n\
             read l; echo '{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"sessionId\":\"fake\"}}}}'\n\
             read l\n\
             {turn}\n"
        );
        AcpSession::start(
            DshLaunchSpec::new("sh", vec!["-c".into(), script]),
            Path::new("."),
            Path::new("duckle-mcp"),
            None,
        )
        .expect("fake DSH handshake")
    }

    #[cfg(unix)]
    const ANSWER_CLOSE: &str =
        "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}'; exec cat >/dev/null";

    #[cfg(unix)]
    fn run_prompt(session: &AcpSession) -> (Result<()>, Vec<HarnessEvent>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let result = session.prompt("hi", move |evt| sink.lock().unwrap().push(evt));
        let events = events.lock().unwrap().clone();
        (result, events)
    }

    #[cfg(unix)]
    fn errors(events: &[HarnessEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                HarnessEvent::Error { message } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    /// A turn used to be abandoned after a fixed 10 minutes even while DSH was
    /// still streaming progress, so long agent runs "failed" yet kept going.
    #[cfg(unix)]
    #[test]
    fn a_turn_that_keeps_streaming_outlives_the_idle_timeout() {
        let turn = format!(
            "for i in 1 2 3 4 5 6; do echo '{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"text\":\"x\"}}}}}}}}'; sleep 0.4; done\n\
             echo '{{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{{\"stopReason\":\"end_turn\"}}}}'\n\
             {ANSWER_CLOSE}"
        );
        let session = fake_dsh(&turn);
        session.set_prompt_idle_timeout(Some(Duration::from_secs(1)));
        let (result, events) = run_prompt(&session);
        assert!(result.is_ok(), "streaming turn failed: {result:?}");
        assert!(errors(&events).is_empty(), "{events:?}");
        assert!(events
            .iter()
            .any(|e| matches!(e, HarnessEvent::Done { reason } if reason == "end_turn")));
        assert!(session.is_alive());
    }

    /// A silent turn is cancelled so DSH does not keep working unseen.
    #[cfg(unix)]
    #[test]
    fn a_silent_turn_is_cancelled_after_the_idle_timeout() {
        let turn = format!(
            "read cancel; echo '{{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{{\"stopReason\":\"cancelled\"}}}}'\n\
             {ANSWER_CLOSE}"
        );
        let session = fake_dsh(&turn);
        session.set_prompt_idle_timeout(Some(Duration::from_secs(1)));
        let (result, events) = run_prompt(&session);
        let err = result.expect_err("silent turn should time out").to_string();
        assert!(err.starts_with("timeout: session/prompt idle timeout"), "{err}");
        assert!(err.contains("the turn was cancelled"), "{err}");
        assert_eq!(errors(&events), vec![err]);
        assert!(session.is_alive());
        assert!(!session.is_busy());
    }

    /// When DSH ignores the cancel it is stopped, and the stop is not reported
    /// as a second "process exited" error.
    #[cfg(unix)]
    #[test]
    fn dsh_that_ignores_cancel_is_stopped() {
        let session = fake_dsh("exec sleep 30");
        session.set_prompt_idle_timeout(Some(Duration::from_secs(1)));
        let (result, events) = run_prompt(&session);
        let err = result.expect_err("silent turn should time out").to_string();
        assert!(err.contains("was stopped"), "{err}");
        assert_eq!(errors(&events), vec![err]);
        assert!(!session.is_alive());
    }

    #[cfg(unix)]
    #[test]
    fn zero_idle_timeout_means_no_limit() {
        let session = fake_dsh("echo '{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}'; exec cat >/dev/null");
        session.set_prompt_idle_timeout(Some(Duration::ZERO));
        assert_eq!(*session.prompt_idle_timeout.lock().unwrap(), None);
        session.set_prompt_idle_timeout(Some(Duration::from_secs(90)));
        assert_eq!(
            *session.prompt_idle_timeout.lock().unwrap(),
            Some(Duration::from_secs(90))
        );
    }
}
