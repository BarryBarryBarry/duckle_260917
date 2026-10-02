// Duckle bridge for the embedded Pi Agent. Written into the Duckle-owned Pi
// agent directory (PI_CODING_AGENT_DIR) on every agent start; edits there are
// overwritten.
//
// - `duckle_subagent` delegates a task to a definition in <agent-dir>/agents/.
//   Each delegation runs a separate `pi --mode json` process, like Pi's own
//   subagent example. In-process subagent packages start their child sessions
//   without the MCP servers, so the Duckle tools were missing there.
// - `mcp__duckle__run_pipeline` asks the user first. A subagent has no UI, so
//   it cannot run pipelines; it is told to leave that to the main agent.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEPTH = Number(process.env.DUCKLE_SUBAGENT_DEPTH ?? "0") || 0;
const CHILD_EXCLUDED_TOOLS = "bash,edit,write,duckle_subagent";
const STDERR_TAIL = 2000;

type AgentDef = { name: string; description: string; systemPrompt: string };

function agentsDir(): string {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "agents");
}

function loadAgents(): AgentDef[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(agentsDir()).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files.sort().map((file) => {
		const text = fs.readFileSync(path.join(agentsDir(), file), "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
		const front = match ? match[1] : "";
		const body = match ? match[2] : text;
		const description = /^description:\s*(.*)$/m.exec(front)?.[1]?.trim() ?? "";
		return { name: file.slice(0, -3), description, systemPrompt: body.trim() };
	});
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

type ChildResult = { output: string; tools: string[]; exitCode: number; stderr: string; aborted: boolean };

function runChild(
	agent: AgentDef,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onActivity: (tools: string[], text: string) => void,
): Promise<ChildResult> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckle-subagent-"));
	const promptFile = path.join(tmpDir, `${agent.name}.md`);
	fs.writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	const args = [
		process.argv[1],
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--exclude-tools",
		CHILD_EXCLUDED_TOOLS,
		"--append-system-prompt",
		promptFile,
		`Task: ${task}`,
	];
	return new Promise((resolve) => {
		const result: ChildResult = { output: "", tools: [], exitCode: 0, stderr: "", aborted: false };
		const proc = spawn(process.execPath, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, DUCKLE_SUBAGENT_DEPTH: String(DEPTH + 1) },
		});
		let buffer = "";
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let record: any;
			try {
				record = JSON.parse(line);
			} catch {
				return;
			}
			if (record.type === "tool_execution_start" && typeof record.toolName === "string") {
				result.tools.push(record.toolName);
				onActivity(result.tools, result.output);
			} else if (record.type === "message_end" && record.message?.role === "assistant") {
				const text = messageText(record.message).trim();
				if (text) result.output = text;
				onActivity(result.tools, result.output);
			}
		};
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.on("data", (chunk) => {
			result.stderr = (result.stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		const finish = (code: number) => {
			if (buffer.trim()) handleLine(buffer);
			result.exitCode = code;
			fs.rmSync(tmpDir, { recursive: true, force: true });
			resolve(result);
		};
		proc.on("close", (code) => finish(code ?? 0));
		proc.on("error", (err) => {
			result.stderr = String(err);
			finish(1);
		});
		if (signal) {
			const kill = () => {
				result.aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc.exitCode === null) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/** Title and detail for the run confirmation: which pipeline, in words. */
function describeRun(input: unknown): [string, string] {
	const args = (input ?? {}) as { path?: unknown; pipeline?: { name?: unknown } };
	if (typeof args.path === "string" && args.path) {
		const name = args.path.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
		return [`运行 pipeline「${name}」？`, args.path];
	}
	const inline = typeof args.pipeline?.name === "string" ? args.pipeline.name : "未保存的 pipeline";
	return [`运行 pipeline「${inline}」？`, "这个 pipeline 还没有保存到工作区。"];
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "mcp__duckle__run_pipeline") return undefined;
		if (DEPTH > 0 || !ctx.hasUI) {
			return {
				block: true,
				reason: "Running a pipeline needs the user's confirmation. Leave running it to the main Duckle agent.",
			};
		}
		const ok = await ctx.ui.confirm(...describeRun(event.input));
		return ok ? undefined : { block: true, reason: "The user declined to run this pipeline." };
	});

	if (DEPTH > 0) return;
	const agents = loadAgents();
	if (agents.length === 0) return;

	pi.registerTool({
		name: "duckle_subagent",
		label: "Duckle subagent",
		description:
			"Delegate a self-contained Duckle task to a specialised subagent with its own context. " +
			"It can use the Duckle MCP tools but cannot run pipelines. Available agents: " +
			agents.map((a) => `${a.name} (${a.description})`).join("; "),
		parameters: Type.Object({
			agent: Type.String({ description: `One of: ${agents.map((a) => a.name).join(", ")}` }),
			task: Type.String({
				description: "What the subagent should do. Include the workspace path and any pipeline ids or paths it needs.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				return {
					content: [
						{ type: "text", text: `Unknown agent "${params.agent}". Available: ${agents.map((a) => a.name).join(", ")}` },
					],
					details: { agent: params.agent },
					isError: true,
				};
			}
			const report = (tools: string[], text: string) =>
				onUpdate?.({
					content: [{ type: "text", text: text || `running (${tools.length} tool calls)` }],
					details: { agent: agent.name, task: params.task, tools, status: "running" },
				});
			const result = await runChild(agent, params.task, ctx.cwd, signal, report);
			const failed = result.aborted || result.exitCode !== 0 || !result.output;
			const text = result.aborted
				? "Subagent was aborted."
				: result.output || `Subagent exited with code ${result.exitCode}. ${result.stderr.trim()}`.trim();
			return {
				content: [{ type: "text", text }],
				details: { agent: agent.name, task: params.task, tools: result.tools, status: failed ? "failed" : "done" },
				isError: failed,
			};
		},
	});
}
