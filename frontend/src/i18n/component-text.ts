import type { TFunction } from 'i18next';

/** i18next namespace holding translated palette summaries, keyed by component id. */
export const COMPONENTS_NS = 'components';

/**
 * The palette summary of a component in the active language. English stays in
 * palette-data.ts as the source of truth; a locale only carries translations
 * (`locales/components/<lang>.json`), and anything it lacks reads in English.
 */
export function componentSummary(t: TFunction, id: string, summary: string | undefined): string | undefined {
    if (!summary) return summary;
    // Component ids contain dots (src.ducklake.maintain), so they are looked
    // up as flat keys rather than as nested paths.
    return t(id, { ns: COMPONENTS_NS, keySeparator: false, nsSeparator: false, defaultValue: summary });
}
