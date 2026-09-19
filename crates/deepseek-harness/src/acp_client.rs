use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::event::HarnessEvent;

const ACP_PROTOCOL_VERSION: u32 = 1;
const ACP_MODEL_CONFIG_ID: &str = "model";

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
    selected_model: Mutex<Option<AcpSelectedModel>>,
}

#[derive(Debug)]
struct ClientState {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<Value>>>>,
    prompt_sink: Mutex<Option<PromptSink>>,
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
        });
        spawn_reader_thread(Arc::clone(&state), Arc::clone(&stdin), stdout);

        let mut session = Self {
            child: Mutex::new(child),
            stdin,
            state,
            remote_session_id: String::new(),
            selected_model: Mutex::new(None),
        };

        session.request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {},
            }),
        )?;

        let remote = session.request(
            "session/new",
            json!({
                "cwd": workspace.to_string_lossy(),
                "mcpServers": [
                    {
                        "name": "duckle",
                        "command": mcp_bin.to_string_lossy(),
                        "args": ["--workspace", workspace.to_string_lossy()],
                        "env": [],
                    }
                ],
            }),
        )?;
        let remote_session_id = remote
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Transport("ACP session/new returned no sessionId".into()))?
            .to_string();
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

        let request_result = self.request(
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
        );

        match &request_result {
            Ok(resp) => {
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
        let _ = self.request(
            "session/close",
            json!({
                "sessionId": self.remote_session_id,
            }),
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

    fn request(&self, method: &str, params: Value) -> Result<Value> {
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
            let _ = self.state.pending.lock().map(|mut p| p.remove(&id));
            return Err(e);
        }

        rx.recv_timeout(Duration::from_secs(600))
            .map_err(|_| Error::Transport(format!("ACP request timed out: {method}")))?
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
        let _ = self.close();
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
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
    let update = msg
        .pointer("/params/update")
        .cloned()
        .unwrap_or(Value::Null);
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
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
        }
        _ => {}
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
    on_send_prompt_event(
        state,
        HarnessEvent::Error {
            message: error.to_string(),
        },
    );
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
