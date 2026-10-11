import { loadPersisted, savePersisted } from '../persistence';

/** Minutes without input before the desktop app locks; 0 turns it off. */
export const IDLE_LOCK_CHOICES = [0, 5, 15, 30, 60] as const;
export const DEFAULT_IDLE_LOCK_MINUTES = 30;
const KEY = 'idleLockMinutes';
export const IDLE_LOCK_EVENT = 'duckle:idle-lock-changed';

export function getIdleLockMinutes(): number {
    const v = loadPersisted<number>(KEY, DEFAULT_IDLE_LOCK_MINUTES);
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_IDLE_LOCK_MINUTES;
}

export function setIdleLockMinutes(minutes: number): void {
    savePersisted(KEY, minutes);
    window.dispatchEvent(new Event(IDLE_LOCK_EVENT));
}

/**
 * Why the app should lock now, if it should: no input for longer than the
 * idle limit, or a remembered sign-in that has lapsed while the app was open.
 */
export function lockReason(
    now: number,
    lastActivity: number,
    idleMinutes: number,
    rememberUntil: number | null,
): 'idle' | 'expired' | null {
    if (rememberUntil !== null && now >= rememberUntil) return 'expired';
    if (idleMinutes > 0 && now - lastActivity >= idleMinutes * 60_000) return 'idle';
    return null;
}
