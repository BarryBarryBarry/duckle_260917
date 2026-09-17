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
import { conditionToSql, type FilterOp } from '../src/workflow-ui/fields/FilterBuilderField';
import { scheduleForSave } from '../src/schedule-save';
import type { Schedule } from '../src/tauri-bridge';

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

// ---------------------------------------------------------------------------
// The filter builder's "contains", "starts with" and "ends with" are literal.
//
// They compiled to LIKE with the typed value spliced into the pattern, so a %
// or _ in it was a wildcard: "contains 50%" also kept "50 units", and "starts
// with a_b" kept "axb". The generated SQL runs in DuckDB (plan/builders.rs
// build_filter). The oracle below is SQL LIKE itself - % any run, _ one
// character, the ESCAPE character makes the next one literal, anything else
// literal, whole string - checked once against DuckDB 1.5.4, so each generated
// pattern must keep exactly the rows plain string matching keeps.
// ---------------------------------------------------------------------------
{
    const likeMatches = (sql: string, text: string): boolean | string => {
        const m = /^"c" (?:NOT )?LIKE '((?:[^']|'')*)'(?: ESCAPE '((?:[^']|'')*)')?$/.exec(sql);
        if (!m) return `not a LIKE this oracle understands: ${sql}`;
        const pattern = m[1].replace(/''/g, "'");
        const escape = m[2]?.replace(/''/g, "'");
        let re = '';
        for (let i = 0; i < pattern.length; i++) {
            const ch = pattern[i];
            if (escape !== undefined && ch === escape && i + 1 < pattern.length) {
                re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            } else if (ch === '%') re += '[\\s\\S]*';
            else if (ch === '_') re += '[\\s\\S]';
            else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp('^' + re + '$').test(text);
    };
    const literal: Record<string, (text: string, v: string) => boolean> = {
        contains: (t, v) => t.includes(v),
        starts_with: (t, v) => t.startsWith(v),
        ends_with: (t, v) => t.endsWith(v),
    };
    const values = ['50%', 'a_b', 'back\\slash', "it's", '100%_\\', 'plain'];
    const texts = [
        '50%', '50 units', '150%', 'a_b', 'axb', 'a_bc', 'xa_b', 'back\\slash', 'backslash', "it's",
        'its', '100%_\\', '100xy\\', '100%_\\ tail', 'plain', 'plainer', 'a plain', '',
    ];
    for (const op of Object.keys(literal) as FilterOp[]) {
        for (const v of values) {
            const sql = conditionToSql({ id: 'x', column: 'c', op, value: v }, 'string');
            for (const t of texts) {
                const got = likeMatches(sql, t);
                const want = literal[op](t, v);
                check(
                    `filter builder: ${op} ${JSON.stringify(v)} on ${JSON.stringify(t)}`,
                    got === want,
                    typeof got === 'string' ? got : `kept=${got}, a literal ${op} keeps=${want}; SQL: ${sql}`,
                );
            }
        }
    }
    // "matches" is the one op whose value IS a pattern; it must stay one.
    check(
        'filter builder: "matches" still treats % as a wildcard',
        likeMatches(conditionToSql({ id: 'x', column: 'c', op: 'like', value: '50%' }, 'string'), '50 units') === true,
        'the escaping leaked into the pattern operator',
    );
}

// ---------------------------------------------------------------------------
// Saving in the desktop Schedules dialog keeps what the dialog does not show.
//
// A schedule's timezone, exclusion calendar, misfire policy and catch-up bounds
// are set through the server API. The dialog has no control for them and built
// a fresh record from its own fields, and the desktop upsert replaces the whole
// record, so renaming a schedule put a Brussels 03:00 job back on the machine's
// clock and switched its maintenance calendar off.
// ---------------------------------------------------------------------------
{
    const loaded: Schedule = {
        id: 's1',
        pipeline_id: 'p1',
        name: 'Nightly',
        enabled: true,
        kind: { type: 'cron', expr: '0 0 3 * * *' },
        timezone: 'Europe/Brussels',
        exclude: { weekdays: ['sunday'], dates: ['2026-12-25'] },
        misfire: 'latest',
        catchup: { maxCatchupRuns: 5, maxCatchupAgeDays: 7 },
    };
    const saved = scheduleForSave(loaded, {
        id: 's1',
        pipelineId: 'p1',
        name: '  Nightly load  ',
        enabled: false,
        kind: { type: 'cron', expr: '0 30 3 * * *' },
    });
    const kept = (k: keyof Schedule) => JSON.stringify(saved[k]) === JSON.stringify(loaded[k]);
    for (const k of ['timezone', 'exclude', 'misfire', 'catchup'] as const) {
        check(
            `schedule save: ${k} survives an edit in the dialog`,
            kept(k),
            `sent ${JSON.stringify(saved[k])}, the store had ${JSON.stringify(loaded[k])}`,
        );
    }
    check(
        'schedule save: the fields the dialog edits are the edited values',
        saved.name === 'Nightly load' &&
            saved.enabled === false &&
            saved.kind.type === 'cron' &&
            saved.kind.expr === '0 30 3 * * *',
        `got ${JSON.stringify(saved)}`,
    );
    const fresh = scheduleForSave(undefined, {
        id: '',
        pipelineId: 'p1',
        name: ' ',
        enabled: true,
        kind: { type: 'interval', seconds: 60 },
    });
    check(
        'schedule save: a new schedule carries no settings it was never given',
        fresh.timezone === undefined && fresh.exclude === undefined && fresh.name === 'Schedule',
        `got ${JSON.stringify(fresh)}`,
    );
}

if (failures.length) {
    console.error(`\ncheck-logic: ${failures.length} check(s) failed:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log('check-logic: all checks passed');
