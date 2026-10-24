// Bundle + run scripts/check-component-i18n.ts under plain Node, the same way
// the other check-* scripts read palette-data.ts.
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'check-component-i18n.ts');
const bundle = resolve(tmpdir(), `duckle-check-component-i18n-${process.pid}.mjs`);

process.env.DUCKLE_COMPONENT_LOCALES = resolve(here, '../src/i18n/locales/components');

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    logLevel: 'warning',
});

try {
    await import('file://' + bundle.replace(/\\/g, '/'));
} finally {
    rmSync(bundle, { force: true });
}
