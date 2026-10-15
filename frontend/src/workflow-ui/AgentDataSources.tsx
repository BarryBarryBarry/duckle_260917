// The Agent composer's data sources: a menu of the databases the component
// palette offers, the connection form of that database's own node (its
// Connection section, nothing else), and the role a picked connection plays
// for the agent - read from, written to, or both.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ArrowUpFromLine, Check, Database, Plug, Repeat, Save, X } from 'lucide-react';
import ComponentIcon from './ComponentIcon';
import FieldRenderer from './fields/FieldRenderer';
import { FieldContext } from './fields/FieldContext';
import { getManifest } from './fields/component-manifests';
import { connectionKindFor } from './fields/manifest-synth';
import { oracleConnectOf, parseOracleConnect } from './fields/oracle-connect';
import type { Field } from './fields/types';
import { PALETTE, type ComponentDef } from './palette-data';
import { testConnection, type ConnectionTestResult } from '../tauri-bridge';
import type { RepoItem } from '../repo-types';

export type SourceRole = 'source' | 'target' | 'both';
/** A saved connection the user picked for the agent, and what it is for. */
export type PickedSource = { id: string; role: SourceRole };

export const ROLE_LABEL: Record<SourceRole, string> = { source: '源', target: '目标', both: '源 + 目标' };

/** The databases of the palette's Sources → Databases group whose connection
 *  this menu can configure; the others are left out rather than shown disabled. */
export function databaseSources(): ComponentDef[] {
    const group = PALETTE.flatMap(c => c.groups).find(g => g.id === 'src.databases');
    return (group?.components ?? []).filter(c => c.availability === 'available' && connectionKindOf(c) !== null);
}

/** Saved-connection kinds whose fields the run time merges onto a node end to
 *  end. */
const SUPPORTED_KINDS = new Set(['mysql', 'mariadb', 'postgres', 'sqlserver', 'oracle']);

/** The saved-connection kind a database component uses, or null when this
 *  menu cannot configure it yet. */
export function connectionKindOf(def: ComponentDef): string | null {
    const kind = connectionKindFor(def.id);
    return kind && SUPPORTED_KINDS.has(kind) ? kind : null;
}

export function connectionsOfKind(connections: RepoItem[], kind: string): RepoItem[] {
    return connections.filter(c => (c.payload as { kind?: string } | undefined)?.kind === kind);
}

// A node field whose saved-connection field has another name.
const FIELD_TO_PAYLOAD: Record<string, string> = { user: 'username' };
const payloadKey = (fieldKey: string) => FIELD_TO_PAYLOAD[fieldKey] ?? fieldKey;

/** The database node's own Connection section, without its saved-connection
 *  picker: the form a connection of this kind is made in. */
function connectionFields(componentId: string): Field[] {
    const section = getManifest(componentId)?.sections[0];
    return (section?.fields ?? []).filter(f => f.key !== 'connectionRef');
}

function valuesFromPayload(fields: Field[], payload: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
        // Oracle's Easy Connect string is stored split into host / port / database.
        const v = f.key === 'connect' ? oracleConnectOf(payload) : payload?.[payloadKey(f.key)];
        if (v !== undefined && v !== null && v !== '') out[f.key] = v;
        else if (f.defaultValue !== undefined) out[f.key] = f.defaultValue;
    }
    return out;
}

function payloadFromValues(kind: string, fields: Field[], values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { kind };
    for (const f of fields) {
        const v = values[f.key];
        if (v === undefined || v === null || v === '') continue;
        if (f.key === 'connect') {
            // Split, so the Connections editor shows the same connection; a
            // string that does not split (a descriptor, an alias) is kept whole.
            Object.assign(out, parseOracleConnect(String(v)) ?? { connect: String(v).trim() });
            continue;
        }
        out[payloadKey(f.key)] = v;
    }
    return out;
}

function connectionLabel(c: RepoItem): string {
    const p = (c.payload ?? {}) as { host?: string; database?: string; connect?: string };
    const target = [p.host, p.database].filter(Boolean).join('/') || p.connect;
    return target ? `${c.name} (${target})` : c.name;
}

// ---- the menu ---------------------------------------------------------------------------

export function DataSourceMenu({
    anchor,
    connections,
    picked,
    onPick,
    onClose,
}: {
    anchor: HTMLElement | null;
    connections: RepoItem[];
    picked: PickedSource[];
    onPick: (def: ComponentDef) => void;
    onClose: () => void;
}) {
    const defs = useMemo(databaseSources, []);
    const pickedKinds = useMemo(() => {
        const kinds = new Set<string>();
        for (const p of picked) {
            const kind = (connections.find(c => c.id === p.id)?.payload as { kind?: string } | undefined)?.kind;
            if (kind) kinds.add(kind);
        }
        return kinds;
    }, [picked, connections]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    // Fixed and portaled, so the panel's own clipping (it may be docked and
    // short) cannot cut it off. Opens upward when there is room.
    const r = anchor?.getBoundingClientRect();
    const MAX_H = 340;
    const style: React.CSSProperties = r
        ? r.top > MAX_H + 16
            ? { left: r.left, bottom: window.innerHeight - r.top + 6 }
            : { left: r.left, top: r.bottom + 6 }
        : { left: 16, bottom: 16 };

    return createPortal(
        <>
            <div className="agent-ds-backdrop" onClick={onClose} />
            <div className="agent-ds-menu" role="menu" aria-label="选择数据源" style={{ ...style, maxHeight: MAX_H }}>
                <div className="agent-ds-menu-head">数据源</div>
                {defs.map(def => {
                    const kind = connectionKindOf(def);
                    const count = kind ? connectionsOfKind(connections, kind).length : 0;
                    return (
                        <button
                            key={def.id}
                            type="button"
                            role="menuitem"
                            className="agent-ds-item"
                            onClick={() => onPick(def)}
                        >
                            <ComponentIcon componentId={def.id} kind="source" size={15} className="agent-ds-item-icon" />
                            <span className="agent-ds-item-text">
                                <span className="agent-ds-item-name">{def.label}</span>
                                <span className="agent-ds-item-sub">
                                    {count > 0 ? `已配置 ${count} 个连接` : '未配置，点击新建'}
                                </span>
                            </span>
                            {kind && pickedKinds.has(kind) ? <Check size={14} className="agent-ds-item-check" /> : null}
                        </button>
                    );
                })}
            </div>
        </>,
        document.body,
    );
}

// ---- the connection dialog ------------------------------------------------------------

const NEW = '__new__';

export function ConnectionDialog({
    def,
    connections,
    workspacePath,
    onSave,
    onUse,
    onClose,
}: {
    def: ComponentDef;
    /** Saved connections of this database's kind. */
    connections: RepoItem[];
    workspacePath: string | null;
    /** Save (id null = new); resolves to the connection's id. */
    onSave: (id: string | null, name: string, payload: Record<string, unknown>) => Promise<string>;
    onUse: (id: string) => void;
    onClose: () => void;
}) {
    const kind = connectionKindOf(def) ?? '';
    const fields = useMemo(() => connectionFields(def.id), [def.id]);
    const [selected, setSelected] = useState<string>(connections[0]?.id ?? NEW);
    const current = connections.find(c => c.id === selected) ?? null;
    const [name, setName] = useState('');
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [dirty, setDirty] = useState(false);
    const [test, setTest] = useState<ConnectionTestResult | null>(null);
    const [testing, setTesting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);

    // Switching connections loads that one; "new" starts from the defaults.
    useEffect(() => {
        const payload = current?.payload as Record<string, unknown> | undefined;
        setValues(valuesFromPayload(fields, payload));
        setName(current?.name ?? '');
        setDirty(false);
        setTest(null);
        setError(null);
        if (!current) nameRef.current?.focus();
    }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    const set = (key: string, v: unknown) => {
        setValues(prev => ({ ...prev, [key]: v }));
        setDirty(true);
        setTest(null);
    };
    const payload = payloadFromValues(kind, fields, values);
    const missing = fields.filter(f => f.required && (values[f.key] === undefined || values[f.key] === ''));
    const defaultName = `${def.label}${payload.database ? ' · ' + String(payload.database) : ''}`;
    const needsSave = !current || dirty || (name.trim() !== '' && name.trim() !== current.name);
    const canSubmit = missing.length === 0 && !saving;

    const handleTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            setTest(await testConnection(payload));
        } finally {
            setTesting(false);
        }
    };

    const handleSubmit = async () => {
        setError(null);
        if (!needsSave && current) {
            onUse(current.id);
            return;
        }
        setSaving(true);
        try {
            const id = await onSave(current?.id ?? null, name.trim() || defaultName, payload);
            onUse(id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSaving(false);
        }
    };

    return createPortal(
        <div className="modal-backdrop agent-ds-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal modal-editor agent-ds-dialog" role="dialog" aria-label={`${def.label} 连接`}>
                <div className="modal-header">
                    <div className="modal-title-row">
                        <ComponentIcon componentId={def.id} kind="source" size={16} className="modal-title-icon" />
                        <div>
                            <div className="modal-title">{def.label} 连接</div>
                            <div className="modal-subtitle">
                                {connections.length > 0 ? `已保存 ${connections.length} 个连接` : '还没有这种数据库的连接，填写后保存'}
                            </div>
                        </div>
                    </div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    {connections.length > 0 ? (
                        <div className="modal-field">
                            <label className="modal-field-label">连接</label>
                            <select className="modal-input" value={selected} onChange={e => setSelected(e.target.value)}>
                                {connections.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {connectionLabel(c)}
                                    </option>
                                ))}
                                <option value={NEW}>+ 新建连接</option>
                            </select>
                        </div>
                    ) : null}
                    <div className="modal-field">
                        <label className="modal-field-label">连接名称</label>
                        <input
                            ref={nameRef}
                            type="text"
                            className="modal-input"
                            value={name}
                            placeholder={defaultName}
                            onChange={e => setName(e.target.value)}
                            spellCheck={false}
                        />
                    </div>
                    <FieldContext.Provider value={{ upstreamSchema: [], nodeSchema: [], repoItems: [], workspacePath, nodeProps: values }}>
                        <div className="agent-ds-fields">
                            {fields.map(f => (
                                <FieldRenderer key={f.key} field={f} value={values[f.key]} onChange={v => set(f.key, v)} />
                            ))}
                        </div>
                    </FieldContext.Provider>
                </div>

                {test ? (
                    <div className={`conn-test ${test.ok ? 'conn-test-ok' : 'conn-test-fail'}`} role="status">
                        <div className="conn-test-message">{test.message}</div>
                    </div>
                ) : null}
                {error ? (
                    <div className="conn-test conn-test-fail" role="alert">
                        <div className="conn-test-message">{error}</div>
                    </div>
                ) : null}

                <div className="modal-footer">
                    <button
                        type="button"
                        className="btn btn-secondary conn-test-button"
                        onClick={() => void handleTest()}
                        disabled={testing || missing.length > 0}
                        title="用这些设置连接数据库，确认能连上"
                    >
                        <Plug size={13} />
                        {testing ? '测试中…' : '测试连接'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={onClose}>
                        取消
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleSubmit()}
                        disabled={!canSubmit}
                        title={missing.length ? `请填写：${missing.map(f => f.label).join('、')}` : undefined}
                    >
                        {needsSave ? <Save size={13} /> : <Check size={13} />}
                        {saving ? '保存中…' : needsSave ? '保存并使用' : '使用此连接'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

// ---- the role and "no data source" dialogs -------------------------------------------

function SmallDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onClose]);
    return createPortal(
        <div className="modal-backdrop agent-ds-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="modal agent-ds-small" role="dialog" aria-label={title}>
                <div className="modal-header">
                    <div className="modal-title">{title}</div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
                        <X size={16} />
                    </button>
                </div>
                {children}
            </div>
        </div>,
        document.body,
    );
}

const ROLE_CHOICES: { role: SourceRole; title: string; hint: string; icon: React.ReactNode }[] = [
    { role: 'source', title: '源数据库', hint: 'Agent 从这里读取数据', icon: <ArrowDownToLine size={16} /> },
    { role: 'target', title: '目标数据库', hint: 'Agent 把结果写到这里', icon: <ArrowUpFromLine size={16} /> },
    { role: 'both', title: '二者都是', hint: '既从这里读取，也写回这里', icon: <Repeat size={16} /> },
];

export function RoleDialog({
    connectionName,
    current,
    onConfirm,
    onClose,
}: {
    connectionName: string;
    current?: SourceRole;
    onConfirm: (role: SourceRole) => void;
    onClose: () => void;
}) {
    return (
        <SmallDialog title="这个连接用作？" onClose={onClose}>
            <div className="modal-body">
                <p className="agent-ds-small-text">
                    <Database size={13} /> {connectionName}
                </p>
                <div className="agent-ds-roles">
                    {ROLE_CHOICES.map(c => (
                        <button
                            key={c.role}
                            type="button"
                            className={`agent-ds-role${current === c.role ? ' agent-ds-role-current' : ''}`}
                            onClick={() => onConfirm(c.role)}
                        >
                            <span className="agent-ds-role-icon">{c.icon}</span>
                            <span className="agent-ds-role-title">{c.title}</span>
                            <span className="agent-ds-role-hint">{c.hint}</span>
                        </button>
                    ))}
                </div>
            </div>
        </SmallDialog>
    );
}

export function NoSourceDialog({
    onChoose,
    onSkip,
    onClose,
}: {
    onChoose: () => void;
    onSkip: () => void;
    onClose: () => void;
}) {
    return (
        <SmallDialog title="还没有选择数据源" onClose={onClose}>
            <div className="modal-body">
                <p className="agent-ds-small-text">
                    告诉 Agent 从哪个数据库读取、写入哪个数据库，它生成的 pipeline 会更准确。连接信息会随这条消息一起发给它，密码不会发送。
                </p>
            </div>
            <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={onSkip}>
                    不需要，直接发送
                </button>
                <button type="button" className="btn btn-primary" onClick={onChoose}>
                    <Database size={13} /> 选择数据源
                </button>
            </div>
        </SmallDialog>
    );
}

// ---- the toolbar button and chips -------------------------------------------------------

export function PickedChips({
    picked,
    connections,
    onEdit,
    onRemove,
}: {
    picked: PickedSource[];
    connections: RepoItem[];
    onEdit: (id: string) => void;
    onRemove: (id: string) => void;
}) {
    return (
        <>
            {picked.map(p => {
                const c = connections.find(x => x.id === p.id);
                if (!c) return null;
                return (
                    <span key={p.id} className={`agent-ds-chip agent-ds-chip-${p.role}`} title={`${ROLE_LABEL[p.role]}：${connectionLabel(c)}`}>
                        <button type="button" className="agent-ds-chip-main" onClick={() => onEdit(p.id)} aria-label={`修改 ${c.name} 的用途`}>
                            <span className="agent-ds-chip-role">{ROLE_LABEL[p.role]}</span>
                            <span className="agent-ds-chip-name">{c.name}</span>
                        </button>
                        <button type="button" className="agent-ds-chip-x" onClick={() => onRemove(p.id)} aria-label={`移除 ${c.name}`}>
                            <X size={11} />
                        </button>
                    </span>
                );
            })}
        </>
    );
}
