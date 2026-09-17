import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Server, ShieldCheck, X } from 'lucide-react';
import {
    deployPipeline,
    deployTargets,
    scheduleList,
    type DeployTarget,
    type Schedule,
} from '../tauri-bridge';
import { stripPreviewRows } from '../workspace';
import { serverSchedule } from '../schedule-save';

/**
 * Send the pipeline you are looking at to a server you own.
 *
 * The plumbing under this was finished a while ago - a Tauri command, a client that talks
 * to `/api/deploy`, and the server side that installs the file - and this dialog is the
 * part that was missing, so until now a pipeline could only reach a server by hand.
 */

type Props = {
    /** Which pipeline to send. Its id is also the name on the far end by default. */
    pipelineId: string;
    pipelineName: string;
    /** The document itself: `{ nodes, edges }` as the editor holds it. */
    pipeline: unknown;
    workspacePath: string | null;
    onClose: () => void;
};

/** How a schedule reads to a person, for the line offering to send it. */
function describe(s: Schedule): string {
    if (s.kind.type === 'cron') return 'cron ' + s.kind.expr;
    if (s.kind.type === 'interval') return 'every ' + s.kind.seconds + 's';
    return 'a file watch, which cannot travel';
}

export default function DeployModal({
    pipelineId,
    pipelineName,
    pipeline,
    workspacePath,
    onClose,
}: Props) {
    const [targets, setTargets] = useState<DeployTarget[]>([]);
    const [target, setTarget] = useState('');
    const [name, setName] = useState(pipelineId);
    const [schedule, setSchedule] = useState<Schedule | undefined>();
    const [sendSchedule, setSendSchedule] = useState(true);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            if (!workspacePath) {
                setLoading(false);
                return;
            }
            try {
                const [list, scheds] = await Promise.all([
                    deployTargets(workspacePath),
                    // An unreadable schedule store must not stop a deploy: the pipeline is
                    // the point and the schedule is the extra.
                    scheduleList().catch(() => [] as Schedule[]),
                ]);
                if (!alive) return;
                setTargets(list);
                setTarget(list[0]?.name ?? '');
                setSchedule(scheds.find(s => s.pipeline_id === pipelineId));
            } catch (e) {
                if (alive) setError(String(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            alive = false;
            document.removeEventListener('keydown', onKey);
        };
    }, [workspacePath, pipelineId, onClose]);

    /**
     * Exactly what will be sent, computed the same way the send computes it.
     *
     * The point of showing this is that it can be checked rather than believed: the
     * counts, the removals and the JSON below all come from this one value, so the
     * preview cannot claim one thing while the request carries another.
     */
    const outgoing = useMemo(() => stripPreviewRows(pipeline), [pipeline]);
    const summary = useMemo(() => {
        const doc = (outgoing ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
        const before = (pipeline ?? {}) as { nodes?: { data?: Record<string, unknown> }[] };
        const previewsDropped = (before.nodes ?? []).filter(
            n => n?.data && 'sampleRows' in n.data,
        ).length;
        return {
            nodes: doc.nodes?.length ?? 0,
            edges: doc.edges?.length ?? 0,
            previewsDropped,
            bytes: JSON.stringify(outgoing ?? {}).length,
        };
    }, [outgoing, pipeline]);

    const send = useCallback(async () => {
        if (!workspacePath || !target) return;
        setBusy(true);
        setError(null);
        try {
            const wanted = sendSchedule ? serverSchedule(schedule, name.trim()) : null;
            const result = await deployPipeline(
                workspacePath,
                target,
                name.trim(),
                // The value the preview above showed, not a second computation of it.
                outgoing,
                wanted ?? undefined,
            );
            const r = (result ?? {}) as Record<string, unknown>;
            // The server calls this key `schedule`, not `scheduled` (serve.rs:2019). Reading
            // the wrong one meant a schedule really did travel and the confirmation never
            // said so, which is the one detail somebody needs to hear.
            const scheduled = !!r.schedule && typeof r.schedule === 'object';
            setDone(
                (r.replaced === true ? 'Replaced ' : 'Installed ') +
                    name.trim() +
                    ' on ' +
                    target +
                    (scheduled ? ', and its schedule went with it, switched off.' : '.'),
            );
        } catch (e) {
            // deploy.rs writes these for a person to act on - a revoked key, the admin role
            // and the command that mints one - so they are shown as written.
            setError(String(e).replace(/^Error:\s*/, ''));
        } finally {
            setBusy(false);
        }
    }, [workspacePath, target, name, outgoing, schedule, sendSchedule]);

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };

    return createPortal(
        <div
            className="modal-backdrop"
            onClick={handleBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Deploy to a server"
        >
            <div className="modal modal-deploy">
                <div className="modal-header">
                    <div className="modal-title-row">
                        <Server size={16} className="modal-title-icon" />
                        <div>
                            <div className="modal-title">Deploy to a server</div>
                            <div className="modal-subtitle">
                                Pipeline: <b>{pipelineName}</b>
                            </div>
                        </div>
                    </div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body modal-deploy-body">
                    {loading ? (
                        <div className="schedule-empty">Loading&#8230;</div>
                    ) : !workspacePath ? (
                        <div className="schedule-empty">
                            <b>No workspace is open.</b>
                        </div>
                    ) : done ? (
                        <p className="setup-note">
                            <Check size={14} />
                            <span>{done}</span>
                        </p>
                    ) : targets.length === 0 ? (
                        <div className="schedule-empty">
                            <b>No server is connected yet.</b>
                            <div>
                                Connect one from Settings, under First run, then Run setup again.
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="modal-field">
                                <label className="modal-field-label" htmlFor="deploy-target">
                                    Server
                                </label>
                                <select
                                    id="deploy-target"
                                    className="modal-input modal-select"
                                    value={target}
                                    onChange={e => setTarget(e.target.value)}
                                >
                                    {targets.map(t => (
                                        <option key={t.name} value={t.name}>
                                            {t.name} - {t.url}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="modal-field">
                                <label className="modal-field-label" htmlFor="deploy-name">
                                    Call it, on the server
                                </label>
                                <input
                                    id="deploy-name"
                                    className="modal-input"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                />
                            </div>

                            {schedule ? (
                                <div className="modal-field">
                                    <label className="schedule-toggle">
                                        <input
                                            type="checkbox"
                                            checked={sendSchedule}
                                            onChange={e => setSendSchedule(e.target.checked)}
                                            disabled={schedule.kind.type === 'file_watch'}
                                        />
                                        Send its schedule too ({describe(schedule)})
                                    </label>
                                </div>
                            ) : null}

                            <div className="deploy-manifest">
                                <div className="deploy-manifest-head">
                                    What will be sent
                                </div>
                                <ul className="deploy-manifest-list">
                                    <li>
                                        {summary.nodes} node{summary.nodes === 1 ? '' : 's'} and{' '}
                                        {summary.edges} connection
                                        {summary.edges === 1 ? '' : 's'}, {summary.bytes} bytes
                                    </li>
                                    <li>
                                        {summary.previewsDropped > 0
                                            ? `Cached preview rows removed from ${summary.previewsDropped} node${summary.previewsDropped === 1 ? '' : 's'}`
                                            : 'No cached preview rows to remove'}
                                    </li>
                                    <li>
                                        Placeholders left unresolved, so no path from this machine
                                        travels
                                    </li>
                                </ul>
                                <details className="deploy-manifest-json">
                                    <summary>Show the exact JSON</summary>
                                    <pre>{JSON.stringify(outgoing, null, 2)}</pre>
                                </details>
                            </div>

                            <p className="setup-note">
                                <ShieldCheck size={14} />
                                <span>
                                    A deployed schedule arrives switched off, so a cadence set
                                    while testing here cannot start firing on the server. Turning
                                    it on is a separate act. Deploying needs the admin role.
                                </span>
                            </p>
                        </>
                    )}

                    {error ? <div className="modal-error">{error}</div> : null}

                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>
                            {done ? 'Close' : 'Cancel'}
                        </button>
                        {done ? null : (
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={send}
                                disabled={busy || loading || !target || !name.trim()}
                            >
                                {busy ? <Loader2 size={14} className="spin" /> : null}
                                {busy ? 'Deploying…' : 'Deploy'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
