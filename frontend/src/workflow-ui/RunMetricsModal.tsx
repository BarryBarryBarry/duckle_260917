// Plan 003: the run metrics page. Every pipeline's runs in the workspace, by
// time, pipeline and status, a page at a time; click a pipeline name to see
// that run's stages. Read-only: it starts nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    Circle,
    Clock,
    Loader2,
    MinusCircle,
    Search,
    X,
    XCircle,
} from 'lucide-react';
import {
    isMetricsFailure,
    metricsPipelines,
    metricsRuns,
    type MetricsFailure,
    type MetricsNode,
    type MetricsPipeline,
    type MetricsRun,
    type MetricsRunsPage,
} from '../tauri-bridge';
import { isWebBackend } from '../web-fs';
import Pagination from './Pagination';
import {
    EMPTY,
    PAGE_SIZES,
    RUN_STATUSES,
    buildRunsQuery,
    firstLine,
    formatCost,
    formatLocalTime,
    formatRows,
    kindLabelKey,
    toLocalInput,
    type RunFilters,
} from './run-metrics-format';

type Props = {
    workspacePath: string | null;
    onClose: () => void;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function defaultFilters(): RunFilters {
    return { from: toLocalInput(new Date(Date.now() - WEEK_MS)), to: '', pipelines: [], statuses: [] };
}

/** The icon for a run or node status, coloured like the History tab's. */
export function StatusIcon({ status }: { status: string }) {
    switch (status) {
        case 'ok':
            return <CheckCircle2 size={14} className="run-row-ok" />;
        case 'unchanged':
            return <CheckCircle2 size={14} className="run-row-idle" />;
        case 'error':
            return <XCircle size={14} className="run-row-err" />;
        case 'running':
            return <Loader2 size={14} className="run-metrics-spin" />;
        case 'queued':
            return <Clock size={14} className="run-row-idle" />;
        case 'interrupted':
            return <AlertTriangle size={14} className="run-row-warn" />;
        case 'pending':
            return <Circle size={14} className="run-row-idle" />;
        default:
            return <MinusCircle size={14} className="run-row-idle" />;
    }
}

type Option = { value: string; label: string };

/** A dropdown of checkboxes; an empty choice means "all". */
function MultiSelect({
    label,
    allLabel,
    options,
    chosen,
    onChange,
}: {
    label: string;
    allLabel: string;
    options: Option[];
    chosen: string[];
    onChange: (next: string[]) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => {
            if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);
    const summary =
        chosen.length === 0
            ? allLabel
            : chosen.length === 1
              ? (options.find((o) => o.value === chosen[0])?.label ?? chosen[0])
              : t('metrics.filters.chosen', { count: chosen.length });
    const toggle = (v: string) => onChange(chosen.includes(v) ? chosen.filter((c) => c !== v) : [...chosen, v]);
    return (
        <div className="run-metrics-multi" ref={box}>
            <button
                type="button"
                className="run-metrics-multi-btn"
                aria-label={label}
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                <span className="run-metrics-multi-text">{summary}</span>
                <ChevronDown size={13} aria-hidden="true" />
            </button>
            {open ? (
                <div className="run-metrics-multi-menu" role="listbox" aria-multiselectable="true">
                    {options.map((o) => (
                        <label key={o.value} className="run-metrics-multi-item">
                            <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
                            <span>{o.label}</span>
                        </label>
                    ))}
                    {options.length === 0 ? <div className="run-metrics-multi-empty">{EMPTY}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

type NodeState = { loading: boolean; failure: MetricsFailure | null; nodes: MetricsNode[] };

/** The stages of one run, under its row. */
function NodePanel({ run, state, onClose }: { run: MetricsRun; state: NodeState; onClose: () => void }) {
    const { t } = useTranslation();
    const kind = (k: string | null) => {
        const key = kindLabelKey(k);
        return key ? t(`metrics.kind.${key}`) : (k ?? EMPTY);
    };
    return (
        <div className="run-metrics-popover" role="dialog" aria-label={t('metrics.nodes.title', { name: run.pipelineName })}>
            <button type="button" className="run-metrics-popover-close" aria-label={t('common.close')} onClick={onClose}>
                <X size={14} />
            </button>
            {state.loading ? <div className="dive-panel-msg">{t('metrics.loading')}</div> : null}
            {state.failure ? <div className="dive-panel-msg dive-panel-err">{state.failure.reason ?? state.failure.error}</div> : null}
            {!state.loading && !state.failure && state.nodes.length === 0 ? (
                <div className="dive-panel-msg">{run.status === 'pending' ? t('metrics.nodes.neverRun') : t('metrics.nodes.none')}</div>
            ) : null}
            {state.nodes.length > 0 ? (
                <table className="run-table run-metrics-nodes">
                    <thead>
                        <tr>
                            <th>{t('metrics.nodes.node')}</th>
                            <th>{t('metrics.nodes.status')}</th>
                            <th>{t('metrics.nodes.executeTime')}</th>
                            <th className="run-num">{t('metrics.columns.cost')}</th>
                            <th>{t('metrics.nodes.type')}</th>
                            <th className="run-num">{t('metrics.columns.rows')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {state.nodes.map((n, i) => (
                            <tr key={n.nodeId}>
                                <td>
                                    <span className="run-node-label">{`${i + 1}. ${n.nodeId}`}</span>
                                    {n.error ? (
                                        <div className="run-node-error run-metrics-error" title={n.error}>
                                            {firstLine(n.error)}
                                        </div>
                                    ) : null}
                                </td>
                                <td>
                                    <span className="run-metrics-status">
                                        <StatusIcon status={n.status} />
                                        {t(`metrics.status.${n.status}`, { defaultValue: n.status })}
                                    </span>
                                </td>
                                <td>{formatLocalTime(n.startedAt)}</td>
                                <td className="run-num">{formatCost(n.durationMs)}</td>
                                <td title={n.component ?? undefined}>{kind(n.kind)}</td>
                                <td className="run-num">{formatRows(n.rows)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </div>
    );
}

/** Loads one page of runs whenever the applied filters or the page change. */
function useRunsPage(workspacePath: string | null, applied: RunFilters, page: number, pageSize: number) {
    const [data, setData] = useState<MetricsRunsPage | null>(null);
    const [failure, setFailure] = useState<MetricsFailure | null>(null);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (workspacePath === null) return;
        let alive = true;
        setLoading(true);
        void metricsRuns(workspacePath, buildRunsQuery(applied, page, pageSize)).then((answer) => {
            if (!alive) return;
            setLoading(false);
            if (isMetricsFailure(answer)) {
                setFailure(answer);
                setData(null);
            } else {
                setFailure(null);
                setData(answer);
            }
        });
        return () => {
            alive = false;
        };
    }, [workspacePath, applied, page, pageSize]);
    return { data, failure, loading };
}

/** Loads the stages of whichever run is open. */
function useRunNodes(workspacePath: string | null, runKey: string | null, pending: boolean): NodeState {
    const [state, setState] = useState<NodeState>({ loading: false, failure: null, nodes: [] });
    useEffect(() => {
        if (workspacePath === null || !runKey || pending) {
            setState({ loading: false, failure: null, nodes: [] });
            return;
        }
        let alive = true;
        setState({ loading: true, failure: null, nodes: [] });
        void metricsRuns(workspacePath, { runKey }).then((answer) => {
            if (!alive) return;
            if (isMetricsFailure(answer)) setState({ loading: false, failure: answer, nodes: [] });
            else setState({ loading: false, failure: null, nodes: answer.runs[0]?.nodes ?? [] });
        });
        return () => {
            alive = false;
        };
    }, [workspacePath, runKey, pending]);
    return state;
}

function Filters({
    draft,
    setDraft,
    pipelines,
    onSearch,
}: {
    draft: RunFilters;
    setDraft: (f: RunFilters) => void;
    pipelines: MetricsPipeline[];
    onSearch: () => void;
}) {
    const { t } = useTranslation();
    return (
        <form
            className="run-metrics-filters"
            onSubmit={(e) => {
                e.preventDefault();
                onSearch();
            }}
        >
            <label className="run-metrics-field">
                <span>{t('metrics.filters.from')}</span>
                <input type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </label>
            <label className="run-metrics-field">
                <span>{t('metrics.filters.to')}</span>
                <input type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </label>
            <MultiSelect
                label={t('metrics.filters.pipelines')}
                allLabel={t('metrics.filters.allPipelines')}
                options={pipelines.map((p) => ({ value: p.pipelineId, label: p.pipelineName }))}
                chosen={draft.pipelines}
                onChange={(pipelinesChosen) => setDraft({ ...draft, pipelines: pipelinesChosen })}
            />
            <MultiSelect
                label={t('metrics.filters.statuses')}
                allLabel={t('metrics.filters.allStatuses')}
                options={RUN_STATUSES.map((s) => ({ value: s, label: t(`metrics.status.${s}`) }))}
                chosen={draft.statuses}
                onChange={(statuses) => setDraft({ ...draft, statuses })}
            />
            <button type="submit" className="dive-btn primary run-metrics-search" aria-label={t('metrics.filters.search')}>
                <Search size={14} />
                {t('metrics.filters.search')}
            </button>
        </form>
    );
}

function RunRow({ run, open, onToggle }: { run: MetricsRun; open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <tr className={`run-row${open ? ' run-metrics-row-open' : ''}`}>
            <td>
                <button type="button" className="run-metrics-name" aria-expanded={open} onClick={onToggle}>
                    {run.pipelineName}
                </button>
                {run.nodeCount ? (
                    <span className="run-metrics-badge" title={t('metrics.nodeCount', { count: run.nodeCount })}>
                        +{run.nodeCount}
                    </span>
                ) : null}
                {run.error ? (
                    <div className="run-node-error run-metrics-error" title={run.error}>
                        {firstLine(run.error)}
                    </div>
                ) : null}
            </td>
            <td>
                <span className="run-metrics-status">
                    <StatusIcon status={run.status} />
                    {t(`metrics.status.${run.status}`, { defaultValue: run.status })}
                </span>
            </td>
            <td>{formatLocalTime(run.startedAt)}</td>
            <td className="run-num">{formatCost(run.durationMs)}</td>
            <td className="run-num">{formatRows(run.rows)}</td>
        </tr>
    );
}

function RunsTable({
    runs,
    stale,
    openKey,
    setOpenKey,
    nodes,
}: {
    runs: MetricsRun[];
    stale: boolean;
    openKey: string | null;
    setOpenKey: (k: string | null) => void;
    nodes: NodeState;
}) {
    const { t } = useTranslation();
    return (
        <div className={`run-metrics-table-wrap${stale ? ' run-metrics-stale' : ''}`}>
            <table className="run-table run-metrics-table">
                <thead>
                    <tr>
                        <th>{t('metrics.columns.pipeline')}</th>
                        <th>{t('metrics.columns.status')}</th>
                        <th>{t('metrics.columns.executedTime')}</th>
                        <th className="run-num">{t('metrics.columns.cost')}</th>
                        <th className="run-num">{t('metrics.columns.rows')}</th>
                    </tr>
                </thead>
                <tbody>
                    {runs.flatMap((run) => {
                        const open = run.runKey === openKey;
                        const row = (
                            <RunRow key={run.runKey} run={run} open={open} onToggle={() => setOpenKey(open ? null : run.runKey)} />
                        );
                        if (!open) return [row];
                        return [
                            row,
                            <tr key={`${run.runKey}-nodes`} className="run-metrics-popover-row">
                                <td colSpan={5}>
                                    <NodePanel run={run} state={nodes} onClose={() => setOpenKey(null)} />
                                </td>
                            </tr>,
                        ];
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default function RunMetricsModal({ workspacePath: chosenWorkspace, onClose }: Props) {
    const { t } = useTranslation();
    // The web edition's server answers for its own workspace whatever the page
    // names, and the page may have none open; only the desktop needs one.
    const workspacePath = chosenWorkspace ?? (isWebBackend() ? '' : null);
    const [draft, setDraft] = useState<RunFilters>(defaultFilters);
    const [applied, setApplied] = useState<RunFilters>(draft);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
    const [pipelines, setPipelines] = useState<MetricsPipeline[]>([]);
    const [openKey, setOpenKey] = useState<string | null>(null);
    const { data, failure, loading } = useRunsPage(workspacePath, applied, page, pageSize);
    const openRun = data?.runs.find((r) => r.runKey === openKey) ?? null;
    const nodes = useRunNodes(workspacePath, openKey, openRun?.status === 'pending');

    useEffect(() => {
        if (workspacePath !== null) void metricsPipelines(workspacePath).then(setPipelines);
    }, [workspacePath]);
    const onKey = useCallback(
        (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (openKey) setOpenKey(null);
            else onClose();
        },
        [openKey, onClose],
    );
    useEffect(() => {
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onKey]);

    const search = () => {
        setOpenKey(null);
        setPage(1);
        setApplied({ ...draft });
    };
    const runs = data?.runs ?? [];
    return (
        <div className="dive-modal-backdrop" onClick={onClose}>
            <div className="run-metrics-modal" role="dialog" aria-label={t('metrics.title')} onClick={(e) => e.stopPropagation()}>
                <div className="lineage-head">
                    <h2 className="lineage-title">{t('metrics.title')}</h2>
                    <button type="button" className="dive-btn" onClick={onClose} aria-label={t('common.close')}>
                        <X size={14} />
                    </button>
                </div>
                {workspacePath === null ? <div className="dive-panel-msg">{t('metrics.noWorkspace')}</div> : null}
                <Filters draft={draft} setDraft={setDraft} pipelines={pipelines} onSearch={search} />
                {failure ? (
                    <div className="dive-panel-msg dive-panel-err">
                        {failure.reason ? `${t('metrics.unavailable')} ${failure.reason}` : failure.error}
                        {failure.status === 503 ? <div className="run-metrics-hint">{t('metrics.unavailableHint')}</div> : null}
                    </div>
                ) : null}
                {loading && !data ? <div className="dive-panel-msg">{t('metrics.loading')}</div> : null}
                {data && runs.length === 0 ? <div className="dive-panel-msg">{t('metrics.empty')}</div> : null}
                {runs.length > 0 ? (
                    <RunsTable runs={runs} stale={loading} openKey={openKey} setOpenKey={setOpenKey} nodes={nodes} />
                ) : null}
                {data ? (
                    <Pagination
                        page={page}
                        pageSize={pageSize}
                        total={data.total ?? runs.length}
                        pageSizes={PAGE_SIZES}
                        onPage={(p) => {
                            setOpenKey(null);
                            setPage(p);
                        }}
                        onPageSize={(s) => {
                            setOpenKey(null);
                            setPage(1);
                            setPageSize(s);
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}
