// Builds apps/desktop/icons/icon.icns from icons/icon-source.png in the shape
// macOS expects (macOS only: uses headless Chrome, sips and iconutil).
//
//   node scripts/gen-macos-icon.mjs
//
// macOS app icons are not full-bleed: on a 1024 canvas the body is an 824 px
// rounded square, centred, with a soft shadow in the margin. A full-bleed icon
// shows up visibly larger than its neighbours in the Dock and Finder. The
// Windows and Linux icons stay full-bleed, which is their convention.
//
// Environment: CHROME_PATH  Chrome / Chromium executable.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ICONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/icons');
const SOURCE = join(ICONS, 'icon-source.png');
const OUT = join(ICONS, 'icon.icns');
// Apple's macOS icon grid, at 1024.
const CANVAS = 1024;
const BODY = 824;
const RADIUS = 185;

if (process.platform !== 'darwin') {
    console.error('gen-macos-icon: needs macOS (sips, iconutil)');
    process.exit(1);
}
const chrome =
    process.env.CHROME_PATH ??
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(
        existsSync,
    );
if (!chrome) {
    console.error('gen-macos-icon: no Chrome found; set CHROME_PATH');
    process.exit(1);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
let master;
try {
    const page = await browser.newPage();
    const src = `data:image/png;base64,${readFileSync(SOURCE).toString('base64')}`;
    master = await page.evaluate(
        async (src, CANVAS, BODY, RADIUS) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = CANVAS;
            const ctx = canvas.getContext('2d');
            const at = (CANVAS - BODY) / 2;
            // The shadow, cast by the body's shape.
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
            ctx.shadowBlur = 24;
            ctx.shadowOffsetY = 10;
            ctx.beginPath();
            ctx.roundRect(at, at, BODY, BODY, RADIUS);
            ctx.fillStyle = '#0a0b0e';
            ctx.fill();
            ctx.restore();
            // The artwork, clipped to the body.
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(at, at, BODY, BODY, RADIUS);
            ctx.clip();
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, at, at, BODY, BODY);
            ctx.restore();
            return canvas.toDataURL('image/png').split(',')[1];
        },
        src,
        CANVAS,
        BODY,
        RADIUS,
    );
} finally {
    await browser.close();
}

const work = join(tmpdir(), `duckle-icon-${process.pid}`);
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset, { recursive: true });
try {
    const masterPng = join(work, 'master.png');
    writeFileSync(masterPng, Buffer.from(master, 'base64'));
    for (const size of [16, 32, 128, 256, 512]) {
        for (const [scale, suffix] of [
            [1, ''],
            [2, '@2x'],
        ]) {
            const px = size * scale;
            const out = join(iconset, `icon_${size}x${size}${suffix}.png`);
            execFileSync('sips', ['-z', String(px), String(px), masterPng, '--out', out], { stdio: 'ignore' });
        }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT]);
    console.log(`gen-macos-icon: wrote ${OUT}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
