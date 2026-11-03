import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertCircle,
    Bot,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Copy,
    PlayCircle,
    Terminal,
    X,
} from 'lucide-react';
import type { RunResult } from '../tauri-bridge';
import type { ValidationResult } from '../validation';
import { friendlyError } from '../errors';
import { consoleLines, consoleText, formatOffset, runPlan, stepTag, type RunPlan } from '../run-timeline';

type TabId = 'problems' | 'output' | 'console';

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 260;

export type Props = {
    runResult: RunResult | null;
    isRunning: boolean;
    nodeLabels: Record<string, string>;
    terminalNodeIds: string[];
    validation: ValidationResult;
    openProblemsRequest?: number;
    /** Sends the failed run to the Agent to diagnose. Absent where the Agent
     *  is not available. */
    onAskAgent?: () => void;
};

export default function BottomPanel({
    runResult,
    isRunning,
    nodeLabels,
    terminalNodeIds,
    validation,
    openProblemsRequest,
    onAskAgent,
}: Props) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<TabId>('problems');
    const [collapsed, setCollapsed] = useState<boolean>(true);
    const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);

    // Auto-expand Output tab when a run finishes. Only then: the editor builds a
    // new run result for every streamed event, and reacting to each one took the
    // tab back to Output, and re-expanded the panel, all through the run. And once
    // per result: going back to the pipeline that ran shows the same result again,
    // which is not a run ending.
    const openedFor = useRef<RunResult | null>(null);
    useEffect(() => {
        if (runResult && !isRunning && openedFor.current !== runResult) {
            openedFor.current = runResult;
            setTab('output');
            setCollapsed(false);
        }
    }, [runResult, isRunning]);

    // Auto-expand Problems tab when Validate is clicked.
    useEffect(() => {
        if (openProblemsRequest && openProblemsRequest > 0) {
            setTab('problems');
            setCollapsed(false);
        }
    }, [openProblemsRequest]);

    const onResizeStart = useCallback(
        (e: React.MouseEvent) => {
            if (collapsed) return;
            dragRef.current = { startY: e.clientY, startH: height };
            e.preventDefault();
        },
        [collapsed, height],
    );

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragRef.current) return;
            const dy = dragRef.current.startY - e.clientY;
            const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startH + dy));
            setHeight(next);
        };
        const onUp = () => {
            dragRef.current = null;
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
    }, []);

    const onTabClick = (id: TabId) => {
        if (collapsed) {
            setCollapsed(false);
            setTab(id);
        } else if (tab === id) {
            setCollapsed(true);
        } else {
            setTab(id);
        }
    };

    const runErrors = runResult
        ? Object.entries(runResult.nodes).filter(([, st]) => st.status === 'error')
        : [];

    const problemsBadge = validation.errorCount + validation.warningCount + runErrors.length;

    const tabs: { id: TabId; label: string; badge?: number }[] = [
        { id: 'problems', label: t('bottom.problems'), badge: problemsBadge },
        { id: 'output', label: t('bottom.output') },
        { id: 'console', label: t('bottom.console') },
    ];

    return (
        <div
            className={'bottom-panel' + (collapsed ? ' is-collapsed' : '')}
            data-tour="bottom"
            style={collapsed ? undefined : { height }}
        >
            <div className="bottom-panel-resize" onMouseDown={onResizeStart} aria-hidden="true" />
            <div className="bottom-panel-tabs" role="tablist">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={!collapsed && tab === t.id}
                        className="bottom-panel-tab"
                        onClick={() => onTabClick(t.id)}
                    >
                        {t.label}
                        {t.badge !== undefined && t.badge > 0 ? (
                            <span className="bottom-panel-tab-badge">{t.badge}</span>
                        ) : null}
                    </button>
                ))}
                <div className="bottom-panel-spacer" />
                <button
                    type="button"
                    className="bottom-panel-toggle"
                    onClick={() => setCollapsed(c => !c)}
                    aria-label={collapsed ? t('bottom.expand') : t('bottom.collapse')}
                >
                    {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
            </div>
            {!collapsed ? (
                <div className="bottom-panel-content">
                    {tab === 'problems' ? (
                        <ProblemsTab
                            validation={validation}
                            runErrors={runErrors}
                            nodeLabels={nodeLabels}
                        />
                    ) : null}
                    {tab === 'output' ? (
                        <OutputTab
                            runResult={runResult}
                            isRunning={isRunning}
                            nodeLabels={nodeLabels}
                            terminalNodeIds={terminalNodeIds}
                            onAskAgent={onAskAgent}
                        />
                    ) : null}
                    {tab === 'console' ? (
                        <ConsoleTab runResult={runResult} nodeLabels={nodeLabels} />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function ProblemsTab({
    validation,
    runErrors,
    nodeLabels,
}: {
    validation: ValidationResult;
    runErrors: [string, { error?: string }][];
    nodeLabels: Record<string, string>;
}) {
    const { t } = useTranslation();
    const hasNothing = validation.issues.length === 0 && runErrors.length === 0;
    if (hasNothing) {
        return (
            <div className="bottom-empty">
                <CheckCircle2 size={22} className="bottom-empty-icon bottom-empty-icon-ok" />
                <div className="bottom-empty-title">{t('bottom.noProblems')}</div>
                <div className="bottom-empty-desc">
                    {t('bottom.noProblemsDesc')}
                </div>
            </div>
        );
    }
    return (
        <div className="bottom-problems">
            {validation.issues.map(issue => (
                <ProblemRow
                    key={issue.id}
                    severity={issue.severity}
                    title={
                        issue.nodeId
                            ? nodeLabels[issue.nodeId] ?? issue.nodeId
                            : t('bottom.pipelineLabel')
                    }
                    detail={issue.message}
                    code={issue.code}
                />
            ))}
            {runErrors.map(([nodeId, st]) => (
                <ProblemRow
                    key={'r_' + nodeId}
                    severity="error"
                    title={nodeLabels[nodeId] ?? nodeId}
                    detail={friendlyError(st.error) || 'Execution failed.'}
                    code="run-error"
                />
            ))}
        </div>
    );
}

function ProblemRow({
    severity,
    title,
    detail,
    code,
}: {
    severity: 'error' | 'warning';
    title: string;
    detail: string;
    code: string;
}) {
    return (
        <div className={'bottom-problem-row severity-' + severity}>
            <AlertCircle size={13} className="bottom-problem-icon" />
            <div className="bottom-problem-body">
                <div className="bottom-problem-title">{title}</div>
                <div className="bottom-problem-detail">{detail}</div>
            </div>
            <code className="bottom-problem-code">{code}</code>
        </div>
    );
}

/** Beside a failed run's status: sends it to the Agent. */
function AskAgentButton({ onClick }: { onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className="bottom-ask-agent" onClick={() => onClick()} title={t('bottom.askAgentTitle')}>
            <Bot size={13} aria-hidden="true" />
            <span>{t('bottom.askAgent')}</span>
        </button>
    );
}

function OutputTab({
    runResult,
    isRunning,
    nodeLabels,
    terminalNodeIds,
    onAskAgent,
}: {
    runResult: RunResult | null;
    isRunning: boolean;
    nodeLabels: Record<string, string>;
    terminalNodeIds: string[];
    onAskAgent?: () => void;
}) {
    const { t } = useTranslation();
    // Let the user dismiss the run-error banner. Reset on every new run
    // (runResult is a fresh object each run) so a later failure shows again.
    const [errorDismissed, setErrorDismissed] = useState(false);
    useEffect(() => {
        setErrorDismissed(false);
    }, [runResult]);
    if (isRunning) {
        return (
            <div className="bottom-empty">
                <PlayCircle size={22} className="bottom-empty-icon bottom-empty-icon-ok" />
                <div className="bottom-empty-title">{t('bottom.running')}</div>
                <div className="bottom-empty-desc">
                    {t('bottom.runningDesc')}
                </div>
            </div>
        );
    }
    if (!runResult) {
        return (
            <div className="bottom-empty">
                <div className="bottom-empty-title">{t('bottom.noRunYet')}</div>
                <div className="bottom-empty-desc">
                    {t('bottom.noRunYetDesc')}
                </div>
            </div>
        );
    }

    const totals = runStats(runResult);
    const plan = runPlan(runResult.timeline);
    const leftOut = leftOutRows(plan, runResult, t);
    // Show only the pipeline's terminal results, not a stacked table per
    // intermediate stage. Fall back to all previews if we can't tell.
    const terminalSet = new Set(terminalNodeIds);
    const terminalPreviews =
        terminalNodeIds.length > 0
            ? runResult.preview.filter(p => terminalSet.has(p.node_id))
            : runResult.preview;
    return (
        <div className="bottom-output">
            <div className="bottom-output-summary">
                <span className={'bottom-status status-' + runResult.status}>
                    {runResult.status === 'ok' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                    {runResult.status === 'ok' ? t('bottom.runSucceeded') : t('bottom.runFailed')}
                </span>
                {onAskAgent && hasFailure(runResult) ? (
                    <AskAgentButton onClick={onAskAgent} />
                ) : null}
                <span className="bottom-output-stat">
                    <b>{totals.nodeCount}</b> {t('bottom.nodesLabel')}
                </span>
                <span className="bottom-output-stat">
                    <b>{totals.rowsWritten.toLocaleString()}</b> {t('bottom.rowsWritten')}
                </span>
                <span className="bottom-output-stat">
                    <b>{runResult.duration_ms} ms</b> {t('bottom.total')}
                </span>
            </div>
            <div className="bottom-output-rows">
                {Object.entries(runResult.nodes).map(([nodeId, st]) => (
                    <div className={'bottom-output-row status-' + st.status} key={nodeId}>
                        <span className="bottom-output-dot" />
                        <span className="bottom-output-label">
                            {plan ? (
                                <span className="bottom-output-step">
                                    {stepTag(plan.steps.get(nodeId), plan.total)}
                                </span>
                            ) : null}
                            {nodeLabels[nodeId] ?? nodeId}
                        </span>
                        <span className="bottom-output-kind">
                            {st.status === 'skipped' ? t('bottom.trace.reasonSkipped') : (st.kind ?? '')}
                        </span>
                        {st.rows !== undefined ? (
                            <span className="bottom-output-rows-stat">
                                {st.rows.toLocaleString()} rows
                            </span>
                        ) : (
                            <span className="bottom-output-rows-stat" />
                        )}
                        <span className="bottom-output-time">
                            {st.duration_ms !== undefined ? st.duration_ms + ' ms' : ''}
                        </span>
                        {st.error ? (
                            <span className="bottom-output-error">
                                {friendlyError(st.error)}
                            </span>
                        ) : null}
                    </div>
                ))}
                {leftOut.map(r => (
                    <div className="bottom-output-row status-skipped" key={'left-' + r.nodeId}>
                        <span className="bottom-output-dot" />
                        <span className="bottom-output-label">
                            {r.step !== undefined && plan ? (
                                <span className="bottom-output-step">{stepTag(r.step, plan.total)}</span>
                            ) : null}
                            {nodeLabels[r.nodeId] ?? r.label}
                        </span>
                        <span className="bottom-output-kind">{r.reason}</span>
                        <span className="bottom-output-rows-stat" />
                        <span className="bottom-output-time" />
                    </div>
                ))}
            </div>
            {runResult.error && !errorDismissed ? (
                <div className="bottom-output-error-banner">
                    <span className="bottom-output-error-banner-text">
                        {friendlyError(runResult.error)}
                    </span>
                    <button
                        type="button"
                        className="bottom-output-error-banner-close"
                        onClick={() => setErrorDismissed(true)}
                        title={t('bottom.dismissError')}
                        aria-label={t('bottom.dismissError')}
                    >
                        <X size={14} />
                    </button>
                </div>
            ) : null}
            {terminalPreviews.length > 0 ? (
                <div className="bottom-output-previews">
                    {terminalPreviews.map(p => (
                        <PreviewTable key={p.node_id} preview={p} label={nodeLabels[p.node_id]} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function PreviewTable({
    preview,
    label,
}: {
    preview: { node_id: string; columns: { name: string; type: string }[]; rows: Record<string, unknown>[] };
    label?: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="bottom-preview">
            <div className="bottom-preview-head">
                {t('bottom.preview')} · <b>{label ?? preview.node_id}</b> · {preview.rows.length} rows
            </div>
            <div className="bottom-preview-scroll">
                <table className="bottom-preview-table">
                    <thead>
                        <tr>
                            {preview.columns.map(c => (
                                <th key={c.name}>
                                    {c.name}
                                    <span className="bottom-preview-coltype">{c.type}</span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {preview.rows.map((r, i) => (
                            <tr key={i}>
                                {preview.columns.map(c => (
                                    <td key={c.name} title={formatCell(r[c.name])}>
                                        {formatCell(r[c.name])}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function ConsoleTab({
    runResult,
    nodeLabels,
}: {
    runResult: RunResult | null;
    nodeLabels: Record<string, string>;
}) {
    const { t } = useTranslation();
    const timeline = runResult?.timeline;
    const lines = useMemo(
        () => (timeline && timeline.length > 0 ? consoleLines(timeline, nodeLabels, t) : null),
        [timeline, nodeLabels, t],
    );
    // Follow the run as it streams, unless the reader has scrolled up to look
    // at something; coming back to the bottom follows again.
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const following = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && following.current) el.scrollTop = el.scrollHeight;
    }, [lines]);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const id = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(id);
    }, [copied]);

    if (!runResult) {
        return (
            <div className="bottom-empty bottom-console">
                <div className="bottom-console-line">
                    <Terminal size={12} className="bottom-console-icon" />
                    <span className="bottom-console-time">{t('bottom.ready')}</span>
                    <span className="bottom-console-msg">
                        {t('bottom.consoleDesc')}
                    </span>
                </div>
            </div>
        );
    }
    if (!lines) return <ConsoleSummary runResult={runResult} nodeLabels={nodeLabels} />;

    const copy = () => {
        void navigator.clipboard?.writeText(consoleText(lines)).then(() => setCopied(true));
    };
    return (
        <div
            className="bottom-console bottom-trace"
            ref={scrollRef}
            onScroll={e => {
                const el = e.currentTarget;
                following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
        >
            <div className="bottom-trace-toolbar">
                <button type="button" className="bottom-trace-copy" onClick={copy}>
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? t('bottom.trace.copied') : t('bottom.trace.copy')}
                </button>
            </div>
            {lines.map(l => (
                <div className={'bottom-trace-line level-' + l.level} key={l.key}>
                    <span className="bottom-trace-time" title={absoluteTime(l.at)}>
                        {formatOffset(l.offset)}
                    </span>
                    <span className="bottom-trace-step">{l.step}</span>
                    <span className="bottom-trace-symbol">{l.symbol}</span>
                    <span className="bottom-trace-text">
                        {l.text}
                        {l.error ? <span className="bottom-trace-error"> · {friendlyError(l.error)}</span> : null}
                        {l.sql ? (
                            <details className="bottom-trace-sql">
                                <summary>{t('bottom.trace.failingSql')}</summary>
                                <pre>{l.sql}</pre>
                            </details>
                        ) : null}
                    </span>
                </div>
            ))}
        </div>
    );
}

function absoluteTime(at: number): string {
    const d = new Date(at);
    return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/** The per-node summary, for a result that carries no timeline. */
function ConsoleSummary({
    runResult,
    nodeLabels,
}: {
    runResult: RunResult;
    nodeLabels: Record<string, string>;
}) {
    const { t } = useTranslation();
    const lines = Object.entries(runResult.nodes).map(([id, st]) => {
        const label = nodeLabels[id] ?? id;
        const tag = st.status === 'ok' ? 'ok' : st.status;
        const detail =
            st.status === 'ok'
                ? `${label} - ${st.kind ?? 'stage'} - ${st.rows ?? 0} rows - ${st.duration_ms ?? 0} ms`
                : `${label} - ${friendlyError(st.error) || st.status}`;
        return { id, tag, detail, ok: st.status === 'ok' };
    });
    return (
        <div className="bottom-console">
            <div className="bottom-console-line">
                <Terminal size={12} className="bottom-console-icon" />
                <span className="bottom-console-time">[run]</span>
                <span className="bottom-console-msg">
                    {runResult.status === 'ok' ? t('bottom.pipelineFinished') : t('bottom.pipelineLabel') + ' ' + runResult.status} ·{' '}
                    {runResult.duration_ms} ms
                </span>
            </div>
            {lines.map(l => (
                <div className="bottom-console-line" key={l.id}>
                    <span
                        className={
                            'bottom-console-tag ' +
                            (l.ok ? 'bottom-console-tag-ok' : 'bottom-console-tag-err')
                        }
                    >
                        [{l.tag}]
                    </span>
                    <span className="bottom-console-msg">{l.detail}</span>
                </div>
            ))}
        </div>
    );
}

/** Planned or pipeline nodes the run did not execute and has no row for. */
function leftOutRows(
    plan: RunPlan | null,
    runResult: RunResult,
    t: (key: string) => string,
): { nodeId: string; label: string; step?: number; reason: string }[] {
    if (!plan) return [];
    const reasons: Record<string, string> = {
        disabled: t('bottom.trace.reasonDisabled'),
        retry_reused: t('bottom.trace.reasonReused'),
    };
    const labelOf = new Map(plan.plan.map(s => [s.node_id, s.label]));
    return [
        ...plan.notRun
            .filter(id => !(id in runResult.nodes))
            .map(id => ({ nodeId: id, label: labelOf.get(id) ?? id, step: plan.steps.get(id), reason: t('bottom.trace.reasonNotRun') })),
        ...plan.skipped
            .filter(s => !(s.node_id in runResult.nodes))
            .map(s => ({ nodeId: s.node_id, label: s.label, reason: reasons[s.reason] ?? s.reason })),
    ];
}

/** A run the Agent can be asked about: it failed, or one of its nodes did. */
function hasFailure(r: RunResult): boolean {
    return r.status === 'error' || !!r.error || Object.values(r.nodes).some(st => st.status === 'error');
}

function runStats(r: RunResult) {
    // "rows written" = rows landed in sinks only. Summing every node
    // (source + transforms + sink) triple-counts the same data and
    // reads as a nonsense total on a simple read -> transform -> write
    // graph. Per-node counts are shown individually in the row list.
    let rowsWritten = 0;
    let nodeCount = 0;
    for (const st of Object.values(r.nodes)) {
        nodeCount += 1;
        if (st.kind === 'sink' && st.rows) rowsWritten += st.rows;
    }
    return { rowsWritten, nodeCount };
}
