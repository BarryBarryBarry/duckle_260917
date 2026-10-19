// The user guide shipped inside the app. Markdown and images under this folder
// are bundled at build time, so updating the guide means rebuilding the app.
// A UI language with its own `manual.<lang>.md` gets that manual; any other
// Chinese variant gets Simplified Chinese, and everything else gets English.

const CHINESE_LANG = 'zh-CN';
const DEFAULT_LANG = 'en';

const MANUALS = import.meta.glob<string>('./manual.*.md', { query: '?raw', import: 'default' });
const IMAGES = import.meta.glob<string>('./images/**/*.{png,jpg,jpeg,gif,webp,svg}', {
    query: '?url',
    import: 'default',
    eager: true,
});

function manualKey(lang: string): string {
    return `./manual.${lang}.md`;
}

export function resolveManualLang(lang: string | undefined): string {
    const isChinese = lang?.toLowerCase().startsWith('zh') ?? false;
    const candidates = [lang, isChinese ? CHINESE_LANG : undefined, DEFAULT_LANG, CHINESE_LANG].filter(
        (l): l is string => !!l,
    );
    return candidates.find(l => manualKey(l) in MANUALS) ?? DEFAULT_LANG;
}

export async function loadManual(lang: string | undefined): Promise<string> {
    const load = MANUALS[manualKey(resolveManualLang(lang))];
    if (!load) throw new Error(`No user guide for ${lang ?? DEFAULT_LANG}`);
    return load();
}

/** Maps a manual's `./images/x.png` (or `images/x.png`) to its bundled URL;
 *  anything else (http links, data URLs) passes through unchanged. */
export function resolveGuideImage(src: string | undefined): string | undefined {
    if (!src) return src;
    const rel = src.replace(/^\.\//, '');
    if (!rel.startsWith('images/')) return src;
    return IMAGES[`./${decodeURI(rel)}`] ?? src;
}

/** GitHub-style heading anchor: `## 4. 排错指南` -> `4-排错指南`. */
export function slugifyHeading(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-');
}
