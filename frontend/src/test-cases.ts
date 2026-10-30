// The Tests tab's model: a pipeline's `tests/<id>.test.json`, the same file `duckle test` runs,
// so a case written in the editor and a case run in CI cannot mean different things.

import type { Column } from './pipeline-types';
import type { GeneratorColumn } from './workflow-ui/fields/types';

export type GenerateInput = {
    generate: { rowCount: number; seed?: string; columns: GeneratorColumn[] };
};

/** What stands in for a source: fixture text, a fixture file, or generated rows. */
export type GivenInput = string | GenerateInput;

export type Expectation = {
    node: string;
    rows?: unknown[];
    rowCount?: number;
    unique?: string[];
    notNull?: string[];
    sql?: string;
    orderBy?: string[];
    unordered?: boolean;
    [other: string]: unknown;
};

export type TestCase = {
    name: string;
    given?: Record<string, GivenInput>;
    expect: Expectation;
};

export type TestSuite = {
    pipeline: string;
    cases: TestCase[];
};

export type CaseResult = { test: string; node: string; status: 'pass' | 'fail'; assertion?: string | null };

/** A suite for a pipeline nothing has tested yet. The path is relative to the test file. */
export function newSuite(pipelineId: string): TestSuite {
    return { pipeline: `../pipelines/${pipelineId}.json`, cases: [] };
}

/** A case that passes for the right reason as soon as it has run: it asks for rows to exist. */
export function newCase(node: string, taken: string[]): TestCase {
    let n = taken.length + 1;
    while (taken.includes(`Test ${n}`)) n += 1;
    return { name: `Test ${n}`, expect: { node, sql: 'SELECT count(*) > 0 FROM {rows}' } };
}

/** The case as written to disk: empty assertions dropped, so the file reads like a person wrote it. */
export function cleaned(c: TestCase): TestCase {
    const expect = { ...c.expect };
    for (const key of ['unique', 'notNull'] as const) {
        if (!expect[key]?.length) delete expect[key];
    }
    if (!expect.sql?.trim()) delete expect.sql;
    if (expect.rowCount === undefined || Number.isNaN(expect.rowCount)) delete expect.rowCount;
    const { given, ...rest } = c;
    return given && Object.keys(given).length > 0 ? { ...rest, given, expect } : { ...rest, expect };
}

/**
 * Why a case cannot be saved as it stands, or null. `duckle test` refuses a case that asserts
 * nothing, and saying so here beats a failure the first time it runs.
 */
export function caseProblem(c: TestCase): string | null {
    const e = c.expect;
    if (!c.name.trim()) return 'Give this test a name.';
    if (!e.node) return 'Choose the node whose output this test checks.';
    const noColumns = Object.values(c.given ?? {}).some(
        g => typeof g !== 'string' && g.generate.columns.length === 0,
    );
    if (noColumns) {
        return 'Add columns to the dummy data. Running the source once, or detecting its schema, fills them in.';
    }
    const asserts =
        e.rows !== undefined ||
        e.rowCount !== undefined ||
        Boolean(e.unique?.length) ||
        Boolean(e.notNull?.length) ||
        Boolean(e.sql?.trim());
    return asserts ? null : 'Say what to check: a row count, a column, a SQL check or recorded rows.';
}

const BY_NAME: Array<[RegExp, string]> = [
    [/^(first|fname|given)(name)?$|^firstname$/, 'person.firstName'],
    [/^(last|lname|sur|family)(name)?$|^lastname$/, 'person.lastName'],
    [/name$/, 'person.fullName'],
    [/e?mail/, 'internet.email'],
    [/^(user|login)/, 'internet.username'],
    [/phone|mobile|cell|^tel/, 'phone.number'],
    [/street|^address/, 'address.street'],
    [/city|town/, 'address.city'],
    [/^state|province|region/, 'address.state'],
    [/zip|postcode|postal/, 'address.zip'],
    [/countrycode/, 'address.countryCode'],
    [/country/, 'address.country'],
    [/^(lat|latitude)$/, 'address.latitude'],
    [/^(lon|lng|long|longitude)$/, 'address.longitude'],
    [/company|employer|organi[sz]ation/, 'company.name'],
    [/job|title|role/, 'job.title'],
    [/^ip|ipaddress/, 'internet.ipv4'],
    [/currency/, 'finance.currencyCode'],
];

/** What a column most likely holds, from its name and then its type. */
export function guessGenerator(column: Column): GeneratorColumn {
    const key = column.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const text = column.type === 'string' || column.type === undefined;
    const isId = key === 'id' || key.endsWith('id');
    if (isId) return { name: column.name, generator: text ? 'uuid' : 'sequence' };
    if (text) {
        const hit = BY_NAME.find(([pattern]) => pattern.test(key));
        return { name: column.name, generator: hit ? hit[1] : 'text.word' };
    }
    const byType: Partial<Record<Column['type'], string>> = {
        int32: 'integer',
        int64: 'integer',
        float32: 'decimal',
        float64: 'decimal',
        decimal: 'decimal',
        bool: 'boolean',
        date: 'date',
        timestamp: 'timestamp',
    };
    return { name: column.name, generator: byType[column.type] ?? 'text.word' };
}

/** Generated rows shaped like a source, so a case can run without the source. */
export function dummyInput(columns: Column[], rowCount = 100): GenerateInput {
    return { generate: { rowCount, columns: columns.map(guessGenerator) } };
}

/** A comma-separated list as a column list, and back. */
export function listOf(text: string): string[] {
    return text.split(',').map(s => s.trim()).filter(Boolean);
}
