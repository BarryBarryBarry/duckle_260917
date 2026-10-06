// Plan 003: the run metrics page's pure logic - formatting, time conversion,
// page numbers and the query it sends - kept apart from the component so
// scripts/check-logic.ts can execute it.

import type { MetricsRunQuery } from '../tauri-bridge';

/** What the page shows for a catalog kind. The store keeps the catalog's own
 *  word; this is only the label, and an unknown kind shows as it is. */
const KIND_LABEL_KEYS: Record<string, string> = {
    source: 'fetch',
    transform: 'convert',
    sink: 'insert',
    quality: 'check',
    control: 'control',
    custom: 'custom',
};

/** The i18n key under `metrics.kind.` for a catalog kind, or null when the
 *  kind is unknown or absent. */
export function kindLabelKey(kind: string | null | undefined): string | null {
    if (!kind) return null;
    return KIND_LABEL_KEYS[kind] ?? null;
}

export const EMPTY = '—';

/** The first line of an error, for a table cell; the whole of it goes in the
 *  cell's tooltip. */
export function firstLine(text: string | null | undefined): string {
    if (!text) return '';
    const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** A duration: milliseconds under a second, then seconds to one decimal, then
 *  minutes and seconds. */
export function formatCost(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** A row count with thousands separators. Absent is not zero. */
export function formatRows(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return EMPTY;
    return Math.round(n).toLocaleString('en-US');
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** An RFC3339 instant as local `YYYY-MM-DD HH:mm:ss`. */
export function formatLocalTime(iso: string | null | undefined): string {
    if (!iso) return EMPTY;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A `<input type="datetime-local">` value (local time) as an RFC3339 UTC
 *  instant, or undefined when empty or unreadable. */
export function localInputToUtc(value: string): string | undefined {
    if (!value.trim()) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** An instant as a `datetime-local` value, to the minute, in local time. */
export function toLocalInput(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function totalPages(total: number, pageSize: number): number {
    if (total <= 0 || pageSize <= 0) return 1;
    return Math.ceil(total / pageSize);
}

/** The page buttons to show: every page when there are at most seven, else
 *  the first, the last, the current one and its neighbours, with `gap` where
 *  pages are left out. */
export function pageItems(current: number, pages: number): Array<number | 'gap'> {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const c = Math.min(Math.max(current, 1), pages);
    const shown = new Set([1, pages, c - 1, c, c + 1]);
    if (c <= 3) [2, 3, 4].forEach((p) => shown.add(p));
    if (c >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((p) => shown.add(p));
    const sorted = [...shown].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
    const out: Array<number | 'gap'> = [];
    sorted.forEach((p, i) => {
        if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
        out.push(p);
    });
    return out;
}

export type RunFilters = {
    /** `datetime-local` values, local time. */
    from: string;
    to: string;
    pipelines: string[];
    statuses: string[];
};

/** The query the page asks for one page of runs. Empty filters are left out,
 *  so they mean "any". Nodes come too: a run's rows are the sum of its
 *  sinks, and the table says which sink wrote what. */
export function buildRunsQuery(f: RunFilters, page: number, pageSize: number): MetricsRunQuery {
    const q: MetricsRunQuery = { page, pageSize, includeNodes: true };
    const from = localInputToUtc(f.from);
    const to = localInputToUtc(f.to);
    if (from) q.from = from;
    if (to) q.to = to;
    if (f.pipelines.length) q.pipeline = [...f.pipelines];
    if (f.statuses.length) q.status = [...f.statuses];
    return q;
}

/** What each sink of a run wrote, in stage order, as `node: rows` lines - the
 *  parts a run's row total adds up. Empty when the run has no sink detail. */
export function sinkRowLines(nodes: ReadonlyArray<{ nodeId: string; kind: string | null; rows: number | null }> | undefined): string[] {
    return (nodes ?? []).filter((n) => n.kind === 'sink').map((n) => `${n.nodeId}: ${formatRows(n.rows)}`);
}

/** Run statuses a filter can pick, `pending` being "never run". */
export const RUN_STATUSES = ['ok', 'error', 'running', 'queued', 'cancelled', 'interrupted', 'pending'] as const;
export const PAGE_SIZES = [20, 50, 100] as const;
