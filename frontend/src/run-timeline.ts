// A run, step by step: the editor keeps every streamed engine event with the
// time it arrived, and the Console and Output tabs read the run's order, its
// skipped nodes and what it left undone from here. Pure, so check-logic can
// drive it without a window.
import type { PipelineEvent, RunPlanStep, SkippedNode } from './tauri-bridge';

export type TimelineEntry =
    | { t: 'run-start'; at: number; total: number; plan: RunPlanStep[]; skipped: SkippedNode[]; omitted: number }
    | { t: 'stage-start'; at: number; nodeId: string; label: string }
    | {
          t: 'stage-end';
          at: number;
          nodeId: string;
          status: string;
          rows?: number;
          durationMs: number;
          error?: string;
          sql?: string;
          branchOf?: string;
      }
    | { t: 'stage-skipped'; at: number; nodeId: string; label: string; reason: string }
    | { t: 'log'; at: number; nodeId: string; level: 'info' | 'warn' | 'error'; message: string }
    | { t: 'assertion'; at: number; nodeId: string; passed: boolean; description: string; detail: string }
    | { t: 'cancelled'; at: number }
    | { t: 'run-end'; at: number; status: string; durationMs: number; notRun: string[] };

/** A long foreach can log a line per row; past this the oldest go. */
export const TIMELINE_LIMIT = 2000;

function entryOf(evt: PipelineEvent, at: number): TimelineEntry {
    switch (evt.type) {
        case 'started':
            return { t: 'run-start', at, total: evt.total_stages, plan: evt.plan ?? [], skipped: evt.skipped ?? [], omitted: 0 };
        case 'stage_started':
            return { t: 'stage-start', at, nodeId: evt.node_id, label: evt.label };
        case 'stage_finished':
            return {
                t: 'stage-end',
                at,
                nodeId: evt.node_id,
                status: evt.status,
                rows: evt.rows,
                durationMs: evt.duration_ms,
                error: evt.error,
                sql: evt.sql,
                branchOf: evt.branch_of,
            };
        case 'stage_skipped':
            return { t: 'stage-skipped', at, nodeId: evt.node_id, label: evt.label, reason: evt.reason };
        case 'log':
            return { t: 'log', at, nodeId: evt.node_id, level: evt.level, message: evt.message };
        case 'assertion':
            return { t: 'assertion', at, nodeId: evt.node_id, passed: evt.passed, description: evt.description, detail: evt.detail };
        case 'cancelled':
            return { t: 'cancelled', at };
        case 'finished':
            return { t: 'run-end', at, status: evt.status, durationMs: evt.duration_ms, notRun: evt.not_run ?? [] };
    }
}

/**
 * The timeline with one more event. `started` opens a new run; warnings the
 * engine sends before it (unread properties, a stale Python lock) belong to
 * that run too, so they are kept after its start.
 */
export function appendEvent(timeline: TimelineEntry[] | undefined, evt: PipelineEvent, at: number): TimelineEntry[] {
    const entry = entryOf(evt, at);
    const prev = timeline ?? [];
    if (entry.t === 'run-start') {
        const early = prev[0]?.t === 'run-start' ? [] : prev.filter(e => e.t === 'log');
        return [entry, ...early];
    }
    // The batched path reports a stage once when it ends and again when its
    // row count is filled in afterwards: update the line rather than repeat it.
    if (entry.t === 'stage-end') {
        const i = prev.findIndex(e => e.t === 'stage-end' && e.nodeId === entry.nodeId);
        if (i >= 0) {
            const next = [...prev];
            next[i] = { ...entry, at: prev[i].at };
            return next;
        }
    }
    const next = [...prev, entry];
    if (next.length > TIMELINE_LIMIT && next[0].t === 'run-start') {
        const drop = next.length - TIMELINE_LIMIT;
        next.splice(1, drop);
        next[0] = { ...next[0], omitted: next[0].omitted + drop };
    }
    return next;
}

export type RunPlan = {
    total: number;
    plan: RunPlanStep[];
    skipped: SkippedNode[];
    /** node id -> 1-based step. */
    steps: Map<string, number>;
    /** Planned nodes that never ran, once the run has finished. */
    notRun: string[];
};

export function runPlan(timeline: TimelineEntry[] | undefined): RunPlan | null {
    const start = timeline?.[0];
    if (!start || start.t !== 'run-start') return null;
    const end = timeline![timeline!.length - 1];
    return {
        total: start.total,
        plan: start.plan,
        skipped: start.skipped,
        steps: new Map(start.plan.map(s => [s.node_id, s.step])),
        notRun: end.t === 'run-end' ? end.notRun : [],
    };
}

/** `[3/8]`, or `[ - ]` for a node outside the plan (a parallelize branch). */
export function stepTag(step: number | undefined, total: number): string {
    return step === undefined ? '[ - ]' : `[${step}/${total}]`;
}

/** Time since the run started: `+1.234s`. */
export function formatOffset(ms: number): string {
    return `+${(Math.max(0, ms) / 1000).toFixed(3)}s`;
}

export type Translate = (key: string, opts?: Record<string, unknown>) => string;

export type ConsoleLine = {
    key: string;
    at: number;
    /** Milliseconds since the run started. */
    offset: number;
    /** `[n/N]`, `[ - ]`, or empty for a line about the whole run. */
    step: string;
    symbol: '●' | '▶' | '✓' | '✗' | '⏭' | 'ℹ' | '⚠' | '■';
    level: 'info' | 'ok' | 'warn' | 'error' | 'muted';
    text: string;
    nodeId?: string;
    /** The engine's error, for the caller to make friendly. */
    error?: string;
    sql?: string;
};

const SKIP_KEYS: Record<string, string> = {
    disabled: 'bottom.trace.skippedDisabled',
    retry_reused: 'bottom.trace.skippedReused',
    budget_stop: 'bottom.trace.skippedBudget',
};

/** What the Console shows, one line per event. */
export function consoleLines(timeline: TimelineEntry[], labels: Record<string, string>, t: Translate): ConsoleLine[] {
    const plan = runPlan(timeline);
    const t0 = plan ? timeline[0].at : (timeline[0]?.at ?? 0);
    const total = plan?.total ?? 0;
    const nameOf = (id: string, fallback?: string) => labels[id] ?? (fallback || id);
    const tagOf = (id: string) => (plan ? stepTag(plan.steps.get(id), total) : '');
    const skipText = (reason: string, label: string) =>
        t(SKIP_KEYS[reason] ?? 'bottom.trace.skippedOther', { label, reason });
    const out: ConsoleLine[] = [];
    timeline.forEach((e, i) => {
        const base = { key: String(i), at: e.at, offset: e.at - t0 };
        switch (e.t) {
            case 'run-start':
                out.push({ ...base, step: '', symbol: '●', level: 'info', text: t('bottom.trace.runStarted', { count: e.total }) });
                e.skipped.forEach((s, j) =>
                    out.push({
                        ...base,
                        key: `${i}.${j}`,
                        step: '',
                        symbol: '⏭',
                        level: 'muted',
                        text: skipText(s.reason, nameOf(s.node_id, s.label)),
                        nodeId: s.node_id,
                    }),
                );
                if (e.omitted > 0) {
                    out.push({ ...base, key: `${i}.o`, step: '', symbol: 'ℹ', level: 'muted', text: t('bottom.trace.omitted', { count: e.omitted }) });
                }
                break;
            case 'stage-start':
                out.push({ ...base, step: tagOf(e.nodeId), symbol: '▶', level: 'muted', text: nameOf(e.nodeId, e.label), nodeId: e.nodeId });
                break;
            case 'stage-end': {
                const name = nameOf(e.nodeId);
                const branch = e.branchOf ? ' · ' + t('bottom.trace.inBranch', { label: nameOf(e.branchOf) }) : '';
                if (e.status === 'error') {
                    out.push({ ...base, step: tagOf(e.nodeId), symbol: '✗', level: 'error', text: name + branch, nodeId: e.nodeId, error: e.error, sql: e.sql });
                    break;
                }
                const rows = e.rows !== undefined ? ' · ' + t('bottom.trace.rows', { count: e.rows, formatted: e.rows.toLocaleString() }) : '';
                out.push({
                    ...base,
                    step: tagOf(e.nodeId),
                    symbol: '✓',
                    level: 'ok',
                    text: `${name}${rows} · ${e.durationMs} ms${branch}`,
                    nodeId: e.nodeId,
                });
                break;
            }
            case 'stage-skipped':
                out.push({ ...base, step: tagOf(e.nodeId), symbol: '⏭', level: 'muted', text: skipText(e.reason, nameOf(e.nodeId, e.label)), nodeId: e.nodeId });
                break;
            case 'log':
                out.push({
                    ...base,
                    step: '',
                    symbol: e.level === 'info' ? 'ℹ' : e.level === 'warn' ? '⚠' : '✗',
                    level: e.level === 'info' ? 'info' : e.level,
                    text: e.nodeId ? `${nameOf(e.nodeId)}: ${e.message}` : e.message,
                    nodeId: e.nodeId || undefined,
                });
                break;
            case 'assertion':
                out.push({
                    ...base,
                    step: '',
                    symbol: e.passed ? 'ℹ' : '⚠',
                    level: e.passed ? 'info' : 'warn',
                    text: e.passed
                        ? t('bottom.trace.assertionHeld', { label: nameOf(e.nodeId), description: e.description })
                        : t('bottom.trace.assertionFailed', { label: nameOf(e.nodeId), description: e.description, detail: e.detail }),
                    nodeId: e.nodeId,
                });
                break;
            case 'cancelled':
                out.push({ ...base, step: '', symbol: '■', level: 'warn', text: t('bottom.trace.cancelled') });
                break;
            case 'run-end':
                out.push({
                    ...base,
                    step: '',
                    symbol: '■',
                    level: e.status === 'ok' ? 'ok' : e.status === 'cancelled' ? 'warn' : 'error',
                    text: t('bottom.trace.runFinished', { status: e.status, duration: e.durationMs }),
                });
                if (e.notRun.length > 0) {
                    out.push({
                        ...base,
                        key: `${i}.n`,
                        step: '',
                        symbol: '⏭',
                        level: 'muted',
                        text: t('bottom.trace.notRun', { labels: e.notRun.map(id => nameOf(id)).join(', ') }),
                    });
                }
                break;
        }
    });
    return out;
}

/** The Console as plain text, for the clipboard. */
export function consoleText(lines: ConsoleLine[]): string {
    return lines
        .map(l => {
            const head = [formatOffset(l.offset), l.step, l.symbol].filter(Boolean).join(' ');
            const err = l.error ? ` · ${l.error}` : '';
            const sql = l.sql ? `\n    ${l.sql.replace(/\n/g, '\n    ')}` : '';
            return `${head} ${l.text}${err}${sql}`;
        })
        .join('\n');
}
