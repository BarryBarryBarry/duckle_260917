# duckle-deepseek-harness

A streaming agent harness for Duckle's DeepSeek integration.

Wires three pieces together:

1. **`DeepSeekClient`** — SSE streaming client for the OpenAI-compatible
   `https://api.deepseek.com/v1/chat/completions` endpoint (tool-calling +
   token streaming).
2. **`McpClient`** — spawns the workspace's `duckle-mcp` binary and speaks
   newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
3. **`AgentLoop`** — multi-round loop: `user → LLM (stream) → tool_calls →
   MCP → LLM …`. Emits one `HarnessEvent` per token, tool call, tool result,
   and terminal state.

## Quick sketch

```rust
use std::path::PathBuf;
use std::sync::Arc;
use deepseek_harness::{AgentLoop, DeepSeekClient, McpClient, HarnessEvent};

let api_key = std::env::var("DEEPSEEK_API_KEY")?;
let mcp_bin = PathBuf::from("/path/to/duckle-mcp");
let workspace = PathBuf::from("/path/to/workspace");

let mcp = Arc::new(McpClient::spawn_with_workspace(&mcp_bin, &workspace)?);
let llm = DeepSeekClient::new(api_key).with_model("deepseek-chat");
let agent = AgentLoop::new(llm, mcp).with_max_rounds(6);

agent.run("Build a pipeline that reads sales.csv and writes top_customers.csv.", |evt| {
    match evt {
        HarnessEvent::Token { text } => print!("{text}"),
        HarnessEvent::ToolCallStart { name, .. } => println!("\n[tool] {name}"),
        HarnessEvent::ToolCallEnd { ok, .. } => println!("[tool] ok={ok}"),
        HarnessEvent::Done { reason } => println!("\n[done: {reason}]"),
        _ => {}
    }
})?;
```

## Integrating with the Tauri desktop shell

See `apps/desktop/src/agent_bridge.rs` for a working `#[tauri::command]`
that wraps `AgentLoop::run` inside `tokio::task::spawn_blocking` and
forwards `HarnessEvent`s to the frontend over a `Channel<HarnessEvent>`.
