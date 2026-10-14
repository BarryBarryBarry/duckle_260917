// Desktop sign-in: nothing behind this gate mounts until someone has signed
// in. The web build is gated by duckle-runner instead, so there it renders its
// children straight away.
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type FormEvent,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2, Lock } from 'lucide-react';
import { DuckleLogo } from '../workflow-ui/DuckleLogo';
import WindowControls from '../workflow-ui/WindowControls';
import WindowResizeHandles from '../workflow-ui/WindowResizeHandles';
import { isTauri } from '../tauri-dialog';
import { copyText } from '../tauri-io';
import { loadPersisted, savePersisted } from '../persistence';
import {
    authErrorMessage,
    authSetup,
    authSignIn,
    authSignOut,
    authStatus,
    authUnlock,
    authRecover,
    MIN_PASSWORD_LENGTH,
    REMEMBER_DAYS,
    type AuthStatus,
    type AuthUser,
    type RememberDays,
} from './auth-api';
import { getIdleLockMinutes, IDLE_LOCK_EVENT, lockReason } from './idle';

export type AuthApi = {
    user: AuthUser;
    lock: () => void;
    signOut: () => void;
    /** Re-read who is signed in, after an administrator changes accounts. */
    refresh: () => void;
};

const AuthContext = createContext<AuthApi | null>(null);

/** The signed-in user and their actions; null in the web build. */
export function useAuth(): AuthApi | null {
    return useContext(AuthContext);
}

const LAST_USER_KEY = 'authLastUser';
const REMEMBER_KEY = 'authRememberDays';
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
/** Long enough for the editor's debounced autosave to land before it unmounts. */
const SIGN_OUT_FLUSH_MS = 450;

export default function AuthGate({ children }: { children: ReactNode }) {
    if (!isTauri()) return <>{children}</>;
    return <DesktopGate>{children}</DesktopGate>;
}

function DesktopGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<AuthStatus | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
    const [locked, setLocked] = useState<'idle' | 'expired' | 'manual' | null>(null);
    const [leaving, setLeaving] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setStatus(await authStatus());
            setLoadError(null);
        } catch (e) {
            setLoadError(authErrorMessage(t, e));
        }
    }, [t]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const signedIn = !!status?.user && !newRecoveryCode && !leaving;

    // Idle and "remember me" expiry both lock rather than sign out, so the
    // open pipelines, unsaved edits and running work stay as they are.
    const lastActivity = useRef(Date.now());
    const [idleMinutes, setIdleMinutes] = useState(getIdleLockMinutes);
    useEffect(() => {
        const sync = () => setIdleMinutes(getIdleLockMinutes());
        window.addEventListener(IDLE_LOCK_EVENT, sync);
        return () => window.removeEventListener(IDLE_LOCK_EVENT, sync);
    }, []);
    useEffect(() => {
        if (!signedIn || locked) return;
        lastActivity.current = Date.now();
        const touch = () => {
            lastActivity.current = Date.now();
        };
        for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, touch, { passive: true, capture: true });
        const timer = window.setInterval(() => {
            const reason = lockReason(Date.now(), lastActivity.current, idleMinutes, status?.rememberUntil ?? null);
            if (reason) setLocked(reason);
        }, 10_000);
        return () => {
            for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch, { capture: true });
            window.clearInterval(timer);
        };
    }, [signedIn, locked, idleMinutes, status?.rememberUntil]);

    const signOut = useCallback(() => {
        setLeaving(true);
        setLocked(null);
        void (async () => {
            try {
                await authSignOut();
            } finally {
                await new Promise(r => window.setTimeout(r, SIGN_OUT_FLUSH_MS));
                await refresh();
                setLeaving(false);
            }
        })();
    }, [refresh]);

    const unlocked = useCallback(() => {
        // A lapsed "remember me" is not renewed by unlocking; it only means the
        // next launch asks again. Drop it here so it does not lock straight away.
        if (locked === 'expired') setStatus(s => (s ? { ...s, rememberUntil: null } : s));
        setLocked(null);
    }, [locked]);

    if (loadError) {
        return (
            <AuthScreen>
                <h3>{t('auth.loadFailedTitle')}</h3>
                <p className="auth-error">{loadError}</p>
                <p className="acct-modal-sub">{t('auth.loadFailedHint')}</p>
                <div className="acct-form-actions">
                    <button type="button" className="acct-btn acct-btn-primary" onClick={() => void refresh()}>
                        {t('auth.retry')}
                    </button>
                </div>
            </AuthScreen>
        );
    }
    if (!status || leaving) {
        return (
            <AuthScreen>
                <div className="auth-busy">
                    <Loader2 size={18} className="spin" />
                    <span>{leaving ? t('auth.signingOut') : t('auth.loading')}</span>
                </div>
            </AuthScreen>
        );
    }
    if (status.needsSetup) {
        return (
            <SetupScreen
                onDone={code => {
                    setNewRecoveryCode(code);
                    void refresh();
                }}
            />
        );
    }
    if (newRecoveryCode) {
        return (
            <AuthScreen>
                <RecoveryCodePanel code={newRecoveryCode} onContinue={() => setNewRecoveryCode(null)} />
            </AuthScreen>
        );
    }
    if (!status.user) {
        return <SignInScreen storePath={status.storePath} onSignedIn={setStatus} />;
    }

    const api: AuthApi = {
        user: status.user,
        lock: () => setLocked('manual'),
        signOut,
        refresh: () => void refresh(),
    };
    return (
        <AuthContext.Provider value={api}>
            {children}
            {locked ? (
                <LockScreen user={status.user} reason={locked} onUnlocked={unlocked} onSignOut={signOut} />
            ) : null}
        </AuthContext.Provider>
    );
}

/** Full-window backdrop with the window's own drag strip and buttons, since
 *  the app window is frameless and the editor's top bar is not mounted yet. */
function AuthScreen({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
    return (
        <div className="auth-screen">
            <WindowResizeHandles />
            <div className="auth-drag" data-tauri-drag-region>
                <div className="auth-drag-spacer" data-tauri-drag-region />
                <WindowControls />
            </div>
            <div className={'acct-modal auth-card' + (wide ? ' auth-card-wide' : '')}>
                <div className="auth-brand">
                    <DuckleLogo size={28} />
                    <span>Otter ETL agent</span>
                </div>
                {children}
            </div>
        </div>
    );
}

function PasswordField({
    label,
    value,
    onChange,
    autoFocus,
    autoComplete = 'current-password',
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    autoFocus?: boolean;
    autoComplete?: string;
}) {
    return (
        <label className="acct-label">
            {label}
            <input
                type="password"
                value={value}
                onChange={e => onChange(e.target.value)}
                autoFocus={autoFocus}
                autoComplete={autoComplete}
                spellCheck={false}
            />
        </label>
    );
}

/** Checks a new password and its confirmation before anything is sent. */
function newPasswordProblem(t: ReturnType<typeof useTranslation>['t'], password: string, confirm: string): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) return t('auth.error.password_too_short', { min: MIN_PASSWORD_LENGTH });
    if (password !== confirm) return t('auth.passwordsDiffer');
    return null;
}

function SetupScreen({ onDone }: { onDone: (recoveryCode: string) => void }) {
    const { t } = useTranslation();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const problem = newPasswordProblem(t, password, confirm);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
            const { recoveryCode } = await authSetup(username, password);
            savePersisted(LAST_USER_KEY, username.trim());
            onDone(recoveryCode);
        } catch (err) {
            setError(authErrorMessage(t, err));
            setBusy(false);
        }
    };

    return (
        <AuthScreen>
            <h3>{t('auth.setupTitle')}</h3>
            <p className="acct-modal-sub">{t('auth.setupSub')}</p>
            <form className="acct-form" onSubmit={submit}>
                <label className="acct-label">
                    {t('auth.username')}
                    <input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" />
                </label>
                <PasswordField label={t('auth.password')} value={password} onChange={setPassword} autoComplete="new-password" />
                <PasswordField label={t('auth.confirmPassword')} value={confirm} onChange={setConfirm} autoComplete="new-password" />
                <p className="auth-hint">{t('auth.passwordRule', { min: MIN_PASSWORD_LENGTH })}</p>
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <div className="acct-form-actions">
                    <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !username.trim()}>
                        {busy ? t('auth.working') : t('auth.createAdmin')}
                    </button>
                </div>
            </form>
        </AuthScreen>
    );
}

export function RecoveryCodePanel({ code, onContinue }: { code: string; onContinue: () => void }) {
    const { t } = useTranslation();
    const [saved, setSaved] = useState(false);
    const [copied, setCopied] = useState(false);
    return (
        <div className="acct-form">
            <div>
                <h3>{t('auth.recoveryTitle')}</h3>
                <p className="acct-modal-sub">{t('auth.recoverySub')}</p>
            </div>
            <div className="auth-code-row">
                <code className="auth-code">{code}</code>
                <button
                    type="button"
                    className="acct-btn"
                    onClick={() => void copyText(code).then(ok => setCopied(ok))}
                    title={t('auth.copy')}
                >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
            </div>
            <label className="auth-check">
                <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
                {t('auth.recoverySaved')}
            </label>
            <div className="acct-form-actions">
                <button type="button" className="acct-btn acct-btn-primary" disabled={!saved} onClick={onContinue}>
                    {t('auth.continue')}
                </button>
            </div>
        </div>
    );
}

function SignInScreen({ storePath, onSignedIn }: { storePath: string; onSignedIn: (s: AuthStatus) => void }) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<'sign-in' | 'forgot'>('sign-in');
    const [username, setUsername] = useState(() => loadPersisted<string>(LAST_USER_KEY, ''));
    const [password, setPassword] = useState('');
    const [rememberDays, setRememberDays] = useState<RememberDays>(() => {
        const saved = loadPersisted<number>(REMEMBER_KEY, 0);
        return (REMEMBER_DAYS as readonly number[]).includes(saved) ? (saved as RememberDays) : 7;
    });
    const [remember, setRemember] = useState(() => {
        const saved = loadPersisted<number>(REMEMBER_KEY, 0);
        return (REMEMBER_DAYS as readonly number[]).includes(saved);
    });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    if (mode === 'forgot') {
        return (
            <ForgotPasswordScreen
                storePath={storePath}
                initialUsername={username}
                onBack={() => setMode('sign-in')}
            />
        );
    }

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const rememberFor = remember ? rememberDays : 0;
            const next = await authSignIn(username, password, rememberFor);
            savePersisted(LAST_USER_KEY, next.user?.username ?? username.trim());
            savePersisted(REMEMBER_KEY, rememberFor);
            onSignedIn(next);
        } catch (err) {
            setError(authErrorMessage(t, err));
            setPassword('');
            setBusy(false);
        }
    };

    return (
        <AuthScreen>
            <h3>{t('auth.signInTitle')}</h3>
            <p className="acct-modal-sub">{t('auth.signInSub')}</p>
            <form className="acct-form" onSubmit={submit}>
                <label className="acct-label">
                    {t('auth.username')}
                    <input
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        autoFocus={!username}
                        autoComplete="username"
                    />
                </label>
                <PasswordField label={t('auth.password')} value={password} onChange={setPassword} autoFocus={!!username} />
                <label className="auth-check">
                    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                    {t('auth.remember')}
                </label>
                {remember ? (
                    <label className="acct-label">
                        {t('auth.rememberFor')}
                        <select
                            className="auth-select"
                            value={rememberDays}
                            onChange={e => setRememberDays(Number(e.target.value) as RememberDays)}
                        >
                            {REMEMBER_DAYS.map(d => (
                                <option key={d} value={d}>
                                    {t('auth.rememberDays', { count: d })}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <div className="auth-actions-split">
                    <button type="button" className="acct-link" onClick={() => setMode('forgot')}>
                        {t('auth.forgot')}
                    </button>
                    <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !username.trim() || !password}>
                        {busy ? t('auth.working') : t('auth.signIn')}
                    </button>
                </div>
            </form>
        </AuthScreen>
    );
}

function ForgotPasswordScreen({
    storePath,
    initialUsername,
    onBack,
}: {
    storePath: string;
    initialUsername: string;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const [username, setUsername] = useState(initialUsername);
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [nextCode, setNextCode] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    if (nextCode) {
        return (
            <AuthScreen>
                <p className="auth-success">{t('auth.recoverDone')}</p>
                <RecoveryCodePanel code={nextCode} onContinue={onBack} />
            </AuthScreen>
        );
    }

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const problem = newPasswordProblem(t, password, confirm);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
            const { recoveryCode } = await authRecover(username, code, password);
            setNextCode(recoveryCode);
        } catch (err) {
            setError(authErrorMessage(t, err));
            setBusy(false);
        }
    };

    return (
        <AuthScreen wide>
            <h3>{t('auth.forgotTitle')}</h3>
            <section className="auth-section">
                <h4>{t('auth.recoverWithCode')}</h4>
                <form className="acct-form" onSubmit={submit}>
                    <label className="acct-label">
                        {t('auth.username')}
                        <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
                    </label>
                    <label className="acct-label">
                        {t('auth.recoveryCode')}
                        <input
                            value={code}
                            onChange={e => setCode(e.target.value)}
                            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                            spellCheck={false}
                            autoComplete="off"
                            autoFocus
                        />
                    </label>
                    <PasswordField label={t('auth.newPassword')} value={password} onChange={setPassword} autoComplete="new-password" />
                    <PasswordField label={t('auth.confirmPassword')} value={confirm} onChange={setConfirm} autoComplete="new-password" />
                    {error ? <p className="auth-error" role="alert">{error}</p> : null}
                    <div className="acct-form-actions">
                        <button
                            type="submit"
                            className="acct-btn acct-btn-primary"
                            disabled={busy || !username.trim() || !code.trim()}
                        >
                            {busy ? t('auth.working') : t('auth.resetPassword')}
                        </button>
                    </div>
                </form>
            </section>
            <section className="auth-section">
                <h4>{t('auth.manualResetTitle')}</h4>
                <p className="acct-modal-sub">{t('auth.manualResetSub')}</p>
                <div className="auth-code-row">
                    <code className="auth-path">{storePath}</code>
                    <button
                        type="button"
                        className="acct-btn"
                        onClick={() => void copyText(storePath).then(ok => setCopied(ok))}
                        title={t('auth.copy')}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                </div>
            </section>
            <button type="button" className="acct-link" onClick={onBack}>
                {t('auth.backToSignIn')}
            </button>
        </AuthScreen>
    );
}

/** Covers the editor without unmounting it. Everything else on the page is
 *  made inert, so neither the mouse nor the keyboard reaches the editor
 *  until the password is given again. */
function LockScreen({
    user,
    reason,
    onUnlocked,
    onSignOut,
}: {
    user: AuthUser;
    reason: 'idle' | 'expired' | 'manual';
    onUnlocked: () => void;
    onSignOut: () => void;
}) {
    const { t } = useTranslation();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        const made: Element[] = [];
        for (const el of Array.from(document.body.children)) {
            if (host && el.contains(host)) continue;
            if (!(el as HTMLElement).inert) {
                (el as HTMLElement).inert = true;
                made.push(el);
            }
        }
        return () => {
            for (const el of made) (el as HTMLElement).inert = false;
        };
    }, []);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await authUnlock(password);
            onUnlocked();
        } catch (err) {
            setError(authErrorMessage(t, err));
            setPassword('');
            setBusy(false);
        }
    };

    return createPortal(
        <div className="auth-lock" ref={hostRef} onKeyDown={e => e.stopPropagation()}>
            <div className="auth-drag" data-tauri-drag-region>
                <div className="auth-drag-spacer" data-tauri-drag-region />
                <WindowControls />
            </div>
            <div className="acct-modal auth-card" role="dialog" aria-modal="true">
                <div className="auth-lock-icon">
                    <Lock size={20} />
                </div>
                <h3>{t('auth.lockedTitle')}</h3>
                <p className="acct-modal-sub">
                    {[t(`auth.lockedReason.${reason}`), t('auth.lockedAs', { name: user.username })].filter(Boolean).join(' ')}
                </p>
                <form className="acct-form" onSubmit={submit}>
                    <PasswordField label={t('auth.password')} value={password} onChange={setPassword} autoFocus />
                    {error ? <p className="auth-error" role="alert">{error}</p> : null}
                    <div className="auth-actions-split">
                        <button type="button" className="acct-link" onClick={onSignOut}>
                            {t('auth.signOutInstead')}
                        </button>
                        <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !password}>
                            {busy ? t('auth.working') : t('auth.unlock')}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
