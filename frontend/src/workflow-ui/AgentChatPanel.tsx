import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import {
    AlertCircle,
    ArrowUp,
    Bot,
    ChevronDown,
    ChevronUp,
    Database,
    Download,
    Loader2,
    Maximize2,
    Minimize2,
    Minus,
    Paperclip,
    PanelLeftClose,
    Plus,
    PanelLeftOpen,
    Sparkles,
    Square,
    Workflow,
    Wrench,
    X,
} from 'lucide-react';
import {
    agentAbort,
    agentAttachFiles,
    agentCheckAttachments,
    agentCheckInstalled,
    agentConversationDelete,
    agentConversationGet,
    agentConversationSave,
    agentConversationsList,
    agentConversationUpdateMeta,
    agentInstall,
    agentListSkills,
    agentSendPrompt,
    agentStart,
    agentStop,
    agentUiReply,
    pickAgentAttachments,
    type AgentAttachment,
    type AgentConnectionContext,
    type AgentContext,
    type AgentEvent,
    type AgentEventEnvelope,
    type AgentSkill,
    type DuckieConversationSummary,
    type InstallProgress,
} from '../tauri-bridge';
import type { RepoItem } from '../repo-types';
import { getWorkspacePath } from '../workspace';
import ConversationSidebar from './ConversationSidebar';
import { SkillCommandMenu, looksLikeSkillCommand, matchSkills, skillCommand, slashQuery } from './AgentSkillMenu';
import ReplyFooter, { type ReplyUsage } from './ReplyFooter';
import { syncComposerHeight, useInputRecall } from './composer';
import { useFloatingPanel } from './floating-panel';
import { useMaximized } from './maximize';
import type { ComponentDef } from './palette-data';
import {
    ConnectionDialog,
    DataSourceMenu,
    NoSourceDialog,
    PickedChips,
    RoleDialog,
    connectionKindOf,
    connectionsOfKind,
    type PickedSource,
    type SourceRole,
} from './AgentDataSources';

type Props = {
    workspace: string | null;
    open: boolean;
    onClose: () => void;
    onOpenPipeline?: (pipelineId: string) => void;
    onWorkspaceChanged?: () => void;
    /** Opens Settings, where the External OpenAI model the agent uses is configured. */
    onOpenSettings?: () => void;
    /** The workspace's saved connections. */
    connections?: RepoItem[];
    /** Save a connection (id null = new) to the connection store; resolves to its id. */
    onSaveConnection?: (id: string | null, name: string, payload: Record<string, unknown>) => Promise<string>;
    /** `side`: docked as a tool window beside the canvas, filling its
     *  container, instead of a floating, draggable window. */
    placement?: 'floating' | 'side';
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
    let message = i18n.t('agent.error.model', { raw });
    if (lower.includes('insufficient_quota') || lower.includes('quota exhausted') || lower.includes('quota')) {
        message = i18n.t('agent.error.quota', { raw });
    } else if (lower.startsWith('401') || lower.includes('invalid api key') || lower.includes('unauthorized')) {
        message = i18n.t('agent.error.apiKey', { raw });
    } else if (lower.startsWith('429') || lower.includes('rate limit')) {
        message = i18n.t('agent.error.rateLimit', { raw });
    }
    return { message, needsSettings: true, fromModel: true };
}

/** Turn a failed start into what the user should do about it. */
function startError(raw: string): ChatError {
    if (raw.includes('agent_llm_not_configured')) {
        return {
            message: i18n.t('agent.error.llmNotConfigured'),
            needsSettings: true,
        };
    }
    if (raw.includes('nodejs_not_installed') || raw.includes('pi_not_installed')) {
        return { message: i18n.t('agent.error.runtimeIncomplete'), needsSettings: false };
    }
    return { message: i18n.t('agent.error.startFailed', { raw }), needsSettings: false };
}

type Message =
    | { kind: 'user'; text: string; attachments?: AgentAttachment[] }
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
const NO_CONNECTIONS: RepoItem[] = [];

/** The panel shrinks down to its header, one line of conversation and the
 *  input; the styles drop the empty-state art and spacing as it gets short
 *  (see .agent-chat-panel in styles.css). Minimized, it docks at that size
 *  along the bottom of the window. */
const AGENT_PANEL_LIMITS = { minWidth: 300, minHeight: 170, autoHideSidebar: true, dockHeight: 150 };

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
    picked: PickedSource[];
} {
    try {
        const raw = localStorage.getItem(selectionKey(workspace));
        if (!raw) return { draft: '', picked: [] };
        const parsed = JSON.parse(raw) as { draft?: unknown; picked?: unknown };
        const roles = new Set<string>(['source', 'target', 'both']);
        const picked = Array.isArray(parsed.picked)
            ? parsed.picked.filter(
                  (p): p is PickedSource =>
                      !!p && typeof p.id === 'string' && typeof p.role === 'string' && roles.has(p.role),
              )
            : [];
        return { draft: typeof parsed.draft === 'string' ? parsed.draft : '', picked };
    } catch {
        return { draft: '', picked: [] };
    }
}

/** What the agent is told about a picked connection: never its secrets. */
function connectionContext(item: RepoItem, role: SourceRole): AgentConnectionContext {
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof p[k] === 'string' && p[k] ? String(p[k]) : null);
    return {
        id: item.id,
        name: item.name,
        kind: text('kind'),
        host: text('host'),
        port: p.port === undefined || p.port === null || p.port === '' ? null : String(p.port),
        database: text('database'),
        schema: text('schema'),
        role,
    };
}

function installLabel(progress: InstallProgress | null): string {
    if (!progress) return i18n.t('agent.install.preparing');
    switch (progress.phase) {
        case 'downloading':
            return progress.total
                ? i18n.t('agent.install.downloadingOf', {
                      received: Math.round(progress.received / 1_000_000),
                      total: Math.round(progress.total / 1_000_000),
                  })
                : i18n.t('agent.install.downloading', { received: Math.round(progress.received / 1_000_000) });
        case 'extracting':
            return i18n.t('agent.install.extracting');
        case 'verifying':
            return i18n.t('agent.install.verifying');
        case 'running_command':
            return progress.label;
        case 'installing_extension':
            return i18n.t('agent.install.extension', { index: progress.index, total: progress.total });
        case 'downloading_model':
            return i18n.t('agent.install.model');
        case 'done':
            return i18n.t('agent.install.done');
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

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function deriveConversationTitle(messages: Message[]): string {
    const firstMessage = messages.find((m): m is Extract<Message, { kind: 'user' }> => m.kind === 'user');
    // A message of attachments alone is titled by their names.
    const first = firstMessage?.text || (firstMessage?.attachments ?? []).map(a => a.name).join(', ');
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
            const attachments = Array.isArray(m.attachments)
                ? m.attachments.filter(
                      (a): a is AgentAttachment =>
                          !!a && typeof a.name === 'string' && typeof a.path === 'string' && typeof a.size === 'number',
                  )
                : [];
            out.push(attachments.length ? { kind: 'user', text: m.text, attachments } : { kind: 'user', text: m.text });
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
                        tool.result === undefined ? { ...tool, result: i18n.t('agent.interrupted'), isError: true } : tool,
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
    connections = NO_CONNECTIONS,
    onSaveConnection,
    placement = 'floating',
}: Props) {
    const { t } = useTranslation();
    const workspace = useMemo(() => workspaceProp ?? getWorkspacePath(), [workspaceProp]);
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState('');
    const [messages, setMessages] = useState<Message[]>([]);
    /** The databases picked for the next message, and what each is for. */
    const [picked, setPicked] = useState<PickedSource[]>([]);
    const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
    const [sourceDialog, setSourceDialog] = useState<ComponentDef | null>(null);
    /** A connection waiting for the user to say what it is for. */
    const [roleFor, setRoleFor] = useState<string | null>(null);
    const [noSourcePrompt, setNoSourcePrompt] = useState(false);
    /** Conversations whose user said they need no database: asked once each. */
    const noSourceOkRef = useRef(new Set<string>());
    /** The user was sent to pick a database by the "no data source" prompt:
     *  the message goes out once they have. */
    const pendingSendRef = useRef(false);
    const sourceButtonRef = useRef<HTMLButtonElement | null>(null);
    /** Files picked for the next message, by path; copied when it is sent. */
    const [pendingFiles, setPendingFiles] = useState<string[]>([]);
    const [attaching, setAttaching] = useState(false);
    /** The workspace's skills, re-read while the input holds a `/command`. */
    const [skills, setSkills] = useState<AgentSkill[] | null>(null);
    const [skillActive, setSkillActive] = useState(0);
    /** Escape closes the skill menu until the input stops being a `/command`. */
    const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
    const composerRef = useRef<HTMLDivElement | null>(null);
    const [error, setError] = useState<ChatError | null>(null);
    const [uiDialog, setUiDialog] = useState<UiDialog | null>(null);
    const [startNonce, setStartNonce] = useState(0);
    const [conversations, setConversations] = useState<DuckieConversationSummary[]>([]);
    /** null = a new chat that has not been saved yet. */
    const [activeId, setActiveId] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const {
        layout,
        docked,
        panelStyle,
        dragging,
        resizing,
        headerProps,
        resizeHandles,
        toggleCollapsed,
        toggleMaximized,
        toggleSidebar: toggleFloatingSidebar,
        sidebarShown: floatingSidebarShown,
    } = useFloatingPanel('pi-agent-panel-position', 'Agent', AGENT_PANEL_LIMITS);
    const side = placement === 'side';
    // Docked, the panel can also cover everything below the top bar.
    const [sideMaximized, setSideMaximized] = useMaximized(open && side);
    // An opened pipeline shows on the canvas, so a maximized panel steps aside.
    const openPipeline = onOpenPipeline
        ? (pipelineId: string) => {
              setSideMaximized(false);
              onOpenPipeline(pipelineId);
          }
        : undefined;
    // Docked beside the canvas, the history sidebar is simply on or off: the
    // tool window's width is the user's, so it is not grown to make room. It
    // starts closed every time the Agent window opens.
    const [sideSidebar, setSideSidebar] = useState(false);
    useEffect(() => {
        if (open) setSideSidebar(false);
    }, [open]);
    const sidebarShown = side ? sideSidebar : floatingSidebarShown;
    const toggleSidebar = () => {
        if (!side) {
            toggleFloatingSidebar();
            return;
        }
        setSideSidebar(prev => !prev);
    };
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

    const skillQuery = busy ? null : slashQuery(draft);
    const skillMatches = useMemo(
        () => (skillQuery === null || !skills ? [] : matchSkills(skills, skillQuery)),
        [skills, skillQuery],
    );
    const skillMenuOpen =
        skillQuery !== null &&
        skills !== null &&
        !skillMenuDismissed &&
        (skillMatches.length > 0 || looksLikeSkillCommand(skillQuery));
    const skillsDir = workspace
        ? [workspace.replace(/[\\/]+$/, ''), '.duckle', 'skills'].join(workspace.includes('\\') ? '\\' : '/')
        : '.duckle/skills';

    useEffect(() => setSkills(null), [workspace]);

    // Read from disk on every keystroke of a `/command`, so a skill added or
    // edited while the app runs is offered at once.
    useEffect(() => {
        if (skillQuery === null || !workspace) return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void agentListSkills(workspace).then(list => {
                if (!cancelled) setSkills(list);
            });
        }, 80);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [skillQuery, workspace]);

    useEffect(() => {
        setSkillActive(0);
        if (skillQuery === null) setSkillMenuDismissed(false);
    }, [skillQuery]);

    const pickSkill = (skill: AgentSkill) => {
        const next = `${skillCommand(skill)} `;
        resetRecall();
        setDraft(next);
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(next.length, next.length);
        });
    };

    /** The skill menu's keys; true when the key was handled. */
    const handleSkillKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!skillMenuOpen) return false;
        const count = skillMatches.length;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSkillMenuDismissed(true);
            return true;
        }
        if (count === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setSkillActive(i => (i + step + count) % count);
            return true;
        }
        if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
            event.preventDefault();
            pickSkill(skillMatches[Math.min(skillActive, count - 1)]);
            return true;
        }
        return false;
    };

    // Also on resize: the composer's own size limits change with the panel's.
    useEffect(() => {
        syncComposerHeight(inputRef.current);
    }, [draft, open, layout.collapsed, layout.width, layout.height, panelStyle.width, panelStyle.height]);

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
        setPicked(saved.picked);
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

    // Esc closes the panel, like Duckie's; a maximized panel is restored
    // first. The history menu handles its own Escape first.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || uiDialog) return;
            if (sideMaximized) setSideMaximized(false);
            else onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, uiDialog, sideMaximized, setSideMaximized]);

    useEffect(() => {
        if (!workspace) return;
        localStorage.setItem(selectionKey(workspace), JSON.stringify({ draft, picked }));
    }, [draft, picked, workspace]);

    // A picked connection that has since been deleted is dropped.
    const livePicked = useMemo(
        () => picked.filter(p => connections.some(c => c.id === p.id)),
        [picked, connections],
    );

    useEffect(() => {
        if (!pendingSendRef.current || livePicked.length === 0) return;
        pendingSendRef.current = false;
        void handleSend();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [livePicked]);

    // Opening the panel checks the runtime. The agent itself starts on the
    // first message, on that conversation's own Pi session, and any start
    // failure is reported in the chat then.
    useEffect(() => {
        if (!open || !workspace) return;
        let cancelled = false;
        (async () => {
            const installed = await agentCheckInstalled();
            if (cancelled) return;
            setSetup(installed ? { phase: 'ready' } : { phase: 'not-installed' });
        })();
        return () => {
            cancelled = true;
        };
    }, [open, workspace, startNonce]);

    /** Run the agent on this conversation's session. Returns why it could not. */
    async function ensureStarted(conversationId: string): Promise<ChatError | null> {
        if (connectedRef.current && startedConversationRef.current === conversationId) return null;
        if (!workspace) return { message: t('agent.error.noWorkspace'), needsSettings: false };
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
                    setError({ message: t('agent.error.exited'), needsSettings: false });
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
                            t('agent.error.truncated'),
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

    /** `noSourceOk`: the user has just said this message needs no database. */
    async function handleSend(noSourceOk = false) {
        const trimmed = draft.trim();
        const files = pendingFiles;
        if ((!trimmed && files.length === 0) || !workspace || busy || attaching) return;
        const conversationId = activeId ?? newConversationId();
        if (noSourceOk) noSourceOkRef.current.add(conversationId);
        // Ask once per conversation; picking a database or saying "none" both
        // answer it.
        if (livePicked.length === 0 && !noSourceOkRef.current.has(conversationId)) {
            setNoSourcePrompt(true);
            return;
        }
        const picks = livePicked.flatMap(p => {
            const item = connections.find(c => c.id === p.id);
            return item ? [connectionContext(item, p.role)] : [];
        });
        let attachments: AgentAttachment[] = [];
        if (files.length > 0) {
            setAttaching(true);
            try {
                attachments = await agentAttachFiles(workspace, conversationId, files);
            } catch (err) {
                setError({ message: t('agent.attach.failed', { message: String(err) }), needsSettings: false });
                return;
            } finally {
                setAttaching(false);
            }
        }
        const context: AgentContext = {
            workspace,
            connection: null,
            connections: picks,
            selectedAssets: [],
            attachments,
        };
        // A message of attachments alone still asks the agent something.
        const prompt = trimmed || t('agent.attach.defaultPrompt');
        if (!activeId) setActiveId(conversationId);
        setMessages(prev => [
            ...prev,
            attachments.length ? { kind: 'user', text: trimmed, attachments } : { kind: 'user', text: trimmed },
        ]);
        setPendingFiles([]);
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
            await agentSendPrompt(prompt, context);
        } catch (err) {
            setBusy(false);
            setError({ message: String(err), needsSettings: false });
        }
    }

    async function handleAttach() {
        try {
            const picked = await pickAgentAttachments();
            // Executables and files over the workspace's size limit are turned
            // away now rather than when the message is sent.
            const rejected = workspace ? await agentCheckAttachments(workspace, picked) : [];
            const refused = new Set(rejected.map(r => r.path));
            const paths = picked.filter(p => !refused.has(p));
            if (paths.length) setPendingFiles(prev => [...prev, ...paths.filter(p => !prev.includes(p))]);
            if (rejected.length) {
                setError({
                    message: t('agent.attach.failed', { message: rejected.map(r => r.error).join('; ') }),
                    needsSettings: false,
                });
            }
        } catch (err) {
            setError({ message: t('agent.attach.failed', { message: String(err) }), needsSettings: false });
        }
        inputRef.current?.focus();
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
                            {t('common.cancel')}
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            className="agent-ui-request-btn"
                            onClick={() => void submitUiDialog('cancel')}
                        >
                            {uiDialog.method === 'confirm' ? t('agent.dialog.deny') : t('common.cancel')}
                        </button>
                        <button
                            type="button"
                            className="agent-ui-request-btn agent-ui-request-btn-primary"
                            onClick={() => void submitUiDialog('confirm')}
                            autoFocus={uiDialog.method === 'confirm'}
                        >
                            {uiDialog.method === 'confirm' ? t('agent.dialog.allow') : t('agent.dialog.submit')}
                        </button>
                    </>
                )}
            </div>
        </div>
    ) : null;

    if (!open) return null;

    const ready = setup.phase === 'ready';
    // Docked, a ready panel keeps its conversation and input; anything else
    // (installing, checking) shrinks to the header as before.
    const headerOnly = !side && layout.collapsed && !(docked && ready);
    const floatingClasses = side
        ? 'agent-chat-panel-side'
        : `${dragging ? 'chat-panel-dragging' : ''} ${resizing ? 'chat-panel-resizing' : ''} ${
              headerOnly ? 'chat-panel-collapsed' : ''
          } ${docked ? 'chat-panel-docked' : ''} ${layout.maximized ? 'chat-panel-maximized' : ''}`;

    return (
        <aside
            className={`chat-panel agent-chat-panel ${floatingClasses}${side && sideMaximized ? ' tool-maximized' : ''}`}
            role="complementary"
            aria-label="Agent"
            style={side ? undefined : panelStyle}
        >
            <header className="chat-panel-head" {...(side ? {} : headerProps)}>
                <div className="chat-panel-title-wrap">
                    <div className="chat-panel-title">
                        <Bot size={14} aria-hidden="true" />
                        <span>Agent</span>
                        {ready && connected ? <span className="chat-panel-tag">{t('agent.connected')}</span> : null}
                        {ready && !headerOnly ? (
                            <button
                                type="button"
                                className="chat-panel-head-btn"
                                onClick={toggleSidebar}
                                title={sidebarShown ? t('chat.history.hideSidebar') : t('chat.history.showSidebar')}
                                aria-label={sidebarShown ? t('chat.history.hideSidebar') : t('chat.history.showSidebar')}
                                aria-pressed={sidebarShown}
                            >
                                {sidebarShown ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
                            </button>
                        ) : null}
                    </div>
                    {busy ? (
                        <div className="chat-panel-meta">
                            <span className="chat-panel-meta-pill chat-panel-meta-pill-live">
                                {t('agent.busy')}
                                <ProcessingDots />
                            </span>
                        </div>
                    ) : null}
                </div>
                <div className="chat-panel-head-actions">
                    {side ? (
                        <button
                            type="button"
                            className="chat-panel-head-btn"
                            onClick={() => setSideMaximized(m => !m)}
                            title={sideMaximized ? t('panel.restoreSize', { name: 'Agent' }) : t('panel.maximize', { name: 'Agent' })}
                            aria-label={sideMaximized ? t('panel.restoreSize', { name: 'Agent' }) : t('panel.maximize', { name: 'Agent' })}
                            aria-pressed={sideMaximized}
                        >
                            {sideMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                    ) : (
                        <>
                            <span className="chat-panel-drag-hint">{t('panel.dragHint')}</span>
                            <button
                                type="button"
                                className="chat-panel-head-btn"
                                onClick={toggleCollapsed}
                                title={layout.collapsed ? t('panel.restore', { name: 'Agent' }) : t('panel.minimize', { name: 'Agent' })}
                                aria-label={layout.collapsed ? t('panel.restore', { name: 'Agent' }) : t('panel.minimize', { name: 'Agent' })}
                            >
                                {layout.collapsed ? (
                                    docked ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                                ) : (
                                    <Minus size={14} />
                                )}
                            </button>
                            <button
                                type="button"
                                className="chat-panel-head-btn"
                                onClick={toggleMaximized}
                                title={layout.maximized ? t('panel.restoreSize', { name: 'Agent' }) : t('panel.maximize', { name: 'Agent' })}
                                aria-label={layout.maximized ? t('panel.restoreSize', { name: 'Agent' }) : t('panel.maximize', { name: 'Agent' })}
                                aria-pressed={layout.maximized}
                            >
                                {layout.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                            </button>
                        </>
                    )}
                    <button
                        type="button"
                        className="chat-panel-close"
                        onClick={onClose}
                        title={t('common.close')}
                        aria-label={t('common.close')}
                    >
                        <X size={14} />
                    </button>
                </div>
            </header>

            {headerOnly ? (
                <div className="chat-panel-collapsed-bar">
                    <span>{t('panel.minimized', { name: 'Agent' })}</span>
                    {busy ? (
                        <span className="chat-panel-collapsed-pill">
                            {t('agent.working')}
                            <ProcessingDots />
                        </span>
                    ) : null}
                </div>
            ) : setup.phase === 'checking' ? (
                <div className="chat-panel-state">
                    <Loader2 size={18} className="spin" />
                    <span>{t('agent.setup.checking')}</span>
                </div>
            ) : setup.phase === 'not-installed' || setup.phase === 'install-failed' ? (
                <div className="chat-panel-setup">
                    <div className="chat-panel-setup-icon">
                        <Bot size={20} />
                    </div>
                    <div className="chat-panel-setup-title">
                        {setup.phase === 'install-failed' ? t('agent.setup.failedTitle') : t('agent.setup.title')}
                    </div>
                    <div className="chat-panel-setup-body">
                        {setup.phase === 'install-failed'
                            ? setup.message
                            : t('agent.setup.body')}
                    </div>
                    <button type="button" className="chat-panel-setup-cta" onClick={() => void handleInstall()}>
                        <Download size={14} /> {setup.phase === 'install-failed' ? t('agent.setup.reinstall') : t('agent.setup.install')}
                    </button>
                    <div className="chat-panel-setup-foot">
                        {t('agent.setup.foot')}
                    </div>
                </div>
            ) : setup.phase === 'installing' ? (
                <div className="chat-panel-state chat-panel-state-install">
                    <Loader2 size={18} className="spin" />
                    <InstallProgressBar progress={setup.progress} />
                </div>
            ) : (
                <div className="chat-panel-body">
                    {sidebarShown ? (
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
                        <div ref={scrollRef} className="chat-panel-scroll">
                            {messages.length === 0 ? (
                                <div className="chat-panel-empty">
                                    <Workflow size={26} className="chat-panel-empty-icon" />
                                    <div className="chat-panel-empty-title">{t('agent.empty.title')}</div>
                                    <div className="chat-panel-empty-hint">
                                        {t('agent.empty.hint')}
                                    </div>
                                </div>
                            ) : (
                                messages.map((message, index) =>
                                    message.kind === 'user' ? (
                                        <div key={index} className="chat-bubble chat-bubble-user">
                                            <div className="chat-bubble-head">
                                                <div className="chat-bubble-head-main">
                                                    <span>{t('agent.you')}</span>
                                                </div>
                                            </div>
                                            <div className="chat-bubble-body">
                                                {message.attachments?.length ? (
                                                    <div className="agent-attach-list">
                                                        {message.attachments.map(a => (
                                                            <span key={a.path} className="agent-attach-chip" title={a.path}>
                                                                <Paperclip size={11} aria-hidden="true" />
                                                                <span className="agent-attach-name">{a.name}</span>
                                                                <span className="agent-attach-size">{formatBytes(a.size)}</span>
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : null}
                                                {message.text ? (
                                                    <div className="chat-bubble-content agent-pre">{message.text}</div>
                                                ) : null}
                                            </div>
                                        </div>
                                    ) : (
                                        <AssistantBubble
                                            key={index}
                                            turn={message.turn}
                                            live={busy && index === messages.length - 1}
                                            onOpenPipeline={openPipeline}
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
                                                {error.fromModel
                                                    ? t('agent.errorTitle.model')
                                                    : error.needsSettings
                                                      ? t('agent.errorTitle.noModel')
                                                      : t('agent.errorTitle.generic')}
                                            </div>
                                            <div className="chat-status-detail agent-pre">{error.message}</div>
                                        </div>
                                    </div>
                                    {error.needsSettings && onOpenSettings ? (
                                        <button type="button" className="chat-status-action" onClick={onOpenSettings}>
                                            {t('agent.openSettings')}
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="chat-status-dismiss"
                                        onClick={() => setError(null)}
                                        title={t('common.close')}
                                        aria-label={t('common.close')}
                                    >
                                        <X size={12} />
                                    </button>
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
                                            {t('agent.busy')}
                                            <ProcessingDots />
                                        </span>
                                    </div>
                                ) : null)}
                            <div ref={composerRef} className="chat-panel-input-row agent-composer">
                                {pendingFiles.length ? (
                                    <div className="agent-attach-list agent-attach-pending">
                                        {pendingFiles.map(path => (
                                            <span key={path} className="agent-attach-chip" title={path}>
                                                <Paperclip size={11} aria-hidden="true" />
                                                <span className="agent-attach-name">{fileName(path)}</span>
                                                <button
                                                    type="button"
                                                    className="agent-attach-remove"
                                                    onClick={() => setPendingFiles(prev => prev.filter(p => p !== path))}
                                                    disabled={attaching}
                                                    title={t('agent.attach.remove')}
                                                    aria-label={t('agent.attach.remove')}
                                                >
                                                    <X size={11} />
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
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
                                    rows={1}
                                    disabled={busy}
                                    placeholder={t('agent.placeholder')}
                                    onKeyDown={event => {
                                        if (handleSkillKey(event)) return;
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            void handleSend();
                                            return;
                                        }
                                        handleRecallKey(event);
                                    }}
                                />
                                {skillMenuOpen ? (
                                    <SkillCommandMenu
                                        anchor={composerRef.current}
                                        items={skillMatches}
                                        total={skills?.length ?? 0}
                                        active={skillActive}
                                        skillsDir={skillsDir}
                                        onPick={pickSkill}
                                        onHover={setSkillActive}
                                    />
                                ) : null}
                                <div className="agent-composer-toolbar">
                                    <button
                                        type="button"
                                        className="agent-attach-button"
                                        onClick={() => void handleAttach()}
                                        disabled={busy || attaching}
                                        title={t('agent.attach.button')}
                                        aria-label={t('agent.attach.button')}
                                    >
                                        <Plus size={14} />
                                    </button>
                                    <button
                                        ref={sourceButtonRef}
                                        type="button"
                                        className={`agent-ds-button${sourceMenuOpen ? ' agent-ds-button-open' : ''}`}
                                        onClick={() => setSourceMenuOpen(o => !o)}
                                        aria-haspopup="menu"
                                        aria-expanded={sourceMenuOpen}
                                        title={t('agent.ds.buttonTitle')}
                                    >
                                        <Database size={12} />
                                        {t('agent.ds.button')}
                                        {sourceMenuOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                                    </button>
                                    <div className="agent-ds-chips">
                                        <PickedChips
                                            picked={livePicked}
                                            connections={connections}
                                            onEdit={id => setRoleFor(id)}
                                            onRemove={id => setPicked(prev => prev.filter(p => p.id !== id))}
                                        />
                                    </div>
                                    {busy ? (
                                        <button
                                            type="button"
                                            className="chat-panel-send"
                                            onClick={() => void agentAbort()}
                                            title={t('agent.stop')}
                                            aria-label={t('agent.stop')}
                                        >
                                            <Square size={11} fill="currentColor" />
                                        </button>
                                    ) : (
                                        <button
                                            type="submit"
                                            className="chat-panel-send"
                                            disabled={(!draft.trim() && pendingFiles.length === 0) || attaching}
                                            title={t('chat.sendTooltip')}
                                            aria-label={t('chat.sendAria')}
                                        >
                                            <ArrowUp size={15} strokeWidth={2.4} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {side ? null : resizeHandles}
            {sourceMenuOpen ? (
                <DataSourceMenu
                    anchor={sourceButtonRef.current}
                    connections={connections}
                    picked={livePicked}
                    onPick={def => {
                        setSourceMenuOpen(false);
                        setSourceDialog(def);
                    }}
                    onClose={() => {
                        setSourceMenuOpen(false);
                        pendingSendRef.current = false;
                    }}
                />
            ) : null}
            {sourceDialog ? (
                <ConnectionDialog
                    def={sourceDialog}
                    connections={connectionsOfKind(connections, connectionKindOf(sourceDialog) ?? '')}
                    workspacePath={workspace}
                    onSave={async (id, name, payload) => {
                        if (!onSaveConnection) throw new Error(t('agent.error.cannotSaveConnection'));
                        return onSaveConnection(id, name, payload);
                    }}
                    onUse={id => {
                        setSourceDialog(null);
                        setRoleFor(id);
                    }}
                    onClose={() => {
                        setSourceDialog(null);
                        pendingSendRef.current = false;
                    }}
                />
            ) : null}
            {roleFor ? (
                <RoleDialog
                    connectionName={connections.find(c => c.id === roleFor)?.name ?? roleFor}
                    current={picked.find(p => p.id === roleFor)?.role}
                    onConfirm={role => {
                        const id = roleFor;
                        setRoleFor(null);
                        setPicked(prev => [...prev.filter(p => p.id !== id), { id, role }]);
                    }}
                    onClose={() => {
                        setRoleFor(null);
                        pendingSendRef.current = false;
                    }}
                />
            ) : null}
            {noSourcePrompt ? (
                <NoSourceDialog
                    onChoose={() => {
                        setNoSourcePrompt(false);
                        pendingSendRef.current = true;
                        setSourceMenuOpen(true);
                    }}
                    onSkip={() => {
                        setNoSourcePrompt(false);
                        void handleSend(true);
                    }}
                    onClose={() => setNoSourcePrompt(false)}
                />
            ) : null}
        </aside>
    );
}

/** Three dots that pulse in turn after the "working" label, so a long run looks alive. */
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
    const { t } = useTranslation();
    const hasStatus = turn.tools.length > 0 || turn.subagents.length > 0 || turn.skills.length > 0;
    return (
        <div className="chat-bubble chat-bubble-assistant">
            <div className="chat-bubble-head">
                <div className="chat-bubble-head-main">
                    <Bot size={12} aria-hidden="true" />
                    <span>Agent</span>
                </div>
                <span className={`chat-bubble-phase ${live ? 'chat-bubble-phase-live' : ''}`}>
                    {live ? t('agent.run.live') : t('agent.run.done')}
                </span>
            </div>
            {turn.thinking ? (
                <details className="agent-thinking">
                    <summary>{t('agent.run.thinking')}</summary>
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
                    <div className="chat-status-heading">{live ? t('agent.run.progress') : t('agent.run.log')}</div>
                    {turn.skills.map(skill => (
                        <div key={`skill-${skill}`} className="chat-status-card chat-status-info">
                            <div className="chat-status-main">
                                <span className="chat-status-icon">
                                    <Sparkles size={12} />
                                </span>
                                <div className="chat-status-copy">
                                    <div className="chat-status-label">{t('agent.run.skill', { name: skill })}</div>
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
                                        {tool.pipelineId ? <div className="chat-status-result-badge">{t('agent.run.result')}</div> : null}
                                        <div className="chat-status-label">
                                            {subagent ? t('agent.run.subagent', { task: subagent.task }) : humanizeTool(tool.name)}
                                        </div>
                                        <details className="chat-status-detail agent-tool-detail">
                                            <summary>{tone === 'running' ? t('agent.run.params') : t('agent.run.details')}</summary>
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
                                        {t('agent.run.open')}
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
                    reportedTitle={t('agent.run.reportedTokens')}
                    estimateTitle={t('agent.run.estimatedTokens')}
                />
            ) : null}
        </div>
    );
}

function humanizeTool(name: string): string {
    const short = toolLabel(name);
    return i18n.t(`agent.tool.${short}`, { defaultValue: short });
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
