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
import { Bot, Check, Copy, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { DuckleLogo } from '../workflow-ui/DuckleLogo';
import WindowControls from '../workflow-ui/WindowControls';
import WindowResizeHandles from '../workflow-ui/WindowResizeHandles';
import { getWorkspacePath } from '../workspace';
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
 *  the app window is frameless and the editor's top bar is not mounted yet.
 *  `home` is the signed-out landing page: what the app does on the left, the
 *  way in on the right, with the brand in the top bar instead of the card. */
function AuthScreen({ children, wide = false, home = false }: { children: ReactNode; wide?: boolean; home?: boolean }) {
    const card = (
        <div className={'acct-modal auth-card' + (wide ? ' auth-card-wide' : '')}>
            {home ? null : (
                <div className="auth-brand">
                    <DuckleLogo size={28} />
                    <span>Otter ETL agent</span>
                </div>
            )}
            {children}
        </div>
    );
    return (
        <div className={'auth-screen' + (home ? ' auth-home' : '')}>
            <WindowResizeHandles />
            <div className="auth-drag" data-tauri-drag-region>
                {home ? (
                    <div className="auth-topbar-brand" data-tauri-drag-region>
                        <DuckleLogo size={26} />
                        <span className="auth-topbar-name">Otter ETL agent</span>
                        <span className="auth-topbar-by">by SlothFlowLabs</span>
                    </div>
                ) : null}
                <div className="auth-drag-spacer" data-tauri-drag-region />
                <WindowControls />
            </div>
            {home ? <LandingFrame>{card}</LandingFrame> : card}
        </div>
    );
}

/** The signed-out landing page: a headline and a picture of the product on
 *  the left, the sign-in card on the right. */
function LandingFrame({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const workspaceName = getWorkspacePath()?.split(/[\\/]/).filter(Boolean).pop() ?? null;
    return (
        <div className="auth-landing">
            <div className="auth-landing-bg" aria-hidden="true" />
            <main className="auth-landing-main">
                <section className="auth-hero">
                    <span className="auth-hero-badge">{t('auth.hero.badge')}</span>
                    <h1 className="auth-hero-title">{t('auth.hero.title')}</h1>
                    <p className="auth-hero-sub">{t('auth.hero.sub')}</p>
                    <HeroArt />
                </section>
                <div className="auth-landing-card">{children}</div>
            </main>
            <footer className="auth-landing-foot">
                {workspaceName ? (
                    <span>{t('launcher.subtitleWs', 'Workspace: {{name}}', { name: workspaceName })}</span>
                ) : null}
                <span>© 2026 SlothFlowLabs · Otter ETL agent</span>
            </footer>
        </div>
    );
}

/** The product, drawn: a pipeline on a canvas, with the Agent that built it
 *  floating beside it. Decorative; every word in it is also said elsewhere on
 *  the page. */
function HeroArt() {
    const { t } = useTranslation();
    const nodes = [
        { kind: 'source', name: 'MySQL' },
        { kind: 'transform', name: 'Filter' },
        { kind: 'sink', name: 'PostgreSQL' },
    ] as const;
    return (
        <div className="auth-hero-art" aria-hidden="true">
            <div className="auth-hero-glow" />
            <div className="auth-hero-canvas">
                <div className="auth-hero-canvas-bar">
                    <i />
                    <i />
                    <i />
                </div>
                <svg className="auth-hero-links" viewBox="0 0 100 60" preserveAspectRatio="none">
                    <path d="M29 30 C 33 30, 33 30, 37 30" />
                    <path d="M63 30 C 67 30, 67 30, 71 30" />
                </svg>
                <div className="auth-hero-nodes">
                    {nodes.map((n, i) => (
                        <div key={n.name} className={`auth-hero-node is-${n.kind}`} style={{ animationDelay: `${i * 0.6}s` }}>
                            <span className="auth-hero-node-kind">{t(`node.${n.kind}`)}</span>
                            <span className="auth-hero-node-name">
                                <span className="auth-hero-node-seq">{i + 1}</span>
                                {n.name}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
            <div className="auth-hero-chip is-agent">
                <Bot size={13} />
                <span>{t('auth.hero.agent')}</span>
                <Check size={12} className="auth-hero-chip-ok" />
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
    const [showPassword, setShowPassword] = useState(false);
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
        <AuthScreen home>
            <div className="auth-signin-head">
                <h3>{t('auth.signInTitle')}</h3>
                <p className="acct-modal-sub">{t('auth.signInSub')}</p>
            </div>
            <form className="acct-form auth-signin-form" onSubmit={submit}>
                <input
                    className="auth-input"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder={t('auth.username')}
                    aria-label={t('auth.username')}
                    autoFocus={!username}
                    autoComplete="username"
                    spellCheck={false}
                />
                <div className="auth-input-wrap">
                    <input
                        className="auth-input"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder={t('auth.password')}
                        aria-label={t('auth.password')}
                        autoFocus={!!username}
                        autoComplete="current-password"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        className="auth-input-eye"
                        onClick={() => setShowPassword(v => !v)}
                        aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                        title={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                </div>
                <div className="auth-signin-row">
                    <label className="auth-check">
                        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                        {t('auth.remember')}
                    </label>
                    {remember ? (
                        <select
                            className="auth-select auth-select-inline"
                            value={rememberDays}
                            onChange={e => setRememberDays(Number(e.target.value) as RememberDays)}
                            aria-label={t('auth.rememberFor')}
                        >
                            {REMEMBER_DAYS.map(d => (
                                <option key={d} value={d}>
                                    {t('auth.rememberDays', { count: d })}
                                </option>
                            ))}
                        </select>
                    ) : null}
                    <button type="button" className="acct-link auth-forgot" onClick={() => setMode('forgot')}>
                        {t('auth.forgot')}
                    </button>
                </div>
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <button
                    type="submit"
                    className="acct-btn acct-btn-primary auth-submit"
                    disabled={busy || !username.trim() || !password}
                >
                    {busy ? t('auth.working') : t('auth.signIn')}
                </button>
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
            <AuthScreen home>
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
        <AuthScreen home>
            <div className="auth-signin-head">
                <h3>{t('auth.forgotTitle')}</h3>
                <p className="acct-modal-sub">{t('auth.recoverWithCode')}</p>
            </div>
            <form className="acct-form auth-signin-form" onSubmit={submit}>
                <input
                    className="auth-input"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder={t('auth.username')}
                    aria-label={t('auth.username')}
                    autoComplete="username"
                    spellCheck={false}
                />
                <input
                    className="auth-input auth-input-code"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder={`${t('auth.recoveryCode')}  XXXXX-XXXXX-XXXXX-XXXXX`}
                    aria-label={t('auth.recoveryCode')}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                />
                <input
                    className="auth-input"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('auth.newPassword')}
                    aria-label={t('auth.newPassword')}
                    autoComplete="new-password"
                    spellCheck={false}
                />
                <input
                    className="auth-input"
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder={t('auth.confirmPassword')}
                    aria-label={t('auth.confirmPassword')}
                    autoComplete="new-password"
                    spellCheck={false}
                />
                {error ? <p className="auth-error" role="alert">{error}</p> : null}
                <button
                    type="submit"
                    className="acct-btn acct-btn-primary auth-submit"
                    disabled={busy || !username.trim() || !code.trim()}
                >
                    {busy ? t('auth.working') : t('auth.resetPassword')}
                </button>
            </form>
            <details className="auth-manual">
                <summary>{t('auth.manualResetTitle')}</summary>
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
            </details>
            <button type="button" className="acct-link auth-back" onClick={onBack}>
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
