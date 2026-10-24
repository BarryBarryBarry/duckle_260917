// Every palette summary is a hover tooltip, so every enabled non-English
// language must carry a translation for it in src/i18n/locales/components/,
// and must not keep translations for components that no longer exist.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_COMPONENTS } from '../src/workflow-ui/palette-data';

const dir = resolve(process.env.DUCKLE_COMPONENT_LOCALES!);
const summaries = new Map(ALL_COMPONENTS.filter(c => c.summary).map(c => [c.id, c.summary!]));

let problems = 0;
const report = (file: string, msg: string) => {
    problems++;
    console.error(`${file}: ${msg}`);
};

const files = readdirSync(dir).filter(f => f.endsWith('.json'));
if (files.length === 0) report(dir, 'no component locale found');

for (const file of files) {
    const translations: Record<string, unknown> = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    for (const id of summaries.keys()) {
        const text = translations[id];
        if (typeof text !== 'string' || !text.trim()) report(file, `missing translation for ${id}`);
    }
    for (const id of Object.keys(translations)) {
        if (!summaries.has(id)) report(file, `translation for ${id}, which has no palette summary`);
    }
    // Inline code must survive translation verbatim.
    for (const [id, summary] of summaries) {
        const text = translations[id];
        if (typeof text !== 'string') continue;
        for (const code of summary.match(/`[^`]+`/g) ?? []) {
            if (!text.includes(code)) report(file, `${id} lost ${code}`);
        }
    }
}

if (problems > 0) {
    console.error(`\n${problems} component translation problem(s).`);
    process.exitCode = 1;
} else {
    console.log(`component translations OK (${summaries.size} summaries, ${files.length} locale(s))`);
}
