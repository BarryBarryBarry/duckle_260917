// The Components palette's "Recently used" list for the open workspace. The
// desktop keeps it in the workspace's DuckDB store (recent_components.rs);
// this module holds the copy the palette shows and keeps it in step.
import { isTauri } from './tauri-dialog';
import { recentComponentsList, recentComponentsRecord, type RecentComponent } from './tauri-bridge';

/** Mirrors MAX_ITEMS and KEEP_DAYS in crates/duckdb-engine/src/recent_components.rs. */
export const RECENT_MAX = 20;
export const RECENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type RecentState = {
    /** Shown only in the desktop app with a workspace open. */
    enabled: boolean;
    items: RecentComponent[];
};

let state: RecentState = { enabled: false, items: [] };
let workspace: string | null = null;
const listeners = new Set<() => void>();
/** Answers that arrive after a newer request are dropped. */
let latest = 0;

function publish(next: RecentState) {
    state = next;
    for (const l of listeners) l();
}

export function subscribeRecentComponents(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getRecentComponents(): RecentState {
    return state;
}

export async function loadRecentComponents(workspacePath: string | null): Promise<void> {
    workspace = workspacePath;
    const request = ++latest;
    if (!workspacePath || !isTauri()) {
        publish({ enabled: false, items: [] });
        return;
    }
    publish({ enabled: true, items: [] });
    const list = await recentComponentsList(workspacePath);
    if (request === latest && list) publish({ enabled: true, items: list });
}

/** Called when a component is added to a canvas. The list updates at once and
 *  then takes the stored list as the answer. */
export async function recordRecentComponent(componentId: string): Promise<void> {
    const ws = workspace;
    if (!ws || !state.enabled) return;
    const request = ++latest;
    const items = [
        { componentId, usedAt: Date.now() },
        ...state.items.filter(r => r.componentId !== componentId),
    ].slice(0, RECENT_MAX);
    publish({ enabled: true, items });
    const list = await recentComponentsRecord(ws, componentId);
    if (request === latest && ws === workspace && list) publish({ enabled: true, items: list });
}
