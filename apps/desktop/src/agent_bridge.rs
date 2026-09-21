use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use deepseek_harness::{AcpModelOverride, AcpSession, DshLaunchSpec, HarnessEvent};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::app_settings::AiProviderConfig;
use crate::llama_chat::ChatEvent;

struct SessionEntry {
    fingerprint: String,
    session: Arc<AcpSession>,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, SessionEntry>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, SessionEntry>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn prompt(
    app: tauri::AppHandle,
    session_id: String,
    prompt: String,
    workspace: String,
    cfg: AiProviderConfig,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let workspace_path = PathBuf::from(&workspace);
        let mcp_bin = resolve_mcp_bin(&app_data)?;
        let launch = resolve_dsh_launch(cfg.harness_command.as_deref())?;
        let model_override = harness_model_override(&cfg)?;
        let fingerprint = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            workspace_path.display(),
            launch.command,
            launch.args.join("\u{1f}"),
            mcp_bin.display(),
            cfg.harness_provider.as_deref().unwrap_or(""),
            cfg.harness_model.as_deref().unwrap_or("")
        );

        let session = get_or_create_session(
            &session_id,
            &fingerprint,
            &launch,
            &workspace_path,
            &mcp_bin,
            model_override,
        )?;
        if let Some(route) = session.selected_model() {
            let _ = on_event.send(ChatEvent::ModelSelected {
                provider: route.provider,
                model: route.model,
            });
        }
        let message = duckie_prompt(&workspace_path, &prompt);
        session
            .prompt(&message, move |evt| {
                if let Some(mapped) = map_event(evt) {
                    let _ = on_event.send(mapped);
                }
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn get_or_create_session(
    session_id: &str,
    fingerprint: &str,
    launch: &DshLaunchSpec,
    workspace: &Path,
    mcp_bin: &Path,
    model_override: Option<AcpModelOverride>,
) -> Result<Arc<AcpSession>, String> {
    let mut guard = sessions()
        .lock()
        .map_err(|_| "session registry poisoned".to_string())?;
    if let Some(existing) = guard.get(session_id) {
        if existing.fingerprint == fingerprint {
            return Ok(Arc::clone(&existing.session));
        }
    }
    let session = Arc::new(
        AcpSession::start(launch.clone(), workspace, mcp_bin, model_override)
            .map_err(|e| e.to_string())?,
    );
    guard.insert(
        session_id.to_string(),
        SessionEntry {
            fingerprint: fingerprint.to_string(),
            session: Arc::clone(&session),
        },
    );
    Ok(session)
}

fn resolve_mcp_bin(app_data: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DUCKLE_MCP_BIN") {
        return Ok(PathBuf::from(path));
    }
    crate::stage_mcp(app_data).map(|(mcp, _runner)| mcp)
}

fn resolve_dsh_launch(command_override: Option<&str>) -> Result<DshLaunchSpec, String> {
    if let Some(cmd) = command_override.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(launch_from_command(cmd));
    }

    if let Some(home) = std::env::var_os("HOME") {
        let script = PathBuf::from(home)
            .join(".dsh")
            .join("profiles")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if script.exists() {
            return Ok(DshLaunchSpec::new(
                "node",
                vec![script.to_string_lossy().into_owned()],
            ));
        }
    }

    let homebrew = PathBuf::from("/opt/homebrew/bin/dsh");
    if homebrew.exists() {
        return Ok(DshLaunchSpec::new(
            homebrew.to_string_lossy().into_owned(),
            vec![],
        ));
    }

    Ok(DshLaunchSpec::new("dsh", vec![]))
}

fn launch_from_command(command: &str) -> DshLaunchSpec {
    if command.ends_with(".js") {
        return DshLaunchSpec::new("node", vec![command.to_string()]);
    }
    DshLaunchSpec::new(command.to_string(), vec![])
}

fn harness_model_override(cfg: &AiProviderConfig) -> Result<Option<AcpModelOverride>, String> {
    match (
        cfg.harness_provider
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        cfg.harness_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        (None, None) => Ok(None),
        (Some(provider), Some(model)) => Ok(Some(AcpModelOverride {
            provider: provider.to_string(),
            model: model.to_string(),
        })),
        _ => Err("DeepSeek Harness override requires both provider and model".into()),
    }
}

fn duckie_prompt(workspace: &Path, user_prompt: &str) -> String {
    format!(
        "You are Duckie, the AI assistant inside Duckle.\n\
Use the attached Duckle MCP tools instead of inventing pipeline JSON.\n\
When the user wants a new pipeline, call create_pipeline with the workspace path so Duckle writes pipelines/<id>.json and registers it in repository.json.\n\
When the user wants to change an existing pipeline, call update_pipeline so the on-disk file stays authoritative.\n\
Prefer list_components and get_component_schema before writing a pipeline when you are not certain about component ids or required properties.\n\
Reply with a short summary after tool work completes.\n\
Workspace: {}\n\n\
User request:\n{}",
        workspace.display(),
        user_prompt
    )
}

fn map_event(evt: HarnessEvent) -> Option<ChatEvent> {
    Some(match evt {
        HarnessEvent::Token { text } => ChatEvent::Token { text },
        HarnessEvent::ToolCallStart {
            id,
            name,
            arguments,
        } => ChatEvent::ToolCallStart {
            id,
            name,
            arguments,
        },
        HarnessEvent::ToolCallEnd { id, ok, content } => ChatEvent::ToolCallEnd { id, ok, content },
        HarnessEvent::ModelSelected { provider, model } => {
            ChatEvent::ModelSelected { provider, model }
        }
        HarnessEvent::Usage {
            input_tokens,
            output_tokens,
            total_tokens,
        } => ChatEvent::Usage {
            input_tokens,
            output_tokens,
            total_tokens,
        },
        HarnessEvent::PipelinePersisted { id, action } => {
            ChatEvent::PipelinePersisted { id, action }
        }
        HarnessEvent::Done { reason } => ChatEvent::Done {
            reason: Some(reason),
        },
        HarnessEvent::Error { message } => ChatEvent::Error {
            message: humanize_dsh_error(&message),
        },
        HarnessEvent::TurnStart { .. } => return None,
    })
}

fn humanize_dsh_error(message: &str) -> String {
    if message.contains("Insufficient Balance") {
        return "DeepSeek Harness 当前选中的模型账户余额或额度不足。请在设置里检查 DSH provider/model 是否正确，或为对应供应商账户充值后重试。".into();
    }
    if message.contains("unknown model option") {
        return "当前填写的 DSH provider/model 在 ACP 会话里不可用。请检查设置中的 provider 和 model 是否与本机 DSH 配置完全一致。".into();
    }
    if message.contains("requires both provider and model") {
        return "DeepSeek Harness 的 provider 和 model 需要同时填写，或同时留空。".into();
    }
    if message.contains("spawn") && message.contains("dsh") {
        return "无法启动 DeepSeek Harness。请检查 DSH 是否已安装，或在设置里填写正确的 DSH 命令路径。".into();
    }
    if message.contains("protocolVersion") {
        return "DeepSeek Harness ACP 握手失败：协议版本不匹配。请重启 Duckle，并确认当前代码已经更新到最新版本。".into();
    }
    if message.contains("session/new returned no sessionId") {
        return "DeepSeek Harness 已启动，但未能创建 ACP 会话。请检查 DSH profile 与本地环境配置。"
            .into();
    }
    if message.contains("session/set_config_option") {
        return format!(
            "DeepSeek Harness 已启动，但切换到指定 provider/model 失败。请检查设置里的 provider/model 是否可用。\n\n原始错误：{}",
            message
        );
    }
    if message.starts_with("transport: ") {
        return format!(
            "DeepSeek Harness 传输层返回了一个错误。请检查 DSH 日志、provider/model 配置和账户状态。\n\n原始错误：{}",
            message
        );
    }
    message.to_string()
}
