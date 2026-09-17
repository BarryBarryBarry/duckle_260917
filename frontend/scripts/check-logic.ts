// Behaviour checks for frontend logic that nothing else tests.
//
// The frontend has no unit-test runner. A bug hunt on 2026-09-17 found logic
// errors that reading the code did not show and only EXECUTING it did, so each
// check here calls the real module with a real input and fails the build if the
// answer is wrong. Run via scripts/check-logic.mjs, which bundles this file.

import type { Node } from '@xyflow/react';
import type { DuckleNodeData } from '../src/pipeline-types';
import type { RepoItem } from '../src/repo-types';
import { discoverParams, resolveForRun } from '../src/run-resolve';

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
    if (!ok) failures.push(`${name}\n      ${detail}`);
}

function node(id: string, componentId: string, properties: Record<string, unknown>): Node<DuckleNodeData> {
    return {
        id,
        position: { x: 0, y: 0 },
        data: { label: id, componentId, properties },
    } as unknown as Node<DuckleNodeData>;
}

function context(name: string, vars: Record<string, string>): RepoItem {
    return {
        id: name,
        name,
        type: 'context',
        payload: { variables: Object.entries(vars).map(([key, value]) => ({ key, value })) },
    } as unknown as RepoItem;
}

// ---------------------------------------------------------------------------
// A name a ctl.setvar node sets is filled in by the RUN, not by a static context.
//
// The README promises it and the engine enforces it on the headless path
// (context.rs skips plan::run_var_names). The desktop resolves placeholders here
// before the engine ever sees them, and did not skip them: a context entry of the
// same name replaced ${batch_date} with its static default, so the run variable
// was never read. With an empty default the run failed on a conversion error;
// with a real one it succeeded and wrote the WRONG rows.
// ---------------------------------------------------------------------------
{
    const nodes = [
        node('s', 'ctl.setvar', { name: 'batch_date', value: 'max(d)' }),
        node('q', 'code.sql', {
            sql: "SELECT * FROM input WHERE d = '${batch_date}' AND r = '${REGION}'",
        }),
    ];
    for (const staticDefault of ['', '2020-01-01']) {
        const out = resolveForRun(nodes, [context('dev', { batch_date: staticDefault, REGION: 'EU' })]);
        const sql = String(out[1].data.properties?.sql);
        check(
            `setvar: a static context default of ${JSON.stringify(staticDefault)} does not pre-empt the run variable`,
            sql.includes('${batch_date}'),
            `the placeholder was replaced before the run could fill it: ${sql}`,
        );
        check(
            `setvar: an ordinary context variable still resolves beside it (default ${JSON.stringify(staticDefault)})`,
            sql.includes("r = 'EU'"),
            `excluding the run variable broke an unrelated one: ${sql}`,
        );
    }

    const params = discoverParams(nodes, {});
    check(
        'setvar: the editor does not prompt for a name a node sets',
        !params.includes('batch_date'),
        `prompted for it, and a typed value would override the run's own: ${JSON.stringify(params)}`,
    );
    check(
        'setvar: an unset ordinary placeholder is still prompted for',
        params.includes('REGION'),
        `stopped prompting for REGION: ${JSON.stringify(params)}`,
    );

    const blank = [node('s', 'ctl.setvar', { name: '   ' }), node('q', 'code.sql', { sql: "SELECT '${X}'" })];
    const resolved = String(resolveForRun(blank, [context('dev', { X: 'x' })])[1].data.properties?.sql);
    check(
        'setvar: a node with a blank name excludes nothing',
        resolved === "SELECT 'x'",
        `a blank name must not stop ordinary resolution: ${resolved}`,
    );
}

if (failures.length) {
    console.error(`\ncheck-logic: ${failures.length} check(s) failed:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log('check-logic: all checks passed');
