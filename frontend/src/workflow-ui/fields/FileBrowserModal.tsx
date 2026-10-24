import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUp, Clock, File as FileIcon, Folder, HardDrive, X } from 'lucide-react';
import type { FileFilter } from '../../tauri-dialog';
import { isWebBackend, webFs } from '../../web-fs';

type Props = {
    open: boolean;
    mode: 'open' | 'save';
    title: string;
    initialPath?: string;
    filters?: FileFilter[];
    onConfirm: (path: string) => void;
    onCancel: () => void;
};

type Entry = { name: string; isFile: boolean; isDirectory: boolean };

const RECENT_KEY = 'duckle:recent-paths';
const MAX_RECENT = 8;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const join = (dir: string, name: string) => (norm(dir) ? norm(dir) + '/' + name : name);

function getRecentPaths(): string[] {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
    } catch {
        return [];
    }
}

function pushRecentPath(path: string) {
    if (!path) return;
    try {
        const list = getRecentPaths().filter(p => p !== path);
        list.unshift(path);
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch {
        /* ignore */
    }
}

export default function FileBrowserModal({
    open,
    mode,
    title,
    initialPath,
    filters,
    onConfirm,
    onCancel,
}: Props) {
    const { t } = useTranslation();
    const [path, setPath] = useState(initialPath ?? '');
    const [recent] = useState<string[]>(() => getRecentPaths());
    const inputRef = useRef<HTMLInputElement>(null);

    // Server-side directory browser (web edition), confined to the workspace.
    const web = isWebBackend();
    const [wsRoot, setWsRoot] = useState('');
    const [cwd, setCwd] = useState('');
    const [entries, setEntries] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // On open: find the workspace root, then start in the folder of the current
    // value if it lives inside the workspace, else at the root.
    useEffect(() => {
        if (!open) return;
        setPath(initialPath ?? '');
        if (!web) {
            setTimeout(() => inputRef.current?.focus(), 30);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const b = await invoke<{ workspace: string }>('web_bootstrap');
                if (cancelled) return;
                const root = norm(b.workspace);
                setWsRoot(root);
                let start = root;
                if (initialPath) {
                    const ip = norm(initialPath)
                        .replace(/\$\{workspace\}/g, root)
                        .replace(/\$\{projectroot\}/g, root);
                    const cut = ip.lastIndexOf('/');
                    const dir = cut > 0 ? ip.slice(0, cut) : root;
                    if (dir.toLowerCase().startsWith(root.toLowerCase())) start = dir;
                }
                setCwd(start);
            } catch (e) {
                setError(String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, initialPath, web]);

    // List the current directory whenever it changes.
    useEffect(() => {
        if (!open || !web || !cwd) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        webFs
            .readDir(cwd)
            .then(es => {
                if (!cancelled) {
                    setEntries(es as Entry[]);
                    setLoading(false);
                }
            })
            .catch(e => {
                if (!cancelled) {
                    setError(String(e));
                    setEntries([]);
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, web, cwd]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            } else if (e.key === 'Enter' && path.trim()) {
                e.preventDefault();
                handleConfirm();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, path]);

    const exts = useMemo(
        () => (filters ?? []).flatMap(f => f.extensions).filter(e => e && e !== '*'),
        [filters],
    );

    const visible = useMemo(() => {
        const showFile = (name: string) =>
            mode === 'save' || exts.length === 0 || exts.some(e => name.toLowerCase().endsWith('.' + e.toLowerCase()));
        return [...entries]
            .filter(en => en.isDirectory || showFile(en.name))
            .sort((a, b) =>
                a.isDirectory === b.isDirectory
                    ? a.name.localeCompare(b.name)
                    : a.isDirectory
                      ? -1
                      : 1,
            );
    }, [entries, exts, mode]);

    if (!open) return null;

    const atRoot = !cwd || norm(cwd).toLowerCase() === norm(wsRoot).toLowerCase();
    const relCwd = wsRoot && cwd ? cwd.slice(wsRoot.length).replace(/^\//, '') : '';

    // Resolve ${workspace} to the absolute root for comparisons; emit picked
    // paths back as ${workspace}-relative so pipelines stay portable.
    const r = norm(wsRoot);
    const resolveWs = (p: string) =>
        r ? norm(p).replace(/\$\{workspace\}/g, r).replace(/\$\{projectroot\}/g, r) : norm(p);
    const toWsPath = (abs: string) => {
        const a = norm(abs);
        return r && a.toLowerCase().startsWith(r.toLowerCase()) ? '${workspace}' + a.slice(r.length) : a;
    };

    const goUp = () => {
        if (atRoot) return;
        const i = norm(cwd).lastIndexOf('/');
        setCwd(i > 0 ? cwd.slice(0, i) : wsRoot);
    };

    const enterDir = (name: string) => setCwd(join(cwd, name));

    const pickFile = (name: string) => {
        // Open: select the file. Save: adopt its name in the current folder.
        setPath(toWsPath(join(cwd, name)));
    };

    const onFileActivate = (name: string) => {
        const full = toWsPath(join(cwd, name));
        setPath(full);
        if (mode === 'open') {
            pushRecentPath(full);
            onConfirm(full);
        }
    };

    const handleConfirm = () => {
        const trimmed = path.trim();
        if (!trimmed) return;
        pushRecentPath(trimmed);
        onConfirm(trimmed);
    };

    const ctaLabel = mode === 'save' ? 'Save' : 'Choose';

    return createPortal(
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            onClick={e => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="modal modal-file">
                <div className="modal-header">
                    <div className="modal-title">{title}</div>
                    <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    {web ? (
                        <div className="modal-field">
                            <div className="fb-bar">
                                <button
                                    type="button"
                                    className="fb-up"
                                    onClick={goUp}
                                    disabled={atRoot}
                                    title={t('fileBrowser.upOneFolder')}
                                >
                                    <ArrowUp size={14} />
                                </button>
                                <span className="fb-crumb">
                                    <HardDrive size={13} aria-hidden="true" />
                                    <span className="fb-crumb-path">
                                        {'workspace' + (relCwd ? ' / ' + relCwd.replace(/\//g, ' / ') : '')}
                                    </span>
                                </span>
                            </div>
                            <div className="fb-list">
                                {loading ? (
                                    <div className="fb-empty">Loading…</div>
                                ) : error ? (
                                    <div className="fb-empty fb-error">{error}</div>
                                ) : visible.length === 0 ? (
                                    <div className="fb-empty">Empty folder</div>
                                ) : (
                                    visible.map(en => (
                                        <button
                                            key={en.name}
                                            type="button"
                                            className={
                                                'fb-row' +
                                                (!en.isDirectory && resolveWs(path) === join(cwd, en.name)
                                                    ? ' is-active'
                                                    : '')
                                            }
                                            onClick={() =>
                                                en.isDirectory ? enterDir(en.name) : pickFile(en.name)
                                            }
                                            onDoubleClick={() =>
                                                en.isDirectory ? enterDir(en.name) : onFileActivate(en.name)
                                            }
                                        >
                                            {en.isDirectory ? (
                                                <Folder size={14} className="fb-ico fb-ico-dir" />
                                            ) : (
                                                <FileIcon size={14} className="fb-ico" />
                                            )}
                                            <span className="fb-name">{en.name}</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    ) : null}

                    <div className="modal-field">
                        <label className="modal-field-label">
                            {mode === 'save' ? 'Output path' : 'File path'}
                        </label>
                        <input
                            ref={inputRef}
                            type="text"
                            className="modal-input modal-input-path"
                            value={path}
                            placeholder={
                                mode === 'save'
                                    ? 'e.g. ${workspace}/out/orders_paid.parquet'
                                    : 'e.g. ${workspace}/data/orders.csv'
                            }
                            onChange={e => setPath(e.target.value)}
                            spellCheck={false}
                        />
                    </div>

                    {recent.length > 0 ? (
                        <div className="modal-field">
                            <label className="modal-field-label">Recent</label>
                            <div className="modal-recent">
                                {recent.map(p => (
                                    <button
                                        key={p}
                                        type="button"
                                        className={'modal-recent-item' + (p === path ? ' is-active' : '')}
                                        onClick={() => setPath(p)}
                                        title={p}
                                    >
                                        <Clock size={13} aria-hidden="true" />
                                        <span className="modal-recent-path">{p}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    {filters && filters.length > 0 ? (
                        <div className="modal-hint">
                            Accepted:{' '}
                            {filters
                                .map(f => f.extensions.map(e => (e === '*' ? '*' : '.' + e)).join(', '))
                                .join('; ')}
                        </div>
                    ) : null}
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleConfirm}
                        disabled={!path.trim()}
                    >
                        {ctaLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
