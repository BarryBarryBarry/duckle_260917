import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
    AlertCircle,
    Bot,
    ChevronDown,
    Download,
    Loader2,
    Maximize2,
    Minimize2,
    Minus,
    PanelLeftClose,
    PanelLeftOpen,
    Send,
    Sparkles,
    Square,
    Workflow,
    Wrench,
    X,
} from 'lucide-react';
import {
    agentAbort,
    agentCheckInstalled,
    agentConversationDelete,
    agentConversationGet,
    agentConversationSave,
    agentConversationsList,
    agentConversationUpdateMeta,
    agentInstall,
    agentListConnections,
    agentSendPrompt,
    agentStart,
    agentStop,
    agentUiReply,
    type AgentConnectionContext,
    type AgentContext,
    type AgentEvent,
    type AgentEventEnvelope,
    type DuckieConversationSummary,
    type InstallProgress,
} from '../tauri-bridge';
import { getWorkspacePath } from '../workspace';
import ConversationSidebar from './ConversationSidebar';
import ReplyFooter, { type ReplyUsage } from './ReplyFooter';
import { syncComposerHeight, useInputRecall } from './composer';
import { useFloatingPanel } from './floating-panel';

type Props = {
    workspace: string | null;
    open: boolean;
    onClose: () => void;
    onOpenPipeline?: (pipelineId: string) => void;
    onWorkspaceChanged?: () => void;
    /** Opens Settings, where the External OpenAI model the agent uses is configured. */
    onOpenSettings?: () => void;
};

type ToolCall = {
    id: string;
    name: string;
    args: unknown;
    partial?: unknown;
    result?: unknown;
    isError?: boolean;
    pipelineId?: string;
    pipelinePath?: string;
};

type SubagentNode = {
    id: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    result?: unknown;
};

type AssistantTurn = {
    /** Fixed when the reply starts, so late updates find the right bubble. */
    id?: string;
    text: string;
    thinking: string;
    tools: ToolCall[];
    skills: string[];
    subagents: SubagentNode[];
    /** When the user sent the message this turn answers. */
    startedAt?: number;
    /** When the agent settled; the footer is shown from then on. */
    finishedAt?: number;
    /** Summed over every model call of the turn, when Pi reports usage. */
    usage?: ReplyUsage;
};

/** Pi reports zeros when the provider sent no usage; that is "unknown", not free. */
function addUsage(total: ReplyUsage | undefined, raw: unknown): ReplyUsage | undefined {
    if (!raw || typeof raw !== 'object') return total;
    const u = raw as Record<string, unknown>;
    const num = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0);
    const input = num('input');
    const output = num('output');
    const cacheRead = num('cacheRead');
    const reported = num('totalTokens') || input + output;
    if (reported === 0) return total;
    return {
        input: (total?.input ?? 0) + input,
        output: (total?.output ?? 0) + output,
        cacheRead: (total?.cacheRead ?? 0) + cacheRead,
        total: (total?.total ?? 0) + reported,
        calls: (total?.calls ?? 0) + 1,
    };
}

type SetupState =
    | { phase: 'checking' }
    | { phase: 'not-installed' }
    | { phase: 'installing'; progress: InstallProgress | null }
    | { phase: 'ready' }
    | { phase: 'install-failed'; message: string };

type ChatError = {
    message: string;
    needsSettings: boolean;
    /** A failed model call. Pi may retry it, so later activity clears it. */
    fromModel?: boolean;
};

/** A provider failure in words the user can act on. */
function modelError(raw: string): ChatError {
    const lower = raw.toLowerCase();
    let message = `模型调用失败：${raw}`;
    if (lower.includes('insufficient_quota') || lower.includes('quota exhausted') || lower.includes('quota')) {
        message = `模型服务的额度已用完，请求被拒绝。请充值，或在「设置 → AI assistant」中换一个模型后，发送「继续」接着完成。\n\n${raw}`;
    } else if (lower.startsWith('401') || lower.includes('invalid api key') || lower.includes('unauthorized')) {
        message = `模型服务拒绝了 API Key，请在「设置 → AI assistant」中检查。\n\n${raw}`;
    } else if (lower.startsWith('429') || lower.includes('rate limit')) {
        message = `模型服务限流了，请稍后再试。\n\n${raw}`;
    }
    return { message, needsSettings: true, fromModel: true };
}

/** Turn a failed start into what the user should do about it. */
function startError(raw: string): ChatError {
    if (raw.includes('agent_llm_not_configured')) {
        return {
            message:
                'Pi Agent 使用「设置 → AI assistant」中的 External OpenAI 模型，目前未启用。请选择 External OpenAI，并填写 Base URL 和模型后重试。',
            needsSettings: true,
        };
    }
    if (raw.includes('nodejs_not_installed') || raw.includes('pi_not_installed')) {
        return { message: 'Pi Agent 运行环境不完整，请关闭面板后重新安装。', needsSettings: false };
    }
    return { message: `Pi Agent 无法启动：${raw}`, needsSettings: false };
}

type Message =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; turn: AssistantTurn };

type UiDialog = {
    id: string;
    method: string;
    title: string;
    message: string;
    options: string[];
    placeholder: string;
    value: string;
    /** Pi answers for the user once this passes, so the card goes away too. */
    timeoutMs?: number;
};

const STATE_KEY = 'duckle-pi-agent-panel';

const EXAMPLE_PROMPTS = [
    '读取 orders.csv，过滤 status = "shipped"，写入 shipped.parquet',
    '检查当前工作区所有 pipeline 是否能通过校验',
    '把当前数据连接中的 orders 表迁移到 DuckDB',
];

function emptyTurn(): AssistantTurn {
    return { text: '', thinking: '', tools: [], skills: [], subagents: [] };
}

function toolLabel(name: string): string {
    return name.startsWith('mcp__duckle__') ? name.slice('mcp__duckle__'.length) : name;
}

function selectionKey(workspace: string): string {
    return `${STATE_KEY}:${workspace}`;
}

function readSavedSelection(workspace: string): {
    draft: string;
    selectedConnectionId: string;
} {
    try {
        const raw = localStorage.getItem(selectionKey(workspace));
        if (!raw) return { draft: '', selectedConnectionId: '' };
        const parsed = JSON.parse(raw) as {
            draft?: unknown;
            selectedConnectionId?: unknown;
        };
        return {
            draft: typeof parsed.draft === 'string' ? parsed.draft : '',
            selectedConnectionId:
                typeof parsed.selectedConnectionId === 'string' ? parsed.selectedConnectionId : '',
        };
    } catch {
        return { draft: '', selectedConnectionId: '' };
    }
}

/** "name (mysql · localhost/sales)", leaving out whatever the connection lacks
 *  and a database that just repeats the name. */
function connectionLabel(connection: AgentConnectionContext): string {
    const target = [connection.host, connection.database !== connection.name ? connection.database : null]
        .filter(Boolean)
        .join('/');
    const detail = [connection.kind, target].filter(Boolean).join(' · ');
    return detail ? `${connection.name} (${detail})` : connection.name;
}

function installLabel(progress: InstallProgress | null): string {
    if (!progress) return '准备安装…';
    switch (progress.phase) {
        case 'downloading':
            return progress.total
                ? `正在下载 Node.js ${Math.round(progress.received / 1_000_000)} / ${Math.round(progress.total / 1_000_000)} MB`
                : `正在下载 Node.js ${Math.round(progress.received / 1_000_000)} MB`;
        case 'extracting':
            return '正在解压运行时…';
        case 'verifying':
            return '正在校验…';
        case 'running_command':
            return progress.label;
        case 'installing_extension':
            return `正在安装扩展 (${progress.index}/${progress.total})`;
        case 'downloading_model':
            return '正在下载模型…';
        case 'done':
            return '安装完成';
        case 'failed':
            return progress.error;
    }
}

/** Per-workspace localStorage key prefix for the conversation to reopen. */
const ACTIVE_CONVERSATION_KEY = 'pi-agent-active-conversation';
/** Auto titles are the first user message, cut to this many characters. */
const TITLE_MAX_CHARS = 30;
/** How often a running turn is saved, so a long run survives the app closing. */
const IN_PROGRESS_SAVE_MS = 5000;

function readActiveConversation(workspace: string | null): string | null {
    if (!workspace) return null;
    try {
        return localStorage.getItem(`${ACTIVE_CONVERSATION_KEY}:${workspace}`);
    } catch {
        return null;
    }
}

function writeActiveConversation(workspace: string, id: string | null) {
    const key = `${ACTIVE_CONVERSATION_KEY}:${workspace}`;
    try {
        if (id) localStorage.setItem(key, id);
        else localStorage.removeItem(key);
    } catch {
        // Storage can be unavailable; reopening on a new chat is fine.
    }
}

/** Also the Pi session id suffix, so only letters, digits and dashes. */
function newConversationId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `c-${Date.now().toString(36)}-${rand}`;
}

function deriveConversationTitle(messages: Message[]): string {
    const first = messages.find((m): m is Extract<Message, { kind: 'user' }> => m.kind === 'user')?.text ?? '';
    const flat = first.replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join('')}…` : flat;
}

/** One question gets one reply card. Older versions could split a reply into
 *  several cards (a late update, or switching conversations mid-run); those
 *  are joined back here so a saved conversation does not look duplicated. */
function mergeSplitReplies(messages: Message[]): Message[] {
    const out: Message[] = [];
    for (const message of messages) {
        const prev = out[out.length - 1];
        if (message.kind !== 'assistant' || prev?.kind !== 'assistant') {
            out.push(message);
            continue;
        }
        const a = prev.turn;
        const b = message.turn;
        const join = (x: string, y: string) => (x && y ? `${x}\n\n${y}` : x || y);
        out[out.length - 1] = {
            kind: 'assistant',
            turn: {
                ...a,
                text: a.text + b.text,
                thinking: join(a.thinking, b.thinking),
                tools: [...a.tools, ...b.tools],
                skills: [...new Set([...a.skills, ...b.skills])],
                subagents: [...a.subagents, ...b.subagents],
                startedAt: a.startedAt ?? b.startedAt,
                finishedAt: Math.max(a.finishedAt ?? 0, b.finishedAt ?? 0) || undefined,
                usage: sumUsage(a.usage, b.usage),
            },
        };
    }
    return out;
}

function sumUsage(a?: ReplyUsage, b?: ReplyUsage): ReplyUsage | undefined {
    if (!a || !b) return a ?? b;
    const add = (x?: number, y?: number) => (x == null && y == null ? undefined : (x ?? 0) + (y ?? 0));
    return {
        input: add(a.input, b.input),
        output: add(a.output, b.output),
        cacheRead: add(a.cacheRead, b.cacheRead),
        total: add(a.total, b.total),
        calls: add(a.calls, b.calls),
    };
}

/** History files are user-editable JSON, so keep only well-formed messages. A
 *  tool still running when the conversation was saved can no longer finish. */
function restoreMessages(raw: unknown[]): Message[] {
    const out: Message[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const m = item as Record<string, unknown>;
        if (m.kind === 'user' && typeof m.text === 'string') {
            out.push({ kind: 'user', text: m.text });
        } else if (m.kind === 'assistant' && m.turn && typeof m.turn === 'object') {
            const t = m.turn as Partial<AssistantTurn>;
            const tools = Array.isArray(t.tools) ? t.tools : [];
            out.push({
                kind: 'assistant',
                turn: {
                    id: typeof t.id === 'string' ? t.id : undefined,
                    text: typeof t.text === 'string' ? t.text : '',
                    thinking: typeof t.thinking === 'string' ? t.thinking : '',
                    skills: Array.isArray(t.skills) ? t.skills.filter((x): x is string => typeof x === 'string') : [],
                    subagents: Array.isArray(t.subagents) ? t.subagents : [],
                    tools: tools.map(tool =>
                        tool.result === undefined ? { ...tool, result: '已中断', isError: true } : tool,
                    ),
                    startedAt: typeof t.startedAt === 'number' ? t.startedAt : undefined,
                    finishedAt: typeof t.finishedAt === 'number' ? t.finishedAt : undefined,
                    usage: t.usage && typeof t.usage === 'object' ? t.usage : undefined,
                },
            });
        }
    }
    return mergeSplitReplies(out);
}

/** Only these write a pipeline; other results also carry an `id` (a component's). */
function writesPipeline(toolName: string): boolean {
    return toolName === 'mcp__duckle__create_pipeline' || toolName === 'mcp__duckle__update_pipeline';
}

function parseToolResult(result: unknown): { pipelineId?: string; pipelinePath?: string } {
    const found = findPipelineRef(result);
    // update_pipeline answers with the path only; a workspace pipeline's id is its file stem.
    if (!found.pipelineId && found.pipelinePath) {
        const match = /[\\/]pipelines[\\/]([^\\/]+)\.json$/.exec(found.pipelinePath);
        if (match) found.pipelineId = match[1];
    }
    return found;
}

function findPipelineRef(result: unknown): { pipelineId?: string; pipelinePath?: string } {
    if (!result || typeof result !== 'object') return {};
    const value = result as Record<string, unknown>;
    const directId = typeof value.id === 'string' ? value.id : undefined;
    const directPath = typeof value.path === 'string' ? value.path : undefined;
    if (directId || directPath) return { pipelineId: directId, pipelinePath: directPath };
    const content = Array.isArray(value.content) ? value.content : [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const text = (item as Record<string, unknown>).text;
        if (typeof text !== 'string') continue;
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const pipelineId = typeof parsed.id === 'string' ? parsed.id : undefined;
            const pipelinePath = typeof parsed.path === 'string' ? parsed.path : undefined;
            if (pipelineId || pipelinePath) return { pipelineId, pipelinePath };
        } catch {
            continue;
        }
    }
    return {};
}

export default function AgentChatPanel({
    workspace: workspaceProp,
    open,
    onClose,
    onOpenPipeline,
    onWorkspaceChanged,
    onOpenSettings,
}: Props) {
    const workspace = useMemo(() => workspaceProp ?? getWorkspacePath(), [workspaceProp]);
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    const [connections, setConnections] = useState<AgentConnectionContext[]>([]);
    const [selectedConnectionId, setSelectedConnectionId] = useState('');
    const [error, setError] = useState<ChatError | null>(null);
    const [uiDialog, setUiDialog] = useState<UiDialog | null>(null);
    const [startNonce, setStartNonce] = useState(0);
    const [conversations, setConversations] = useState<DuckieConversationSummary[]>([]);
    /** null = a new chat that has not been saved yet. */
    const [activeId, setActiveId] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const {
        layout,
        panelStyle,
        dragging,
        resizing,
        headerProps,
        resizeHandles,
        toggleCollapsed,
        toggleMaximized,
        toggleSidebar,
    } = useFloatingPanel('pi-agent-panel-position', 'Pi Agent');
    /** The conversation whose Pi session is running, if any. */
    const startedConversationRef = useRef<string | null>(null);
    /** Serializes history writes so a slow save cannot land after a newer one. */
    const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
    /** What was last written to disk, to skip saves that would change nothing. */
    const savedSignatureRef = useRef('');
    const connectedRef = useRef(false);
    connectedRef.current = connected;
    const busyRef = useRef(false);
    busyRef.current = busy;
    /** The reply being streamed, by turn id. Updates are queued and applied in
     *  batches, so each one carries its target id instead of looking up "the
     *  current reply" when it runs - by then a settle may have cleared it, and
     *  the tail of the reply landed in a bubble of its own. */
    const currentTurnIdRef = useRef<string | null>(null);
    /** When the message being answered was sent, stamped on the reply's turn. */
    const turnStartedAtRef = useRef<number | undefined>(undefined);
    /** The listener is registered once; it calls the latest handler through this. */
    const agentEventHandlerRef = useRef<(event: AgentEvent) => void>(() => undefined);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const messagesRef = useRef<Message[]>([]);
    messagesRef.current = messages;
    const { handleRecallKey, resetRecall } = useInputRecall(
        () =>
            messagesRef.current
                .filter((m): m is Extract<Message, { kind: 'user' }> => m.kind === 'user')
                .map(m => m.text),
        setDraft,
        inputRef,
    );

    useEffect(() => {
        syncComposerHeight(inputRef.current);
    }, [draft, open, layout.collapsed]);

    const runHistoryTask = useCallback((task: () => Promise<void>) => {
        historyQueueRef.current = historyQueueRef.current
            .then(task)
            .catch(err => setHistoryError(String(err)));
        return historyQueueRef.current;
    }, []);

    const stopAgent = useCallback(() => {
        startedConversationRef.current = null;
        connectedRef.current = false;
        setConnected(false);
        void agentStop().catch(() => undefined);
    }, []);

    // A new workspace starts from its own history and reopens the conversation
    // that was active there last time.
    useEffect(() => {
        if (!workspace) return;
        const saved = readSavedSelection(workspace);
        setDraft(saved.draft);
        setSelectedConnectionId(saved.selectedConnectionId);
        setMessages([]);
        setActiveId(null);
        setError(null);
        setBusy(false);
        currentTurnIdRef.current = null;
        savedSignatureRef.current = '';
        stopAgent();
        let cancelled = false;
        const restoreId = readActiveConversation(workspace);
        void (async () => {
            try {
                const list = await agentConversationsList(workspace);
                if (cancelled) return;
                setConversations(list);
                setHistoryError(null);
                if (restoreId && list.some(c => c.id === restoreId)) {
                    const conv = await agentConversationGet(workspace, restoreId);
                    if (cancelled) return;
                    const loaded = restoreMessages(conv.messages);
                    savedSignatureRef.current = JSON.stringify(loaded);
                    setMessages(loaded);
                    setActiveId(restoreId);
                }
            } catch (err) {
                if (!cancelled) setHistoryError(String(err));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [workspace, stopAgent]);

    useEffect(() => {
        if (workspace) writeActiveConversation(workspace, activeId);
    }, [activeId, workspace]);

    // Save the conversation when a turn settles, and every few seconds while a
    // long one runs, so closing the app mid-turn keeps the work done so far.
    // A tool still running when that happens shows as interrupted on reload.
    const saveConversation = useCallback(
        (conversationId: string, list: Message[]) => {
            if (!workspace || list.length === 0) return;
            const signature = JSON.stringify(list);
            if (signature === savedSignatureRef.current) return;
            savedSignatureRef.current = signature;
            const payload = { id: conversationId, title: deriveConversationTitle(list), messages: list };
            void runHistoryTask(async () => {
                setConversations(await agentConversationSave(workspace, payload));
                setHistoryError(null);
            });
        },
        [workspace, runHistoryTask],
    );
    const pendingSaveRef = useRef<number | null>(null);
    const latestRef = useRef({ activeId, messages });
    latestRef.current = { activeId, messages };
    useEffect(() => {
        if (!activeId || messages.length === 0) return;
        if (!busy) {
            if (pendingSaveRef.current != null) window.clearTimeout(pendingSaveRef.current);
            pendingSaveRef.current = null;
            saveConversation(activeId, messages);
            return;
        }
        if (pendingSaveRef.current != null) return;
        pendingSaveRef.current = window.setTimeout(() => {
            pendingSaveRef.current = null;
            const latest = latestRef.current;
            if (latest.activeId) saveConversation(latest.activeId, latest.messages);
        }, IN_PROGRESS_SAVE_MS);
    }, [messages, busy, activeId, saveConversation]);
    useEffect(
        () => () => {
            if (pendingSaveRef.current != null) window.clearTimeout(pendingSaveRef.current);
        },
        [],
    );

    const startNewConversation = useCallback(() => {
        if (busyRef.current) return;
        resetRecall();
        currentTurnIdRef.current = null;
        savedSignatureRef.current = '';
        setMessages([]);
        setActiveId(null);
        setError(null);
    }, []);

    const openConversation = useCallback(
        async (id: string) => {
            if (!workspace || busyRef.current) return;
            try {
                const conv = await agentConversationGet(workspace, id);
                const loaded = restoreMessages(conv.messages);
                currentTurnIdRef.current = null;
                savedSignatureRef.current = JSON.stringify(loaded);
                resetRecall();
                setMessages(loaded);
                setActiveId(id);
                setError(null);
                setHistoryError(null);
            } catch (err) {
                setHistoryError(String(err));
            }
        },
        [workspace],
    );

    const renameConversation = useCallback(
        (id: string, title: string) => {
            if (!workspace) return;
            void runHistoryTask(async () => {
                setConversations(await agentConversationUpdateMeta(workspace, id, { title }));
            });
        },
        [workspace, runHistoryTask],
    );

    const togglePinned = useCallback(
        (conv: DuckieConversationSummary) => {
            if (!workspace) return;
            void runHistoryTask(async () => {
                setConversations(await agentConversationUpdateMeta(workspace, conv.id, { pinned: !conv.pinned }));
            });
        },
        [workspace, runHistoryTask],
    );

    const deleteConversation = useCallback(
        (id: string) => {
            if (!workspace) return;
            if (busyRef.current && id === activeId) return;
            if (id === activeId) startNewConversation();
            if (startedConversationRef.current === id) stopAgent();
            void runHistoryTask(async () => {
                setConversations(await agentConversationDelete(workspace, id));
            });
        },
        [workspace, activeId, startNewConversation, stopAgent, runHistoryTask],
    );

    // Esc closes the panel, like Duckie's. The history menu handles its own
    // Escape first.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !uiDialog) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, uiDialog]);

    useEffect(() => {
        if (!workspace) return;
        localStorage.setItem(
            selectionKey(workspace),
            JSON.stringify({ draft, selectedConnectionId }),
        );
    }, [draft, selectedConnectionId, workspace]);

    // Opening the panel checks the runtime and loads the saved connections.
    // The agent itself starts on the first message, on that conversation's
    // own Pi session, and any start failure is reported in the chat then.
    useEffect(() => {
        if (!open || !workspace) return;
        let cancelled = false;
        (async () => {
            const installed = await agentCheckInstalled();
            if (cancelled) return;
            if (!installed) {
                setSetup({ phase: 'not-installed' });
                return;
            }
            setSetup({ phase: 'ready' });
            const list = await agentListConnections(workspace);
            if (!cancelled) setConnections(list);
        })();
        return () => {
            cancelled = true;
        };
    }, [open, workspace, startNonce]);

    /** Run the agent on this conversation's session. Returns why it could not. */
    async function ensureStarted(conversationId: string): Promise<ChatError | null> {
        if (connectedRef.current && startedConversationRef.current === conversationId) return null;
        if (!workspace) return { message: '请先打开一个工作区。', needsSettings: false };
        // Set before starting: the new session's events can arrive before the
        // start call returns, and the old one's after.
        startedConversationRef.current = conversationId;
        try {
            await agentStart(workspace, conversationId);
            connectedRef.current = true;
            setConnected(true);
            return null;
        } catch (err) {
            startedConversationRef.current = null;
            return startError(String(err));
        }
    }

    // Exactly one listener for the panel's lifetime. `listen` resolves later,
    // so a cleanup that runs first (React's StrictMode double mount does) must
    // unregister it once it arrives; a second live listener appended every
    // streamed token twice.
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        let disposed = false;
        void listen<AgentEventEnvelope>('agent_event', event => {
            // Only the conversation the agent was started for. Starting another
            // one stops the previous Pi process, and that process's exit (or a
            // last event in flight) must not end or leak into this one.
            const expected = startedConversationRef.current;
            if (!expected || event.payload.session !== `duckle-${expected}`) return;
            agentEventHandlerRef.current(event.payload);
        })
            .then(fn => {
                if (disposed) void fn();
                else unlisten = fn;
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            if (unlisten) void unlisten();
        };
    }, []);

    useEffect(() => {
        return () => {
            void agentStop().catch(() => undefined);
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [open, messages, busy, error, uiDialog]);

    async function handleInstall() {
        setSetup({ phase: 'installing', progress: null });
        try {
            await agentInstall(progress => setSetup({ phase: 'installing', progress }));
            setStartNonce(n => n + 1);
        } catch (err) {
            setSetup({ phase: 'install-failed', message: String(err) });
        }
    }

    function appendAssistant(mutator: (turn: AssistantTurn) => void) {
        let turnId = currentTurnIdRef.current;
        if (!turnId) {
            turnId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            currentTurnIdRef.current = turnId;
        }
        const target = turnId;
        const startedAt = turnStartedAtRef.current;
        setMessages(prev => {
            const next = [...prev];
            let index = next.findIndex(m => m.kind === 'assistant' && m.turn.id === target);
            if (index < 0) {
                index = next.length;
                next.push({ kind: 'assistant', turn: { ...emptyTurn(), id: target, startedAt } });
            }
            const item = next[index];
            if (item.kind === 'assistant') {
                const turn: AssistantTurn = {
                    ...item.turn,
                    tools: [...item.turn.tools],
                    skills: [...item.turn.skills],
                    subagents: [...item.turn.subagents],
                };
                mutator(turn);
                next[index] = { kind: 'assistant', turn };
            }
            return next;
        });
    }

    function updateTool(id: string, mutator: (tool: ToolCall) => ToolCall) {
        appendAssistant(turn => {
            const at = turn.tools.findIndex(tool => tool.id === id);
            if (at >= 0) turn.tools[at] = mutator(turn.tools[at]);
        });
    }

    // The id is read now, not inside the state update: that runs later,
    // after the ref is cleared, and would have stamped a new empty bubble.
    function finishTurn() {
        const target = currentTurnIdRef.current;
        currentTurnIdRef.current = null;
        if (!target) return;
        const finishedAt = Date.now();
        setMessages(prev => {
            const index = prev.findIndex(m => m.kind === 'assistant' && m.turn.id === target);
            const item = prev[index];
            if (!item || item.kind !== 'assistant' || item.turn.finishedAt) return prev;
            const next = [...prev];
            next[index] = { kind: 'assistant', turn: { ...item.turn, finishedAt } };
            return next;
        });
    }

    /** A retried call that now works makes the earlier failure moot. */
    function clearModelError() {
        setError(current => (current?.fromModel ? null : current));
    }

    agentEventHandlerRef.current = handleAgentEvent;
    function handleAgentEvent(event: AgentEvent) {
        switch (event.kind) {
            // The panel keeps its own copy of each conversation, with tool cards
            // that Pi's transcript does not have, so Pi's restored history is
            // not shown again.
            case 'session_ready':
            case 'history_loaded':
                break;
            case 'text_delta':
                clearModelError();
                appendAssistant(turn => {
                    turn.text += event.delta;
                });
                break;
            case 'thinking_delta':
                appendAssistant(turn => {
                    turn.thinking += event.delta;
                });
                break;
            case 'tool_start':
                clearModelError();
                appendAssistant(turn => {
                    turn.tools.push({ id: event.id, name: event.name, args: event.args });
                });
                break;
            case 'tool_update':
                updateTool(event.id, tool => ({ ...tool, partial: event.partial }));
                break;
            case 'tool_end':
                updateTool(event.id, tool => {
                    const action = writesPipeline(event.name) ? parseToolResult(event.result) : {};
                    return {
                        ...tool,
                        result: event.result,
                        isError: event.is_error,
                        pipelineId: action.pipelineId,
                        pipelinePath: action.pipelinePath,
                    };
                });
                if (
                    !event.is_error &&
                    (event.name === 'mcp__duckle__create_pipeline' ||
                        event.name === 'mcp__duckle__update_pipeline')
                ) {
                    onWorkspaceChanged?.();
                }
                break;
            case 'skill_used':
                appendAssistant(turn => {
                    if (!turn.skills.includes(event.name)) turn.skills.push(event.name);
                });
                break;
            case 'subagent':
                appendAssistant(turn => {
                    const at = turn.subagents.findIndex(item => item.id === event.id);
                    const next: SubagentNode = {
                        id: event.id,
                        task: event.task,
                        status: event.status,
                        result: event.result ?? undefined,
                    };
                    if (at >= 0) turn.subagents[at] = next;
                    else turn.subagents.push(next);
                });
                break;
            case 'ui_request':
                setUiDialog({
                    id: event.id,
                    method: event.method,
                    title: event.title ?? 'Agent input required',
                    message: event.message ?? '',
                    options: event.options ?? [],
                    placeholder: event.placeholder ?? '',
                    value: event.prefill ?? '',
                    timeoutMs: event.timeout_ms ?? undefined,
                });
                break;
            case 'command_failed':
                setError({ message: event.error, needsSettings: false });
                setBusy(false);
                finishTurn();
                break;
            case 'error':
                setError({ message: event.message, needsSettings: false });
                setBusy(false);
                finishTurn();
                break;
            case 'exited':
                // Also fired when settings change, the conversation switches or
                // the agent is stopped on purpose; the next message starts it again.
                setConnected(false);
                connectedRef.current = false;
                startedConversationRef.current = null;
                if (busyRef.current) {
                    setError({ message: 'Pi Agent 进程意外退出，请重新发送。', needsSettings: false });
                }
                setBusy(false);
                break;
            case 'settled':
                setBusy(false);
                finishTurn();
                break;
            case 'message_end':
                appendAssistant(turn => {
                    turn.usage = addUsage(turn.usage, event.usage);
                });
                if (event.error) setError(modelError(event.error));
                else if (event.truncated) {
                    setError({
                        message:
                            '模型这次的输出超过了单次长度上限，被截断了，任务没有完成。可以发送「继续」让它接着做；内容很大时，可以让它先建出可运行的骨架，再分步补充节点。',
                        needsSettings: false,
                        fromModel: true,
                    });
                }
                break;
            case 'ui_notify':
                break;
            default:
                break;
        }
    }

    /** `value` overrides the typed text, for a clicked select option. */
    async function submitUiDialog(action: 'confirm' | 'cancel', value?: string) {
        if (!uiDialog) return;
        const dialog = uiDialog;
        setUiDialog(null);
        try {
            if (dialog.method === 'confirm') {
                await agentUiReply(dialog.id, { confirmed: action === 'confirm' });
                return;
            }
            if (action === 'cancel') {
                await agentUiReply(dialog.id, { cancelled: true });
                return;
            }
            await agentUiReply(dialog.id, { value: value ?? dialog.value });
        } catch (err) {
            setError({ message: String(err), needsSettings: false });
        }
    }

    const uiDialogId = uiDialog?.id;
    const uiDialogTimeout = uiDialog?.timeoutMs;
    useEffect(() => {
        if (!uiDialogId || !uiDialogTimeout) return;
        const timer = window.setTimeout(
            () => setUiDialog(current => (current?.id === uiDialogId ? null : current)),
            uiDialogTimeout,
        );
        return () => window.clearTimeout(timer);
    }, [uiDialogId, uiDialogTimeout]);

    async function handleSend() {
        const trimmed = draft.trim();
        if (!trimmed || !workspace || busy) return;
        const connection = connections.find(item => item.id === selectedConnectionId) ?? null;
        const context: AgentContext = {
            workspace,
            connection,
            selectedAssets: [],
        };
        const conversationId = activeId ?? newConversationId();
        if (!activeId) setActiveId(conversationId);
        setMessages(prev => [...prev, { kind: 'user', text: trimmed }]);
        resetRecall();
        currentTurnIdRef.current = null;
        turnStartedAtRef.current = Date.now();
        setBusy(true);
        setError(null);
        setDraft('');
        const startFailure = await ensureStarted(conversationId);
        if (startFailure) {
            setBusy(false);
            setError(startFailure);
            return;
        }
        try {
            await agentSendPrompt(trimmed, context);
        } catch (err) {
            setBusy(false);
            setError({ message: String(err), needsSettings: false });
        }
    }

    // Shown in the composer area, above the input, so the user answers without
    // leaving the conversation.
    const uiRequestCard = uiDialog ? (
        <div className="agent-ui-request" role="group" aria-label={uiDialog.title}>
            <div className="agent-ui-request-head">
                <AlertCircle size={14} aria-hidden="true" />
                <span className="agent-ui-request-title">{uiDialog.title}</span>
            </div>
            {uiDialog.message ? <div className="agent-ui-request-message">{uiDialog.message}</div> : null}
            {uiDialog.method === 'input' ? (
                <input
                    className="chat-panel-model-select agent-ui-request-field"
                    value={uiDialog.value}
                    placeholder={uiDialog.placeholder}
                    autoFocus
                    onChange={event =>
                        setUiDialog(current => (current ? { ...current, value: event.target.value } : current))
                    }
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            void submitUiDialog('confirm');
                        }
                    }}
                />
            ) : uiDialog.method === 'editor' ? (
                <textarea
                    className="chat-panel-model-select agent-ui-request-field"
                    rows={5}
                    value={uiDialog.value}
                    placeholder={uiDialog.placeholder}
                    autoFocus
                    onChange={event =>
                        setUiDialog(current => (current ? { ...current, value: event.target.value } : current))
                    }
                />
            ) : null}
            <div className="agent-ui-request-actions">
                {uiDialog.method === 'select' ? (
                    <>
                        {uiDialog.options.map(option => (
                            <button
                                key={option}
                                type="button"
                                className="agent-ui-request-btn"
                                onClick={() => void submitUiDialog('confirm', option)}
                            >
                                {option}
                            </button>
                        ))}
                        <button
                            type="button"
                            className="agent-ui-request-btn"
                            onClick={() => void submitUiDialog('cancel')}
                        >
                            取消
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            className="agent-ui-request-btn"
                            onClick={() => void submitUiDialog('cancel')}
                        >
                            {uiDialog.method === 'confirm' ? '拒绝' : '取消'}
                        </button>
                        <button
                            type="button"
                            className="agent-ui-request-btn agent-ui-request-btn-primary"
                            onClick={() => void submitUiDialog('confirm')}
                            autoFocus={uiDialog.method === 'confirm'}
                        >
                            {uiDialog.method === 'confirm' ? '允许' : '提交'}
                        </button>
                    </>
                )}
            </div>
        </div>
    ) : null;

    if (!open) return null;

    const ready = setup.phase === 'ready';

    return (
        <aside
            className={`chat-panel agent-chat-panel ${dragging ? 'chat-panel-dragging' : ''} ${
                resizing ? 'chat-panel-resizing' : ''
            } ${layout.collapsed ? 'chat-panel-collapsed' : ''} ${layout.maximized ? 'chat-panel-maximized' : ''}`}
            role="complementary"
            aria-label="Pi Agent"
            style={panelStyle}
        >
            <header className="chat-panel-head" {...headerProps}>
                <div className="chat-panel-title-wrap">
                    <div className="chat-panel-title">
                        <Bot size={14} aria-hidden="true" />
                        <span>Pi Agent</span>
                        {ready && connected ? <span className="chat-panel-tag">已连接</span> : null}
                        {ready && !layout.collapsed ? (
                            <button
                                type="button"
                                className="chat-panel-head-btn"
                                onClick={toggleSidebar}
                                title={layout.sidebar ? '隐藏历史对话' : '显示历史对话'}
                                aria-label={layout.sidebar ? '隐藏历史对话' : '显示历史对话'}
                                aria-pressed={layout.sidebar}
                            >
                                {layout.sidebar ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
                            </button>
                        ) : null}
                    </div>
                    {busy ? (
                        <div className="chat-panel-meta">
                            <span className="chat-panel-meta-pill chat-panel-meta-pill-live">
                                Pi Agent 正在处理
                                <ProcessingDots />
                            </span>
                        </div>
                    ) : null}
                </div>
                <div className="chat-panel-head-actions">
                    <span className="chat-panel-drag-hint">拖动 / 吸附</span>
                    <button
                        type="button"
                        className="chat-panel-head-btn"
                        onClick={toggleCollapsed}
                        title={layout.collapsed ? '还原 Pi Agent' : '最小化 Pi Agent'}
                        aria-label={layout.collapsed ? '还原 Pi Agent' : '最小化 Pi Agent'}
                    >
                        {layout.collapsed ? <ChevronDown size={14} /> : <Minus size={14} />}
                    </button>
                    <button
                        type="button"
                        className="chat-panel-head-btn"
                        onClick={toggleMaximized}
                        title={layout.maximized ? '还原 Pi Agent 窗口大小' : '最大化 Pi Agent'}
                        aria-label={layout.maximized ? '还原 Pi Agent 窗口大小' : '最大化 Pi Agent'}
                        aria-pressed={layout.maximized}
                    >
                        {layout.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button
                        type="button"
                        className="chat-panel-close"
                        onClick={onClose}
                        title="关闭"
                        aria-label="关闭"
                    >
                        <X size={14} />
                    </button>
                </div>
            </header>

            {layout.collapsed ? (
                <div className="chat-panel-collapsed-bar">
                    <span>Pi Agent 已最小化</span>
                    {busy ? (
                        <span className="chat-panel-collapsed-pill">
                            正在处理
                            <ProcessingDots />
                        </span>
                    ) : null}
                </div>
            ) : setup.phase === 'checking' ? (
                <div className="chat-panel-state">
                    <Loader2 size={18} className="spin" />
                    <span>正在检查 Pi Agent 运行环境…</span>
                </div>
            ) : setup.phase === 'not-installed' || setup.phase === 'install-failed' ? (
                <div className="chat-panel-setup">
                    <div className="chat-panel-setup-icon">
                        <Bot size={20} />
                    </div>
                    <div className="chat-panel-setup-title">
                        {setup.phase === 'install-failed' ? '安装失败' : '安装 Pi Agent'}
                    </div>
                    <div className="chat-panel-setup-body">
                        {setup.phase === 'install-failed'
                            ? setup.message
                            : '首次使用需要下载 Node.js 运行时和 Pi Agent（约 75 MB 下载，解压后约 350 MB），安装在 Duckle 自己的数据目录中。'}
                    </div>
                    <button type="button" className="chat-panel-setup-cta" onClick={() => void handleInstall()}>
                        <Download size={14} /> {setup.phase === 'install-failed' ? '重新安装' : '安装'}
                    </button>
                    <div className="chat-panel-setup-foot">
                        Pi Agent 使用「设置 → AI assistant」中的 External OpenAI 模型。
                    </div>
                </div>
            ) : setup.phase === 'installing' ? (
                <div className="chat-panel-state chat-panel-state-install">
                    <Loader2 size={18} className="spin" />
                    <InstallProgressBar progress={setup.progress} />
                </div>
            ) : (
                <div className="chat-panel-body">
                    {layout.sidebar ? (
                        <ConversationSidebar
                            conversations={conversations}
                            activeId={activeId}
                            busy={busy}
                            hasWorkspace={!!workspace}
                            error={historyError}
                            onNew={startNewConversation}
                            onOpen={id => void openConversation(id)}
                            onRename={renameConversation}
                            onTogglePin={togglePinned}
                            onDelete={deleteConversation}
                        />
                    ) : null}
                    <div className="chat-panel-main">
                        {resizing ? (
                            <div className="chat-panel-size-indicator" aria-live="polite">
                                {Math.round(layout.width)} × {Math.round(layout.height)}
                            </div>
                        ) : null}
                        <div className="agent-context">
                            <label className="chat-panel-model">
                                <span className="chat-panel-model-label">数据连接</span>
                                <select
                                    className="chat-panel-model-select"
                                    value={selectedConnectionId}
                                    onChange={event => setSelectedConnectionId(event.target.value)}
                                >
                                    <option value="">不指定</option>
                                    {connections.map(connection => (
                                        <option key={connection.id} value={connection.id}>
                                            {connectionLabel(connection)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>

                        <div ref={scrollRef} className="chat-panel-scroll">
                            {messages.length === 0 ? (
                                <div className="chat-panel-empty">
                                    <Workflow size={26} className="chat-panel-empty-icon" />
                                    <div className="chat-panel-empty-title">让 Pi Agent 处理 pipeline</div>
                                    <div className="chat-panel-empty-hint">
                                        描述需求即可：创建、检查、运行或排查 pipeline。上方选择的数据连接会一并发给 Agent。
                                    </div>
                                    <div className="chat-panel-prompts">
                                        {EXAMPLE_PROMPTS.map(prompt => (
                                            <button
                                                key={prompt}
                                                type="button"
                                                className="chat-panel-prompt"
                                                onClick={() => setDraft(prompt)}
                                            >
                                                {prompt}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                messages.map((message, index) =>
                                    message.kind === 'user' ? (
                                        <div key={index} className="chat-bubble chat-bubble-user">
                                            <div className="chat-bubble-head">
                                                <div className="chat-bubble-head-main">
                                                    <span>你</span>
                                                </div>
                                            </div>
                                            <div className="chat-bubble-body">
                                                <div className="chat-bubble-content agent-pre">{message.text}</div>
                                            </div>
                                        </div>
                                    ) : (
                                        <AssistantBubble
                                            key={index}
                                            turn={message.turn}
                                            live={busy && index === messages.length - 1}
                                            onOpenPipeline={onOpenPipeline}
                                        />
                                    ),
                                )
                            )}
                            {error ? (
                                <div className="chat-status-card chat-status-error agent-error">
                                    <div className="chat-status-main">
                                        <span className="chat-status-icon">
                                            <AlertCircle size={12} />
                                        </span>
                                        <div className="chat-status-copy">
                                            <div className="chat-status-label">
                                                {error.fromModel ? '模型调用失败' : error.needsSettings ? '未配置模型' : '出错了'}
                                            </div>
                                            <div className="chat-status-detail agent-pre">{error.message}</div>
                                        </div>
                                    </div>
                                    {error.needsSettings && onOpenSettings ? (
                                        <button type="button" className="chat-status-action" onClick={onOpenSettings}>
                                            打开设置
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>

                        <form
                            className="chat-panel-form"
                            onSubmit={event => {
                                event.preventDefault();
                                void handleSend();
                            }}
                        >
                            {uiRequestCard ??
                                (busy ? (
                                    <div className="chat-panel-live-banner" aria-live="polite">
                                        <span className="chat-panel-live-dot" />
                                        <span>
                                            Pi Agent 正在处理
                                            <ProcessingDots />
                                        </span>
                                    </div>
                                ) : null)}
                            <div className="chat-panel-input-row">
                                <textarea
                                    ref={inputRef}
                                    className="chat-panel-input"
                                    value={draft}
                                    onChange={event => {
                                        // Editing a recalled input makes it the new draft.
                                        resetRecall();
                                        setDraft(event.target.value);
                                        syncComposerHeight(event.currentTarget);
                                    }}
                                    rows={2}
                                    disabled={busy}
                                    placeholder={
                                        '描述你想让 Pi Agent 完成的 pipeline 工作…'
                                    }
                                    onKeyDown={event => {
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            void handleSend();
                                            return;
                                        }
                                        handleRecallKey(event);
                                    }}
                                />
                                {busy ? (
                                    <button
                                        type="button"
                                        className="chat-panel-send"
                                        onClick={() => void agentAbort()}
                                        title="停止"
                                        aria-label="停止"
                                    >
                                        <Square size={14} />
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        className="chat-panel-send"
                                        disabled={!draft.trim()}
                                        title="发送 (Enter)"
                                        aria-label="发送"
                                    >
                                        <Send size={14} />
                                    </button>
                                )}
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {resizeHandles}
        </aside>
    );
}

/** Three dots that pulse in turn after "正在处理", so a long run looks alive. */
function ProcessingDots() {
    return (
        <span className="agent-processing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
        </span>
    );
}

function AssistantBubble({
    turn,
    live,
    onOpenPipeline,
}: {
    turn: AssistantTurn;
    live: boolean;
    onOpenPipeline?: (pipelineId: string) => void;
}) {
    const hasStatus = turn.tools.length > 0 || turn.subagents.length > 0 || turn.skills.length > 0;
    return (
        <div className="chat-bubble chat-bubble-assistant">
            <div className="chat-bubble-head">
                <div className="chat-bubble-head-main">
                    <Bot size={12} aria-hidden="true" />
                    <span>Pi Agent</span>
                </div>
                <span className={`chat-bubble-phase ${live ? 'chat-bubble-phase-live' : ''}`}>
                    {live ? '处理中' : '已完成'}
                </span>
            </div>
            {turn.thinking ? (
                <details className="agent-thinking">
                    <summary>思考过程</summary>
                    <div className="agent-pre">{turn.thinking}</div>
                </details>
            ) : null}
            {turn.text ? (
                <div className="chat-bubble-body">
                    <div className="chat-bubble-content agent-pre">
                        {turn.text}
                        {live ? <span className="chat-caret" /> : null}
                    </div>
                </div>
            ) : null}
            {hasStatus ? (
                <div className="chat-bubble-status" aria-live="polite">
                    <div className="chat-status-heading">{live ? '执行进度' : '本轮执行记录'}</div>
                    {turn.skills.map(skill => (
                        <div key={`skill-${skill}`} className="chat-status-card chat-status-info">
                            <div className="chat-status-main">
                                <span className="chat-status-icon">
                                    <Sparkles size={12} />
                                </span>
                                <div className="chat-status-copy">
                                    <div className="chat-status-label">使用技能 {skill}</div>
                                </div>
                            </div>
                        </div>
                    ))}
                    {turn.tools.map(tool => {
                        const tone = tool.isError ? 'error' : tool.result !== undefined ? 'done' : 'running';
                        const subagent = turn.subagents.find(item => item.id === tool.id);
                        return (
                            <div
                                key={tool.id}
                                className={`chat-status-card chat-status-${tone} ${
                                    tool.pipelineId ? 'chat-status-card-result' : ''
                                }`}
                            >
                                <div className="chat-status-main">
                                    <span className="chat-status-icon">
                                        {tone === 'running' ? (
                                            <Loader2 size={12} className="spin" />
                                        ) : tone === 'error' ? (
                                            <AlertCircle size={12} />
                                        ) : subagent ? (
                                            <Bot size={12} />
                                        ) : tool.pipelineId ? (
                                            <Workflow size={12} />
                                        ) : (
                                            <Wrench size={12} />
                                        )}
                                    </span>
                                    <div className="chat-status-copy">
                                        {tool.pipelineId ? <div className="chat-status-result-badge">结果</div> : null}
                                        <div className="chat-status-label">
                                            {subagent ? `子 Agent · ${subagent.task}` : humanizeTool(tool.name)}
                                        </div>
                                        <details className="chat-status-detail agent-tool-detail">
                                            <summary>{tone === 'running' ? '参数' : '详情'}</summary>
                                            <pre>{formatJson(tool.result ?? tool.partial ?? tool.args)}</pre>
                                        </details>
                                    </div>
                                </div>
                                {tool.pipelineId && onOpenPipeline ? (
                                    <button
                                        type="button"
                                        className="chat-status-action"
                                        onClick={() => onOpenPipeline(tool.pipelineId!)}
                                    >
                                        打开
                                    </button>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {!live && turn.finishedAt && (turn.text || turn.usage) ? (
                <ReplyFooter
                    text={turn.text}
                    usage={turn.usage}
                    startedAt={turn.startedAt}
                    finishedAt={turn.finishedAt}
                    reportedTitle="由模型服务上报的 token 用量"
                    estimateTitle="模型服务未上报 token 用量，这是按回复长度估算的值"
                />
            ) : null}
        </div>
    );
}

const TOOL_LABELS: Record<string, string> = {
    create_pipeline: '创建 pipeline',
    update_pipeline: '更新 pipeline',
    validate_pipeline: '校验 pipeline',
    verify_pipeline: '验证 pipeline',
    run_pipeline: '运行 pipeline',
    read_pipeline: '读取 pipeline',
    list_pipelines: '列出 pipeline',
    list_components: '列出组件',
    get_component_schema: '读取组件 schema',
    check_node_sql: '检查节点 SQL',
    read_run_logs: '读取运行日志',
    list_connections: '列出连接',
    read: '读取文件',
};

function humanizeTool(name: string): string {
    const short = toolLabel(name);
    return TOOL_LABELS[short] ?? short;
}

function formatJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? '';
    } catch {
        return String(value);
    }
}

function InstallProgressBar({ progress }: { progress: InstallProgress | null }) {
    const pct =
        progress?.phase === 'downloading' && progress.total
            ? Math.round((progress.received / progress.total) * 100)
            : null;
    return (
        <div className="chat-panel-install-progress">
            <div className="chat-panel-install-bar">
                <div
                    className="chat-panel-install-fill"
                    style={{ width: pct != null ? `${pct}%` : '30%' }}
                    data-indeterminate={pct == null}
                />
            </div>
            <div className="chat-panel-install-label">{installLabel(progress)}</div>
        </div>
    );
}
