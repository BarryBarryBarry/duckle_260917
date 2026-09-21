import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, CheckCircle2, ChevronDown, ChevronUp, Clock, Copy, Download, Gauge, Loader2, Send, Sparkles, Wrench, X, Workflow } from 'lucide-react';
import {
    chatExtractPipeline,
    chatSend,
    engineInstall,
    engineStatus,
    llamaDefaultModel,
    llamaModels,
    settingsGetAi,
    type ChatMessage,
    type EngineStatus,
    type InstallProgress,
    type LlamaModel,
} from '../tauri-bridge';
import { getWorkspacePath } from '../workspace';

type Props = {
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

const CHAT_PANEL_WIDTH = 420;
const CHAT_PANEL_MIN_WIDTH = 360;
const CHAT_PANEL_MAX_WIDTH = 620;
const CHAT_PANEL_MIN_HEIGHT = 520;
const CHAT_PANEL_MAX_HEIGHT = 760;
const CHAT_PANEL_MARGIN = 16;
const CHAT_PANEL_STORAGE_KEY = 'duckie-chat-panel-position';
const CHAT_PANEL_SNAP_DISTANCE = 28;

type PanelLayout = {
    x: number;
    y: number;
    width: number;
    height: number;
    collapsed: boolean;
};

type ResizeMode = 'left' | 'right' | 'corner';

export default function ChatPanel({ onClose, onInsertPipeline, onPersistedPipeline }: Props) {
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
    const sessionIdRef = useRef(`duckie:${getWorkspacePath() ?? 'global'}`);
    const pendingPersistedPipelineId = useRef<string | null>(null);
    const toolNamesRef = useRef<Record<string, string>>({});
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const resizeRef = useRef<{
        pointerId: number;
        mode: ResizeMode;
        startX: number;
        startY: number;
        originX: number;
        originWidth: number;
        originHeight: number;
    } | null>(null);
    const activeStatus = useMemo(() => findActiveStatus(messages), [messages]);

    // Detect the AI engine on mount so we can either show the chat
    // UI or a clear install card. Without this the user clicks Send
    // and gets a cryptic spawn error.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ai = await settingsGetAi(getWorkspacePath() ?? '');
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
    }, []);

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
        }, getWorkspacePath(), sessionIdRef.current);
    }, [draft, busy, messages, onPersistedPipeline, setup, updateStreamingAssistant]);

    // Esc closes the panel.
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    // Auto-scroll as tokens stream in.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

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
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: start.x,
            originY: start.y,
        };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
    }, [panelLayout]);

    const handleHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            return clampPanelLayout({
                ...base,
                x: drag.originX + (event.clientX - drag.startX),
                y: drag.originY + (event.clientY - drag.startY),
            });
        });
    }, []);

    const finishDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        setPanelLayout(prev => (prev ? snapPanelLayout(prev) : prev));
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
            originX: base.x,
            originWidth: base.width,
            originHeight: base.height,
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
            const deltaX = event.clientX - resize.startX;
            const deltaY = event.clientY - resize.startY;
            if (resize.mode === 'left') {
                return clampPanelLayout({
                    ...base,
                    x: resize.originX + deltaX,
                    width: resize.originWidth - deltaX,
                });
            }
            if (resize.mode === 'right') {
                return clampPanelLayout({
                    ...base,
                    width: resize.originWidth + deltaX,
                });
            }
            return clampPanelLayout({
                ...base,
                width: resize.originWidth + deltaX,
                height: resize.originHeight + deltaY,
            });
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

    const toggleCollapsed = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            return { ...base, collapsed: !base.collapsed };
        });
    }, []);

    const resetPanelLayout = useCallback(() => {
        setPanelLayout(clampPanelLayout(defaultPanelLayout()));
    }, []);

    const currentLayout = panelLayout ?? defaultPanelLayout();
    const panelStyle = {
        left: currentLayout.x,
        top: currentLayout.y,
        width: currentLayout.width,
        height: currentLayout.collapsed ? undefined : currentLayout.height,
    };

    return (
        <aside
            ref={panelRef}
            className={`chat-panel ${dragging ? 'chat-panel-dragging' : ''} ${
                resizing ? 'chat-panel-resizing' : ''
            } ${currentLayout.collapsed ? 'chat-panel-collapsed' : ''}`}
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
                        title={currentLayout.collapsed ? '展开 Duckie' : '折叠 Duckie'}
                        aria-label={currentLayout.collapsed ? '展开 Duckie' : '折叠 Duckie'}
                    >
                        {currentLayout.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
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
                    <span>Duckie 已折叠</span>
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
                <>
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
                                    }
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
                </>
            )}
            {!currentLayout.collapsed ? (
                <>
                    <button
                        type="button"
                        className={`chat-panel-resize-handle chat-panel-resize-handle-left ${
                            resizeHover === 'left' ? 'chat-panel-resize-handle-visible' : ''
                        }`}
                        aria-label="向左或向右调整 Duckie 面板宽度"
                        title="拖动以左右调整 Duckie 面板宽度"
                        onPointerDown={event => handleResizePointerDown(event, 'left')}
                        onPointerMove={handleResizePointerMove}
                        onPointerUp={finishResize}
                        onPointerCancel={finishResize}
                        onMouseEnter={() => setResizeHover('left')}
                        onMouseLeave={() => setResizeHover(prev => (prev === 'left' ? null : prev))}
                    />
                    <button
                        type="button"
                        className={`chat-panel-resize-handle chat-panel-resize-handle-right ${
                            resizeHover === 'right' ? 'chat-panel-resize-handle-visible' : ''
                        }`}
                        aria-label="向左或向右调整 Duckie 面板宽度"
                        title="拖动以左右调整 Duckie 面板宽度"
                        onPointerDown={event => handleResizePointerDown(event, 'right')}
                        onPointerMove={handleResizePointerMove}
                        onPointerUp={finishResize}
                        onPointerCancel={finishResize}
                        onMouseEnter={() => setResizeHover('right')}
                        onMouseLeave={() => setResizeHover(prev => (prev === 'right' ? null : prev))}
                    />
                    <button
                        type="button"
                        className={`chat-panel-resize-handle chat-panel-resize-handle-corner ${
                            resizeHover === 'corner' ? 'chat-panel-resize-handle-visible' : ''
                        }`}
                        aria-label="调整 Duckie 面板大小"
                        title="拖动以调整 Duckie 面板大小"
                        onPointerDown={event => handleResizePointerDown(event, 'corner')}
                        onPointerMove={handleResizePointerMove}
                        onPointerUp={finishResize}
                        onPointerCancel={finishResize}
                        onMouseEnter={() => setResizeHover('corner')}
                        onMouseLeave={() => setResizeHover(prev => (prev === 'corner' ? null : prev))}
                    />
                </>
            ) : null}
        </aside>
    );
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
            collapsed?: unknown;
        };
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return {
                x: parsed.x,
                y: parsed.y,
                width: typeof parsed.width === 'number' ? parsed.width : CHAT_PANEL_WIDTH,
                height: typeof parsed.height === 'number' ? parsed.height : CHAT_PANEL_MAX_HEIGHT,
                collapsed: parsed.collapsed === true,
            };
        }
    } catch {
        // Ignore malformed saved positions and fall back to the default.
    }
    return null;
}

function defaultPanelLayout(): PanelLayout {
    if (typeof window === 'undefined') {
        return {
            x: CHAT_PANEL_MARGIN,
            y: CHAT_PANEL_MARGIN,
            width: CHAT_PANEL_WIDTH,
            height: CHAT_PANEL_MAX_HEIGHT,
            collapsed: false,
        };
    }
    const width = Math.min(CHAT_PANEL_WIDTH, window.innerWidth - CHAT_PANEL_MARGIN * 2);
    const height = Math.min(
        CHAT_PANEL_MAX_HEIGHT,
        Math.max(CHAT_PANEL_MIN_HEIGHT, window.innerHeight - readTopbarHeight() - 24),
    );
    const topbarHeight = readTopbarHeight();
    return {
        x: Math.max(CHAT_PANEL_MARGIN, window.innerWidth - width - CHAT_PANEL_MARGIN),
        y: topbarHeight + 10,
        width,
        height,
        collapsed: false,
    };
}

function clampPanelLayout(layout: PanelLayout): PanelLayout {
    if (typeof window === 'undefined') return layout;
    const width = Math.min(
        Math.max(layout.width, CHAT_PANEL_MIN_WIDTH),
        Math.min(CHAT_PANEL_MAX_WIDTH, window.innerWidth - CHAT_PANEL_MARGIN * 2),
    );
    const maxHeight = Math.min(CHAT_PANEL_MAX_HEIGHT, window.innerHeight - readTopbarHeight() - 24);
    const height = Math.min(Math.max(layout.height, Math.min(CHAT_PANEL_MIN_HEIGHT, maxHeight)), maxHeight);
    const minX = CHAT_PANEL_MARGIN;
    const maxX = Math.max(CHAT_PANEL_MARGIN, window.innerWidth - width - CHAT_PANEL_MARGIN);
    const minY = readTopbarHeight() + 8;
    const effectiveHeight = layout.collapsed ? 82 : height;
    const maxY = Math.max(minY, window.innerHeight - effectiveHeight - CHAT_PANEL_MARGIN);
    return {
        ...layout,
        width,
        height,
        x: Math.min(Math.max(layout.x, minX), maxX),
        y: Math.min(Math.max(layout.y, minY), maxY),
    };
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
