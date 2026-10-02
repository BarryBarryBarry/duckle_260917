import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    Download,
    Ellipsis,
    KeyRound,
    Loader2,
    Maximize2,
    Minimize2,
    Minus,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    Pin,
    PinOff,
    Send,
    Sparkles,
    ShieldCheck,
    SquarePen,
    Trash2,
    Wrench,
    X,
    Workflow,
} from 'lucide-react';
import {
    chatCloseSession,
    chatExtractPipeline,
    chatSend,
    duckieConnectionSetCredentials,
    duckieConversationDelete,
    duckieConversationGet,
    duckieConversationSave,
    duckieConversationsList,
    duckieConversationUpdateMeta,
    engineInstall,
    engineStatus,
    llamaDefaultModel,
    llamaModels,
    settingsGetAi,
    type ChatMessage,
    type CredentialsRequestConnection,
    type DuckieConversationSummary,
    type EngineStatus,
    type InstallProgress,
    type LlamaModel,
} from '../tauri-bridge';
import { getWorkspacePath } from '../workspace';
import { useFloatingPanel } from './floating-panel';
import ReplyFooter from './ReplyFooter';
import { syncComposerHeight, useInputRecall } from './composer';

type Props = {
    workspace: string | null;
    /** The panel stays mounted while closed so an in-flight reply keeps
     *  streaming and gets saved; `open` only controls visibility. */
    open: boolean;
    onClose: () => void;
    onInsertPipeline: (pipeline: unknown) => void;
    onPersistedPipeline: (pipelineId: string) => void;
    /** A connection file changed on disk (credentials saved from the chat). */
    onConnectionsChanged?: () => void;
};

type Bubble = ChatMessage & {
    /** True while tokens are still streaming in. */
    streaming?: boolean;
    /** Cached extracted pipeline, computed after the stream finishes. */
    pipeline?: unknown;
    /** Structured live progress for the current assistant turn. */
    statusItems?: StatusItem[];
    /** Saved connections this turn could not sign in with. Metadata only: the
     *  password is typed into the card and goes straight to the backend. */
    credentialRequests?: CredentialRequest[];
    /** Wall-clock start of the turn, used for the elapsed-time readout. */
    startedAt?: number;
    /** Wall-clock end of the turn. */
    finishedAt?: number;
    /** Token accounting reported by the agent, when it reports any. */
    usage?: { input?: number; output?: number; total?: number; cacheRead?: number; calls?: number };
};

type CredentialRequest = CredentialsRequestConnection & {
    status: 'pending' | 'saved' | 'dismissed';
};

type StatusTone = 'running' | 'done' | 'error' | 'info';
type StatusKind = 'thinking' | 'route' | 'tool' | 'pipeline' | 'error';

type StatusItem = {
    key: string;
    kind: StatusKind;
    tone: StatusTone;
    label: string;
    detail?: string;
    pipelineId?: string;
};

type SetupState =
    | { phase: 'checking' }
    | { phase: 'not-installed'; engine: EngineStatus }
    | { phase: 'installing'; progress: InstallProgress | null }
    | { phase: 'ready'; provider: 'deepseek_harness' | 'openai_compatible' | 'local_qwen' }
    | { phase: 'install-failed'; error: string };

const EXAMPLE_PROMPTS = [
    'Read orders.csv, filter where status = "shipped", write to shipped.parquet',
    'Pull GitHub issues from my repo and load them into a Postgres table',
    'Embed the description column with OpenAI and dedupe near-duplicates',
];

/** Size of a freshly opened panel. Dragging an edge may exceed these - the
 *  only hard limits on a resize are the minimums and the work area. */
/** Per-workspace localStorage key prefix for the conversation to reopen. */
const ACTIVE_CONVERSATION_KEY = 'duckie-active-conversation';
/** Auto titles are the first user message, cut to this many characters. */
const TITLE_MAX_CHARS = 30;

export default function ChatPanel({
    workspace: workspaceProp,
    open,
    onClose,
    onInsertPipeline,
    onPersistedPipeline,
    onConnectionsChanged,
}: Props) {
    const { t } = useTranslation();
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [messages, setMessages] = useState<Bubble[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [dshRoute, setDshRoute] = useState<string | null>(null);
    const {
        layout: currentLayout,
        panelStyle,
        dragging,
        resizing,
        headerProps,
        resizeHandles,
        toggleCollapsed,
        toggleMaximized,
        toggleSidebar,
    } = useFloatingPanel('duckie-chat-panel-position', 'Duckie');
    const panelRef = useRef<HTMLElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    // App remounts the panel per workspace, so this is fixed for its lifetime.
    const [workspace] = useState(() => workspaceProp ?? getWorkspacePath());
    // Read before the effect that mirrors activeId into storage clears it.
    const [restoreId] = useState(() => readActiveConversation(workspace));
    const [conversations, setConversations] = useState<DuckieConversationSummary[]>([]);
    /** null = a new chat that has not been saved yet. */
    const [activeId, setActiveId] = useState<string | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [menu, setMenu] = useState<{ id: string; top: number; left: number; confirmDelete: boolean } | null>(null);
    const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
    const renamingRef = useRef<{ id: string; draft: string } | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    /** ACP session id of the active conversation, saved so DSH can resume it. */
    const remoteSessionRef = useRef<string | null>(null);
    /** Signature of the messages last written to disk; skips redundant saves. */
    const savedSignatureRef = useRef(computeSaveSignature([]));
    /** Serializes history writes so a slow save cannot land after a newer one. */
    const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
    const messagesRef = useRef<Bubble[]>([]);
    messagesRef.current = messages;
    const { handleRecallKey, resetRecall } = useInputRecall(
        () => messagesRef.current.filter(m => m.role === 'user').map(m => m.content),
        setDraft,
        inputRef,
    );
    const pendingPersistedPipelineId = useRef<string | null>(null);
    const toolNamesRef = useRef<Record<string, string>>({});
    const activeStatus = useMemo(() => findActiveStatus(messages), [messages]);

    // Detect the AI engine each time the panel opens so we can either show the
    // chat UI or a clear install card (without this the user clicks Send and
    // gets a cryptic spawn error), and so a mode changed in Settings applies on
    // the next open. An install in progress is left alone.
    const setupPhaseRef = useRef(setup.phase);
    setupPhaseRef.current = setup.phase;
    useEffect(() => {
        if (!open || setupPhaseRef.current === 'installing') return;
        let cancelled = false;
        (async () => {
            const ai = await settingsGetAi(workspace ?? '');
            if (cancelled) return;
            if (ai.mode === 'deepseek_harness') {
                setSetup({ phase: 'ready', provider: 'deepseek_harness' });
                return;
            }
            if (ai.mode === 'openai_compatible') {
                setSetup({ phase: 'ready', provider: 'openai_compatible' });
                return;
            }
            const list = await engineStatus();
            const llama = list.find(e => e.id === 'llamacpp');
            if (cancelled) return;
            if (!llama) {
                setSetup({ phase: 'install-failed', error: 'AI engine not registered.' });
                return;
            }
            setSetup(llama.installed
                ? { phase: 'ready', provider: 'local_qwen' }
                : { phase: 'not-installed', engine: llama });
        })();
        return () => {
            cancelled = true;
        };
    }, [open, workspace]);

    // The catalogue is only needed on the install screen, so it is fetched
    // when that screen appears rather than on every panel open. An empty
    // list is not fatal: the install falls back to the default model.
    const [models, setModels] = useState<LlamaModel[]>([]);
    const [modelId, setModelId] = useState<string>('');

    useEffect(() => {
        if (setup.phase !== 'not-installed' && setup.phase !== 'install-failed') return;
        if (models.length) return;
        let cancelled = false;
        void (async () => {
            // The backend owns which model is the sensible default; the list
            // is ordered smallest-first, so falling back to [0] would quietly
            // pick the weakest one instead.
            const [list, fallback] = await Promise.all([
                llamaModels(),
                llamaDefaultModel().catch(() => ''),
            ]);
            if (cancelled || !list.length) return;
            setModels(list);
            const preferred = list.some(m => m.id === fallback) ? fallback : list[0].id;
            setModelId(prev => prev || preferred);
        })();
        return () => { cancelled = true; };
    }, [setup.phase, models.length]);

    const chosen = models.find(m => m.id === modelId) ?? null;

    const installEngine = useCallback(async () => {
        setSetup({ phase: 'installing', progress: null });
        try {
            await engineInstall('llamacpp', p => {
                setSetup({ phase: 'installing', progress: p });
            }, modelId || undefined);
            setSetup({ phase: 'ready', provider: 'local_qwen' });
        } catch (err) {
            setSetup({ phase: 'install-failed', error: String(err) });
        }
    }, [modelId]);

    const updateStreamingAssistant = useCallback((updater: (bubble: Bubble) => Bubble) => {
        setMessages(prev => {
            const out = prev.slice();
            const last = out[out.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return prev;
            out[out.length - 1] = updater(last);
            return out;
        });
    }, []);

    const send = useCallback(async (text?: string) => {
        const body = (text ?? draft).trim();
        if (!body || busy || setup.phase !== 'ready') return;
        if (!text) setDraft('');
        resetRecall();
        let conversationId = activeId;
        if (!conversationId) {
            conversationId = newConversationId();
            remoteSessionRef.current = null;
            setActiveId(conversationId);
        }
        const userMsg: Bubble = { role: 'user', content: body };
        setMessages(prev => [
            ...prev,
            userMsg,
            {
                role: 'assistant',
                content: '',
                streaming: true,
                startedAt: Date.now(),
                statusItems: [
                    {
                        key: 'thinking',
                        kind: 'thinking',
                        tone: 'running',
                        label: '正在思考',
                    },
                ],
            },
        ]);
        setBusy(true);
        const history: ChatMessage[] = [
            ...messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: body },
        ];
        await chatSend(history, ev => {
            if (ev.kind === 'token') {
                updateStreamingAssistant(last => {
                    return {
                        ...last,
                        content: last.content + ev.text,
                        statusItems: removeStatusItem(last.statusItems, 'thinking'),
                    };
                });
            } else if (ev.kind === 'session') {
                remoteSessionRef.current = ev.remote_session_id;
            } else if (ev.kind === 'model_selected') {
                setDshRoute(`${ev.provider}/${ev.model}`);
                updateStreamingAssistant(last => ({
                    ...last,
                    statusItems: upsertStatusItem(last.statusItems, {
                        key: 'route',
                        kind: 'route',
                        tone: 'info',
                        label: '已连接 DSH',
                        detail: `${ev.provider}/${ev.model}`,
                    }),
                }));
            } else if (ev.kind === 'usage') {
                updateStreamingAssistant(last => ({
                    ...last,
                    usage: {
                        input: ev.input_tokens ?? undefined,
                        output: ev.output_tokens ?? undefined,
                        total: ev.total_tokens ?? undefined,
                        cacheRead: ev.cache_read_tokens ?? undefined,
                        calls: ev.model_calls ?? undefined,
                    },
                }));
            } else if (ev.kind === 'tool_call_start') {
                toolNamesRef.current[ev.id] = ev.name;
                updateStreamingAssistant(last => ({
                    ...last,
                    statusItems: upsertStatusItem(last.statusItems, {
                        key: `tool:${ev.id}`,
                        kind: 'tool',
                        tone: 'running',
                        label: '正在调用工具',
                        detail: humanizeToolName(ev.name),
                    }),
                }));
            } else if (ev.kind === 'tool_call_end') {
                const toolName = toolNamesRef.current[ev.id] ?? '';
                delete toolNamesRef.current[ev.id];
                updateStreamingAssistant(last => ({
                    ...last,
                    statusItems: upsertStatusItem(
                        last.statusItems,
                        {
                            key: `tool:${ev.id}`,
                            kind: 'tool',
                            tone: ev.ok ? 'done' : 'error',
                            label: ev.ok ? '工具已完成' : '工具调用失败',
                            detail: ev.ok ? humanizeToolName(toolName) : humanizeToolName(toolName) || '请查看错误信息',
                        },
                    ),
                }));
            } else if (ev.kind === 'done') {
                if (pendingPersistedPipelineId.current) {
                    onPersistedPipeline(pendingPersistedPipelineId.current);
                    pendingPersistedPipelineId.current = null;
                }
                toolNamesRef.current = {};
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = {
                            ...last,
                            streaming: false,
                            finishedAt: Date.now(),
                            statusItems: finalizeStatusItems(last.statusItems),
                        };
                        if (setup.phase === 'ready' && setup.provider !== 'deepseek_harness') {
                            void chatExtractPipeline(last.content).then(pipe => {
                                if (pipe) {
                                    setMessages(c => {
                                        const o2 = c.slice();
                                        const t = o2[o2.length - 1];
                                        if (t && t.role === 'assistant') {
                                            o2[o2.length - 1] = { ...t, pipeline: pipe };
                                        }
                                        return o2;
                                    });
                                }
                            });
                        }
                    }
                    return out;
                });
                setBusy(false);
            } else if (ev.kind === 'credentials_required') {
                const incoming = ev.request?.connections ?? [];
                updateStreamingAssistant(last => {
                    const others = (last.credentialRequests ?? []).filter(
                        r => !incoming.some(c => c.connectionRef === r.connectionRef),
                    );
                    return {
                        ...last,
                        credentialRequests: [
                            ...others,
                            ...incoming.map(c => ({ ...c, status: 'pending' as const })),
                        ],
                    };
                });
            } else if (ev.kind === 'pipeline_persisted') {
                pendingPersistedPipelineId.current = ev.id;
                updateStreamingAssistant(last => ({
                    ...last,
                    statusItems: upsertStatusItem(last.statusItems, {
                        key: `pipeline:${ev.id}`,
                        kind: 'pipeline',
                        tone: 'done',
                        label: ev.action === 'updated' ? '已更新 pipeline' : '已创建 pipeline',
                        detail: ev.id,
                        pipelineId: ev.id,
                    }),
                }));
            } else if (ev.kind === 'error') {
                pendingPersistedPipelineId.current = null;
                toolNamesRef.current = {};
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = {
                            ...last,
                            streaming: false,
                            content: ev.message,
                            finishedAt: Date.now(),
                            statusItems: upsertStatusItem(last.statusItems, {
                                key: 'error',
                                kind: 'error',
                                tone: 'error',
                                label: '执行失败',
                                detail: '已返回错误信息',
                            }),
                        };
                    }
                    return out;
                });
                setBusy(false);
            }
        }, workspace, conversationSessionKey(workspace, conversationId), remoteSessionRef.current);
    }, [draft, busy, messages, onPersistedPipeline, setup, updateStreamingAssistant, activeId, workspace]);

    const runHistoryTask = useCallback((task: () => Promise<void>) => {
        historyQueueRef.current = historyQueueRef.current
            .then(task)
            .catch(err => setHistoryError(String(err)));
        return historyQueueRef.current;
    }, []);

    // Persist the active conversation whenever a turn settles. Streaming
    // bubbles are left out, so a reply is written once it finishes rather
    // than on every token.
    const saveSignature = useMemo(() => computeSaveSignature(messages), [messages]);
    useEffect(() => {
        if (!workspace || !activeId) return;
        if (saveSignature === savedSignatureRef.current) return;
        const stable = messagesRef.current.filter(m => !m.streaming);
        if (!stable.length) return;
        savedSignatureRef.current = saveSignature;
        const payload = {
            id: activeId,
            title: deriveConversationTitle(stable),
            remoteSessionId: remoteSessionRef.current,
            messages: stable.map(toStoredBubble),
        };
        void runHistoryTask(async () => {
            setConversations(await duckieConversationSave(workspace, payload));
            setHistoryError(null);
        });
    }, [saveSignature, activeId, workspace, runHistoryTask]);

    useEffect(() => {
        if (workspace) writeActiveConversation(workspace, activeId);
    }, [activeId, workspace]);

    const resetTurnState = useCallback(() => {
        resetRecall();
        toolNamesRef.current = {};
        pendingPersistedPipelineId.current = null;
        setDshRoute(null);
    }, []);

    const startNewConversation = useCallback(() => {
        if (busy) return;
        resetTurnState();
        remoteSessionRef.current = null;
        savedSignatureRef.current = computeSaveSignature([]);
        setMessages([]);
        setActiveId(null);
        setMenu(null);
        inputRef.current?.focus();
    }, [busy, resetTurnState]);

    const openConversation = useCallback(async (id: string) => {
        if (!workspace || busy) return;
        setMenu(null);
        try {
            const conv = await duckieConversationGet(workspace, id);
            const loaded = restoreBubbles(conv.messages);
            resetTurnState();
            remoteSessionRef.current = conv.remoteSessionId ?? null;
            savedSignatureRef.current = computeSaveSignature(loaded);
            setMessages(loaded);
            setActiveId(id);
            setHistoryError(null);
        } catch (err) {
            setHistoryError(String(err));
        }
    }, [workspace, busy, resetTurnState]);

    // Load the history once, and reopen the conversation that was active when
    // the app last closed, so a restart does not drop the user into a blank chat.
    const openConversationRef = useRef(openConversation);
    openConversationRef.current = openConversation;
    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;
        void (async () => {
            try {
                const list = await duckieConversationsList(workspace);
                if (cancelled) return;
                setConversations(list);
                if (restoreId && list.some(c => c.id === restoreId)) await openConversationRef.current(restoreId);
            } catch (err) {
                if (!cancelled) setHistoryError(String(err));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [workspace, restoreId]);

    const togglePinned = useCallback((conv: DuckieConversationSummary) => {
        if (!workspace) return;
        setMenu(null);
        void runHistoryTask(async () => {
            setConversations(await duckieConversationUpdateMeta(workspace, conv.id, { pinned: !conv.pinned }));
        });
    }, [workspace, runHistoryTask]);

    const beginRename = useCallback((conv: DuckieConversationSummary) => {
        setMenu(null);
        const next = { id: conv.id, draft: conv.title };
        renamingRef.current = next;
        setRenaming(next);
    }, []);

    const updateRenameDraft = useCallback((draftTitle: string) => {
        setRenaming(prev => {
            const next = prev ? { ...prev, draft: draftTitle } : prev;
            renamingRef.current = next;
            return next;
        });
    }, []);

    const cancelRename = useCallback(() => {
        renamingRef.current = null;
        setRenaming(null);
    }, []);

    // Reads the ref, not state: Enter commits and then the input's blur fires
    // with a stale closure, and Escape must not be undone by that blur.
    const commitRename = useCallback(() => {
        const current = renamingRef.current;
        renamingRef.current = null;
        setRenaming(null);
        if (!current || !workspace) return;
        const title = current.draft.trim();
        const existing = conversations.find(c => c.id === current.id);
        if (!title || title === existing?.title) return;
        void runHistoryTask(async () => {
            setConversations(await duckieConversationUpdateMeta(workspace, current.id, { title }));
        });
    }, [workspace, conversations, runHistoryTask]);

    const deleteConversation = useCallback((id: string) => {
        if (!workspace) return;
        if (busy && id === activeId) return;
        setMenu(null);
        if (id === activeId) startNewConversation();
        void runHistoryTask(async () => {
            setConversations(await duckieConversationDelete(workspace, id));
        });
        void chatCloseSession(conversationSessionKey(workspace, id)).catch(() => undefined);
    }, [workspace, busy, activeId, startNewConversation, runHistoryTask]);

    const openMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, id: string) => {
        event.stopPropagation();
        if (menu?.id === id) {
            setMenu(null);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const menuHeight = 132;
        const menuWidth = 176;
        const below = rect.bottom + 4;
        const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 4) : below;
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
        setMenu({ id, top, left, confirmDelete: false });
    }, [menu]);

    useEffect(() => {
        if (open) return;
        setMenu(null);
        cancelRename();
    }, [open, cancelRename]);

    // Close the item menu on any press outside it, and when the window moves under it.
    useEffect(() => {
        if (!menu) return;
        const onPointerDown = (e: PointerEvent) => {
            if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
            setMenu(null);
        };
        const close = () => setMenu(null);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [menu]);

    // Once every credential card in a reply is answered and at least one was
    // saved, tell the agent so it retries. Queued until the reply finishes.
    const [pendingFollowUp, setPendingFollowUp] = useState<string | null>(null);
    const sendRef = useRef(send);
    sendRef.current = send;
    useEffect(() => {
        if (!pendingFollowUp || busy || setup.phase !== 'ready') return;
        setPendingFollowUp(null);
        void sendRef.current(pendingFollowUp);
    }, [pendingFollowUp, busy, setup.phase]);

    const resolveCredentialRequest = useCallback((
        messageIndex: number,
        connectionRef: string,
        status: 'saved' | 'dismissed',
    ) => {
        setMessages(prev => {
            const target = prev[messageIndex];
            if (!target?.credentialRequests) return prev;
            const requests = target.credentialRequests.map(r =>
                r.connectionRef === connectionRef ? { ...r, status } : r,
            );
            const out = prev.slice();
            out[messageIndex] = { ...target, credentialRequests: requests };
            if (requests.every(r => r.status !== 'pending')) {
                const saved = requests.filter(r => r.status === 'saved').map(r => r.name);
                if (saved.length) {
                    setPendingFollowUp(
                        t('chat.credentials.followUp', { names: saved.join('」「') }),
                    );
                }
            }
            return out;
        });
    }, [t]);

    const saveCredentials = useCallback(async (
        messageIndex: number,
        request: CredentialRequest,
        username: string,
        password: string,
    ) => {
        if (!workspace) throw new Error(t('chat.history.noWorkspace'));
        await duckieConnectionSetCredentials(workspace, request.connectionRef, username.trim() || null, password);
        resolveCredentialRequest(messageIndex, request.connectionRef, 'saved');
        // The editor holds connections in memory; reload so it sees the new
        // password instead of saving its older copy back over it.
        onConnectionsChanged?.();
    }, [workspace, t, resolveCredentialRequest, onConnectionsChanged]);

    // Esc closes an open item menu first, then the panel. The rename input
    // stops its own Escape from reaching this listener.
    useEffect(() => {
        if (!open) return;
        const h = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (menu) {
                setMenu(null);
                return;
            }
            onClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose, open, menu]);

    // Auto-scroll as tokens stream in, when a conversation opens, and when the panel reopens.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, open]);

    useEffect(() => {
        syncComposerHeight(inputRef.current);
    }, [draft]);

    const menuConversation = menu ? conversations.find(c => c.id === menu.id) ?? null : null;
    if (!open) return null;

    return (
        <aside
            ref={panelRef}
            className={`chat-panel ${dragging ? 'chat-panel-dragging' : ''} ${
                resizing ? 'chat-panel-resizing' : ''
            } ${currentLayout.collapsed ? 'chat-panel-collapsed' : ''} ${
                currentLayout.maximized ? 'chat-panel-maximized' : ''
            }`}
            role="complementary"
            aria-label={t('chat.title')}
            style={panelStyle}
        >
            <header className="chat-panel-head" {...headerProps}>
                <div className="chat-panel-title-wrap">
                    <div className="chat-panel-title">
                        <Sparkles size={14} aria-hidden="true" />
                        <span>{t('chat.title')}</span>
                        {setup.phase === 'ready' ? (
                            <span className="chat-panel-tag">
                                {setup.provider === 'deepseek_harness'
                                    ? t('chat.modeHarness', { defaultValue: 'DSH' })
                                    : setup.provider === 'openai_compatible'
                                      ? t('chat.modeOpenAI', { defaultValue: 'OpenAI-compatible' })
                                      : t('chat.localTag')}
                            </span>
                        ) : null}
                        {setup.phase === 'ready' && !currentLayout.collapsed ? (
                            <button
                                type="button"
                                className="chat-panel-head-btn"
                                onClick={toggleSidebar}
                                title={currentLayout.sidebar ? t('chat.history.hideSidebar') : t('chat.history.showSidebar')}
                                aria-label={currentLayout.sidebar ? t('chat.history.hideSidebar') : t('chat.history.showSidebar')}
                                aria-pressed={currentLayout.sidebar}
                            >
                                {currentLayout.sidebar ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
                            </button>
                        ) : null}
                    </div>
                    {setup.phase === 'ready' && (dshRoute || activeStatus) ? (
                        <div className="chat-panel-meta">
                            {dshRoute ? (
                                <span className="chat-panel-meta-pill">
                                    Route <code>{dshRoute}</code>
                                </span>
                            ) : null}
                            {activeStatus ? (
                                <span className="chat-panel-meta-pill chat-panel-meta-pill-live">
                                    当前阶段：{activeStatus.label}
                                    {activeStatus.detail ? ` · ${activeStatus.detail}` : ''}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <div className="chat-panel-head-actions">
                    <span className="chat-panel-drag-hint">拖动 / 吸附</span>
                    <button
                        type="button"
                        className="chat-panel-head-btn"
                        onClick={toggleCollapsed}
                        title={currentLayout.collapsed ? '还原 Duckie' : '最小化 Duckie'}
                        aria-label={currentLayout.collapsed ? '还原 Duckie' : '最小化 Duckie'}
                    >
                        {currentLayout.collapsed ? <ChevronDown size={14} /> : <Minus size={14} />}
                    </button>
                    <button
                        type="button"
                        className="chat-panel-head-btn"
                        onClick={toggleMaximized}
                        title={currentLayout.maximized ? '还原 Duckie 窗口大小' : '最大化 Duckie'}
                        aria-label={currentLayout.maximized ? '还原 Duckie 窗口大小' : '最大化 Duckie'}
                        aria-pressed={currentLayout.maximized}
                    >
                        {currentLayout.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
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

            {currentLayout.collapsed ? (
                <div className="chat-panel-collapsed-bar">
                    <span>Duckie 已最小化</span>
                    {activeStatus ? (
                        <span className="chat-panel-collapsed-pill">
                            当前阶段：{activeStatus.label}
                        </span>
                    ) : dshRoute ? (
                        <span className="chat-panel-collapsed-pill">
                            Route：{dshRoute}
                        </span>
                    ) : null}
                </div>
            ) : setup.phase === 'checking' ? (
                <div className="chat-panel-state">
                    <Loader2 size={18} className="spin" />
                    <span>{t('chat.checking')}</span>
                </div>
            ) : setup.phase === 'not-installed' ? (
                <SetupCard
                    title={t('chat.installTitle')}
                    body={t('chat.modelBody', {
                        defaultValue:
                            'The assistant runs entirely on your machine - no API keys, no cloud calls. Pick the model that suits your hardware.',
                    })}
                    cta={
                        chosen
                            ? t('chat.installCtaSized', {
                                defaultValue: 'Install ({{size}})',
                                size: formatSize(chosen.size_mb),
                            })
                            : t('chat.installCta')
                    }
                    onCta={installEngine}
                >
                    {models.length > 1 ? (
                        <ModelPicker
                            models={models}
                            value={modelId}
                            onChange={setModelId}
                            label={t('chat.modelLabel', { defaultValue: 'Chat model' })}
                        />
                    ) : null}
                </SetupCard>
            ) : setup.phase === 'install-failed' ? (
                <SetupCard
                    title={t('chat.installFailedTitle')}
                    body={setup.error}
                    cta={t('chat.retry')}
                    onCta={installEngine}
                >
                    {models.length > 1 ? (
                        <ModelPicker
                            models={models}
                            value={modelId}
                            onChange={setModelId}
                            label={t('chat.modelLabel', { defaultValue: 'Chat model' })}
                        />
                    ) : null}
                </SetupCard>
            ) : setup.phase === 'installing' ? (
                <div className="chat-panel-state chat-panel-state-install">
                    <Loader2 size={18} className="spin" />
                    <InstallProgressView progress={setup.progress} />
                </div>
            ) : (
                <div className="chat-panel-body">
                    {currentLayout.sidebar ? (
                        <nav className="chat-history" aria-label={t('chat.history.recent')}>
                            <button
                                type="button"
                                className="chat-history-new"
                                onClick={startNewConversation}
                                disabled={busy}
                                title={busy ? t('chat.history.busyHint') : undefined}
                            >
                                <SquarePen size={14} aria-hidden="true" />
                                <span>{t('chat.history.newChat')}</span>
                            </button>
                            <div className="chat-history-label">{t('chat.history.recent')}</div>
                            <div className="chat-history-list" onScroll={() => setMenu(null)}>
                                {!workspace ? (
                                    <div className="chat-history-empty">{t('chat.history.noWorkspace')}</div>
                                ) : conversations.length === 0 ? (
                                    <div className="chat-history-empty">{t('chat.history.empty')}</div>
                                ) : (
                                    conversations.map(conv => {
                                        const isActive = conv.id === activeId;
                                        const title = conv.title || t('chat.history.untitled');
                                        return (
                                            <div
                                                key={conv.id}
                                                className={`chat-history-item ${isActive ? 'chat-history-item-active' : ''} ${
                                                    menu?.id === conv.id ? 'chat-history-item-menu-open' : ''
                                                }`}
                                            >
                                                {renaming?.id === conv.id ? (
                                                    <input
                                                        className="chat-history-rename"
                                                        value={renaming.draft}
                                                        autoFocus
                                                        maxLength={120}
                                                        aria-label={t('chat.history.rename')}
                                                        onChange={e => updateRenameDraft(e.target.value)}
                                                        onFocus={e => e.currentTarget.select()}
                                                        onBlur={commitRename}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                commitRename();
                                                            } else if (e.key === 'Escape') {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                cancelRename();
                                                            }
                                                        }}
                                                    />
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="chat-history-item-main"
                                                        onClick={() => {
                                                            if (!isActive) void openConversation(conv.id);
                                                        }}
                                                        onDoubleClick={() => beginRename(conv)}
                                                        disabled={busy && !isActive}
                                                        title={busy && !isActive ? t('chat.history.busyHint') : title}
                                                        aria-current={isActive ? 'true' : undefined}
                                                    >
                                                        {conv.pinned ? (
                                                            <Pin size={11} className="chat-history-pin" aria-hidden="true" />
                                                        ) : null}
                                                        <span className="chat-history-title">{title}</span>
                                                    </button>
                                                )}
                                                {renaming?.id === conv.id ? null : (
                                                    <button
                                                        type="button"
                                                        className="chat-history-more"
                                                        onClick={e => openMenu(e, conv.id)}
                                                        title={t('chat.history.more')}
                                                        aria-label={t('chat.history.more')}
                                                        aria-haspopup="menu"
                                                        aria-expanded={menu?.id === conv.id}
                                                    >
                                                        <Ellipsis size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                            {historyError ? (
                                <div className="chat-history-error" role="alert" title={historyError}>
                                    <AlertCircle size={12} aria-hidden="true" />
                                    <span>{historyError}</span>
                                </div>
                            ) : null}
                        </nav>
                    ) : null}
                    <div className="chat-panel-main">
                        {resizing ? (
                            <div className="chat-panel-size-indicator" aria-live="polite">
                                {Math.round(currentLayout.width)} × {Math.round(currentLayout.height)}
                            </div>
                        ) : null}
                        <div ref={scrollRef} className="chat-panel-scroll">
                            {messages.length === 0 ? (
                                <div className="chat-panel-empty">
                                    <Workflow size={26} className="chat-panel-empty-icon" />
                                    <div className="chat-panel-empty-title">
                                        {t('chat.emptyTitle')}
                                    </div>
                                    <div className="chat-panel-empty-hint">
                                        {t('chat.emptyHint')}
                                    </div>
                                    <div className="chat-panel-prompts">
                                        {EXAMPLE_PROMPTS.map(p => (
                                            <button
                                                key={p}
                                                type="button"
                                                className="chat-panel-prompt"
                                                onClick={() => void send(p)}
                                            >
                                                {p}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                messages.map((m, i) => (
                                    <div key={i} className={`chat-bubble chat-bubble-${m.role}`}>
                                        <div className="chat-bubble-head">
                                            <div className="chat-bubble-head-main">
                                                {m.role === 'assistant' ? (
                                                    <Sparkles size={12} aria-hidden="true" />
                                                ) : null}
                                                <span>{m.role === 'assistant' ? 'Duckie' : '你'}</span>
                                            </div>
                                            {m.role === 'assistant' ? (
                                                <span
                                                    className={`chat-bubble-phase ${m.streaming ? 'chat-bubble-phase-live' : ''}`}
                                                >
                                                    {m.streaming ? '处理中' : '已完成'}
                                                </span>
                                            ) : null}
                                        </div>
                                        {m.content ? (
                                            <div className="chat-bubble-body">
                                                <div className="chat-bubble-content">
                                                    {renderMessageContent(m.content)}
                                                    {m.streaming ? <span className="chat-caret" /> : null}
                                                </div>
                                            </div>
                                        ) : null}
                                        {m.role === 'assistant' && m.statusItems?.length ? (
                                            <div className="chat-bubble-status" aria-live="polite">
                                                <div className="chat-status-heading">
                                                    {m.streaming ? '执行进度' : '本轮执行记录'}
                                                </div>
                                                {m.statusItems.map(item => (
                                                    <div
                                                        key={`${i}-${item.key}`}
                                                        className={`chat-status-card chat-status-${item.tone} ${
                                                            m.streaming && activeStatus?.key === item.key
                                                                ? 'chat-status-card-active'
                                                                : ''
                                                        } ${item.kind === 'pipeline' ? 'chat-status-card-result' : ''}`}
                                                    >
                                                        <div className="chat-status-main">
                                                            <span className="chat-status-icon">
                                                                <StatusIcon item={item} />
                                                            </span>
                                                            <div className="chat-status-copy">
                                                                {item.kind === 'pipeline' ? (
                                                                    <div className="chat-status-result-badge">结果</div>
                                                                ) : null}
                                                                <div className="chat-status-label">{item.label}</div>
                                                                {item.detail ? (
                                                                    <div className="chat-status-detail">{item.detail}</div>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                        {item.pipelineId ? (
                                                            <button
                                                                type="button"
                                                                className="chat-status-action"
                                                                onClick={() => onPersistedPipeline(item.pipelineId!)}
                                                            >
                                                                打开
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                        {m.role === 'assistant' && m.credentialRequests?.length ? (
                                            <div className="chat-credentials">
                                                {m.credentialRequests.map(req => (
                                                    <CredentialCard
                                                        key={req.connectionRef}
                                                        request={req}
                                                        onSave={(username, password) => saveCredentials(i, req, username, password)}
                                                        onDismiss={() => resolveCredentialRequest(i, req.connectionRef, 'dismissed')}
                                                    />
                                                ))}
                                            </div>
                                        ) : null}
                                        {m.role === 'assistant' && !m.streaming && (m.content || m.usage) ? (
                                            <MessageFooter message={m} />
                                        ) : null}
                                        {m.pipeline ? (
                                            <button
                                                type="button"
                                                className="chat-bubble-insert"
                                                onClick={() => onInsertPipeline(m.pipeline)}
                                            >
                                                <Workflow size={12} /> {t('chat.insertIntoCanvas')}
                                            </button>
                                        ) : null}
                                    </div>
                                ))
                            )}
                        </div>

                        <form
                            className="chat-panel-form"
                            onSubmit={e => {
                                e.preventDefault();
                                void send();
                            }}
                        >
                            {busy && activeStatus ? (
                                <div className="chat-panel-live-banner" aria-live="polite">
                                    <span className="chat-panel-live-dot" />
                                    <span>
                                        当前阶段：{activeStatus.label}
                                        {activeStatus.detail ? ` · ${activeStatus.detail}` : ''}
                                    </span>
                                </div>
                            ) : null}
                            <div className="chat-panel-input-row">
                                <textarea
                                    ref={inputRef}
                                    className="chat-panel-input"
                                    value={draft}
                                    onChange={e => {
                                        // Editing a recalled input makes it the new draft.
                                        resetRecall();
                                        setDraft(e.target.value);
                                        syncComposerHeight(e.currentTarget);
                                    }}
                                    placeholder={busy ? t('chat.thinking') : t('chat.placeholder')}
                                    rows={2}
                                    disabled={busy}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            void send();
                                            return;
                                        }
                                        handleRecallKey(e);
                                    }}
                                />
                                <button
                                    type="submit"
                                    className="chat-panel-send"
                                    disabled={busy || !draft.trim()}
                                    aria-label={t('chat.sendAria')}
                                    title={t('chat.sendTooltip')}
                                >
                                    {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {menu && menuConversation
                ? createPortal(
                      <div
                          ref={menuRef}
                          className="chat-history-menu"
                          role="menu"
                          style={{ top: menu.top, left: menu.left }}
                      >
                          {menu.confirmDelete ? (
                              <div className="chat-history-confirm">
                                  <div className="chat-history-confirm-text">{t('chat.history.deleteConfirm')}</div>
                                  <div className="chat-history-confirm-actions">
                                      <button
                                          type="button"
                                          className="chat-history-confirm-cancel"
                                          onClick={() => setMenu(prev => (prev ? { ...prev, confirmDelete: false } : prev))}
                                      >
                                          {t('chat.history.cancel')}
                                      </button>
                                      <button
                                          type="button"
                                          className="chat-history-confirm-delete"
                                          onClick={() => deleteConversation(menuConversation.id)}
                                          autoFocus
                                      >
                                          {t('chat.history.deleteConfirmCta')}
                                      </button>
                                  </div>
                              </div>
                          ) : (
                              <>
                                  <button
                                      type="button"
                                      role="menuitem"
                                      className="chat-history-menu-item"
                                      onClick={() => beginRename(menuConversation)}
                                  >
                                      <Pencil size={13} aria-hidden="true" />
                                      <span>{t('chat.history.rename')}</span>
                                  </button>
                                  <button
                                      type="button"
                                      role="menuitem"
                                      className="chat-history-menu-item"
                                      onClick={() => togglePinned(menuConversation)}
                                  >
                                      {menuConversation.pinned ? (
                                          <PinOff size={13} aria-hidden="true" />
                                      ) : (
                                          <Pin size={13} aria-hidden="true" />
                                      )}
                                      <span>
                                          {menuConversation.pinned ? t('chat.history.unpin') : t('chat.history.pin')}
                                      </span>
                                  </button>
                                  <div className="chat-history-menu-sep" role="separator" />
                                  <button
                                      type="button"
                                      role="menuitem"
                                      className="chat-history-menu-item chat-history-menu-item-danger"
                                      disabled={busy && menuConversation.id === activeId}
                                      title={busy && menuConversation.id === activeId ? t('chat.history.busyHint') : undefined}
                                      onClick={() => setMenu(prev => (prev ? { ...prev, confirmDelete: true } : prev))}
                                  >
                                      <Trash2 size={13} aria-hidden="true" />
                                      <span>{t('chat.history.delete')}</span>
                                  </button>
                              </>
                          )}
                      </div>,
                      document.body,
                  )
                : null}
            {resizeHandles}
        </aside>
    );
}

function readActiveConversation(workspace: string | null): string | null {
    if (!workspace || typeof window === 'undefined') return null;
    try {
        return window.localStorage.getItem(`${ACTIVE_CONVERSATION_KEY}:${workspace}`);
    } catch {
        return null;
    }
}

function writeActiveConversation(workspace: string, id: string | null) {
    const key = `${ACTIVE_CONVERSATION_KEY}:${workspace}`;
    try {
        if (id) window.localStorage.setItem(key, id);
        else window.localStorage.removeItem(key);
    } catch {
        // Storage can be unavailable; reopening on a new chat is fine.
    }
}

function newConversationId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `c-${Date.now().toString(36)}-${rand}`;
}

/** Backend session key: one DSH agent session per conversation. */
function conversationSessionKey(workspace: string | null, conversationId: string): string {
    return `duckie:${workspace ?? 'global'}:${conversationId}`;
}

/** Changes whenever the settled part of the conversation changes: a new
 *  message, a finished reply, or a pipeline extracted after the fact. */
function computeSaveSignature(messages: Bubble[]): string {
    const stable = messages.filter(m => !m.streaming);
    const last = stable[stable.length - 1];
    return [
        stable.length,
        last?.finishedAt ?? '',
        last?.content.length ?? 0,
        last?.pipeline ? 1 : 0,
    ].join('|');
}

function deriveConversationTitle(messages: Bubble[]): string {
    const first = messages.find(m => m.role === 'user')?.content ?? '';
    const flat = first.replace(/\s+/g, ' ').trim();
    const chars = Array.from(flat);
    return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS).join('')}…` : flat;
}

function toStoredBubble(message: Bubble): Omit<Bubble, 'streaming'> {
    const { streaming: _streaming, ...rest } = message;
    return rest;
}

/** History files are user-editable JSON, so keep only well-formed bubbles. */
function restoreBubbles(raw: unknown[]): Bubble[] {
    return raw.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const bubble = item as Partial<Bubble>;
        if ((bubble.role !== 'user' && bubble.role !== 'assistant') || typeof bubble.content !== 'string') {
            return [];
        }
        return [{
            ...bubble,
            role: bubble.role,
            content: bubble.content,
            streaming: false,
            statusItems: Array.isArray(bubble.statusItems) ? finalizeStatusItems(bubble.statusItems) : undefined,
        } as Bubble];
    });
}

/** Sizes come from the Hugging Face file listing, so they are the real
 *  download, not an estimate. */
function formatSize(mb: number): string {
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

function upsertStatusItem(items: StatusItem[] | undefined, next: StatusItem): StatusItem[] {
    const prior = (items ?? []).filter(item => item.key !== next.key);
    return [...prior.slice(-4), next];
}

function removeStatusItem(items: StatusItem[] | undefined, key: string): StatusItem[] | undefined {
    const next = (items ?? []).filter(item => item.key !== key);
    return next.length ? next : undefined;
}

function finalizeStatusItems(items: StatusItem[] | undefined): StatusItem[] | undefined {
    const next = (items ?? []).filter(item => item.key !== 'thinking');
    return next.length ? next : undefined;
}

function findActiveStatus(messages: Bubble[]): StatusItem | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== 'assistant' || !message.statusItems?.length) continue;
        const running = [...message.statusItems].reverse().find(item => item.tone === 'running');
        if (running) return running;
        const recent = message.statusItems[message.statusItems.length - 1];
        if (message.streaming && recent) return recent;
    }
    return null;
}

function renderMessageContent(content: string) {
    const blocks = parseMessageBlocks(content);
    return blocks.map((block, index) => {
        if (block.type === 'code') {
            return (
                <pre key={`code-${index}`} className="chat-code-block">
                    <code>{block.text}</code>
                </pre>
            );
        }
        return (
            <p key={`p-${index}`} className="chat-paragraph">
                {renderInlineCode(block.text)}
            </p>
        );
    });
}

function parseMessageBlocks(content: string): Array<{ type: 'paragraph' | 'code'; text: string }> {
    const lines = content.split('\n');
    const blocks: Array<{ type: 'paragraph' | 'code'; text: string }> = [];
    let codeBuffer: string[] | null = null;
    let textBuffer: string[] = [];

    const flushText = () => {
        const text = textBuffer.join('\n').trim();
        if (text) blocks.push({ type: 'paragraph', text });
        textBuffer = [];
    };
    const flushCode = () => {
        if (codeBuffer === null) return;
        const text = codeBuffer.join('\n').trimEnd();
        if (text) blocks.push({ type: 'code', text });
        codeBuffer = null;
    };

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            if (codeBuffer === null) {
                flushText();
                codeBuffer = [];
            } else {
                flushCode();
            }
            continue;
        }
        if (codeBuffer) {
            codeBuffer.push(line);
            continue;
        }
        if (!line.trim()) {
            flushText();
            continue;
        }
        textBuffer.push(line);
    }

    flushText();
    flushCode();

    return blocks.length ? blocks : [{ type: 'paragraph', text: content }];
}

function renderInlineCode(text: string) {
    const parts = text.split(/(`[^`]+`)/g);
    return parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            return (
                <code key={`code-${index}`} className="chat-inline-code">
                    {part.slice(1, -1)}
                </code>
            );
        }
        return <span key={`text-${index}`}>{part}</span>;
    });
}

function humanizeToolName(name: string): string {
    switch (name) {
        case 'create_pipeline':
            return '创建 pipeline';
        case 'update_pipeline':
            return '更新 pipeline';
        case 'validate_pipeline':
            return '校验 pipeline';
        case 'run_pipeline':
            return '运行 pipeline';
        case 'list_components':
            return '列出组件';
        case 'get_component_schema':
            return '读取组件 schema';
        default:
            return name || '未知工具';
    }
}

function StatusIcon({ item }: { item: StatusItem }) {
    if (item.tone === 'running') return <Loader2 size={12} className="spin" />;
    if (item.tone === 'error') return <AlertCircle size={12} />;
    if (item.kind === 'tool') return <Wrench size={12} />;
    if (item.kind === 'pipeline') return <Workflow size={12} />;
    if (item.kind === 'route' || item.kind === 'thinking') return <Sparkles size={12} />;
    return <CheckCircle2 size={12} />;
}

function MessageFooter({ message }: { message: Bubble }) {
    return (
        <ReplyFooter
            text={message.content}
            usage={message.usage}
            startedAt={message.startedAt}
            finishedAt={message.finishedAt}
            reportedTitle="由 DSH 上报的 token 用量"
            estimateTitle="当前 ACP 会话未上报 token 用量，这是按回复长度估算的值"
        />
    );
}

/** Secure credential form for a saved connection. The password lives only in
 *  this component's state until it is handed to the backend, and is cleared
 *  right after, so it never reaches the message list or the saved history. */
function CredentialCard({
    request,
    onSave,
    onDismiss,
}: {
    request: CredentialRequest;
    onSave: (username: string, password: string) => Promise<void>;
    onDismiss: () => void;
}) {
    const { t } = useTranslation();
    const [username, setUsername] = useState(request.username ?? '');
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const target = [request.host, request.port].filter(v => v !== null && v !== undefined && v !== '').join(':');
    const where = [request.kind, target, request.database].filter(Boolean).join(' · ');

    if (request.status !== 'pending') {
        return (
            <div className={`chat-credential chat-credential-${request.status}`}>
                {request.status === 'saved' ? <ShieldCheck size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}
                <span>
                    {request.status === 'saved'
                        ? t('chat.credentials.saved', { name: request.name })
                        : t('chat.credentials.dismissed', { name: request.name })}
                </span>
            </div>
        );
    }

    const submit = async () => {
        if (!password || saving) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(username, password);
            setPassword('');
        } catch (err) {
            setError(String(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <form
            className="chat-credential"
            onSubmit={e => {
                e.preventDefault();
                void submit();
            }}
        >
            <div className="chat-credential-head">
                <KeyRound size={14} aria-hidden="true" />
                <span>{t('chat.credentials.title')}</span>
            </div>
            <div className="chat-credential-text">
                {request.reason === 'rejected'
                    ? t('chat.credentials.rejected', { name: request.name })
                    : t('chat.credentials.missing', { name: request.name })}
            </div>
            {where ? <div className="chat-credential-where">{where}</div> : null}
            <label className="chat-credential-field">
                <span>{t('chat.credentials.username')}</span>
                <input
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                />
            </label>
            <label className="chat-credential-field">
                <span>{t('chat.credentials.password')}</span>
                <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="new-password"
                    autoFocus
                    disabled={saving}
                />
            </label>
            {error ? <div className="chat-credential-error" role="alert">{error}</div> : null}
            <div className="chat-credential-note">
                <ShieldCheck size={12} aria-hidden="true" />
                <span>{t('chat.credentials.privacy')}</span>
            </div>
            <div className="chat-credential-actions">
                <button type="button" className="chat-credential-cancel" onClick={onDismiss} disabled={saving}>
                    {t('chat.credentials.cancel')}
                </button>
                <button type="submit" className="chat-credential-save" disabled={!password || saving}>
                    {saving ? <Loader2 size={12} className="spin" /> : null}
                    {t('chat.credentials.save')}
                </button>
            </div>
        </form>
    );
}

function ModelPicker({
    models,
    value,
    onChange,
    label,
}: {
    models: LlamaModel[];
    value: string;
    onChange: (id: string) => void;
    label: string;
}) {
    const chosen = models.find(m => m.id === value);
    return (
        <div className="chat-panel-model">
            <label className="chat-panel-model-label" htmlFor="duckie-model">
                {label}
            </label>
            <select
                id="duckie-model"
                className="chat-panel-model-select"
                value={value}
                onChange={e => onChange(e.target.value)}
            >
                {models.map(m => (
                    <option key={m.id} value={m.id}>
                        {m.label} - {formatSize(m.size_mb)}
                    </option>
                ))}
            </select>
            {chosen ? <div className="chat-panel-model-note">{chosen.note}</div> : null}
        </div>
    );
}

function SetupCard({
    title,
    body,
    cta,
    onCta,
    children,
}: {
    title: string;
    body: string;
    cta: string;
    onCta: () => void;
    /** Optional controls between the copy and the button - the model picker. */
    children?: React.ReactNode;
}) {
    return (
        <div className="chat-panel-setup">
            <div className="chat-panel-setup-icon">
                <Sparkles size={20} />
            </div>
            <div className="chat-panel-setup-title">{title}</div>
            <div className="chat-panel-setup-body">{body}</div>
            {children}
            <button type="button" className="chat-panel-setup-cta" onClick={onCta}>
                <Download size={14} /> {cta}
            </button>
            <div className="chat-panel-setup-foot">
                Runs on your CPU. No data leaves your machine.
            </div>
        </div>
    );
}

function InstallProgressView({ progress }: { progress: InstallProgress | null }) {
    if (!progress) return <span>Starting download...</span>;
    let label = '';
    let pct: number | null = null;
    switch (progress.phase) {
        case 'downloading': {
            const mb = (progress.received / 1_000_000).toFixed(0);
            if (progress.total) {
                pct = Math.round((progress.received / progress.total) * 100);
                const totalMb = (progress.total / 1_000_000).toFixed(0);
                label = `Downloading server ${mb} / ${totalMb} MB`;
            } else {
                label = `Downloading server ${mb} MB`;
            }
            break;
        }
        case 'extracting':
            label = 'Extracting...';
            break;
        case 'verifying':
            label = 'Verifying...';
            break;
        case 'running_command':
            label = progress.label;
            break;
        case 'downloading_model': {
            const mb = (progress.received / 1_000_000).toFixed(0);
            if (progress.total) {
                pct = Math.round((progress.received / progress.total) * 100);
                const totalMb = (progress.total / 1_000_000).toFixed(0);
                label = `Downloading model ${mb} / ${totalMb} MB`;
            } else {
                label = `Downloading model ${mb} MB`;
            }
            break;
        }
        case 'installing_extension':
            label = `Installing extensions (${progress.index}/${progress.total})`;
            break;
        case 'done':
            label = 'Ready';
            break;
        case 'failed':
            label = progress.error;
            break;
    }
    return (
        <div className="chat-panel-install-progress">
            <div className="chat-panel-install-bar">
                <div
                    className="chat-panel-install-fill"
                    style={{ width: pct != null ? `${pct}%` : '30%' }}
                    data-indeterminate={pct == null}
                />
            </div>
            <div className="chat-panel-install-label">{label}</div>
        </div>
    );
}
