// Captures the screenshots used by the bundled user guide (src/guide/images).
//
//   npm run capture-guide
//
// It builds the web frontend, seeds a throwaway workspace with the starter
// samples, starts `duckle-runner web` on it (so runs, autodetect and preview
// are real), drives the UI in headless Chrome, and writes one WebP per step.
// Nothing touches a real workspace. Re-run it whenever the UI changes.
//
// Environment:
//   CHROME_PATH         Chrome / Chromium executable (default: the usual install path)
//   RUNNER              duckle-runner binary (default: newest under target/)
//   DUCKLE_DUCKDB_BIN   DuckDB CLI (default: PATH, then the desktop app's engine)
//   GUIDE_URL           use an already running web editor instead of starting one
//   SKIP_BUILD=1        reuse frontend/dist-web as it is
//   PORT                port for the runner it starts (default 8799)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(FRONTEND, '..');
const OUT = join(FRONTEND, 'src/guide/images');
const EXE = process.platform === 'win32' ? '.exe' : '';
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const QUALITY = 80;
const MARK = '#e5484d';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => {
    console.error(`capture-guide: ${msg}`);
    process.exit(1);
};

function chromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const candidates = {
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
        win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
        linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    }[process.platform] ?? [];
    return candidates.find(existsSync) ?? fail('no Chrome found; set CHROME_PATH');
}

function onPath(name) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function duckdbPath() {
    if (process.env.DUCKLE_DUCKDB_BIN) return process.env.DUCKLE_DUCKDB_BIN;
    const appData = {
        darwin: join(homedir(), 'Library/Application Support/io.duckle.app'),
        win32: join(process.env.APPDATA ?? homedir(), 'io.duckle.app'),
        linux: join(homedir(), '.local/share/io.duckle.app'),
    }[process.platform];
    const candidates = [
        onPath('duckdb'),
        appData && join(appData, `engines/duckdb/duckdb${EXE}`),
        join(ROOT, `.web-server/bin/duckdb${EXE}`),
    ];
    return candidates.find(p => p && existsSync(p)) ?? fail('no DuckDB CLI found; set DUCKLE_DUCKDB_BIN');
}

function runnerPath() {
    if (process.env.RUNNER) return process.env.RUNNER;
    const target = join(ROOT, 'target');
    const built = existsSync(target)
        ? readdirSync(target)
              .map(profile => join(target, profile, `duckle-runner${EXE}`))
              .filter(existsSync)
              .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        : [];
    return built[0] ?? fail('no duckle-runner build found; run `cargo build -p duckle-runner` or set RUNNER');
}

/** The starter samples, as scripts/seed-starter-workspace.sh lays them out.
 *  A short fixed path, since it shows in the Properties panel and in errors. */
function seedWorkspace() {
    const ws = join(process.platform === 'win32' ? tmpdir() : '/tmp', 'otter-guide-workspace');
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws);
    for (const d of ['data', 'output', 'pipelines', 'logs']) mkdirSync(join(ws, d));
    for (const f of ['orders.csv', 'regions.csv']) cpSync(join(ROOT, 'samples', f), join(ws, 'data', f));
    cpSync(join(ROOT, 'examples/starter-workspace/pipelines'), join(ws, 'pipelines'), { recursive: true });
    return ws;
}

async function waitForHttp(url, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {
            /* not up yet */
        }
        await sleep(300);
    }
    fail(`${url} did not answer within ${timeoutMs / 1000}s`);
}

async function startServer() {
    if (process.env.GUIDE_URL) return { url: process.env.GUIDE_URL, stop: () => {} };
    if (process.env.SKIP_BUILD !== '1') {
        console.log('==> Building the web frontend');
        const r = spawnSync('npm', ['run', 'build'], {
            cwd: FRONTEND,
            env: { ...process.env, DUCKLE_WEB: '1' },
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        if (r.status !== 0) fail('web frontend build failed');
    }
    const ws = seedWorkspace();
    const port = process.env.PORT ?? '8799';
    const url = `http://127.0.0.1:${port}/`;
    console.log(`==> Starting duckle-runner web on ${url} (workspace ${ws})`);
    const child = spawn(
        runnerPath(),
        ['web', '--host', '127.0.0.1', '--port', port, '--dist', join(FRONTEND, 'dist-web'), '--workspace', ws, '--duckdb', duckdbPath()],
        { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('exit', code => {
        if (code) console.error(`duckle-runner exited with ${code}`);
    });
    await waitForHttp(url);
    return {
        url,
        stop: () => {
            child.kill();
            rmSync(ws, { recursive: true, force: true });
        },
    };
}

// ---- Page helpers ----------------------------------------------------------

/** Outlines the given boxes in red. A box with a `label` gets a number badge,
 *  centred on its top edge, or its bottom edge with `at: 'bottom'`, so the
 *  badge sits on the frame rather than over what it frames. */
async function mark(page, boxes) {
    await page.evaluate(
        (boxes, color) => {
            document.getElementById('guide-marks')?.remove();
            const layer = document.createElement('div');
            layer.id = 'guide-marks';
            layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
            for (const b of boxes) {
                const box = document.createElement('div');
                box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;border:2.5px solid ${color};border-radius:8px;box-sizing:border-box`;
                layer.appendChild(box);
                if (b.label) {
                    const size = 22;
                    const edge = b.at === 'bottom' ? b.y + b.height : b.y;
                    const left = b.x + b.width / 2 - size / 2;
                    const top = Math.min(innerHeight - size - 2, Math.max(2, edge - size / 2));
                    const badge = document.createElement('div');
                    badge.textContent = b.label;
                    badge.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${size}px;height:${size}px;border-radius:50%;background:${color};color:#fff;font:700 13px/${size}px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35)`;
                    layer.appendChild(badge);
                }
            }
            document.body.appendChild(layer);
        },
        boxes,
        MARK,
    );
}

async function unmark(page) {
    await page.evaluate(() => document.getElementById('guide-marks')?.remove());
}

/** Bounding box of an element handle, grown by `pad`, with an optional badge. */
async function boxOf(el, { pad = 4, label, at } = {}) {
    const b = await el.boundingBox();
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, label, at };
}

/** boxOf for the `index`th match of a selector. */
async function box(page, selector, { index = 0, ...opts } = {}) {
    const el = (await page.$$(selector))[index];
    if (!el) throw new Error(`no element for ${selector}`);
    return boxOf(el, opts);
}

/** The part of a panel its text actually fills: a panel's own box runs to
 *  its full height however little is in it. */
async function filledBox(page, selector, pad = 12) {
    const r = await page.$eval(selector, el => {
        const outer = el.getBoundingClientRect();
        let bottom = outer.top;
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent.trim()) continue;
            range.selectNodeContents(n);
            bottom = Math.max(bottom, range.getBoundingClientRect().bottom);
        }
        return { x: outer.left, y: outer.top, width: outer.width, height: Math.min(outer.height, bottom - outer.top) };
    });
    return { x: r.x + 2, y: r.y + 2, width: r.width - 4, height: r.height + pad };
}

function union(boxes, pad = 0) {
    const x1 = Math.min(...boxes.map(b => b.x)) - pad;
    const y1 = Math.min(...boxes.map(b => b.y)) - pad;
    const x2 = Math.max(...boxes.map(b => b.x + b.width)) + pad;
    const y2 = Math.max(...boxes.map(b => b.y + b.height)) + pad;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

async function shot(page, name, clip) {
    const opts = { path: join(OUT, `${name}.webp`), type: 'webp', quality: QUALITY };
    if (clip) {
        const x = Math.max(0, Math.floor(clip.x));
        const y = Math.max(0, Math.floor(clip.y));
        opts.clip = {
            x,
            y,
            width: Math.min(VIEWPORT.width - x, Math.ceil(clip.width)),
            height: Math.min(VIEWPORT.height - y, Math.ceil(clip.height)),
        };
    }
    await page.screenshot(opts);
    await unmark(page);
    console.log(`    ${name}.webp`);
}

async function clickText(page, selector, text) {
    const ok = await page.evaluate(
        (selector, text) => {
            const el = [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text);
            el?.click();
            return !!el;
        },
        selector,
        text,
    );
    if (!ok) throw new Error(`no ${selector} reading "${text}"`);
}

async function replaceText(page, selector, text) {
    await page.click(selector, { count: 3 });
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('a');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('Backspace');
    if (text) await page.keyboard.type(text);
}

const node = n => `.react-flow__node:nth-child(${n})`;

/** Shows a bottom panel tab. Clicking the tab already shown collapses the
 *  panel, so only click one that is not. */
async function bottomTab(page, label) {
    await page.evaluate(label => {
        const tab = [...document.querySelectorAll('.bottom-panel-tabs [role=tab]')].find(t => t.textContent.trim().startsWith(label));
        if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    }, label);
    await page.waitForSelector('.bottom-panel-content');
    await sleep(300);
}

async function fitCanvas(page) {
    await page.click('.react-flow__controls-fitview');
    await sleep(500);
}

/** Hides the canvas's zoom controls and minimap, for close-ups of nodes. */
async function hideCanvasChrome(page, hidden) {
    await page.evaluate(hidden => {
        document.getElementById('guide-hide-chrome')?.remove();
        if (!hidden) return;
        const style = document.createElement('style');
        style.id = 'guide-hide-chrome';
        style.textContent = '.react-flow__controls,.react-flow__minimap{visibility:hidden}';
        document.head.appendChild(style);
    }, hidden);
}

async function selectNode(page, n, tab) {
    await page.waitForSelector(node(n), { timeout: 30000 });
    await page.click(node(n));
    await sleep(300);
    if (tab) {
        await clickText(page, '.properties [role=tab]', tab);
        await sleep(300);
    }
}

async function run(page) {
    await page.click('.toolbar-run');
    await page.waitForSelector('.toolbar-run', { timeout: 60000 });
    await sleep(800);
}

async function openPipelineFromProject(page, pipelineNames) {
    const names = Array.isArray(pipelineNames) ? pipelineNames : [pipelineNames];
    await clickText(page, '.left-sidebar [role=tab]', '项目');
    await page.waitForSelector('.repo-tree-body', { timeout: 60000 });
    for (let attempt = 0; attempt < 20; attempt++) {
        const opened = await page.evaluate(pipelineNames => {
            const norm = s => (s ?? '').trim();
            const matches = label => pipelineNames.some(name => label === name || label.startsWith(name));
            const rows = () => [...document.querySelectorAll('.repo-node')];
            const findPipeline = () =>
                rows().find(row => row.classList.contains('is-pipeline') && matches(norm(row.querySelector('.repo-label')?.textContent)));
            let pipeline = findPipeline();
            if (!pipeline) {
                for (const row of rows()) {
                    const isContainer = row.classList.contains('is-project') || row.classList.contains('is-folder');
                    if (!isContainer) continue;
                    if (row.querySelector('.repo-chevron .lucide-chevron-right')) {
                        row.click();
                    }
                }
                pipeline = findPipeline();
            }
            if (!pipeline) return false;
            pipeline.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            return true;
        }, names);
        if (opened) {
            await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 2, { timeout: 30000 });
            return;
        }
        await sleep(500);
    }
    throw new Error(`cannot open starter pipeline from Project tree (${names.join(', ')})`);
}

// ---- The shots, in the order the guide uses them ----------------------------

async function capture(page) {
    // The runner usually opens a default pipeline on startup. If not, open one
    // from Project and continue from there.
    const ready = await page.evaluate(() => document.querySelectorAll('.react-flow__node').length >= 2);
    if (!ready) {
        await openPipelineFromProject(page, ['orders_etl', '1. CSV filter to Parquet', 'orders_filter.pipeline', 'orders_filter']);
    }
    await page.click('.react-flow__controls-fitview');
    await sleep(400);

    // 2.1 The window at a glance, after a run so every area has something in it.
    await clickText(page, '.left-sidebar [role=tab]', '组件');
    await selectNode(page, 2, '基础');
    await run(page);
    await bottomTab(page, '输出');
    await fitCanvas(page);
    await mark(page, [
        await box(page, '.topbar', { pad: -3, label: '1' }),
        await box(page, '.editor-header', { pad: -3, label: '2' }),
        await box(page, '.tabbar', { pad: -3, label: '3' }),
        await box(page, '.left-sidebar', { pad: -3, label: '4', at: 'bottom' }),
        await box(page, '.react-flow', { pad: -3, label: '5' }),
        await box(page, '.tool-strip', { pad: -3, label: '6', at: 'bottom' }),
        await box(page, '.bottom-panel', { pad: -3, label: '7' }),
    ]);
    await shot(page, 'overview');

    // 3.2 Step 1: the New pipeline dialog.
    await page.click('button[aria-label="新建管道"]');
    await page.waitForSelector('.template-grid');
    await sleep(300);
    const dialog = await box(page, '.modal', { pad: 0 });
    await mark(page, [await box(page, '.modal input'), await box(page, '.template-grid', { pad: 6 })]);
    await shot(page, 'new-pipeline', union([dialog], 12));
    await page.keyboard.press('Escape');
    await sleep(300);

    // 3.2 Step 2: find a source in Components.
    await page.click('.palette input');
    await page.keyboard.type('csv');
    await sleep(400);
    const sidebar = await box(page, '.left-sidebar', { pad: 0 });
    await mark(page, [await box(page, '.palette input'), await box(page, '.palette [draggable="true"]', { pad: 3 })]);
    await shot(page, 'palette', { ...sidebar, height: Math.min(sidebar.height, 520) });
    await replaceText(page, '.palette input', '');

    // 3.2 Step 2: autodetect the schema, then the preview.
    await selectNode(page, 1, '模式');
    const detect = await page.evaluateHandle(() => [...document.querySelectorAll('.properties button')].find(b => b.textContent.includes('自动检测')));
    await detect.click();
    await sleep(2500);
    const props = await box(page, '.properties', { pad: 0 });
    await mark(page, [await box(page, '.properties [role=tab]', { index: 1, pad: 3 }), await boxOf(detect)]);
    await shot(page, 'autodetect', { ...props, height: Math.min(props.height, 560) });
    await clickText(page, '.properties [role=tab]', '预览');
    await sleep(800);
    await mark(page, [await box(page, '.properties [role=tab]', { index: 2, pad: 3 })]);
    await shot(page, 'preview', { ...props, height: Math.min(props.height, 520) });

    // 3.2 Step 3: an output port wired to the next node's input.
    await hideCanvasChrome(page, true);
    const nodes = await Promise.all([1, 2].map(n => box(page, node(n), { pad: 0 })));
    const wire = union([
        await box(page, `${node(1)} .react-flow__handle.source`, { pad: 0 }),
        await box(page, `${node(2)} .react-flow__handle.target`, { pad: 0 }),
    ], 9);
    await mark(page, [wire]);
    await shot(page, 'connect', union(nodes, 28));
    await hideCanvasChrome(page, false);

    // 3.2 Step 5: validate, run, and the per-node row counts under Output.
    await run(page);
    await bottomTab(page, '输出');
    // Everything below the top bar, down to where the bottom panel's text ends.
    const below = async () => {
        const filled = await filledBox(page, '.bottom-panel-content');
        return { filled, clip: union([await box(page, '.editor-header', { pad: 0 }), filled], 0) };
    };
    let { filled, clip } = await below();
    await mark(page, [await box(page, '.toolbar-run'), await box(page, '[aria-label="验证"]'), filled]);
    await shot(page, 'run-result', { ...clip, height: clip.height + 10 });

    // 4.1 A required field left empty: the node says so, and so does Problems.
    await selectNode(page, 1, '基础');
    const pathInput = await page.evaluateHandle(() => [...document.querySelectorAll('.properties input.field-input')].find(i => i.value.includes('orders.csv')));
    const originalPath = await pathInput.evaluate(i => i.value);
    const setPath = async value => {
        await pathInput.click({ count: 3 });
        await page.keyboard.press('Backspace');
        if (value) await page.keyboard.type(value);
        await sleep(300);
    };
    await setPath('');
    await page.click('[aria-label="验证"]');
    await sleep(600);
    await bottomTab(page, '问题');
    ({ filled, clip } = await below());
    await mark(page, [await box(page, node(1), { pad: 6 }), filled]);
    await shot(page, 'problems', { ...clip, height: clip.height + 10 });

    // 4.1 A run that fails: the node turns red and Console has the reason.
    await setPath('${workspace}/data/orders_2025.csv');
    await run(page);
    await bottomTab(page, '控制台');
    ({ filled, clip } = await below());
    await mark(page, [await box(page, node(1), { pad: 6 }), filled]);
    await shot(page, 'run-failed', { ...clip, height: clip.height + 10 });
    await setPath(originalPath);
}

const server = await startServer();
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, defaultViewport: VIEWPORT });
try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        localStorage.setItem('duckle.lang', 'zh-CN');
        localStorage.setItem('duckle:theme', 'light');
        localStorage.setItem('duckle.tour.v5.done', '1');
        localStorage.setItem('duckle.reviewPrompt', 'dismissed');
        localStorage.setItem('duckle:v1:showHomeOnStartup', 'false');
        localStorage.setItem('duckle.rightTool', 'properties');
    });
    await page.goto(server.url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.left-sidebar [role=tab]', { timeout: 60000 });
    await sleep(800);
    console.log(`==> Capturing into ${OUT}`);
    await capture(page);
} finally {
    await browser.close();
    server.stop();
}
