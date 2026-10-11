import { loadPersisted, savePersisted } from '../persistence';

/** Each signed-in user's last workspace, keyed by lower-cased username. */
const KEY = 'userWorkspaces';
export type UserWorkspaces = Record<string, string>;

/**
 * The workspace to open for `username`. Before anyone has one remembered
 * (the first launch after this existed) the workspace already open is kept;
 * after that, a user with nothing remembered gets the workspace picker.
 */
export function pickWorkspace(map: UserWorkspaces, username: string | undefined, current: string | null): string | null {
    if (!username) return current;
    const key = username.toLowerCase();
    if (key in map) return map[key];
    return Object.keys(map).length === 0 ? current : null;
}

export function withWorkspace(map: UserWorkspaces, username: string, path: string): UserWorkspaces {
    const key = username.toLowerCase();
    return map[key] === path ? map : { ...map, [key]: path };
}

export function rememberedWorkspace(username: string | undefined, current: string | null): string | null {
    return pickWorkspace(loadPersisted<UserWorkspaces>(KEY, {}), username, current);
}

export function rememberWorkspace(username: string, path: string): void {
    const map = loadPersisted<UserWorkspaces>(KEY, {});
    const next = withWorkspace(map, username, path);
    if (next !== map) savePersisted(KEY, next);
}
