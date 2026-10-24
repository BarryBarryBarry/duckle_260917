import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { RepoItem } from '../repo-types';
import { pipelineFromSql, type FromSql } from '../tauri-bridge';

export type PipelineTemplate = 'empty' | 'sample-csv-to-parquet' | 'sample-join-groupby' | 'from-sql';

type Props = {
    open: boolean;
    defaultParentId: string;
    repoItems: RepoItem[];
    onCancel: () => void;
    /** `seed` is the finished graph when the template built one (From SQL). */
    onCreate: (name: string, parentId: string, template: PipelineTemplate, seed?: FromSql['pipeline']) => void;
};

/** `key` names the label and description under newPipeline.templates. */
const TEMPLATES: { id: PipelineTemplate; key: string; available: boolean }[] = [
    { id: 'empty', key: 'empty', available: true },
    { id: 'sample-csv-to-parquet', key: 'sampleCsv', available: true },
    { id: 'sample-join-groupby', key: 'sampleJoin', available: true },
    { id: 'from-sql', key: 'fromSql', available: true },
];

function buildPath(item: RepoItem, allItems: RepoItem[]): string {
    const chain: string[] = [];
    let current: RepoItem | undefined = item;
    while (current) {
        chain.unshift(current.name);
        current = current.parentId ? allItems.find(i => i.id === current!.parentId) : undefined;
    }
    return chain.join(' / ');
}

function sanitizeName(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

export default function NewPipelineModal(props: Props) {
    const { open, defaultParentId, repoItems, onCancel, onCreate } = props;
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [parentId, setParentId] = useState(defaultParentId);
    const [template, setTemplate] = useState<PipelineTemplate>('empty');
    const [sql, setSql] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const nameRef = useRef<HTMLInputElement>(null);

    const folderOptions = useMemo(
        () =>
            repoItems
                .filter(i => i.type === 'project' || i.type === 'folder')
                .map(f => ({ id: f.id, label: buildPath(f, repoItems) })),
        [repoItems],
    );

    useEffect(() => {
        if (open) {
            setName('');
            setTemplate('empty');
            setSql('');
            setError('');
            setBusy(false);
            setParentId(defaultParentId);
            setTimeout(() => nameRef.current?.focus(), 30);
        }
    }, [open, defaultParentId]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onCancel]);

    if (!open) return null;

    const sanitized = sanitizeName(name);
    const fromSql = template === 'from-sql';
    const canCreate = sanitized.length > 0 && !busy && (!fromSql || sql.trim().length > 0);

    const handleCreate = async () => {
        if (!canCreate) return;
        if (!fromSql) {
            onCreate(sanitized, parentId, template);
            return;
        }
        // Converted here, so a query that will not parse is said in the dialog
        // and can be fixed, rather than opening a pipeline that is empty.
        setBusy(true);
        setError('');
        try {
            const built = await pipelineFromSql(sql);
            if (!built) {
                setError(t('newPipeline.needsDesktop'));
                return;
            }
            onCreate(sanitized, parentId, template, built.pipeline);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    return createPortal(
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            onClick={e => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="modal modal-new-pipeline">
                <div className="modal-header">
                    <div className="modal-title">{t('newPipeline.title')}</div>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onCancel}
                        aria-label={t('common.close')}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="modal-field">
                        <label className="modal-field-label">{t('newPipeline.name')}</label>
                        <input
                            ref={nameRef}
                            type="text"
                            className="modal-input"
                            value={name}
                            placeholder={t('newPipeline.namePlaceholder')}
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && canCreate) {
                                    e.preventDefault();
                                    handleCreate();
                                }
                            }}
                            spellCheck={false}
                        />
                        {name && name !== sanitized ? (
                            <div className="modal-field-hint">
                                {t('newPipeline.savedAs')} <code>{sanitized}</code>
                            </div>
                        ) : null}
                    </div>

                    <div className="modal-field">
                        <label className="modal-field-label">{t('newPipeline.folder')}</label>
                        <select
                            className="modal-input modal-select"
                            value={parentId}
                            onChange={e => setParentId(e.target.value)}
                        >
                            {folderOptions.map(f => (
                                <option key={f.id} value={f.id}>
                                    {f.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="modal-field">
                        <label className="modal-field-label">{t('newPipeline.template')}</label>
                        <div className="template-grid">
                            {TEMPLATES.map(tpl => (
                                <button
                                    key={tpl.id}
                                    type="button"
                                    className={
                                        'template-card' +
                                        (template === tpl.id ? ' is-active' : '') +
                                        (!tpl.available ? ' is-disabled' : '')
                                    }
                                    onClick={() => {
                                        if (tpl.available) setTemplate(tpl.id);
                                    }}
                                    disabled={!tpl.available}
                                >
                                    <div className="template-card-title">{t(`newPipeline.templates.${tpl.key}.label`)}</div>
                                    <div className="template-card-desc">{t(`newPipeline.templates.${tpl.key}.desc`)}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                    {fromSql ? (
                        <div className="modal-field">
                            <label className="modal-field-label">{t('newPipeline.sqlLabel')}</label>
                            <textarea
                                className="modal-input"
                                rows={8}
                                value={sql}
                                placeholder={'WITH paid AS (SELECT * FROM orders WHERE status = \'paid\')\nSELECT customer_id, sum(amount) FROM paid GROUP BY customer_id'}
                                onChange={e => setSql(e.target.value)}
                                spellCheck={false}
                            />
                            <div className="modal-field-hint">{t('newPipeline.sqlHint')}</div>
                            {error ? <div className="modal-field-hint field-warning">{error}</div> : null}
                        </div>
                    ) : null}
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        {t('common.cancel')}
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleCreate}
                        disabled={!canCreate}
                    >
                        {busy ? t('newPipeline.converting') : t('common.create')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
