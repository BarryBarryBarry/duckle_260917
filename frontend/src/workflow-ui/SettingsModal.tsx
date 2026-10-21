import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { X, Loader2, Check, ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import {
    settingsGetProxy,
    settingsSetProxy,
    settingsGetAi,
    settingsSetAi,
    aiModels,
    type AiModelChoice,
    settingsGetMemoryLimit,
    settingsGetAllowUnsigned,
    settingsGetPower,
    settingsSetPower,
    settingsSetAllowUnsigned,
    settingsGetContextFile,
    settingsSetContextFile,
    settingsGetAgentAttachmentMaxMb,
    settingsSetAgentAttachmentMaxMb,
    DEFAULT_AGENT_ATTACHMENT_MAX_MB,
} from '../tauri-bridge';
import { loadPersisted, savePersisted } from '../persistence';
import { openExternal } from '../tauri-io';
import {
    DEFAULT_FONT_SIZE,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    getFontSize,
    setFontSize as applyAndSaveFontSize,
} from '../font-size';
import { DUCKIE_ENABLED } from '../features';
import { isTauri } from '../tauri-dialog';
import { getIdleLockMinutes, IDLE_LOCK_CHOICES, setIdleLockMinutes } from '../auth/idle';

// With DSH hidden it cannot be picked, so a workspace still on it (the backend
// default) shows, and saves as, the external endpoint the Agent uses.
const DEFAULT_AI_MODE = DUCKIE_ENABLED ? 'deepseek_harness' : 'openai_compatible';

/**
 * App settings, grouped into collapsible categories so the panel stays simple
 * (#102). Workspace settings (proxy, memory cap, context file, AI endpoint) are
 * persisted per workspace to .duckle/settings.json via the Save button; UI
 * preferences (font size, Dives button) apply immediately and live in
 * localStorage.
 */
export function SettingsModal({
    workspace,
    onClose,
}: {
    workspace: string | null;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const code = { code: <code /> };
    const [proxy, setProxy] = useState('');
    const [aiMode, setAiMode] = useState<'deepseek_harness' | 'openai_compatible' | 'local_qwen'>(DEFAULT_AI_MODE);
    // Duckie AI provider configuration.
    const [aiBaseUrl, setAiBaseUrl] = useState('');
    const [aiModel, setAiModel] = useState('');
    const [aiKey, setAiKey] = useState('');
    const [aiHarnessCommand, setAiHarnessCommand] = useState('');
    const [aiHarnessProvider, setAiHarnessProvider] = useState('');
    const [aiHarnessModel, setAiHarnessModel] = useState('');
    // Minutes a DSH turn may stay silent before Duckie cancels it (empty = default).
    const [aiHarnessIdleMinutes, setAiHarnessIdleMinutes] = useState('');
    const [aiChoices, setAiChoices] = useState<AiModelChoice[] | null>(null);
    const [aiListError, setAiListError] = useState('');
    const [aiListing, setAiListing] = useState(false);
    // #102: per-workspace total memory cap in MB (empty = engine default).
    const [memLimit, setMemLimit] = useState('');
    // #143: allow loading unsigned / community DuckDB extensions (off by default).
    const [allowUnsigned, setAllowUnsigned] = useState(false);
    // Power mode: throughput settings. Empty concurrency = leave the host on
    // its own default, so a workspace that never opts in behaves as before.
    const [maxRuns, setMaxRuns] = useState('');
    const [spillDir, setSpillDir] = useState('');
    const [cpuCount, setCpuCount] = useState(1);
    // Global context file: a key/value file auto-merged into the global context.
    const [contextFile, setContextFile] = useState('');
    // Largest file, in MB, the Agent input may attach (empty = default).
    const [attachMaxMb, setAttachMaxMb] = useState('');
    // Local UI pref: show/hide the top-bar Dives button.
    const [showDives, setShowDives] = useState(() => !loadPersisted('hideDivesButton', false));
    // Local UI pref: show/hide the canvas minimap. On by default, because it
    // is how you find a node on a large graph; off for anyone who would rather
    // have the corner of the canvas back.
    const [showMinimap, setShowMinimap] = useState(() => !loadPersisted('hideMinimap', false));
    // Local UI pref: lock the desktop app after this many idle minutes (0 = never).
    const [idleLock, setIdleLock] = useState(getIdleLockMinutes);
    // Local UI pref: global font size (applies live, no Save).
    const [fontSize, setFontSize] = useState(() => getFontSize());
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Which categories are expanded. Persisted so the panel reopens as left.
    const [expanded, setExpanded] = useState<Set<string>>(
        () => new Set(loadPersisted<string[]>('settingsExpanded', ['appearance'])),
    );

    useEffect(() => {
        let alive = true;
        if (!workspace) {
            setLoaded(true);
            return;
        }
        Promise.all([
            settingsGetProxy(workspace),
            settingsGetAi(workspace),
            settingsGetMemoryLimit(workspace),
            settingsGetContextFile(workspace),
            settingsGetAllowUnsigned(workspace),
            settingsGetPower(workspace),
            settingsGetAgentAttachmentMaxMb(workspace),
        ])
            .then(([p, ai, mem, ic, unsigned, power, attachMb]) => {
                if (!alive) return;
                setProxy(p ?? '');
                const mode = ai.mode ?? 'deepseek_harness';
                setAiMode(mode === 'deepseek_harness' ? DEFAULT_AI_MODE : mode);
                setAiBaseUrl(ai.baseUrl ?? '');
                setAiModel(ai.model ?? '');
                setAiKey(ai.apiKey ?? '');
                setAiHarnessCommand(ai.harnessCommand ?? '');
                setAiHarnessProvider(ai.harnessProvider ?? '');
                setAiHarnessModel(ai.harnessModel ?? '');
                setAiHarnessIdleMinutes(
                    ai.harnessIdleTimeoutSecs != null ? String(ai.harnessIdleTimeoutSecs / 60) : '',
                );
                setMemLimit(mem != null ? String(mem) : '');
                setContextFile(ic ?? '');
                setAllowUnsigned(unsigned ?? false);
                setMaxRuns(power.maxConcurrentRuns != null ? String(power.maxConcurrentRuns) : '');
                setSpillDir(power.spillDir ?? '');
                setCpuCount(power.cpuCount || 1);
                setAttachMaxMb(attachMb !== DEFAULT_AGENT_ATTACHMENT_MAX_MB ? String(attachMb) : '');
                setLoaded(true);
            })
            .catch(e => {
                if (alive) {
                    setError(String(e));
                    setLoaded(true);
                }
            });
        return () => {
            alive = false;
        };
    }, [workspace]);

    const save = async () => {
        if (!workspace) return;
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            await settingsSetProxy(workspace, proxy.trim() || null);
            await settingsSetAi(workspace, {
                mode: aiMode,
                baseUrl: aiBaseUrl.trim() || null,
                model: aiModel.trim() || null,
                apiKey: aiKey.trim() || null,
                harnessCommand: aiHarnessCommand.trim() || null,
                harnessProvider: aiHarnessProvider.trim() || null,
                harnessModel: aiHarnessModel.trim() || null,
                harnessIdleTimeoutSecs: idleMinutesToSecs(aiHarnessIdleMinutes),
            });
            const mb = parseInt(memLimit.trim(), 10);
            const memMb = Number.isFinite(mb) && mb > 0 ? mb : null;
            const runs = parseInt(maxRuns.trim(), 10);
            await settingsSetPower(workspace, {
                maxConcurrentRuns: Number.isFinite(runs) && runs > 0 ? runs : null,
                memoryLimitMb: memMb,
                spillDir: spillDir.trim() || null,
            });
            await settingsSetAllowUnsigned(workspace, allowUnsigned);
            await settingsSetContextFile(workspace, contextFile.trim() || null);
            const attachMb = parseInt(attachMaxMb.trim(), 10);
            await settingsSetAgentAttachmentMaxMb(workspace, Number.isFinite(attachMb) && attachMb > 0 ? attachMb : null);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (e) {
            setError(String(e));
        } finally {
            setSaving(false);
        }
    };

    // Local UI pref - applies immediately (no Save), broadcast so App re-reads.
    const toggleDives = (next: boolean) => {
        setShowDives(next);
        savePersisted('hideDivesButton', !next);
        window.dispatchEvent(new Event('duckle:dives-visibility'));
    };

    const toggleMinimap = (next: boolean) => {
        setShowMinimap(next);
        savePersisted('hideMinimap', !next);
        window.dispatchEvent(new Event('duckle:minimap-visibility'));
    };

    // Font size applies live as it changes; clamped + persisted in font-size.ts.
    const changeFontSize = (next: number) => {
        setFontSize(applyAndSaveFontSize(next));
    };

    const toggleSection = (id: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            savePersisted('settingsExpanded', [...next]);
            return next;
        });
    };

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };
    const btn: React.CSSProperties = {
        padding: '7px 14px',
        borderRadius: 'var(--radius-btn)',
        border: '1px solid var(--border)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
    };
    const primary: React.CSSProperties = {
        ...btn,
        background: 'var(--btn-primary-bg)',
        borderColor: 'var(--btn-primary-bg)',
        color: 'var(--btn-primary-fg)',
    };
    const aiInput: React.CSSProperties = {
        width: '100%',
        padding: '8px 10px',
        borderRadius: 'var(--radius-input)',
        border: '1px solid var(--field-border)',
        background: 'var(--field-bg)',
        color: 'inherit',
        boxSizing: 'border-box',
    };
    const help: React.CSSProperties = { marginTop: 0, marginBottom: 8, fontSize: '0.9231rem', opacity: 0.7 };
    // The security table. Deliberately two columns of plain text rather than a grid of
    // reassurance: the second column is where the honest answers live, and a reader
    // should be able to scan for the ones that are not green.
    const secTable: React.CSSProperties = {
        display: 'flex', flexDirection: 'column', gap: 6,
        borderTop: '1px solid var(--border)', paddingTop: 10,
    };
    const secRow: React.CSSProperties = {
        display: 'flex', justifyContent: 'space-between', gap: 16,
        fontSize: '0.9231rem', flexWrap: 'wrap',
    };
    const secWhat: React.CSSProperties = { opacity: 0.85 };
    const secGood: React.CSSProperties = { color: 'var(--success)', textAlign: 'right' };
    const secWarn: React.CSSProperties = { color: 'var(--accent-warn, #d0902f)', textAlign: 'right' };

    const sectionState = (id: string) => ({ open: expanded.has(id), onToggle: () => toggleSection(id) });

    return createPortal(
        <div className="modal-backdrop" onClick={handleBackdrop}>
            <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={t('settings.title')}
                style={{ maxWidth: 480 }}
            >
                <div className="modal-header">
                    <div className="modal-title">{t('settings.title')}</div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>
                        <X size={16} />
                    </button>
                </div>
                <div className="modal-body">
                    {!workspace ? (
                        <p style={{ fontSize: '0.9231rem', color: 'var(--danger, #ff4d6d)', margin: '0 0 8px' }}>
                            {t('settings.noWorkspace')}
                        </p>
                    ) : null}
                    {error ? (
                        <p style={{ fontSize: '0.9231rem', color: 'var(--danger, #ff4d6d)', margin: '0 0 8px' }}>
                            {error}
                        </p>
                    ) : null}

                    <SettingsSection {...sectionState('appearance')} title={t('settings.sections.appearance')}>
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
                            {t('settings.appearance.fontSize')}
                        </label>
                        <p style={help}>
                            {t('settings.appearance.fontSizeHelp', { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE })}
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <button
                                type="button"
                                style={{ ...btn, padding: '6px 10px' }}
                                onClick={() => changeFontSize(fontSize - 1)}
                                disabled={fontSize <= MIN_FONT_SIZE}
                                aria-label={t('settings.appearance.decrease')}
                            >
                                <Minus size={14} />
                            </button>
                            <span style={{ minWidth: 56, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                                {fontSize}px
                            </span>
                            <button
                                type="button"
                                style={{ ...btn, padding: '6px 10px' }}
                                onClick={() => changeFontSize(fontSize + 1)}
                                disabled={fontSize >= MAX_FONT_SIZE}
                                aria-label={t('settings.appearance.increase')}
                            >
                                <Plus size={14} />
                            </button>
                            {fontSize !== DEFAULT_FONT_SIZE ? (
                                <button
                                    type="button"
                                    style={{ ...btn, padding: '6px 10px', marginLeft: 'auto' }}
                                    onClick={() => changeFontSize(DEFAULT_FONT_SIZE)}
                                >
                                    {t('settings.appearance.reset')}
                                </button>
                            ) : null}
                        </div>
                    </SettingsSection>

                    <SettingsSection {...sectionState('proxy')} title={t('settings.sections.proxy')}>
                        <p style={help}>{t('settings.proxy.help')}</p>
                        <input
                            id="settings-proxy"
                            type="text"
                            value={proxy}
                            onChange={e => setProxy(e.target.value)}
                            placeholder="http://user:pass@proxy.company.com:8080"
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('memory')} title={t('settings.sections.memory')}>
                        <p style={help}>{t('settings.memory.help')}</p>
                        <input
                            id="settings-mem"
                            type="number"
                            min={0}
                            value={memLimit}
                            onChange={e => setMemLimit(e.target.value)}
                            placeholder={t('settings.memory.placeholder')}
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('power')} title={t('settings.sections.power')}>
                        <p style={help}>{t('settings.power.help')}</p>
                        <label htmlFor="settings-max-runs" style={{ fontSize: '0.9231rem', opacity: 0.8 }}>
                            {t('settings.power.maxRuns')}
                        </label>
                        <input
                            id="settings-max-runs"
                            type="number"
                            min={1}
                            max={64}
                            value={maxRuns}
                            onChange={e => setMaxRuns(e.target.value)}
                            placeholder={t('settings.power.maxRunsPlaceholder', { cores: cpuCount })}
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                        <p style={help}>{t('settings.power.maxRunsHelp')}</p>
                        <label htmlFor="settings-spill" style={{ fontSize: '0.9231rem', opacity: 0.8 }}>
                            {t('settings.power.spill')}
                        </label>
                        <input
                            id="settings-spill"
                            type="text"
                            value={spillDir}
                            onChange={e => setSpillDir(e.target.value)}
                            placeholder={t('settings.power.spillPlaceholder')}
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                        <p style={help}>{t('settings.power.spillHelp')}</p>
                    </SettingsSection>

                    <SettingsSection {...sectionState('unsigned')} title={t('settings.sections.unsigned')}>
                        <p style={help}>
                            <Trans i18nKey="settings.unsigned.help" components={code} />
                        </p>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={allowUnsigned}
                                onChange={e => setAllowUnsigned(e.target.checked)}
                                disabled={!loaded || !workspace}
                            />
                            {t('settings.unsigned.allow')}
                        </label>
                    </SettingsSection>

                    <SettingsSection {...sectionState('context')} title={t('settings.sections.context')}>
                        <p style={help}>
                            <Trans i18nKey="settings.context.help" components={code} />
                        </p>
                        <input
                            id="settings-context-file"
                            type="text"
                            value={contextFile}
                            onChange={e => setContextFile(e.target.value)}
                            placeholder={t('settings.context.placeholder')}
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('agentAttachments')} title={t('settings.sections.agentAttachments')}>
                        <p style={help}>
                            {t('settings.attachments.help', { mb: DEFAULT_AGENT_ATTACHMENT_MAX_MB })}
                        </p>
                        <input
                            id="settings-agent-attach-max"
                            type="number"
                            min={1}
                            value={attachMaxMb}
                            onChange={e => setAttachMaxMb(e.target.value)}
                            placeholder={`${DEFAULT_AGENT_ATTACHMENT_MAX_MB} (MB)`}
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('ai')} title={t('settings.sections.ai')}>
                        <p style={help}>
                            {DUCKIE_ENABLED ? t('settings.ai.helpDuckie') : t('settings.ai.help')}
                        </p>
                        {DUCKIE_ENABLED ? (
                            <>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                                <input
                                    type="radio"
                                    name="duckie-ai-mode"
                                    checked={aiMode === 'deepseek_harness'}
                                    onChange={() => setAiMode('deepseek_harness')}
                                    disabled={!loaded || !workspace}
                                />
                                {t('settings.ai.modeDsh')}
                            </label>
                            {aiMode === 'deepseek_harness' ? (
                                <>
                                    <input
                                        type="text"
                                        value={aiHarnessCommand}
                                        onChange={e => setAiHarnessCommand(e.target.value)}
                                        placeholder={t('settings.ai.dshCommandPlaceholder')}
                                        disabled={!loaded || !workspace}
                                        spellCheck={false}
                                        autoComplete="off"
                                        style={aiInput}
                                    />
                                    <p style={help}>
                                        <Trans i18nKey="settings.ai.dshCommandHelp" components={code} />
                                    </p>
                                    <input
                                        type="text"
                                        value={aiHarnessProvider}
                                        onChange={e => setAiHarnessProvider(e.target.value)}
                                        placeholder={t('settings.ai.dshProviderPlaceholder')}
                                        disabled={!loaded || !workspace}
                                        spellCheck={false}
                                        autoComplete="off"
                                        style={aiInput}
                                    />
                                    <input
                                        type="text"
                                        value={aiHarnessModel}
                                        onChange={e => setAiHarnessModel(e.target.value)}
                                        placeholder={t('settings.ai.dshModelPlaceholder')}
                                        disabled={!loaded || !workspace}
                                        spellCheck={false}
                                        autoComplete="off"
                                        style={{ ...aiInput, marginTop: 8 }}
                                    />
                                    <p style={help}>
                                        <Trans i18nKey="settings.ai.dshProviderHelp" components={code} />
                                    </p>
                                    <input
                                        type="number"
                                        min={0}
                                        value={aiHarnessIdleMinutes}
                                        onChange={e => setAiHarnessIdleMinutes(e.target.value)}
                                        placeholder={t('settings.ai.dshIdlePlaceholder')}
                                        disabled={!loaded || !workspace}
                                        style={aiInput}
                                    />
                                    <p style={help}>
                                        <Trans i18nKey="settings.ai.dshIdleHelp" components={code} />
                                    </p>
                                </>
                            ) : null}
                            </>
                        ) : null}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                            <input
                                type="radio"
                                name="duckie-ai-mode"
                                checked={aiMode === 'openai_compatible'}
                                onChange={() => setAiMode('openai_compatible')}
                                disabled={!loaded || !workspace}
                            />
                            {t('settings.ai.modeOpenai')}
                        </label>
                        {aiMode === 'openai_compatible' ? (
                            <>
                        <input
                            type="text"
                            value={aiBaseUrl}
                            onChange={e => setAiBaseUrl(e.target.value)}
                            placeholder={t('settings.ai.baseUrlPlaceholder')}
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={aiInput}
                        />
                        <input
                            type="text"
                            value={aiModel}
                            onChange={e => setAiModel(e.target.value)}
                            placeholder={t('settings.ai.modelPlaceholder')}
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...aiInput, marginTop: 8 }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <button
                                type="button"
                                onClick={async () => {
                                    setAiListing(true);
                                    setAiListError('');
                                    try {
                                        const got = await aiModels(workspace ?? '', aiBaseUrl || null, aiKey || null);
                                        setAiChoices(got);
                                        if (got.length === 0) setAiListError(t('settings.ai.noModels'));
                                    } catch (e) {
                                        setAiChoices(null);
                                        setAiListError(e instanceof Error ? e.message : String(e));
                                    } finally {
                                        setAiListing(false);
                                    }
                                }}
                                disabled={!loaded || !workspace || !aiBaseUrl || aiListing}
                                style={{ ...aiInput, width: 'auto', cursor: 'pointer' }}
                            >
                                {aiListing ? t('settings.ai.fetching') : t('settings.ai.fetchModels')}
                            </button>
                            {aiChoices && aiChoices.some(m => m.chat) && (
                                <select
                                    value=""
                                    onChange={e => e.target.value && setAiModel(e.target.value)}
                                    style={{ ...aiInput, flex: 1 }}
                                >
                                    <option value="">
                                        {t('settings.ai.pickModel', { n: aiChoices.filter(m => m.chat).length })}
                                    </option>
                                    {aiChoices.filter(m => m.chat).map(m => (
                                        <option key={m.id} value={m.id}>{m.id}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                        {aiListError && <p style={{ ...help, color: '#f0803c' }}>{aiListError}</p>}
                        {aiChoices && aiChoices.some(m => !m.chat) && (
                            <p style={help}>
                                {t('settings.ai.nonChatModels', {
                                    skipped: aiChoices.filter(m => !m.chat).length,
                                    total: aiChoices.length,
                                })}
                            </p>
                        )}
                        <input
                            type="password"
                            value={aiKey}
                            onChange={e => setAiKey(e.target.value)}
                            placeholder={t('settings.ai.apiKeyPlaceholder')}
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...aiInput, marginTop: 8 }}
                        />
                            </>
                        ) : null}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
                            <input
                                type="radio"
                                name="duckie-ai-mode"
                                checked={aiMode === 'local_qwen'}
                                onChange={() => setAiMode('local_qwen')}
                                disabled={!loaded || !workspace}
                            />
                            {t('settings.ai.modeLocal')}
                        </label>
                    </SettingsSection>

                    {isTauri() ? (
                        <SettingsSection {...sectionState('signin')} title={t('settings.sections.signin')}>
                            <p style={help}>{t('settings.signin.help')}</p>
                            <label htmlFor="settings-idle-lock" style={{ fontSize: '0.9231rem', opacity: 0.8 }}>
                                {t('settings.signin.lockAfter')}
                            </label>
                            <select
                                id="settings-idle-lock"
                                value={idleLock}
                                onChange={e => {
                                    const minutes = Number(e.target.value);
                                    setIdleLock(minutes);
                                    setIdleLockMinutes(minutes);
                                }}
                                style={aiInput}
                            >
                                {IDLE_LOCK_CHOICES.map(m => (
                                    <option key={m} value={m}>
                                        {m === 0 ? t('settings.signin.never') : t('settings.signin.minutes', { n: m })}
                                    </option>
                                ))}
                            </select>
                        </SettingsSection>
                    ) : null}

                    <SettingsSection {...sectionState('toolbar')} title={t('settings.sections.toolbar')}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={showDives} onChange={e => toggleDives(e.target.checked)} />
                            {t('settings.toolbar.showDives')}
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', cursor: 'pointer', marginTop: 10 }}>
                            <input type="checkbox" checked={showMinimap} onChange={e => toggleMinimap(e.target.checked)} />
                            {t('settings.toolbar.showMinimap')}
                        </label>
                    </SettingsSection>

                    <SettingsSection {...sectionState('security')} title={t('settings.sections.security')}>
                        <p style={help}>{t('settings.security.help')}</p>

                        <div style={secTable}>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.connSecrets')}</span>
                                <span style={secGood}>{t('settings.security.aesPerValue')}</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.serverKeys')}</span>
                                <span style={secGood}>AES-256-GCM</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.gitToken')}</span>
                                <span style={secGood}>AES-256-GCM</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.decryptKey')}</span>
                                <span style={secWarn}>{t('settings.security.decryptKeyWhere')}</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.contextVars')}</span>
                                <span style={secWarn}>{t('settings.security.plainOnDisk')}</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.aiKeyProxy')}</span>
                                <span style={secWarn}>{t('settings.security.aiKeyProxyWhere')}</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>{t('settings.security.fieldValues')}</span>
                                <span style={secWarn}>{t('settings.security.fieldValuesWhere')}</span>
                            </div>
                        </div>

                        <p style={{ ...help, marginTop: 12 }}>{t('settings.security.encryptionNote')}</p>

                        <p style={{ ...help, marginTop: 12 }}>
                            <Trans i18nKey="settings.security.telemetry" components={{ b: <b /> }} />
                        </p>

                        {workspace ? (
                            <p style={{ ...help, marginTop: 12, wordBreak: 'break-all' }}>
                                {t('settings.security.thisWorkspace')} <code>{workspace}</code>
                            </p>
                        ) : null}

                        <button
                            type="button"
                            style={btn}
                            onClick={() =>
                                void openExternal(
                                    'https://github.com/slothflowlabs/duckle/blob/main/docs/current/client-server-architecture.md',
                                )
                            }
                        >
                            {t('settings.security.readGuide')}
                        </button>
                    </SettingsSection>

                    <SettingsSection {...sectionState('tour')} title={t('settings.sections.tour')}>
                        <p style={help}>{t('settings.tour.help')}</p>
                        <button
                            type="button"
                            style={btn}
                            onClick={() => {
                                // Closed first, then dispatched: the tour spotlights elements on
                                // the workspace behind this modal, and starting it while the modal
                                // is still up would dim and cover the very thing it points at.
                                onClose();
                                setTimeout(() => window.dispatchEvent(new Event('duckle:start-tour')), 250);
                            }}
                        >
                            {t('settings.tour.replay')}
                        </button>
                        <p style={{ ...help, marginTop: 14 }}>{t('settings.tour.setupHelp')}</p>
                        <button
                            type="button"
                            style={btn}
                            onClick={() => {
                                onClose();
                                setTimeout(
                                    () => window.dispatchEvent(new Event('duckle:reset-setup')),
                                    250,
                                );
                            }}
                        >
                            {t('settings.tour.runSetup')}
                        </button>
                    </SettingsSection>
                </div>
                <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" style={btn} onClick={onClose}>
                        {t('common.close')}
                    </button>
                    <button type="button" style={primary} onClick={save} disabled={saving || !workspace}>
                        {saving ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : null}
                        {saved ? t('settings.saved') : t('common.save')}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/** Blank or invalid = use the default; 0 = no limit. */
function idleMinutesToSecs(minutes: string): number | null {
    const n = Number(minutes.trim());
    if (minutes.trim() === '' || !Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 60);
}

// Module-level so its identity is stable across SettingsModal renders; declaring it
// inside the modal remounted every section body on each keystroke and dropped input focus.
function SettingsSection({
    title,
    open,
    onToggle,
    children,
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <div className="settings-section">
            <button
                type="button"
                className="settings-section-header"
                aria-expanded={open}
                onClick={onToggle}
            >
                <span className="settings-cat-chevron" aria-hidden="true">
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span className="settings-section-title">{title}</span>
            </button>
            {open ? <div className="settings-section-body">{children}</div> : null}
        </div>
    );
}
