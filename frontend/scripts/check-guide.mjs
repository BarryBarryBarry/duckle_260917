// Checks the bundled user guide (src/guide/manual.*.md): every `./images/...`
// reference must exist, and every in-guide `#anchor` link must name a heading.
// Slugs follow slugifyHeading in src/guide/index.ts; keep the two in step.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const guideDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/guide');

const slugify = text =>
    text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');

// Heading text as rendered: links keep their label, emphasis and code marks drop.
const plainText = md =>
    md
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '');

let problems = 0;
const report = (file, msg) => {
    problems++;
    console.error(`${file}: ${msg}`);
};

const manuals = readdirSync(guideDir).filter(f => /^manual\..+\.md$/.test(f));
if (manuals.length === 0) report('src/guide', 'no manual.<lang>.md found');

for (const file of manuals) {
    const lines = readFileSync(resolve(guideDir, file), 'utf8').split('\n');
    const anchors = new Set();
    const seen = new Map();
    const body = [];
    let fenced = false;
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) continue;
        body.push(line);
        const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            const base = slugify(plainText(heading[1])) || 'section';
            const n = seen.get(base) ?? 0;
            seen.set(base, n + 1);
            anchors.add(n === 0 ? base : `${base}-${n}`);
        }
    }
    const text = body.join('\n');
    for (const [, src] of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
        if (/^(https?:|data:)/i.test(src)) continue;
        const rel = src.replace(/^\.\//, '');
        if (!rel.startsWith('images/')) {
            report(file, `image ${src} must live under ./images/`);
        } else if (!existsSync(resolve(guideDir, decodeURI(rel)))) {
            report(file, `image ${src} not found`);
        }
    }
    for (const [, id] of text.matchAll(/\]\(#([^)\s]+)\)/g)) {
        if (!anchors.has(decodeURIComponent(id))) report(file, `link #${id} matches no heading`);
    }
}

if (problems > 0) {
    console.error(`check-guide: ${problems} problem(s)`);
    process.exit(1);
}
console.log(`check-guide: ${manuals.length} manual(s) OK`);
