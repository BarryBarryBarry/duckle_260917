# Duckle UI translations

35 languages ship in `locales/`. English (`en.json`) is the source of truth; every other locale is generated from it.

Only the languages listed in `ENABLED_CODES` in `languages.ts` (currently en, zh-CN, zh-TW, ja, ko) appear in the selector and are accepted by the language detector; the rest stay bundled but hidden, and a browser or saved choice for a hidden language falls back to English. Add a code there to turn a language back on.

## How translations get there

1. `en.json` is hand-curated. Every key, every English string, every interpolation slot lives here.
2. `scripts/i18n-translate.py` (at the repo root) flattens it, calls the [MyMemory free API](https://mymemory.translated.net/) for every language in `languages.ts`, and writes the resulting JSON to `locales/<lang>.json`.
3. The result is **machine-translated**, not human-quality. Major languages (es, de, fr, ja, zh-CN, pt-BR, ko, it, ru) are usually fine; smaller languages can read awkwardly. Native-speaker contributions are welcome and replace the auto-generated text 1:1.

## Adding or improving a translation

If you're a native speaker, just edit `locales/<lang>.json` directly. Keys must match `en.json` exactly; interpolation slots like `{{path}}` and `{{name}}` must stay intact. Open a PR.

If you want to fix translations across many languages, edit `en.json` then run:

```bash
python scripts/i18n-translate.py --force
```

`--force` re-translates everything. Without it, languages with an existing JSON are skipped (the script is idempotent).

## Adding a new language

1. Add a row to `LANGUAGES` in `languages.ts` (code, English name, native name, direction).
2. Add the import + entry in `index.ts`.
3. Add the language code to `TARGETS` in `scripts/i18n-translate.py`.
4. Run the script. It will produce `locales/<code>.json`.

For RTL languages, set `dir: 'rtl'` in the languages.ts row. The bootstrap in `index.ts` reads that and sets `document.documentElement.dir`.

## Translation scope, today

Only the highest-traffic surfaces are wrapped with `useTranslation()` so far:
- Topbar (workspace button, context selector, Git / Duckie / theme toggles)
- Chat panel (Duckie AI assistant)
- Palette top-level group labels (Sources, Transforms, Sinks, Control Flow, Data Quality, Custom Code)
- Common dialog buttons (Save, Cancel, Close, Delete, OK)
- Settings dialog (`settings.*`) and the Connect to Claude / MCP dialog (`mcp.*`), hand-translated for zh-CN, zh-TW, ja and ko
- Guided tour (`guidedTour.*`, one `steps.<id>` entry per step in `GuidedTour.tsx`), hand-translated for zh-CN, zh-TW, ja and ko. Labels of screens that are not translated yet (Home tiles, context menus) are kept in English inside the translated text so they match what is on screen.

Deferred to follow-ups:
- Palette subgroup labels and component summaries
- GitPanel internals
- Properties panel tab labels
- Every modal (EdgeEditor, VisualMapper, ConnectionEditor, ContextEditor, etc.)
- Status bar messages
- Validation errors

When you wrap a new surface:
1. Add the English string to `en.json` under the relevant namespace (`common`, `topbar`, `chat`, `palette`, or add a new one).
2. Run `python scripts/i18n-translate.py` to back-fill the other languages (will only translate the new keys).
3. Replace the hardcoded string in the component with `t('namespace.key')`.

## Using the local Duckie AI instead of the cloud API

The `scripts/i18n-translate.py` script uses MyMemory's web API. If you want to translate entirely offline (and the user has Duckie installed), you can replace the `translate_one()` function to POST to the local llama-server's `/v1/chat/completions` with a translate-to-X system prompt instead. The Qwen 2.5 Coder 1.5B model is multilingual; quality varies by language but it's free, offline, and respects the local-first principle.
