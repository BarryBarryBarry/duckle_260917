import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { FieldContext } from './FieldContext';
import { CAST_TYPES, type Cast } from './types';

// #160: multi-column Cast / Convert editor. Every upstream column is listed
// with a checkbox + its current (source) type shown inline, so bulk type
// conversions no longer mean adding one row at a time and hopping to the Schema
// tab to see the source types. Only checked columns are emitted, keeping the
// same stored shape `casts: [{ column, targetType, format?, onError? }]` that
// build_cast reads.

type Props = {
    value: Cast[] | undefined;
    onChange: (v: Cast[]) => void;
};

const isDateLike = (t: string) => t === 'date' || t === 'timestamp';

// #144: per-column error handling. "" inherits the node-level default; the
// engine reads each entry's onError and falls back to the node setting.
const ON_ERROR_OPTIONS: Array<{ label: string; value: string }> = [
    { label: 'Default', value: '' },
    { label: 'Set NULL', value: 'null' },
    { label: 'Fail run', value: 'fail' },
];

// Default target when a column is first checked: keep its current type if that
// type is one we can cast to, else fall back to string. A same-type cast is a
// harmless no-op, so the user just changes it to the type they actually want.
const CAST_TYPE_VALUES = new Set(CAST_TYPES.map(t => t.value));
const defaultTargetFor = (sourceType: string) =>
    CAST_TYPE_VALUES.has(sourceType) ? sourceType : 'string';

// Grid: checkbox, column, source type, target type, format, on-error.
const CAST_GRID = { gridTemplateColumns: '18px 1.2fr 0.7fr 1fr 1fr 0.9fr' };

export function CastsField({ value, onChange }: Props) {
    const { t } = useTranslation();
    const { upstreamSchema } = useContext(FieldContext);
    const casts = value ?? [];
    const byCol = new Map(casts.map(c => [c.column, c]));
    const upstreamNames = new Set(upstreamSchema.map(c => c.name));
    // Casts whose column is no longer in the upstream (the source changed).
    // Show them flagged so the user can uncheck them, rather than leaving a
    // stale conversion in the config that keeps failing the run invisibly.
    const stale = casts.filter(c => !upstreamNames.has(c.column));

    const setCast = (col: string, next: Cast | null) => {
        const others = casts.filter(c => c.column !== col);
        onChange(next ? [...others, next] : others);
    };
    const toggle = (name: string, sourceType: string) => {
        if (byCol.has(name)) setCast(name, null);
        else setCast(name, { column: name, targetType: defaultTargetFor(sourceType) });
    };
    const update = (col: string, patch: Partial<Cast>) => {
        const cur = byCol.get(col);
        if (cur) setCast(col, { ...cur, ...patch });
    };

    if (upstreamSchema.length === 0 && stale.length === 0) {
        return (
            <div className="field-input field-warning">
                No upstream schema. Connect an input to populate this list.
            </div>
        );
    }

    const renderRow = (
        name: string,
        sourceType: string,
        cast: Cast | undefined,
        staleRow: boolean,
    ) => {
        const enabled = Boolean(cast);
        return (
            <div className={`field-agg-row${staleRow ? ' field-rename-stale' : ''}`} key={name} style={CAST_GRID}>
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => (staleRow ? setCast(name, null) : toggle(name, sourceType))}
                    aria-label={`Convert ${name}`}
                />
                <span className="field-cast-name field-rename-old" title={name}>{name}</span>
                <span className="field-cast-source" title={sourceType}>{sourceType}</span>
                <select
                    className="schema-input"
                    value={cast?.targetType ?? defaultTargetFor(sourceType)}
                    disabled={!enabled}
                    onChange={e => update(name, { targetType: e.target.value })}
                >
                    {CAST_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                </select>
                <input
                    type="text"
                    className="schema-input"
                    value={cast?.format ?? ''}
                    onChange={e => update(name, { format: e.target.value })}
                    disabled={!enabled || !isDateLike(cast?.targetType ?? '')}
                    placeholder={enabled && isDateLike(cast?.targetType ?? '') ? '%d/%m/%Y' : ''}
                    title={t('fields.castFormatTooltip')}
                    spellCheck={false}
                />
                <select
                    className="schema-input"
                    value={cast?.onError ?? ''}
                    disabled={!enabled}
                    onChange={e => update(name, { onError: e.target.value || undefined })}
                    title={t('fields.castOnErrorTooltip')}
                >
                    {ON_ERROR_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
            </div>
        );
    };

    // Count only upstream columns that are converting; stale casts are surfaced
    // separately below, so folding them into "N" would read as "7 of 5".
    const activeCount = upstreamSchema.filter(c => byCol.has(c.name)).length;

    return (
        <div className="field-aggregations">
            <div className="field-agg-toolbar">
                <span className="field-agg-count">
                    {activeCount} of {upstreamSchema.length} column{upstreamSchema.length === 1 ? '' : 's'} converting
                </span>
            </div>
            <div className="field-agg-table">
                <div className="field-agg-row field-agg-header" style={CAST_GRID}>
                    <div />
                    <div>Column</div>
                    <div>Source</div>
                    <div>Target type</div>
                    <div>Format</div>
                    <div>On error</div>
                </div>
                {upstreamSchema.map(c => renderRow(c.name, c.type, byCol.get(c.name), false))}
                {stale.map(c => renderRow(c.column, 'not in input', c, true))}
            </div>
        </div>
    );
}
