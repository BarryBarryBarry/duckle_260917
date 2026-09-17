import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotationPatch } from '../catalog-annotate';
import { Library, RefreshCw, Search, Tag, User, X } from 'lucide-react';
import {
    workspaceCatalog,
    workspaceCatalogAnnotate,
    workspaceCatalogInspect,
    workspaceCatalogRebuild,
    type CatalogAsset,
    type CatalogView,
} from '../tauri-bridge';

type Props = {
    workspace: string | null;
    onClose: () => void;
};

/** Newest-first is meaningless for freshness; "how long ago" is what reads. */
function ago(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return iso;
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 90) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 90) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 36) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

/**
 * Rank a search hit so the obvious answer comes first.
 *
 * A plain substring filter puts `/lake/raw/archive/orders_2019.parquet` above
 * `/lake/orders.parquet` for the query "orders", which is the wrong way round
 * for every question anyone asks. Exact and prefix matches lead; a match in the
 * name beats a match in a tag or a description.
 */
function score(asset: CatalogAsset, q: string): number {
    const id = asset.id.toLowerCase();
    // The last path segment WITHOUT its extension. Splitting on dots as well as
    // slashes made this the extension every time, so every parquet file had the
    // name "parquet" and the prefix rule below could never fire.
    const seg = id.split('/').filter(Boolean).pop() ?? id;
    const tail = seg.includes('.') ? seg.slice(0, seg.lastIndexOf('.')) : seg;
    if (id === q || tail === q) return 0;
    if (tail.startsWith(q)) return 1;
    if (id.includes(q)) return 2;
    if ((asset.owner ?? '').toLowerCase().includes(q)) return 3;
    if (asset.tags.some(t => t.toLowerCase().includes(q))) return 3;
    if ((asset.description ?? '').toLowerCase().includes(q)) return 4;
    if (asset.columns.some(c => c.toLowerCase().includes(q))) return 5;
    return Number.POSITIVE_INFINITY;
}

export default function CatalogPanel({ workspace, onClose }: Props) {
    const [view, setView] = useState<CatalogView | null>(null);
    // Kept apart from the view: a failed refresh must not blank a catalog that
    // is on screen and still perfectly readable.
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [live, setLive] = useState<{ asset: string; columns?: string[]; error?: string } | null>(
        null,
    );

    const load = useCallback(
        async (rebuild = false) => {
            if (!workspace) return;
            setLoading(true);
            try {
                setView(rebuild ? await workspaceCatalogRebuild(workspace) : await workspaceCatalog(workspace));
                setError(null);
            } catch (err) {
                setError(String(err));
            }
            setLoading(false);
        },
        [workspace],
    );

    // Loaded when the workspace changes, not whenever the editor re-renders. The
    // close handler App passes is a new function on every render, and a run sends
    // a stream of events, so depending on it reloaded the catalog per event - and
    // the reload re-seeded the form, erasing what was being typed.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        void load();
    }, [load]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCloseRef.current();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const assets = view?.assets ?? [];
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return assets;
        return assets
            .map(a => ({ a, s: score(a, q) }))
            .filter(x => Number.isFinite(x.s))
            .sort((x, y) => x.s - y.s || x.a.id.localeCompare(y.a.id))
            .map(x => x.a);
    }, [assets, query]);

    const current = selected ? assets.find(a => a.id === selected) ?? null : null;

    const annotate = async (patch: Partial<CatalogAsset>) => {
        if (!workspace || !current) return;
        setBusy(true);
        try {
            setView(
                await workspaceCatalogAnnotate({
                    workspace,
                    pipelines: false,
                    name: current.id,
                    owner: patch.owner ?? null,
                    contact: patch.contact ?? null,
                    description: patch.description ?? null,
                    tags: patch.tags ?? null,
                }),
            );
            setError(null);
        } catch (err) {
            setError(String(err));
        }
        setBusy(false);
    };

    const inspect = async () => {
        if (!workspace || !current) return;
        setLive({ asset: current.id });
        try {
            setLive({ asset: current.id, columns: await workspaceCatalogInspect(workspace, current.id) });
        } catch (err) {
            setLive({ asset: current.id, error: String(err) });
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal catalog-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-head">
                    <div className="modal-title-row">
                        <Library size={16} className="modal-title-icon" />
                        <div>
                            <div className="modal-title">Data Catalog</div>
                            <div className="modal-subtitle">
                                Every dataset this workspace reads or writes, joined across pipelines
                            </div>
                        </div>
                    </div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body catalog-body">
                    {!workspace ? (
                        <div className="schedule-empty">Open a workspace to see its catalog.</div>
                    ) : (
                        <>
                            <div className="catalog-toolbar">
                                <div className="catalog-search">
                                    <Search size={14} />
                                    <input
                                        autoFocus
                                        value={query}
                                        onChange={e => setQuery(e.target.value)}
                                        placeholder="Search assets, owners, tags, columns"
                                    />
                                </div>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => void load(true)}
                                    disabled={loading || busy}
                                    title="Re-read every pipeline and rebuild the graph"
                                >
                                    <RefreshCw size={13} /> Rescan
                                </button>
                            </div>

                            {/* The graph is derived and this reads the saved copy, so it can be
                                describing pipelines as they were an hour ago. Rebuilding is a
                                deliberate act, so this says so rather than quietly doing it. */}
                            {view?.stale ? (
                                <div className="catalog-note catalog-note-warn">
                                    Pipelines have changed since this was built. Press <b>Rescan</b> for a
                                    current answer.
                                </div>
                            ) : null}
                            {view && view.unresolved.length > 0 ? (
                                <div className="catalog-note catalog-note-warn">
                                    {view.unresolved.length} source/sink node(s) could not be named, so this
                                    list may be incomplete.
                                </div>
                            ) : null}
                            {error ? <div className="modal-error">{error}</div> : null}

                            <div className="catalog-split">
                                <div className="catalog-list">
                                    {loading && !view ? (
                                        <div className="schedule-empty">Loading…</div>
                                    ) : shown.length === 0 ? (
                                        <div className="schedule-empty">
                                            {assets.length === 0
                                                ? 'No assets yet. Are there pipelines in this workspace?'
                                                : `Nothing matches “${query}”.`}
                                        </div>
                                    ) : (
                                        shown.map(a => (
                                            <button
                                                type="button"
                                                key={a.id}
                                                className={
                                                    'catalog-row' + (a.id === selected ? ' is-selected' : '')
                                                }
                                                onClick={() => {
                                                    setSelected(a.id);
                                                    setLive(null);
                                                }}
                                            >
                                                <div className="catalog-row-id">{a.id}</div>
                                                <div className="catalog-row-meta">
                                                    <span className="catalog-kind">{a.kind}</span>
                                                    {a.owner ? (
                                                        <span className="catalog-owner">
                                                            <User size={11} /> {a.owner}
                                                        </span>
                                                    ) : null}
                                                    {a.tags.map(t => (
                                                        <span className="catalog-tag" key={t}>
                                                            <Tag size={10} /> {t}
                                                        </span>
                                                    ))}
                                                    {a.freshness ? (
                                                        <span className="catalog-fresh">
                                                            written {ago(a.freshness.lastWrittenAt)}
                                                        </span>
                                                    ) : (
                                                        <span className="catalog-fresh catalog-fresh-none">
                                                            never written here
                                                        </span>
                                                    )}
                                                </div>
                                            </button>
                                        ))
                                    )}
                                </div>

                                <div className="catalog-detail">
                                    {!current ? (
                                        <div className="schedule-empty">
                                            Pick an asset to see who owns it, what is in it, and which
                                            pipelines touch it.
                                        </div>
                                    ) : (
                                        <AssetDetail
                                            asset={current}
                                            busy={busy}
                                            live={live?.asset === current.id ? live : null}
                                            onInspect={inspect}
                                            onAnnotate={annotate}
                                        />
                                    )}
                                </div>
                            </div>

                            {view && Object.keys(view.terms).length > 0 ? (
                                <div className="catalog-glossary">
                                    <div className="catalog-section-title">Glossary</div>
                                    {Object.entries(view.terms).map(([term, meaning]) => (
                                        <div className="catalog-term" key={term}>
                                            <b>{term}</b> {meaning}
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function AssetDetail({
    asset,
    busy,
    live,
    onInspect,
    onAnnotate,
}: {
    asset: CatalogAsset;
    busy: boolean;
    live: { columns?: string[]; error?: string } | null;
    onInspect: () => void;
    onAnnotate: (patch: Partial<CatalogAsset>) => void;
}) {
    const [owner, setOwner] = useState(asset.owner ?? '');
    const [description, setDescription] = useState(asset.description ?? '');
    const [tags, setTags] = useState(asset.tags.join(', '));

    // Re-seed when a different asset is selected, so the form never shows one
    // asset's description under another's name. Only then: a reload hands back
    // a new tags array for the same asset, and re-seeding on it erased typing.
    useEffect(() => {
        setOwner(asset.owner ?? '');
        setDescription(asset.description ?? '');
        setTags(asset.tags.join(', '));
    }, [asset.id]);

    return (
        <div className="catalog-detail-inner">
            <div className="catalog-detail-id">{asset.id}</div>
            <div className="catalog-row-meta">
                <span className="catalog-kind">{asset.kind}</span>
                {asset.freshness ? (
                    <span className="catalog-fresh">
                        written {ago(asset.freshness.lastWrittenAt)} by {asset.freshness.pipelineId}
                        {typeof asset.freshness.rows === 'number'
                            ? `, ${asset.freshness.rows.toLocaleString()} rows`
                            : ''}
                    </span>
                ) : (
                    <span className="catalog-fresh catalog-fresh-none">
                        no successful run in this workspace has written it
                    </span>
                )}
            </div>

            <div className="catalog-section-title">Produced and consumed by</div>
            <div className="catalog-lineage">
                <div>
                    <span className="catalog-muted">written by</span>{' '}
                    {asset.writtenBy.length ? asset.writtenBy.join(', ') : <i>nothing here</i>}
                </div>
                <div>
                    <span className="catalog-muted">read by</span>{' '}
                    {asset.readBy.length ? asset.readBy.join(', ') : <i>nothing here</i>}
                </div>
            </div>

            <div className="catalog-section-title">
                Columns
                <button type="button" className="btn btn-small" onClick={onInspect}>
                    Read live schema
                </button>
            </div>
            {asset.columns.length ? (
                <div className="catalog-columns">{asset.columns.join(', ')}</div>
            ) : (
                <div className="catalog-columns catalog-muted">
                    No pipeline declares columns for this asset. That is not the same as it having
                    none - read the live schema to find out.
                </div>
            )}
            {live?.columns ? (
                <div className="catalog-columns">
                    <b>Live:</b> {live.columns.join(', ')}
                </div>
            ) : null}
            {live?.error ? <div className="modal-error">{live.error}</div> : null}

            <div className="catalog-section-title">Ownership and description</div>
            <div className="catalog-form">
                <label>
                    Owner
                    <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="Team" />
                </label>
                <label>
                    Description
                    <textarea
                        rows={2}
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        placeholder="What is this, for someone who does not already know?"
                    />
                </label>
                <label>
                    Tags
                    <input
                        value={tags}
                        onChange={e => setTags(e.target.value)}
                        placeholder="pii, gold, deprecated"
                    />
                </label>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => onAnnotate(annotationPatch(owner, description, tags))}
                >
                    Save to owners.json
                </button>
                <div className="catalog-muted">
                    Written as a rule for this exact name, above any wildcard that covers it - so
                    describing one file never re-describes its neighbours.
                </div>
            </div>
        </div>
    );
}
