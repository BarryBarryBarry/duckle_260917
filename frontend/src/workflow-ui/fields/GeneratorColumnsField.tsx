import { X } from 'lucide-react';
import type { Field, GeneratorColumn, SelectOption } from './types';

// The Data Generator's table, one entry per column: what it is called, what fills it, the
// options that generator takes, and how often it is NULL. Stored as
// `columns: [{ name, generator, ...options, nullPercent }]`, which is what
// plan/generate.rs reads.

type Param = { key: string; hint: string };

// The hints are the engine's defaults, so a blank box means what it appears to mean.
const PARAMS: Record<string, Param[]> = {
    sequence: [{ key: 'start', hint: 'start 1' }, { key: 'step', hint: 'step 1' }],
    integer: [{ key: 'min', hint: 'min 0' }, { key: 'max', hint: 'max 100' }],
    decimal: [{ key: 'min', hint: 'min 0' }, { key: 'max', hint: 'max 1000' }, { key: 'scale', hint: 'places 2' }],
    boolean: [{ key: 'percent', hint: '% true 50' }],
    date: [{ key: 'min', hint: '2020-01-01' }, { key: 'max', hint: '2025-12-31' }],
    timestamp: [{ key: 'min', hint: '2020-01-01 00:00:00' }, { key: 'max', hint: '2025-12-31 23:59:59' }],
    pick: [{ key: 'values', hint: 'free, pro, team' }],
    pattern: [{ key: 'pattern', hint: 'AB-##-?? (# digit, ? letter, * either)' }],
    constant: [{ key: 'value', hint: 'the text' }],
};

// `Person: first name` is drawn as an entry under a Person heading.
function grouped(options: SelectOption[]): Array<[string, SelectOption[]]> {
    const groups = new Map<string, SelectOption[]>();
    for (const o of options) {
        const [group] = o.label.split(': ');
        groups.set(group, [...(groups.get(group) ?? []), o]);
    }
    return [...groups];
}

type Props = {
    field: Field;
    value: GeneratorColumn[] | undefined;
    onChange: (v: GeneratorColumn[]) => void;
};

export function GeneratorColumnsField({ field, value, onChange }: Props) {
    const columns = value ?? [];
    const groups = grouped(field.options ?? []);
    const put = (i: number, next: GeneratorColumn) => onChange(columns.map((c, n) => (n === i ? next : c)));
    const add = () =>
        onChange([...columns, { name: `column_${columns.length + 1}`, generator: 'sequence' }]);
    const remove = (i: number) => onChange(columns.filter((_, n) => n !== i));
    // Options belong to the generator they were typed for: a `min` of 18 is not a date.
    const pick = (i: number, generator: string) => {
        const { name, nullPercent } = columns[i];
        put(i, { name, generator, ...(nullPercent === undefined ? {} : { nullPercent }) });
    };

    return (
        <div className="field-aggregations">
            <div className="field-agg-toolbar">
                <span className="field-agg-count">
                    {columns.length} column{columns.length === 1 ? '' : 's'}
                </span>
                <button type="button" className="schema-add" onClick={add}>
                    + Add column
                </button>
            </div>
            {columns.length === 0 ? (
                <div className="field-agg-empty">
                    No columns yet. Click <b>+ Add column</b>, then choose what fills it.
                </div>
            ) : (
                <div className="field-agg-table">
                    {columns.map((c, i) => {
                        const params = PARAMS[c.generator] ?? [];
                        return (
                            <div className="field-gen-column" key={i}>
                                <div className="field-agg-row" style={{ gridTemplateColumns: '1fr 1.3fr 28px' }}>
                                    <input
                                        type="text"
                                        className="schema-input"
                                        value={c.name}
                                        onChange={e => put(i, { ...c, name: e.target.value })}
                                        aria-label="Column name"
                                        placeholder="column name"
                                        spellCheck={false}
                                    />
                                    <select
                                        className="schema-input"
                                        value={c.generator}
                                        onChange={e => pick(i, e.target.value)}
                                        aria-label={`What fills ${c.name}`}
                                    >
                                        {groups.map(([group, options]) => (
                                            <optgroup key={group} label={group}>
                                                {options.map(o => (
                                                    <option key={o.value} value={o.value}>
                                                        {o.label.slice(group.length + 2)}
                                                    </option>
                                                ))}
                                            </optgroup>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        className="schema-remove"
                                        onClick={() => remove(i)}
                                        aria-label={`Remove ${c.name}`}
                                    >
                                        <X size={13} />
                                    </button>
                                </div>
                                <div
                                    className="field-agg-row"
                                    style={{ gridTemplateColumns: `repeat(${params.length}, 1fr) 64px` }}
                                >
                                    {params.map(p => (
                                        <input
                                            key={p.key}
                                            type="text"
                                            className="schema-input"
                                            value={String(c[p.key] ?? '')}
                                            onChange={e => put(i, { ...c, [p.key]: e.target.value })}
                                            aria-label={`${c.name} ${p.key}`}
                                            placeholder={p.hint}
                                            title={p.hint}
                                            spellCheck={false}
                                        />
                                    ))}
                                    <input
                                        type="text"
                                        className="schema-input"
                                        value={String(c.nullPercent ?? '')}
                                        onChange={e => put(i, { ...c, nullPercent: e.target.value })}
                                        aria-label={`${c.name} percent NULL`}
                                        placeholder="% NULL"
                                        title="How often this column is NULL, from 0 to 100"
                                        spellCheck={false}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
