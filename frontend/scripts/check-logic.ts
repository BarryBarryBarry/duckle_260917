// Behaviour checks for frontend logic that nothing else tests.
//
// The frontend has no unit-test runner. A bug hunt on 2026-09-17 found logic
// errors that reading the code did not show and only EXECUTING it did, so each
// check here calls the real module with a real input and fails the build if the
// answer is wrong. Run via scripts/check-logic.mjs, which bundles this file.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Node } from '@xyflow/react';
import type { DuckleNodeData } from '../src/pipeline-types';
import type { RepoItem } from '../src/repo-types';
import { livePreviewable } from '../src/live-preview';
import { discoverParams, resolveForRun } from '../src/run-resolve';

// The frontend directory, injected by check-logic.mjs: the bundle runs from a
// temp dir, so neither import.meta.url nor the cwd can be trusted to find it.
declare const __FRONTEND_DIR__: string;

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

// ---------------------------------------------------------------------------
// Live mode never runs up to a sink.
//
// A preview is a partial run to the target, so previewing a sink writes. The
// select and toggle triggers skipped sinks; the edit trigger did not, and typing
// into a sink's path wrote to the half-typed path.
// ---------------------------------------------------------------------------
{
    for (const sink of ['snk.parquet', 'snk.csv', 'snk.postgres', 'snk.rest']) {
        check(`live preview: ${sink} is never previewed`, !livePreviewable(sink), 'a preview would write');
    }
    for (const other of ['src.csv', 'xf.filter', 'code.sql', 'qa.expect']) {
        check(`live preview: ${other} is still previewed`, livePreviewable(other), 'the guard is too broad');
    }
    check(
        'live preview: a node with no component id is not refused as a sink',
        livePreviewable(undefined) && livePreviewable(''),
        'an unknown node must not be mistaken for a sink',
    );

    // The rule only helps if the place every trigger reaches applies it. App.tsx
    // has no harness to render, so this reads the preview entry point: it must
    // ask before it claims the run slot, or a trigger that skips its own check
    // (the edit one did) still writes.
    const app = readFileSync(resolve(__FRONTEND_DIR__, 'src/App.tsx'), 'utf8');
    const entry = app.indexOf('const triggerLivePreview = useCallback(');
    const claim = entry < 0 ? -1 : app.indexOf('isRunningRef.current = true;', entry);
    check(
        'live preview: the preview entry point is still where it was',
        entry >= 0 && claim > entry,
        'triggerLivePreview moved or changed shape; update this check to follow it',
    );
    check(
        'live preview: the preview entry point refuses a sink before starting a run',
        claim > entry && app.slice(entry, claim).includes('livePreviewable('),
        'triggerLivePreview starts a partial run without asking livePreviewable, so editing a sink writes',
    );
}

if (failures.length) {
    console.error(`\ncheck-logic: ${failures.length} check(s) failed:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log('check-logic: all checks passed');
