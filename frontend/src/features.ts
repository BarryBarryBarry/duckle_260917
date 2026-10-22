// The built-in Duckie assistant, and the DeepSeek Harness (DSH) + duckle-mcp
// mode it runs on, are hidden in this build: the Agent panel is the AI entry
// point. The code stays; set this to true to bring both back.
export const DUCKIE_ENABLED = false;

// Top-bar buttons hidden in this build; set a switch to true to show its
// button again. Lineage, Trust and Git can still be opened from Home. The web
// dashboard and Dives have no other entry, so they are unreachable while off.
/** Opens the web management console (desktop only). */
export const TOPBAR_WEB_DASHBOARD = false;
/** Dives: live data views and dashboards. Settings can also hide it. */
export const TOPBAR_DIVES = false;
/** Column lineage. */
export const TOPBAR_LINEAGE = false;
/** Trust score. */
export const TOPBAR_TRUST = false;
/** Git version control panel. */
export const TOPBAR_GIT = false;
/** Execution engine picker (DuckDB, ...). The current engine still applies. */
export const TOPBAR_ENGINE_SELECTOR = false;
/** "by SlothFlowLabs" under the product name in the top bar. */
export const TOPBAR_BRAND_BYLINE = false;
/** Home button in the pipeline toolbar. Home still opens at startup if it is
 *  set to; the guided tour skips its Home steps while the button is hidden. */
export const TOOLBAR_HOME = false;
/** Live preview (lightning) button in the pipeline toolbar. Live mode starts
 *  off on every launch, so hiding the button leaves it off. */
export const TOOLBAR_LIVE_PREVIEW = false;
/** "Deploy to a server…" in the toolbar's More menu. */
export const MORE_MENU_DEPLOY = true;
/** "Import Talend job…" in the toolbar's More menu. */
export const MORE_MENU_IMPORT_TALEND = false;
/** "Talend" import button above the project tree. */
export const PROJECT_TREE_IMPORT_TALEND = false;
