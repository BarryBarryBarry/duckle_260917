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
