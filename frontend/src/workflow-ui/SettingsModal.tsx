import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Check, ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import {
    settingsGetProxy,
    settingsSetProxy,
    settingsGetAi,
    settingsSetAi,
    settingsGetMemoryLimit,
    settingsGetAllowUnsigned,
    settingsGetPower,
    settingsSetPower,
    settingsSetAllowUnsigned,
    settingsGetContextFile,
    settingsSetContextFile,
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
    const [proxy, setProxy] = useState('');
    const [aiMode, setAiMode] = useState<'deepseek_harness' | 'openai_compatible' | 'local_qwen'>('deepseek_harness');
    // Duckie AI provider configuration.
    const [aiBaseUrl, setAiBaseUrl] = useState('');
    const [aiModel, setAiModel] = useState('');
    const [aiKey, setAiKey] = useState('');
    const [aiHarnessCommand, setAiHarnessCommand] = useState('');
    const [aiHarnessProvider, setAiHarnessProvider] = useState('');
    const [aiHarnessModel, setAiHarnessModel] = useState('');
    // Minutes a DSH turn may stay silent before Duckie cancels it (empty = default).
    const [aiHarnessIdleMinutes, setAiHarnessIdleMinutes] = useState('');
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
    // Local UI pref: show/hide the top-bar Dives button.
    const [showDives, setShowDives] = useState(() => !loadPersisted('hideDivesButton', false));
    // Local UI pref: show/hide the canvas minimap. On by default, because it
    // is how you find a node on a large graph; off for anyone who would rather
    // have the corner of the canvas back.
    const [showMinimap, setShowMinimap] = useState(() => !loadPersisted('hideMinimap', false));
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
        ])
            .then(([p, ai, mem, ic, unsigned, power]) => {
                if (!alive) return;
                setProxy(p ?? '');
                setAiMode(ai.mode ?? 'deepseek_harness');
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
                aria-label="Settings"
                style={{ maxWidth: 480 }}
            >
                <div className="modal-header">
                    <div className="modal-title">Settings</div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>
                <div className="modal-body">
                    {!workspace ? (
                        <p style={{ fontSize: '0.9231rem', color: 'var(--danger, #ff4d6d)', margin: '0 0 8px' }}>
                            Open a workspace first to save workspace settings.
                        </p>
                    ) : null}
                    {error ? (
                        <p style={{ fontSize: '0.9231rem', color: 'var(--danger, #ff4d6d)', margin: '0 0 8px' }}>
                            {error}
                        </p>
                    ) : null}

                    <SettingsSection {...sectionState('appearance')} title="Appearance">
                        <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
                            Font size
                        </label>
                        <p style={help}>
                            Scales the interface text. Affects every view. ({MIN_FONT_SIZE}-{MAX_FONT_SIZE}px)
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <button
                                type="button"
                                style={{ ...btn, padding: '6px 10px' }}
                                onClick={() => changeFontSize(fontSize - 1)}
                                disabled={fontSize <= MIN_FONT_SIZE}
                                aria-label="Decrease font size"
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
                                aria-label="Increase font size"
                            >
                                <Plus size={14} />
                            </button>
                            {fontSize !== DEFAULT_FONT_SIZE ? (
                                <button
                                    type="button"
                                    style={{ ...btn, padding: '6px 10px', marginLeft: 'auto' }}
                                    onClick={() => changeFontSize(DEFAULT_FONT_SIZE)}
                                >
                                    Reset
                                </button>
                            ) : null}
                        </div>
                    </SettingsSection>

                    <SettingsSection {...sectionState('proxy')} title="HTTP / HTTPS proxy">
                        <p style={help}>
                            Routes REST and cloud-API connectors and the in-app updater through a proxy, so
                            Duckle works behind a corporate proxy without setting a system environment
                            variable. Leave empty for a direct connection.
                        </p>
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

                    <SettingsSection {...sectionState('memory')} title="Memory limit">
                        <p style={help}>
                            Caps total RAM for every run in this workspace (sets DuckDB's memory_limit for
                            both batched and per-stage execution). Leave empty for the engine default
                            (about 80% of system RAM).
                        </p>
                        <input
                            id="settings-mem"
                            type="number"
                            min={0}
                            value={memLimit}
                            onChange={e => setMemLimit(e.target.value)}
                            placeholder="e.g. 4096 (MB)"
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('power')} title="Power mode">
                        <p style={help}>
                            Throughput settings for this workspace. Independent pipelines scale well
                            across cores, so running several at once is the lever that pays; splitting a
                            single pipeline across processes was measured slower and is deliberately not
                            offered.
                        </p>
                        <label htmlFor="settings-max-runs" style={{ fontSize: '0.9231rem', opacity: 0.8 }}>
                            Pipelines at once
                        </label>
                        <input
                            id="settings-max-runs"
                            type="number"
                            min={1}
                            max={64}
                            value={maxRuns}
                            onChange={e => setMaxRuns(e.target.value)}
                            placeholder={`empty = default  (this machine has ${cpuCount} cores)`}
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                        <p style={help}>
                            Caps how many scheduled pipelines execute together. Each one gets its own
                            memory limit and its own DuckDB process, so N at once needs roughly N times
                            the memory above. Raise it only with the RAM to match.
                        </p>
                        <label htmlFor="settings-spill" style={{ fontSize: '0.9231rem', opacity: 0.8 }}>
                            Spill folder
                        </label>
                        <input
                            id="settings-spill"
                            type="text"
                            value={spillDir}
                            onChange={e => setSpillDir(e.target.value)}
                            placeholder="empty = beside the run's own database"
                            disabled={!loaded || !workspace}
                            style={aiInput}
                        />
                        <p style={help}>
                            Where DuckDB writes when a query outgrows memory. Point it at a bigger or
                            faster disk. Every run gets a private subfolder, so concurrent runs cannot
                            collide here.
                        </p>
                    </SettingsSection>

                    <SettingsSection {...sectionState('unsigned')} title="Unsigned extensions">
                        <p style={help}>
                            Allow loading unsigned or community DuckDB extensions (for example a custom{' '}
                            <code>quack</code> build). When on, the engine starts DuckDB with{' '}
                            <code>-unsigned</code>. Leave off unless you trust the extension: it turns off
                            signature verification for every run in this workspace.
                        </p>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={allowUnsigned}
                                onChange={e => setAllowUnsigned(e.target.checked)}
                                disabled={!loaded || !workspace}
                            />
                            Allow unsigned extensions
                        </label>
                    </SettingsSection>

                    <SettingsSection {...sectionState('context')} title="Global context file">
                        <p style={help}>
                            Auto-load context variables from a key/value file before every run, so{' '}
                            <code>{'${KEY}'}</code> resolves everywhere without wiring a node. Supports .env /
                            .properties (KEY=VALUE), .csv (key,value) and .json. A relative path is resolved
                            against the workspace root.
                        </p>
                        <input
                            id="settings-context-file"
                            type="text"
                            value={contextFile}
                            onChange={e => setContextFile(e.target.value)}
                            placeholder="config/context.env  (or an absolute path)"
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={aiInput}
                        />
                    </SettingsSection>

                    <SettingsSection {...sectionState('ai')} title="AI assistant">
                        <p style={help}>
                            Choose how Duckie runs: DeepSeek Harness via ACP + duckle-mcp (default),
                            an external OpenAI-compatible endpoint, or the bundled local Qwen model.
                        </p>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                            <input
                                type="radio"
                                name="duckie-ai-mode"
                                checked={aiMode === 'deepseek_harness'}
                                onChange={() => setAiMode('deepseek_harness')}
                                disabled={!loaded || !workspace}
                            />
                            DeepSeek Harness (DSH) + duckle-mcp
                        </label>
                        {aiMode === 'deepseek_harness' ? (
                            <>
                                <input
                                    type="text"
                                    value={aiHarnessCommand}
                                    onChange={e => setAiHarnessCommand(e.target.value)}
                                    placeholder="Optional DSH command override, e.g. /opt/homebrew/bin/dsh or /Users/me/.dsh/.../bin.js"
                                    disabled={!loaded || !workspace}
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={aiInput}
                                />
                                <p style={help}>
                                    Leave blank to auto-detect DSH. Duckle launches it as <code>--profile acp</code>.
                                </p>
                                <input
                                    type="text"
                                    value={aiHarnessProvider}
                                    onChange={e => setAiHarnessProvider(e.target.value)}
                                    placeholder="Optional DSH provider override, e.g. deepseek-official or dashscope"
                                    disabled={!loaded || !workspace}
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={aiInput}
                                />
                                <input
                                    type="text"
                                    value={aiHarnessModel}
                                    onChange={e => setAiHarnessModel(e.target.value)}
                                    placeholder="Optional DSH model override, e.g. deepseek-v4-pro"
                                    disabled={!loaded || !workspace}
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={{ ...aiInput, marginTop: 8 }}
                                />
                                <p style={help}>
                                    Set both provider and model to make Duckle call ACP <code>session/set_config_option</code>
                                    after <code>session/new</code>. Leave both blank to use the ACP profile default.
                                </p>
                                <input
                                    type="number"
                                    min={0}
                                    value={aiHarnessIdleMinutes}
                                    onChange={e => setAiHarnessIdleMinutes(e.target.value)}
                                    placeholder="DSH idle timeout in minutes (default 30, 0 = no limit)"
                                    disabled={!loaded || !workspace}
                                    style={aiInput}
                                />
                                <p style={help}>
                                    A Duckie turn keeps waiting while DSH is still streaming progress; it is cancelled only
                                    after this many minutes without any output from DSH. Leave blank for the default
                                    (or <code>DUCKLE_DSH_IDLE_TIMEOUT_SECS</code> if set), 0 to never time out.
                                </p>
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
                            External OpenAI-compatible endpoint
                        </label>
                        {aiMode === 'openai_compatible' ? (
                            <>
                        <input
                            type="text"
                            value={aiBaseUrl}
                            onChange={e => setAiBaseUrl(e.target.value)}
                            placeholder="Base URL, e.g. https://api.openai.com"
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={aiInput}
                        />
                        <input
                            type="text"
                            value={aiModel}
                            onChange={e => setAiModel(e.target.value)}
                            placeholder="Model, e.g. gpt-4o-mini"
                            disabled={!loaded || !workspace}
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...aiInput, marginTop: 8 }}
                        />
                        <input
                            type="password"
                            value={aiKey}
                            onChange={e => setAiKey(e.target.value)}
                            placeholder="API key (sent as a Bearer token)"
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
                            Bundled local Qwen via llama.cpp
                        </label>
                    </SettingsSection>

                    <SettingsSection {...sectionState('toolbar')} title="Toolbar">
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={showDives} onChange={e => toggleDives(e.target.checked)} />
                            Show the Dives button (live data views &amp; dashboards) in the toolbar
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', cursor: 'pointer', marginTop: 10 }}>
                            <input type="checkbox" checked={showMinimap} onChange={e => toggleMinimap(e.target.checked)} />
                            Show the minimap in the corner of the canvas
                        </label>
                    </SettingsSection>

                    <SettingsSection {...sectionState('security')} title="Security and privacy">
                        <p style={help}>
                            Where this workspace keeps credentials, and what is protected. The
                            same facts are in the architecture guide, with citations.
                        </p>

                        <div style={secTable}>
                            <div style={secRow}>
                                <span style={secWhat}>Connection secrets</span>
                                <span style={secGood}>AES-256-GCM, per value</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>Server API keys</span>
                                <span style={secGood}>AES-256-GCM</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>Cached Git token</span>
                                <span style={secGood}>AES-256-GCM</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>The key that decrypts them</span>
                                <span style={secWarn}>
                                    plain file in .duckle/keys, beside what it protects
                                </span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>Context variables, even "secret" ones</span>
                                <span style={secWarn}>plain text on disk</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>AI key and proxy URL</span>
                                <span style={secWarn}>plain text in .duckle/settings.json</span>
                            </div>
                            <div style={secRow}>
                                <span style={secWhat}>Values typed into a pipeline field</span>
                                <span style={secWarn}>plain text; use ${'{'}ENV:NAME{'}'}</span>
                            </div>
                        </div>

                        <p style={{ ...help, marginTop: 12 }}>
                            Encryption here defends a stray file, a backup or a commit. It does
                            not defend a copied workspace folder, because the key travels with
                            it. Everything above is excluded from git automatically.
                        </p>

                        <p style={{ ...help, marginTop: 12 }}>
                            <b>No telemetry.</b> No analytics, usage reporting or crash reporting
                            of any kind. One automatic outbound call exists: a version check
                            against a public GitHub URL that sends nothing about you or your work.
                        </p>

                        {workspace ? (
                            <p style={{ ...help, marginTop: 12, wordBreak: 'break-all' }}>
                                This workspace: <code>{workspace}</code>
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
                            Read the architecture guide
                        </button>
                    </SettingsSection>

                    <SettingsSection {...sectionState('tour')} title="First run">
                        <p style={help}>
                            Everything you were shown the first time you opened Duckle, available
                            again whenever you want it.
                        </p>
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
                            Replay guided tour
                        </button>
                        <p style={{ ...help, marginTop: 14 }}>
                            The setup question asks whether you are working on your own machine or
                            with a team on a server. Resetting it asks again; it changes nothing on
                            its own, and any server you already connected to stays connected.
                        </p>
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
                            Run setup again
                        </button>
                    </SettingsSection>
                </div>
                <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" style={btn} onClick={onClose}>
                        Close
                    </button>
                    <button type="button" style={primary} onClick={save} disabled={saving || !workspace}>
                        {saving ? <Loader2 size={14} className="spin" /> : saved ? <Check size={14} /> : null}
                        {saved ? 'Saved' : 'Save'}
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
