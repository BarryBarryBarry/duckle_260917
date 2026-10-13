// Desktop sign-in commands (apps/desktop/src/local_auth.rs). Errors come back
// as stable codes such as `invalid_credentials` or `throttled:30`, which
// authErrorMessage turns into text.
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';

export type AuthUser = { username: string; isAdmin: boolean };

export type AuthStatus = {
    needsSetup: boolean;
    user: AuthUser | null;
    /** Epoch milliseconds when "remember me" lapses; null when not remembered. */
    rememberUntil: number | null;
    /** The credentials file, named on the "forgot password" screen. */
    storePath: string;
};

export type AuthUserRow = AuthUser & { createdAt: number };

/** "Remember me" choices shown in the sign-in dropdown. */
export const REMEMBER_DAYS = [1, 7, 30] as const;
export type RememberDays = 0 | (typeof REMEMBER_DAYS)[number];

export const MIN_PASSWORD_LENGTH = 8;

export const authStatus = () => invoke<AuthStatus>('auth_status');

export const authSetup = (username: string, password: string) =>
    invoke<{ recoveryCode: string }>('auth_setup', { username, password });

export const authSignIn = (username: string, password: string, rememberDays: RememberDays) =>
    invoke<AuthStatus>('auth_sign_in', { username, password, rememberDays });

export const authUnlock = (password: string) => invoke<void>('auth_unlock', { password });

export const authSignOut = () => invoke<void>('auth_sign_out');

export const authChangePassword = (current: string, next: string) =>
    invoke<void>('auth_change_password', { current, next });

export const authListUsers = () => invoke<AuthUserRow[]>('auth_list_users');

export const authDeleteUser = (username: string) => invoke<void>('auth_delete_user', { username });

export const authResetPassword = (username: string, password: string) =>
    invoke<void>('auth_reset_password', { username, password });

export const authRecover = (username: string, code: string, password: string) =>
    invoke<{ recoveryCode: string }>('auth_recover', { username, code, password });

export const authRegenerateRecovery = (password: string) =>
    invoke<{ recoveryCode: string }>('auth_regenerate_recovery', { password });

/** A translated message for an error a command threw. */
export function authErrorMessage(t: TFunction, err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const throttled = /^throttled:(\d+)$/.exec(raw);
    if (throttled) return t('auth.error.throttled', { seconds: Number(throttled[1]) });
    const code = raw.split(':')[0];
    return t(`auth.error.${code}`, { defaultValue: raw, min: MIN_PASSWORD_LENGTH });
}
