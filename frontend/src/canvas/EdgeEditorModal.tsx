import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Edge } from '@xyflow/react';
import { connectionLabel, metaFor, type ConnectionType } from './connection-types';

type Props = {
    edge: Edge;
    onSave: (patch: { label?: string; condition?: string }) => void;
    onCancel: () => void;
};

export default function EdgeEditorModal({ edge, onSave, onCancel }: Props) {
    const { t } = useTranslation();
    const type = ((edge.data as { connectionType?: ConnectionType } | undefined)?.connectionType ??
        'main') as ConnectionType;
    const meta = metaFor(type);
    const showCondition = Boolean(meta.expressionRequired);
    const data = edge.data as { label?: string; condition?: string } | undefined;
    const [label, setLabel] = useState(data?.label ?? '');
    const [condition, setCondition] = useState(data?.condition ?? '');
    const ref = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setTimeout(() => ref.current?.focus(), 30);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const handleSave = () => {
        onSave({
            label: label.trim() || undefined,
            condition: showCondition ? condition.trim() || undefined : undefined,
        });
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
            <div className="modal modal-edge-editor">
                <div className="modal-header">
                    <div className="modal-title">
                        {t('edgeEditor.titleBefore')}{' '}
                        <span
                            className="edge-label-badge"
                            style={{ display: 'inline-block', marginLeft: 6 }}
                        >
                            {meta.badge ?? connectionLabel(t, meta)}
                        </span>{' '}
                        {t('edgeEditor.titleAfter')}
                    </div>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onCancel}
                        aria-label={t('edgeEditor.close')}
                    >
                        <X size={16} />
                    </button>
                </div>
                <div className="modal-body">
                    <div className="modal-field">
                        <label className="modal-field-label">{t('edgeEditor.label')}</label>
                        <input
                            ref={ref}
                            type="text"
                            className="modal-input"
                            value={label}
                            placeholder={t('edgeEditor.labelPlaceholder')}
                            onChange={e => setLabel(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && !showCondition) {
                                    e.preventDefault();
                                    handleSave();
                                }
                            }}
                            spellCheck={false}
                        />
                    </div>
                    {showCondition ? (
                        <div className="modal-field">
                            <label className="modal-field-label">
                                {t('edgeEditor.condition')}
                            </label>
                            <textarea
                                className="modal-input modal-input-path"
                                value={condition}
                                placeholder="row.amount > 100 AND row.currency = 'USD'"
                                onChange={e => setCondition(e.target.value)}
                                rows={3}
                                spellCheck={false}
                            />
                            <div className="modal-field-hint">
                                {t('edgeEditor.conditionHint')}
                            </div>
                        </div>
                    ) : null}
                    <div className="modal-tip" style={{ marginTop: 8 }}>
                        <span style={{ flexShrink: 0 }}>{connectionLabel(t, meta)}</span>
                    </div>
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        {t('edgeEditor.cancel')}
                    </button>
                    <button type="button" className="btn btn-primary" onClick={handleSave}>
                        {t('edgeEditor.save')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
