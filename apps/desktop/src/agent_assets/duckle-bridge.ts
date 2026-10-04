// Duckle bridge for the embedded Pi Agent. Written into the Duckle-owned Pi
// agent directory (PI_CODING_AGENT_DIR) on every agent start; edits there are
// overwritten.
//
// - `duckle_subagent` delegates a task to a definition in <agent-dir>/agents/.
//   Each delegation runs a separate `pi --mode json` process, like Pi's own
//   subagent example. In-process subagent packages start their child sessions
//   without the MCP servers, so the Duckle tools were missing there.
// - Every tool call goes through one policy (`tool_call` below), in the main
//   agent and in subagents alike:
//   * Duckle MCP tools that only read run freely. create/update_pipeline run
//     freely in the main agent. Anything else that runs, writes or changes
//     state asks the user first, and so does an MCP tool this list does not
//     know yet. A subagent has no UI, so it gets the read-only tools only.
//   * Paths, for Pi's `read` and for the MCP tools' path arguments, must stay
//     inside the workspace, outside its .duckle (keys, settings with the API
//     key) and .git folders. `read` may also open Duckle's skills. The checked
//     absolute path replaces the argument, so what runs is what was checked.
//   * Any other tool is refused.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEPTH = Number(process.env.DUCKLE_SUBAGENT_DEPTH ?? "0") || 0;
// Pi's built-ins other than `read`; keep in sync with EXCLUDED_TOOLS in agent_manager.rs.
const CHILD_EXCLUDED_TOOLS = "bash,powershell,edit,write,grep,find,ls,duckle_subagent";
const STDERR_TAIL = 2000;

const MCP_PREFIX = "mcp__duckle__";
/** Duckle MCP tools that write nothing and run nothing. */
const READ_ONLY_TOOLS = new Set([
	"list_components",
	"asset_freshness",
	"component_capabilities",
	"get_component_schema",
	"validate_pipeline",
	"pipeline_lineage",
	"verify_pipeline",
	"check_node_sql",
	"complete_node_sql",
	"suggest_contracts",
	"pipeline_impact",
	"workspace_impact",
	"diff_pipelines",
	"trust_report",
	"schema_drift",
	"list_pipelines",
	"read_pipeline",
	"read_run_logs",
	"backfill_list",
	"baseline_list",
	"baseline_inspect",
	"list_connections",
]);
/** The agent's own job: writing pipelines the user can see in the project tree. */
const AUTHORING_TOOLS = new Set(["create_pipeline", "update_pipeline"]);
/** What the confirmation says for tools that run or change something. */
const CONFIRM_LABELS: Record<string, string> = {
	run_tests: "运行 pipeline 测试",
	backfill: "执行回填",
	backfill_set: "修改节点的增量状态",
	backfill_clear: "清除节点的已保存状态",
	baseline_accept: "接受新的数据基线",
	baseline_clear: "清除数据基线历史",
	build_pipeline: "构建部署产物",
	create_connection: "新建连接",
};
const PATH_ARGS = ["path", "beforePath", "afterPath", "directory", "workspace", "logDir", "out"];
const PATH_LIST_ARGS = ["paths"];
const PROTECTED_DIRS = [".duckle", ".git"];
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

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
		"--no-approve",
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

/** Title and detail for confirming any other tool that runs or changes something. */
function describeAction(tool: string, input: unknown): [string, string] {
	if (tool === "run_pipeline") return describeRun(input);
	const args = (input ?? {}) as Record<string, unknown>;
	if (tool === "create_connection" && typeof args.name === "string") {
		return [`新建连接「${args.name}」？`, typeof args.workspace === "string" ? args.workspace : ""];
	}
	const label = CONFIRM_LABELS[tool] ?? `使用 Duckle 工具 ${tool}`;
	// Inline pipeline objects are long and say little here; the rest is what the call will do.
	const shown = Object.fromEntries(Object.entries(args).filter(([, v]) => typeof v !== "object" || v === null));
	return [`${label}？`, JSON.stringify(shown, null, 1).slice(0, 600)];
}

function sameCase(p: string): string {
	return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(sameCase(parent), sameCase(child));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Absolute and free of symlinks, also for a path that does not exist yet: the
 *  deepest existing ancestor is resolved and the rest appended to it. */
function canonical(p: string): string {
	let current = path.resolve(p);
	const rest: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(current), ...rest.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(p);
			rest.push(path.basename(current));
			current = parent;
		}
	}
}

type PathCheck = { ok: true; resolved: string } | { ok: false; reason: string };

/**
 * Where a tool's path argument really points, and whether the agent may use it.
 * `read` takes Pi's own spellings (`@file`, `~/...`, `file://...`); the MCP
 * server reads its paths as given, relative to the workspace.
 */
function checkPath(raw: string, cwd: string, forRead: boolean): PathCheck {
	let p = raw.replace(UNICODE_SPACES, " ");
	if (forRead) {
		if (p.startsWith("@")) p = p.slice(1);
		if (p === "~") p = os.homedir();
		else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
			p = path.join(os.homedir(), p.slice(2));
		} else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
	}
	const resolved = canonical(path.resolve(cwd, p));
	const workspace = canonical(process.env.DUCKLE_AGENT_WORKSPACE || cwd);
	if (isInside(resolved, workspace)) {
		const hidden = PROTECTED_DIRS.find((dir) => isInside(resolved, canonical(path.join(workspace, dir))));
		if (!hidden) return { ok: true, resolved };
		return {
			ok: false,
			reason: `${raw}: the workspace's ${hidden} folder holds Duckle's keys and settings and is not available to the agent.`,
		};
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (forRead && agentDir && isInside(resolved, canonical(path.join(agentDir, "skills")))) {
		return { ok: true, resolved };
	}
	return { ok: false, reason: `${raw} is outside the workspace (${workspace}); the agent can only use files inside it.` };
}

/** A pipeline id becomes pipelines/<id>.json, so it must be a plain file stem. */
function badPipelineId(input: Record<string, unknown>): string | undefined {
	const pipeline = input.pipeline as { id?: unknown } | undefined;
	for (const id of [input.id, pipeline?.id]) {
		if (typeof id === "string" && (/[\\/]/.test(id) || id === "." || id === "..")) return id;
	}
	return undefined;
}

type Verdict = { block: true; reason: string } | undefined;

/** Confines every path argument of a Duckle MCP call, rewriting each to its checked form. */
function confineMcpPaths(input: Record<string, unknown>, cwd: string): Verdict {
	for (const key of PATH_ARGS) {
		const value = input[key];
		if (typeof value !== "string" || !value) continue;
		const check = checkPath(value, cwd, false);
		if (!check.ok) return { block: true, reason: check.reason };
		input[key] = check.resolved;
	}
	for (const key of PATH_LIST_ARGS) {
		const list = input[key];
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			if (typeof list[i] !== "string") continue;
			const check = checkPath(list[i], cwd, false);
			if (!check.ok) return { block: true, reason: check.reason };
			list[i] = check.resolved;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx): Promise<Verdict> => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const cwd = ctx.cwd || process.cwd();

		if (event.toolName === "read") {
			if (typeof input.path !== "string") return undefined;
			const check = checkPath(input.path, cwd, true);
			if (!check.ok) return { block: true, reason: check.reason };
			input.path = check.resolved;
			return undefined;
		}
		if (event.toolName === "duckle_subagent" && DEPTH === 0) return undefined;
		if (!event.toolName.startsWith(MCP_PREFIX)) {
			return { block: true, reason: `The ${event.toolName} tool is not available in Duckle.` };
		}

		const tool = event.toolName.slice(MCP_PREFIX.length);
		if (input.duckdb !== undefined) {
			return { block: true, reason: "Do not pass 'duckdb': Duckle provides the DuckDB binary itself." };
		}
		const confined = confineMcpPaths(input, cwd);
		if (confined) return confined;

		if (READ_ONLY_TOOLS.has(tool) || (tool === "backfill" && input.action === "status")) return undefined;
		if (DEPTH > 0) {
			return {
				block: true,
				reason: `A subagent only inspects; ${tool} writes or runs something. Report what should be done and leave it to the main Duckle agent.`,
			};
		}
		if (AUTHORING_TOOLS.has(tool)) {
			const bad = badPipelineId(input);
			return bad === undefined
				? undefined
				: { block: true, reason: `Pipeline id "${bad}" must be a plain name without path separators.` };
		}
		if (!ctx.hasUI) {
			return { block: true, reason: `${tool} needs the user's confirmation, and there is no one to ask here.` };
		}
		const ok = await ctx.ui.confirm(...describeAction(tool, input));
		return ok
			? undefined
			: {
					block: true,
					reason:
						tool === "run_pipeline"
							? "The user declined to run this pipeline."
							: `The user declined ${tool}.`,
				};
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
