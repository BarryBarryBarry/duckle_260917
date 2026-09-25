import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    AlertCircle,
    Check,
    CheckCircle2,
    ChevronDown,
    Clock,
    Copy,
    Download,
    Ellipsis,
    Gauge,
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
    type DuckieConversationSummary,
    type EngineStatus,
    type InstallProgress,
    type LlamaModel,
} from '../tauri-bridge';
import { getWorkspacePath } from '../workspace';

type Props = {
    workspace: string | null;
    /** The panel stays mounted while closed so an in-flight reply keeps
     *  streaming and gets saved; `open` only controls visibility. */
    open: boolean;
    onClose: () => void;
    onInsertPipeline: (pipeline: unknown) => void;
    onPersistedPipeline: (pipelineId: string) => void;
};

type Bubble = ChatMessage & {
    /** True while tokens are still streaming in. */
    streaming?: boolean;
    /** Cached extracted pipeline, computed after the stream finishes. */
    pipeline?: unknown;
    /** Structured live progress for the current assistant turn. */
    statusItems?: StatusItem[];
    /** Wall-clock start of the turn, used for the elapsed-time readout. */
    startedAt?: number;
    /** Wall-clock end of the turn. */
    finishedAt?: number;
    /** Token accounting reported by the agent, when it reports any. */
    usage?: { input?: number; output?: number; total?: number };
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
const CHAT_PANEL_WIDTH = 420;
const CHAT_PANEL_MAX_WIDTH = 620;
const CHAT_PANEL_MAX_HEIGHT = 760;
/** Smallest the panel may be dragged to before the edge stops following. */
const CHAT_PANEL_MIN_WIDTH = 360;
const CHAT_PANEL_MIN_HEIGHT = 360;
const CHAT_PANEL_MARGIN = 16;
const CHAT_PANEL_STORAGE_KEY = 'duckie-chat-panel-position';
/** Width of the chat-history sidebar; the panel grows by this much when it is shown. */
const CHAT_SIDEBAR_WIDTH = 216;
/** Per-workspace localStorage key prefix for the conversation to reopen. */
const ACTIVE_CONVERSATION_KEY = 'duckie-active-conversation';
/** Auto titles are the first user message, cut to this many characters. */
const TITLE_MAX_CHARS = 30;
const CHAT_PANEL_SNAP_DISTANCE = 28;
/** Height of the header strip, which is all that is left when minimized. */
const CHAT_PANEL_COLLAPSED_HEIGHT = 82;
/** How far the pointer must travel before a press on the header counts as a
 *  drag. Below this a press is just a click and leaves the panel untouched. */
const DRAG_THRESHOLD = 4;

type PanelRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

type PanelLayout = PanelRect & {
    /** Whether the chat-history sidebar is shown. */
    sidebar: boolean;
    /** Minimized: only the header strip is drawn. */
    collapsed: boolean;
    /** Maximized: fills the work area, ignoring the default size caps. */
    maximized: boolean;
    /** The rect to go back to when un-maximizing. */
    restore: PanelRect | null;
};

/** Every edge and corner, so the panel resizes in all four directions. */
type ResizeMode =
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right';

const RESIZE_MODES: ResizeMode[] = [
    'top',
    'bottom',
    'left',
    'right',
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
];

const RESIZE_LABEL: Record<ResizeMode, string> = {
    top: '拖动以调整 Duckie 面板高度（上边缘）',
    bottom: '拖动以调整 Duckie 面板高度（下边缘）',
    left: '拖动以调整 Duckie 面板宽度（左边缘）',
    right: '拖动以调整 Duckie 面板宽度（右边缘）',
    'top-left': '拖动以调整 Duckie 面板大小（左上角）',
    'top-right': '拖动以调整 Duckie 面板大小（右上角）',
    'bottom-left': '拖动以调整 Duckie 面板大小（左下角）',
    'bottom-right': '拖动以调整 Duckie 面板大小（右下角）',
};

export default function ChatPanel({ workspace: workspaceProp, open, onClose, onInsertPipeline, onPersistedPipeline }: Props) {
    const { t } = useTranslation();
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [messages, setMessages] = useState<Bubble[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [dshRoute, setDshRoute] = useState<string | null>(null);
    const [panelLayout, setPanelLayout] = useState<PanelLayout | null>(null);
    const [dragging, setDragging] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [resizeHover, setResizeHover] = useState<ResizeMode | null>(null);
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
    /** Shell-style input recall: how many inputs back the composer shows
     *  (null = not recalling), and the unsent draft to return to. */
    const recallIndexRef = useRef<number | null>(null);
    const recallStashRef = useRef('');
    const pendingPersistedPipelineId = useRef<string | null>(null);
    const toolNamesRef = useRef<Record<string, string>>({});
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; started: boolean } | null>(null);
    const resizeRef = useRef<{
        pointerId: number;
        mode: ResizeMode;
        startX: number;
        startY: number;
        origin: PanelRect;
    } | null>(null);
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
        recallIndexRef.current = null;
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
        recallIndexRef.current = null;
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

    /** Up recalls this conversation's earlier inputs, newest first; Down walks
     *  back towards the draft that was being typed. Up only starts recalling
     *  from the composer's first line so multi-line drafts stay editable; once
     *  recalling, both keys keep navigating until the text is edited. */
    const handleRecallKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (event.nativeEvent.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
        const el = event.currentTarget;
        const current = recallIndexRef.current;
        const inputs = messagesRef.current.filter(m => m.role === 'user').map(m => m.content);
        let next: number;
        if (event.key === 'ArrowUp') {
            const onFirstLine =
                el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes('\n');
            if (current === null && !onFirstLine) return;
            next = (current ?? 0) + 1;
            if (next > inputs.length) {
                event.preventDefault();
                return;
            }
            if (current === null) recallStashRef.current = el.value;
        } else {
            if (current === null) return;
            next = current - 1;
        }
        event.preventDefault();
        const value = next === 0 ? recallStashRef.current : inputs[inputs.length - next];
        recallIndexRef.current = next === 0 ? null : next;
        setDraft(value);
        requestAnimationFrame(() => {
            const input = inputRef.current;
            if (!input) return;
            input.setSelectionRange(value.length, value.length);
            syncComposerHeight(input);
        });
    }, []);

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

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const saved = readSavedPanelLayout();
        setPanelLayout(clampPanelLayout(saved ?? defaultPanelLayout()));
    }, []);

    useEffect(() => {
        if (!panelLayout || typeof window === 'undefined') return;
        window.localStorage.setItem(CHAT_PANEL_STORAGE_KEY, JSON.stringify(panelLayout));
    }, [panelLayout]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onResize = () => setPanelLayout(prev => clampPanelLayout(prev ?? defaultPanelLayout()));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        document.body.classList.toggle('chat-panel-dragging-body', dragging || resizing);
        return () => document.body.classList.remove('chat-panel-dragging-body');
    }, [dragging, resizing]);

    const handleHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, input, textarea, select, a')) return;
        const start = panelLayout ?? defaultPanelLayout();
        // Nothing is committed here, not even for a maximized panel: a press
        // is not yet a drag, and restoring on press alone would shrink the
        // panel on a plain click of the header.
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: start.x,
            originY: start.y,
            started: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }, [panelLayout]);

    const handleHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const totalX = event.clientX - drag.startX;
        const totalY = event.clientY - drag.startY;
        if (!drag.started) {
            // Wait for real movement before treating the gesture as a drag, so
            // a click (or a click that wobbles by a pixel) leaves the panel be.
            if (Math.abs(totalX) < DRAG_THRESHOLD && Math.abs(totalY) < DRAG_THRESHOLD) return;
            drag.started = true;
            setDragging(true);
        }
        setPanelLayout(prev => {
            let base = prev ?? defaultPanelLayout();
            if (base.maximized) {
                // First real movement on a maximized panel restores it, the way
                // a desktop window does. The anchor uses the point the user
                // pressed, so the cursor keeps the same relative spot on the
                // header and the panel does not jump out from under it.
                const restore = base.restore ?? defaultPanelLayout(base.sidebar);
                const ratio = (drag.startX - base.x) / Math.max(1, base.width);
                drag.originX = drag.startX - restore.width * ratio;
                drag.originY = base.y;
                base = {
                    ...base,
                    width: restore.width,
                    height: restore.height,
                    maximized: false,
                    restore: null,
                };
            }
            return clampPanelLayout({
                ...base,
                x: drag.originX + totalX,
                y: drag.originY + totalY,
            });
        });
    }, []);

    const finishDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const started = drag.started;
        dragRef.current = null;
        setDragging(false);
        // A click that never became a drag must not snap the panel around.
        if (started) setPanelLayout(prev => (prev ? snapPanelLayout(prev) : prev));
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    const handleResizePointerDown = useCallback((
        event: React.PointerEvent<HTMLButtonElement>,
        mode: ResizeMode,
    ) => {
        if (event.button !== 0) return;
        const base = panelLayout ?? defaultPanelLayout();
        resizeRef.current = {
            pointerId: event.pointerId,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            origin: { x: base.x, y: base.y, width: base.width, height: base.height },
        };
        setResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.stopPropagation();
    }, [panelLayout]);

    const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            const next = resizeRect(
                resize.origin,
                resize.mode,
                event.clientX - resize.startX,
                event.clientY - resize.startY,
                minPanelWidth(base.sidebar),
            );
            // A resized panel is no longer "maximized", so the restore button
            // does not snap away the size the user just dragged.
            return clampPanelLayout({ ...base, ...next, maximized: false });
        });
    }, []);

    const finishResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    /** Minimize: collapse to the header strip. Restores the previous height. */
    const toggleCollapsed = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            return clampPanelLayout({ ...base, collapsed: !base.collapsed });
        });
    }, []);

    /** Maximize / restore. The pre-maximize rect is kept so restoring puts the
     *  panel back exactly where it was rather than at the default position. */
    const toggleMaximized = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            if (base.maximized) {
                const restore = base.restore ?? defaultPanelLayout(base.sidebar);
                return clampPanelLayout({
                    ...base,
                    ...restore,
                    sidebar: base.sidebar,
                    collapsed: false,
                    maximized: false,
                    restore: null,
                });
            }
            return clampPanelLayout({
                ...base,
                ...maximizedRect(),
                collapsed: false,
                maximized: true,
                restore: { x: base.x, y: base.y, width: base.width, height: base.height },
            });
        });
    }, []);

    const resetPanelLayout = useCallback(() => {
        setPanelLayout(prev => clampPanelLayout(defaultPanelLayout(prev?.sidebar ?? true)));
    }, []);

    /** Showing the sidebar grows the panel leftwards by its width (and hiding
     *  shrinks it back), so the conversation column keeps its size and the
     *  panel's right edge stays put. */
    const toggleSidebar = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            const sidebar = !base.sidebar;
            if (base.maximized) return clampPanelLayout({ ...base, sidebar });
            const delta = sidebar ? CHAT_SIDEBAR_WIDTH : -CHAT_SIDEBAR_WIDTH;
            return clampPanelLayout({
                ...base,
                sidebar,
                width: base.width + delta,
                x: base.x - delta,
            });
        });
    }, []);

    const currentLayout = panelLayout ?? defaultPanelLayout();
    const menuConversation = menu ? conversations.find(c => c.id === menu.id) ?? null : null;
    const panelStyle = {
        left: currentLayout.x,
        top: currentLayout.y,
        width: currentLayout.width,
        height: currentLayout.collapsed ? undefined : currentLayout.height,
    };

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
            <header
                className="chat-panel-head"
                onPointerDown={handleHeaderPointerDown}
                onPointerMove={handleHeaderPointerMove}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onDoubleClick={resetPanelLayout}
            >
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
                                        recallIndexRef.current = null;
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
            {!currentLayout.collapsed ? (
                <>
                    {RESIZE_MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            className={`chat-panel-resize-handle chat-panel-resize-handle-${mode} ${
                                resizeHover === mode ? 'chat-panel-resize-handle-visible' : ''
                            }`}
                            aria-label={RESIZE_LABEL[mode]}
                            title={RESIZE_LABEL[mode]}
                            onPointerDown={event => handleResizePointerDown(event, mode)}
                            onPointerMove={handleResizePointerMove}
                            onPointerUp={finishResize}
                            onPointerCancel={finishResize}
                            onMouseEnter={() => setResizeHover(mode)}
                            onMouseLeave={() => setResizeHover(prev => (prev === mode ? null : prev))}
                        />
                    ))}
                </>
            ) : null}
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

function readSavedPanelLayout(): PanelLayout | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(CHAT_PANEL_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
            x?: unknown;
            y?: unknown;
            width?: unknown;
            height?: unknown;
            sidebar?: unknown;
            collapsed?: unknown;
            maximized?: unknown;
            restore?: unknown;
        };
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return {
                x: parsed.x,
                y: parsed.y,
                width: typeof parsed.width === 'number' ? parsed.width : CHAT_PANEL_WIDTH,
                height: typeof parsed.height === 'number' ? parsed.height : CHAT_PANEL_MAX_HEIGHT,
                // Layouts saved before the sidebar existed get it shown; the
                // clamp then widens them to fit.
                sidebar: parsed.sidebar !== false,
                collapsed: parsed.collapsed === true,
                maximized: parsed.maximized === true,
                restore: readRect(parsed.restore),
            };
        }
    } catch {
        // Ignore malformed saved positions and fall back to the default.
    }
    return null;
}

function readRect(value: unknown): PanelRect | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number'
    ) {
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
}

function sidebarExtra(sidebar: boolean): number {
    return sidebar ? CHAT_SIDEBAR_WIDTH : 0;
}

function minPanelWidth(sidebar: boolean): number {
    return CHAT_PANEL_MIN_WIDTH + sidebarExtra(sidebar);
}

function defaultPanelLayout(sidebar = true): PanelLayout {
    if (typeof window === 'undefined') {
        return {
            x: CHAT_PANEL_MARGIN,
            y: CHAT_PANEL_MARGIN,
            width: CHAT_PANEL_WIDTH + sidebarExtra(sidebar),
            height: CHAT_PANEL_MAX_HEIGHT,
            sidebar,
            collapsed: false,
            maximized: false,
            restore: null,
        };
    }
    const topbarHeight = readTopbarHeight();
    const width = Math.min(
        CHAT_PANEL_MAX_WIDTH + sidebarExtra(sidebar),
        Math.min(CHAT_PANEL_WIDTH + sidebarExtra(sidebar), window.innerWidth - CHAT_PANEL_MARGIN * 2),
    );
    const height = Math.min(
        CHAT_PANEL_MAX_HEIGHT,
        Math.max(CHAT_PANEL_MIN_HEIGHT, window.innerHeight - topbarHeight - 24),
    );
    return {
        x: Math.max(CHAT_PANEL_MARGIN, window.innerWidth - width - CHAT_PANEL_MARGIN),
        y: topbarHeight + 10,
        width,
        height,
        sidebar,
        collapsed: false,
        maximized: false,
        restore: null,
    };
}

/** The rectangle the panel is allowed to live in: below the topbar, inset by
 *  the margin on the other three sides. */
function panelWorkArea() {
    const top = readTopbarHeight() + 8;
    return {
        top,
        left: CHAT_PANEL_MARGIN,
        right: Math.max(CHAT_PANEL_MARGIN, window.innerWidth - CHAT_PANEL_MARGIN),
        bottom: Math.max(top, window.innerHeight - CHAT_PANEL_MARGIN),
    };
}

/** Maximizing fills the work area, so it deliberately ignores the default
 *  size caps that keep a freshly opened panel a comfortable reading width.
 *  It does not force the minimum size either: in a window too short for it,
 *  overflowing the work area would push the composer off-screen. */
function maximizedRect(): PanelRect {
    const area = panelWorkArea();
    return {
        x: area.left,
        y: area.top,
        width: area.right - area.left,
        height: area.bottom - area.top,
    };
}

function clampPanelLayout(layout: PanelLayout): PanelLayout {
    if (typeof window === 'undefined') return layout;
    if (layout.maximized) {
        return { ...layout, ...maximizedRect() };
    }
    const area = panelWorkArea();
    const availableWidth = area.right - area.left;
    const availableHeight = area.bottom - area.top;
    // A dragged edge may legitimately grow the panel past the default caps,
    // so the only hard limit is the work area itself.
    const width = clampSize(layout.width, minPanelWidth(layout.sidebar), availableWidth);
    const height = clampSize(layout.height, CHAT_PANEL_MIN_HEIGHT, availableHeight);
    // While minimized only the header is on screen, so that is what has to
    // stay inside the work area - not the height it will restore to.
    const occupiedHeight = layout.collapsed ? CHAT_PANEL_COLLAPSED_HEIGHT : height;
    const maxX = Math.max(area.left, area.right - width);
    const maxY = Math.max(area.top, area.bottom - occupiedHeight);
    return {
        ...layout,
        width,
        height,
        x: Math.min(Math.max(layout.x, area.left), maxX),
        y: Math.min(Math.max(layout.y, area.top), maxY),
    };
}

/** Keeps a dimension inside [min, max] even when the available space is
 *  smaller than the minimum (a very short window), where max wins. */
function clampSize(value: number, min: number, max: number): number {
    if (max <= min) return max;
    return Math.min(Math.max(value, min), max);
}

/** Resizes by moving only the dragged edges, so the opposite edge stays put
 *  even when the drag runs into the minimum size. Anchoring it this way is
 *  what stops the panel from sliding away under the cursor. */
function resizeRect(
    origin: PanelRect,
    mode: ResizeMode,
    deltaX: number,
    deltaY: number,
    minWidth: number,
): PanelRect {
    const area = panelWorkArea();
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;

    if (mode.includes('left')) {
        left = Math.min(Math.max(origin.x + deltaX, area.left), right - minWidth);
    }
    if (mode.includes('right')) {
        right = Math.max(Math.min(right + deltaX, area.right), left + minWidth);
    }
    if (mode.includes('top')) {
        top = Math.min(Math.max(origin.y + deltaY, area.top), bottom - CHAT_PANEL_MIN_HEIGHT);
    }
    if (mode.includes('bottom')) {
        bottom = Math.max(Math.min(bottom + deltaY, area.bottom), top + CHAT_PANEL_MIN_HEIGHT);
    }

    return { x: left, y: top, width: right - left, height: bottom - top };
}

function snapPanelLayout(layout: PanelLayout): PanelLayout {
    if (typeof window === 'undefined') return layout;
    const next = { ...layout };
    const maxX = Math.max(CHAT_PANEL_MARGIN, window.innerWidth - next.width - CHAT_PANEL_MARGIN);
    const minY = readTopbarHeight() + 8;
    if (Math.abs(next.x - CHAT_PANEL_MARGIN) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.x = CHAT_PANEL_MARGIN;
    }
    if (Math.abs(next.x - maxX) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.x = maxX;
    }
    if (Math.abs(next.y - minY) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.y = minY;
    }
    return clampPanelLayout(next);
}

function readTopbarHeight() {
    if (typeof window === 'undefined') return 56;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim();
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : 56;
}

function syncComposerHeight(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    textarea.style.height = '0px';
    const next = Math.min(textarea.scrollHeight, 240);
    textarea.style.height = `${Math.max(next, 72)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 240 ? 'auto' : 'hidden';
}

function MessageFooter({ message }: { message: Bubble }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1600);
        return () => window.clearTimeout(timer);
    }, [copied]);

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }, [message.content]);

    const tokens = formatTokenUsage(message);
    const elapsed = formatElapsed(message.startedAt, message.finishedAt);
    const finishedAt = message.finishedAt ? formatClock(message.finishedAt) : null;

    return (
        <div className="chat-bubble-footer">
            <button
                type="button"
                className={`chat-bubble-footer-btn ${copied ? 'chat-bubble-footer-btn-done' : ''}`}
                onClick={() => void copy()}
                title={copied ? '已复制' : '复制回复内容'}
                aria-label={copied ? '已复制' : '复制回复内容'}
            >
                {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <div className="chat-bubble-metrics">
                {tokens ? (
                    <span className="chat-bubble-metric" title={tokens.title}>
                        <Gauge size={12} aria-hidden="true" />
                        用量 {tokens.label}
                    </span>
                ) : null}
                {elapsed ? (
                    <span className="chat-bubble-metric">
                        <Clock size={12} aria-hidden="true" />
                        用时 {elapsed}
                    </span>
                ) : null}
                {finishedAt ? <span className="chat-bubble-metric">{finishedAt}</span> : null}
            </div>
        </div>
    );
}

/** The agent does not always report token counts, so an estimate is labelled
 *  as one rather than presented as a real accounting figure. */
function formatTokenUsage(message: Bubble): { label: string; title: string } | null {
    const usage = message.usage;
    const reported = usage?.total ?? sumTokens(usage?.input, usage?.output);
    if (reported != null) {
        const parts: string[] = [];
        if (usage?.input != null) parts.push(`输入 ${formatTokenCount(usage.input)}`);
        if (usage?.output != null) parts.push(`输出 ${formatTokenCount(usage.output)}`);
        return {
            label: `${formatTokenCount(reported)} tok`,
            title: parts.length ? parts.join(' · ') : '由 DSH 上报的 token 用量',
        };
    }
    if (!message.content) return null;
    const estimated = Math.max(1, Math.round(message.content.length / 3.2));
    return {
        label: `≈${formatTokenCount(estimated)} tok`,
        title: '当前 ACP 会话未上报 token 用量，这是按回复长度估算的值',
    };
}

function sumTokens(input?: number, output?: number): number | null {
    if (input == null && output == null) return null;
    return (input ?? 0) + (output ?? 0);
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}

function formatElapsed(startedAt?: number, finishedAt?: number): string | null {
    if (startedAt == null || finishedAt == null || finishedAt < startedAt) return null;
    const seconds = Math.round((finishedAt - startedAt) / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

function formatClock(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
    });
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
