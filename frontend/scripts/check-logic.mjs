// Bundle + run scripts/check-logic.ts under plain Node.
//
// Same arrangement as check-secret-fields.mjs: the modules under test are
// TypeScript, and anything that reaches for a live Tauri window is stubbed.
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'check-logic.ts');
const bundle = resolve(tmpdir(), `duckle-check-logic-${process.pid}.mjs`);

const stubTauri = {
    name: 'stub-tauri',
    setup(build) {
        build.onResolve({ filter: /(^|\/)tauri-bridge$/ }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onResolve({ filter: /(^|\/)tauri-dialog$/ }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: 'stub', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents:
                'export const invoke = async () => null;' +
                'export class Channel {}' +
                'export const isTauri = () => false;' +
                'export default {};',
            loader: 'js',
        }));
    },
};

await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    define: { __FRONTEND_DIR__: JSON.stringify(resolve(here, '..')) },
    plugins: [stubTauri],
    logLevel: 'warning',
});

try {
    await import('file://' + bundle.replace(/\\/g, '/'));
} finally {
    rmSync(bundle, { force: true });
}
