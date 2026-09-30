import { useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, X } from 'lucide-react';
import type { ParamSpec } from '../run-resolve';

type Props = {
    /** Placeholders no context resolves and the pipeline does not declare (#127). */
    paramNames: string[];
    /** The pipeline's declared parameters (#317), each asked for by its type. */
    declared?: Record<string, ParamSpec>;
    /** A value a context already gives a declared parameter. */
    prefill?: Record<string, string>;
    pipelineName: string;
    onSubmit: (values: { undeclared: Record<string, string>; declared: Record<string, string> }) => void;
    onCancel: () => void;
};

// Issue #127: when a pipeline references ${name} placeholders that no context
// or builtin resolves, prompt for their values right before the run. Blank
// fields are omitted so the engine/context fallback still applies. This is the
// editor counterpart of the web-dashboard run-parameters form, and runs on both
// the desktop app and the self-hosted web editor (one shared handler).
//
// #317: a parameter the pipeline DECLARES gets a control for its type, and its
// value goes to the engine, which checks it against the declaration and fills
// the default when the field is left blank.
export default function RunParametersModal({
    paramNames,
    declared = {},
    prefill = {},
    pipelineName,
    onSubmit,
    onCancel,
}: Props) {
    const declaredNames = Object.keys(declared);
    const [values, setValues] = useState<Record<string, string>>(() => ({ ...prefill }));
    const set = (name: string, value: string) => setValues(v => ({ ...v, [name]: value }));

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onCancel();
    };

    const submit = () => {
        const undeclared: Record<string, string> = {};
        for (const name of paramNames) {
            const v = (values[name] ?? '').trim();
            if (v) undeclared[name] = v;
        }
        const typed: Record<string, string> = {};
        for (const name of declaredNames) {
            const v = (values[name] ?? '').trim();
            if (!v) continue;
            typed[name] = fromParamInput(declared[name], v);
        }
        onSubmit({ undeclared, declared: typed });
    };

    return createPortal(
        <div className="modal-backdrop" onClick={handleBackdrop}>
            <div className="modal">
                <div className="modal-header">
                    <div className="modal-title-row">
                        <SlidersHorizontal size={16} className="modal-title-icon" />
                        <div>
                            <div className="modal-title">Run parameters</div>
                            <div className="modal-subtitle">
                                Pipeline: <b>{pipelineName}</b>
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="modal-close"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    <form
                        onSubmit={e => {
                            e.preventDefault();
                            submit();
                        }}
                        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                    >
                        {declaredNames.length > 0 && (
                            <p style={{ margin: '0 0 2px', fontSize: '1rem', opacity: 0.8 }}>
                                This pipeline takes these parameters. A blank field uses its default.
                            </p>
                        )}
                        {declaredNames.map((name, i) => (
                            <label key={name} className="run-param">
                                <span className="run-param-name">
                                    {name}
                                    {declared[name].required ? <span className="run-param-required"> *</span> : null}
                                </span>
                                <ParamControl
                                    spec={declared[name]}
                                    value={values[name] ?? ''}
                                    onChange={v => set(name, v)}
                                    autoFocus={i === 0}
                                />
                                {declared[name].description ? (
                                    <span className="run-param-hint">{declared[name].description}</span>
                                ) : null}
                            </label>
                        ))}
                        {paramNames.length > 0 && (
                            <p style={{ margin: '4px 0 2px', fontSize: '1rem', opacity: 0.8 }}>
                                This pipeline references variables that no context provides. Set a value for
                                this run, or leave a field blank to keep the placeholder unresolved.
                            </p>
                        )}
                        {paramNames.map((name, i) => (
                            <label key={name} className="run-param">
                                <span className="run-param-name">{name}</span>
                                <input
                                    className="modal-input"
                                    value={values[name] ?? ''}
                                    onChange={ev => set(name, ev.target.value)}
                                    placeholder={'${' + name + '}'}
                                    spellCheck={false}
                                    autoFocus={declaredNames.length === 0 && i === 0}
                                />
                            </label>
                        ))}
                        {/* Enter submits the form. */}
                        <button type="submit" hidden />
                    </form>
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="btn btn-primary" onClick={submit}>
                        Run
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * A control's text as the engine takes it. A datetime-local control has no
 * offset; the engine wants RFC3339, so it is read in local time and sent as UTC.
 */
export function fromParamInput(spec: ParamSpec, input: string): string {
    return spec.type === 'datetime' && input ? new Date(input).toISOString() : input;
}

/** A stored value as its control shows it: an RFC3339 datetime in local time. */
export function toParamInput(spec: ParamSpec, stored: string): string {
    if (spec.type !== 'datetime' || !stored) return stored;
    const d = new Date(stored);
    if (Number.isNaN(d.getTime())) return stored;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One declared parameter's control, chosen by its type; the engine validates. */
export function ParamControl({
    spec,
    value,
    onChange,
    autoFocus,
}: {
    spec: ParamSpec;
    value: string;
    onChange: (v: string) => void;
    autoFocus: boolean;
}) {
    const blank = spec.default !== undefined ? `Default (${spec.default})` : spec.required ? 'Choose...' : 'None';
    if (spec.enum && spec.enum.length > 0) {
        return (
            <select className="modal-input" value={value} onChange={e => onChange(e.target.value)} autoFocus={autoFocus}>
                <option value="">{blank}</option>
                {spec.enum.map(v => (
                    <option key={v} value={v}>
                        {v}
                    </option>
                ))}
            </select>
        );
    }
    if (spec.type === 'boolean') {
        return (
            <select className="modal-input" value={value} onChange={e => onChange(e.target.value)} autoFocus={autoFocus}>
                <option value="">{blank}</option>
                <option value="true">true</option>
                <option value="false">false</option>
            </select>
        );
    }
    const inputType =
        spec.type === 'date'
            ? 'date'
            : spec.type === 'datetime'
              ? 'datetime-local'
              : spec.type === 'integer' || spec.type === 'number'
                ? 'number'
                : spec.type === 'secret'
                  ? 'password'
                  : 'text';
    return (
        <input
            className="modal-input"
            type={inputType}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={spec.default ?? ''}
            min={spec.minimum}
            max={spec.maximum}
            step={spec.type === 'integer' ? 1 : spec.type === 'number' ? 'any' : undefined}
            autoComplete={spec.type === 'secret' ? 'off' : undefined}
            spellCheck={false}
            autoFocus={autoFocus}
        />
    );
}
