import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Send, Sparkles, X, Workflow } from 'lucide-react';
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

export default function ChatPanel({ onClose, onInsertPipeline, onPersistedPipeline }: Props) {
    const { t } = useTranslation();
    const [setup, setSetup] = useState<SetupState>({ phase: 'checking' });
    const [messages, setMessages] = useState<Bubble[]>([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [dshRoute, setDshRoute] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const sessionIdRef = useRef(`duckie:${getWorkspacePath() ?? 'global'}`);
    const pendingPersistedPipelineId = useRef<string | null>(null);

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

    const send = useCallback(async (text?: string) => {
        const body = (text ?? draft).trim();
        if (!body || busy || setup.phase !== 'ready') return;
        if (!text) setDraft('');
        const userMsg: Bubble = { role: 'user', content: body };
        setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', streaming: true }]);
        setBusy(true);
        const history: ChatMessage[] = [
            ...messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: body },
        ];
        await chatSend(history, ev => {
            if (ev.kind === 'token') {
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = { ...last, content: last.content + ev.text };
                    }
                    return out;
                });
            } else if (ev.kind === 'model_selected') {
                setDshRoute(`${ev.provider}/${ev.model}`);
            } else if (ev.kind === 'done') {
                if (pendingPersistedPipelineId.current) {
                    onPersistedPipeline(pendingPersistedPipelineId.current);
                    pendingPersistedPipelineId.current = null;
                }
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = { ...last, streaming: false };
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
            } else if (ev.kind === 'error') {
                pendingPersistedPipelineId.current = null;
                setMessages(prev => {
                    const out = prev.slice();
                    const last = out[out.length - 1];
                    if (last && last.role === 'assistant' && last.streaming) {
                        out[out.length - 1] = {
                            ...last,
                            streaming: false,
                            content: ev.message,
                        };
                    }
                    return out;
                });
                setBusy(false);
            }
        }, getWorkspacePath(), sessionIdRef.current);
    }, [draft, busy, messages, onPersistedPipeline, setup]);

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

    return (
        <aside className="chat-panel" role="complementary" aria-label={t('chat.title')}>
            <header className="chat-panel-head">
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
                {setup.phase === 'ready' && setup.provider === 'deepseek_harness' && dshRoute ? (
                    <div style={{ fontSize: '0.85rem', opacity: 0.72, marginTop: 4 }}>
                        DSH route: <code>{dshRoute}</code>
                    </div>
                ) : null}
                <button
                    type="button"
                    className="chat-panel-close"
                    onClick={onClose}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                >
                    <X size={14} />
                </button>
            </header>

            {setup.phase === 'checking' ? (
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
                                    <div className="chat-bubble-content">
                                        {m.content}
                                        {m.streaming ? <span className="chat-caret" /> : null}
                                    </div>
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
                        <textarea
                            className="chat-panel-input"
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
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
                    </form>
                </>
            )}
        </aside>
    );
}

/** Sizes come from the Hugging Face file listing, so they are the real
 *  download, not an estimate. */
function formatSize(mb: number): string {
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
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
