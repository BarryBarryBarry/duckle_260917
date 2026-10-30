import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, FlaskConical, Play, Plus, Trash2, XCircle } from 'lucide-react';
import type { Edge, Node } from '@xyflow/react';
import type { Column, DuckleNodeData } from '../pipeline-types';
import { resolveOutputSchema } from '../schema-resolve';
import { testsLoad, testsRun, testsSave } from '../tauri-bridge';
import {
    caseProblem,
    cleaned,
    dummyInput,
    listOf,
    newCase,
    newSuite,
    type CaseResult,
    type GivenInput,
    type TestCase,
    type TestSuite,
} from '../test-cases';
import { GeneratorColumnsField } from './fields/GeneratorColumnsField';
import { getManifest } from './fields/component-manifests';
import type { Field, GeneratorColumn } from './fields/types';

// Test cases for the open pipeline: what goes in, which node's output is checked, and what
// that output must be. A case stops at its node, so nothing downstream runs and no sink
// writes. Saved to tests/<pipeline>.test.json, the file `duckle test` runs in CI.

type Props = {
    workspacePath: string | null;
    pipelineId: string | null;
    nodes: Node<DuckleNodeData>[];
    /** The same nodes with their placeholders resolved, for reading a source's columns. */
    resolvedNodes: Node<DuckleNodeData>[];
    edges: Edge[];
    /** Saves the canvas, because a test runs the pipeline as it is on disk. */
    onSaveBeforeRun: () => Promise<void>;
    /** A node somebody asked to test from the canvas, once. */
    newForNode: string | null;
    onNewForNodeTaken: () => void;
};

const label = (n: Node<DuckleNodeData>) => n.data.label || n.id;

function ResultIcon({ result }: { result?: CaseResult }) {
    if (!result) return <CircleDashed size={14} className="run-row-idle" />;
    return result.status === 'pass'
        ? <CheckCircle2 size={14} className="run-row-ok" />
        : <XCircle size={14} className="run-row-err" />;
}

type InputKind = 'real' | 'text' | 'dummy';

function kindOf(given: GivenInput | undefined): InputKind {
    if (given === undefined) return 'real';
    return typeof given === 'string' ? 'text' : 'dummy';
}

/**
 * A source's columns when nothing has told the editor yet, read the way its Schema tab reads
 * them. A source that cannot be reached is exactly the one somebody wants dummy data for, so
 * failing here is ordinary and leaves the columns to be added by hand.
 */
async function detectColumns(source: Node<DuckleNodeData>): Promise<Column[]> {
    try {
        const manifest = getManifest(source.data.componentId ?? '');
        const found = await manifest?.autodetect?.(source.data.properties ?? {});
        return found?.columns ?? [];
    } catch {
        return [];
    }
}

function SourceInput({
    source,
    resolved,
    given,
    onChange,
    generatorField,
    columns,
}: {
    source: Node<DuckleNodeData>;
    resolved: Node<DuckleNodeData>;
    given: GivenInput | undefined;
    onChange: (next: GivenInput | undefined) => void;
    generatorField: Field | undefined;
    columns: Column[];
}) {
    const kind = kindOf(given);
    const pick = async (next: InputKind) => {
        if (next === 'real') onChange(undefined);
        else if (next === 'text') onChange('id,name\n1,example\n');
        else onChange(dummyInput(columns.length > 0 ? columns : await detectColumns(resolved)));
    };
    return (
        <div className="tests-input">
            <div className="tests-input-head">
                <span className="tests-input-name" title={source.id}>{label(source)}</span>
                <select
                    className="schema-input"
                    value={kind}
                    onChange={e => void pick(e.target.value as InputKind)}
                    aria-label={`What ${label(source)} reads in this test`}
                >
                    <option value="real">The real source</option>
                    <option value="text">Text I write here</option>
                    <option value="dummy">Generated dummy data</option>
                </select>
            </div>
            {typeof given === 'string' ? (
                <textarea
                    className="schema-input tests-text"
                    rows={4}
                    value={given}
                    onChange={e => onChange(e.target.value)}
                    aria-label={`Text ${label(source)} reads`}
                    spellCheck={false}
                />
            ) : null}
            {given !== undefined && typeof given !== 'string' && generatorField ? (
                <div className="tests-dummy">
                    <label className="tests-field">
                        <span>Rows</span>
                        <input
                            className="schema-input"
                            type="number"
                            min={0}
                            value={given.generate.rowCount}
                            onChange={e => onChange({ generate: { ...given.generate, rowCount: Number(e.target.value) } })}
                        />
                    </label>
                    <GeneratorColumnsField
                        field={generatorField}
                        value={given.generate.columns}
                        onChange={(next: GeneratorColumn[]) => onChange({ generate: { ...given.generate, columns: next } })}
                    />
                </div>
            ) : null}
        </div>
    );
}

export default function TestsView({
    workspacePath,
    pipelineId,
    nodes,
    resolvedNodes,
    edges,
    onSaveBeforeRun,
    newForNode,
    onNewForNodeTaken,
}: Props) {
    const [suite, setSuite] = useState<TestSuite | null>(null);
    const [open, setOpen] = useState(0);
    const [results, setResults] = useState<CaseResult[]>([]);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = useRef(false);

    const sources = useMemo(() => nodes.filter(n => n.data.componentId?.startsWith('src.')), [nodes]);
    const generatorField = useMemo(
        () => getManifest('src.generate')?.sections.flatMap(s => s.fields).find(f => f.key === 'columns'),
        [],
    );

    useEffect(() => {
        let gone = false;
        setSuite(null);
        setResults([]);
        setError(null);
        dirty.current = false;
        if (!workspacePath || !pipelineId) return;
        void testsLoad(workspacePath, pipelineId)
            .then(loaded => {
                if (!gone) setSuite(loaded ?? newSuite(pipelineId));
            })
            .catch(e => {
                if (!gone) setError(String(e));
            });
        return () => {
            gone = true;
        };
    }, [workspacePath, pipelineId]);

    // Written as it is edited, like the pipeline itself, so a test is never lost to a closed tab.
    useEffect(() => {
        if (!suite || !dirty.current || !workspacePath || !pipelineId) return;
        const timer = setTimeout(() => {
            dirty.current = false;
            void testsSave(workspacePath, pipelineId, { ...suite, cases: suite.cases.map(cleaned) }).catch(e =>
                setError(String(e)),
            );
        }, 400);
        return () => clearTimeout(timer);
    }, [suite, workspacePath, pipelineId]);

    const change = useCallback((next: TestSuite) => {
        dirty.current = true;
        setSuite(next);
    }, []);
    const setCase = (i: number, next: TestCase) => {
        if (suite) change({ ...suite, cases: suite.cases.map((c, n) => (n === i ? next : c)) });
    };
    const addFor = useCallback(
        (node: string) => {
            if (!suite) return;
            change({ ...suite, cases: [...suite.cases, newCase(node, suite.cases.map(c => c.name))] });
            setOpen(suite.cases.length);
        },
        [suite, change],
    );

    useEffect(() => {
        if (newForNode && suite) {
            addFor(newForNode);
            onNewForNodeTaken();
        }
    }, [newForNode, suite, addFor, onNewForNodeTaken]);

    const go = async (record: boolean, only?: string) => {
        if (!suite || !workspacePath || !pipelineId) return;
        setRunning(true);
        setError(null);
        try {
            await onSaveBeforeRun();
            const written = { ...suite, cases: suite.cases.map(cleaned) };
            await testsSave(workspacePath, pipelineId, written);
            dirty.current = false;
            const report = await testsRun(workspacePath, pipelineId, { record, caseName: only });
            if (report.suite) setSuite(report.suite);
            setResults(prev =>
                only ? [...prev.filter(r => r.test !== only), ...report.results] : report.results,
            );
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(false);
        }
    };

    if (!workspacePath || !pipelineId) {
        return <div className="tests-empty">Open a pipeline to write tests for it.</div>;
    }
    if (!suite) {
        return <div className="tests-empty">{error ?? 'Loading tests...'}</div>;
    }

    const failed = results.filter(r => r.status === 'fail').length;
    const passed = results.filter(r => r.status === 'pass').length;
    const blocked = suite.cases.map(caseProblem).find(Boolean) ?? null;
    const firstNode = sources.length > 0 ? nodes[nodes.length - 1]?.id : nodes[0]?.id;

    return (
        <div className="tests-view">
            <div className="tests-bar">
                <FlaskConical size={15} />
                <span className="tests-title">Tests</span>
                {results.length > 0 ? (
                    <span className={failed ? 'tests-count tests-count-bad' : 'tests-count'}>
                        {passed} passed{failed ? `, ${failed} failed` : ''}
                    </span>
                ) : null}
                <div className="tests-bar-actions">
                    <button
                        type="button"
                        className="schema-add"
                        onClick={() => firstNode && addFor(firstNode)}
                        disabled={!firstNode}
                    >
                        <Plus size={12} /> New test
                    </button>
                    <button
                        type="button"
                        className="schema-add"
                        onClick={() => void go(true)}
                        disabled={running || suite.cases.length === 0 || Boolean(blocked)}
                        title="Run every test and save what each node produced as its expected rows, for the tests that list rows"
                    >
                        Update expected rows
                    </button>
                    <button
                        type="button"
                        className="tests-run"
                        onClick={() => void go(false)}
                        disabled={running || suite.cases.length === 0 || Boolean(blocked)}
                        title={blocked ?? 'Save the pipeline and run every test'}
                    >
                        <Play size={12} /> {running ? 'Running...' : 'Run all'}
                    </button>
                </div>
            </div>
            {error ? <div className="tests-error">{error}</div> : null}
            {suite.cases.length === 0 ? (
                <div className="tests-empty">
                    <p>
                        A test runs this pipeline up to one node on inputs you choose, and checks what comes
                        out. Nothing after that node runs and no sink writes.
                    </p>
                    <p>
                        Click <b>New test</b>, or right-click a node on the canvas and choose <b>Create test</b>.
                    </p>
                </div>
            ) : null}
            <div className="tests-list">
                {suite.cases.map((c, i) => {
                    const result = results.find(r => r.test === c.name);
                    const expanded = open === i;
                    const put = (patch: Partial<TestCase['expect']>) =>
                        setCase(i, { ...c, expect: { ...c.expect, ...patch } });
                    const problem = caseProblem(c);
                    const recorded = Array.isArray(c.expect.rows) ? c.expect.rows.length : null;
                    return (
                        <div className={'tests-case' + (expanded ? ' tests-case-open' : '')} key={i}>
                            <div className="tests-case-head">
                                <button
                                    type="button"
                                    className="tests-case-toggle"
                                    onClick={() => setOpen(expanded ? -1 : i)}
                                    aria-expanded={expanded}
                                >
                                    <ResultIcon result={result} />
                                    <span>{c.name || 'Untitled test'}</span>
                                </button>
                                <button
                                    type="button"
                                    className="schema-add"
                                    onClick={() => void go(false, c.name)}
                                    disabled={running || Boolean(problem)}
                                    title={problem ?? 'Run this test'}
                                >
                                    <Play size={11} /> Run
                                </button>
                                <button
                                    type="button"
                                    className="schema-remove"
                                    onClick={() => {
                                        change({ ...suite, cases: suite.cases.filter((_, n) => n !== i) });
                                        setResults(results.filter(r => r.test !== c.name));
                                    }}
                                    aria-label={`Delete ${c.name}`}
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>
                            {result?.status === 'fail' ? <pre className="tests-why">{result.assertion}</pre> : null}
                            {expanded ? (
                                <div className="tests-case-body">
                                    {problem ? <div className="tests-problem">{problem}</div> : null}
                                    <label className="tests-field">
                                        <span>Name</span>
                                        <input
                                            className="schema-input"
                                            value={c.name}
                                            onChange={e => setCase(i, { ...c, name: e.target.value })}
                                        />
                                    </label>
                                    <label className="tests-field">
                                        <span>Check the output of</span>
                                        <select
                                            className="schema-input"
                                            value={c.expect.node}
                                            onChange={e => put({ node: e.target.value })}
                                        >
                                            {nodes.map(n => (
                                                <option key={n.id} value={n.id}>{label(n)}</option>
                                            ))}
                                        </select>
                                    </label>
                                    <div className="tests-section">Inputs</div>
                                    {sources.map(s => (
                                        <SourceInput
                                            key={s.id}
                                            source={s}
                                            resolved={resolvedNodes.find(n => n.id === s.id) ?? s}
                                            given={c.given?.[s.id]}
                                            generatorField={generatorField}
                                            columns={resolveOutputSchema(s.id, nodes, edges)}
                                            onChange={next => {
                                                const given = { ...(c.given ?? {}) };
                                                if (next === undefined) delete given[s.id];
                                                else given[s.id] = next;
                                                setCase(i, { ...c, given });
                                            }}
                                        />
                                    ))}
                                    <div className="tests-section">Expect</div>
                                    <label className="tests-field">
                                        <span>Exactly this many rows</span>
                                        <input
                                            className="schema-input"
                                            type="number"
                                            min={0}
                                            value={c.expect.rowCount ?? ''}
                                            onChange={e =>
                                                put({ rowCount: e.target.value === '' ? undefined : Number(e.target.value) })
                                            }
                                        />
                                    </label>
                                    <label className="tests-field">
                                        <span>No repeats in</span>
                                        <input
                                            className="schema-input"
                                            value={(c.expect.unique ?? []).join(', ')}
                                            onChange={e => put({ unique: listOf(e.target.value) })}
                                            placeholder="order_id"
                                            spellCheck={false}
                                        />
                                    </label>
                                    <label className="tests-field">
                                        <span>Never empty</span>
                                        <input
                                            className="schema-input"
                                            value={(c.expect.notNull ?? []).join(', ')}
                                            onChange={e => put({ notNull: listOf(e.target.value) })}
                                            placeholder="customer_id, amount"
                                            spellCheck={false}
                                        />
                                    </label>
                                    <label className="tests-field">
                                        <span>SQL check</span>
                                        <input
                                            className="schema-input"
                                            value={c.expect.sql ?? ''}
                                            onChange={e => put({ sql: e.target.value })}
                                            placeholder="SELECT max(amount) < 100 FROM {rows}"
                                            spellCheck={false}
                                        />
                                    </label>
                                    <label className="tests-check">
                                        <input
                                            type="checkbox"
                                            checked={recorded !== null}
                                            onChange={e => put({ rows: e.target.checked ? [] : undefined })}
                                        />
                                        <span>
                                            Compare every row
                                            {recorded !== null
                                                ? ` (${recorded} recorded; Update expected rows records what the node produces now)`
                                                : ''}
                                        </span>
                                    </label>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
