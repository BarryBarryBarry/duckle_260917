// Account dialogs opened from the top bar's account menu: change your own
// password, and (administrators) manage the local users.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, Trash2, X } from 'lucide-react';
import {
    authChangePassword,
    authCreateUser,
    authDeleteUser,
    authErrorMessage,
    authListUsers,
    authRegenerateRecovery,
    authResetPassword,
    MIN_PASSWORD_LENGTH,
    type AuthUserRow,
} from './auth-api';
import { RecoveryCodePanel, useAuth } from './AuthGate';

function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
    const { t } = useTranslation();
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return createPortal(
        <div className="acct-overlay" onClick={onClose}>
            <div
                className={'acct-modal' + (wide ? ' auth-card-wide' : '')}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={e => e.stopPropagation()}
            >
                <button type="button" className="acct-modal-x" aria-label={t('common.close', 'Close')} onClick={onClose}>
                    <X size={16} />
                </button>
                <h3>{title}</h3>
                {children}
            </div>
        </div>,
        document.body,
    );
}

function Field({
    label,
    value,
    onChange,
    type = 'password',
    autoComplete = 'new-password',
    autoFocus,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: 'password' | 'text';
    autoComplete?: string;
    autoFocus?: boolean;
}) {
    return (
        <label className="acct-label">
            {label}
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                autoComplete={autoComplete}
                autoFocus={autoFocus}
                spellCheck={false}
            />
        </label>
    );
}

function passwordProblem(t: ReturnType<typeof useTranslation>['t'], password: string, confirm: string): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) return t('auth.error.password_too_short', { min: MIN_PASSWORD_LENGTH });
    if (password !== confirm) return t('auth.passwordsDiffer');
    return null;
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const problem = passwordProblem(t, next, confirm);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
            await authChangePassword(current, next);
            setDone(true);
        } catch (err) {
            setError(authErrorMessage(t, err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog title={t('auth.changePassword')} onClose={onClose}>
            {done ? (
                <div className="acct-form">
                    <p className="auth-success">{t('auth.passwordChanged')}</p>
                    <div className="acct-form-actions">
                        <button type="button" className="acct-btn acct-btn-primary" onClick={onClose}>
                            {t('auth.done')}
                        </button>
                    </div>
                </div>
            ) : (
                <form className="acct-form" onSubmit={submit}>
                    <Field label={t('auth.currentPassword')} value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
                    <Field label={t('auth.newPassword')} value={next} onChange={setNext} />
                    <Field label={t('auth.confirmPassword')} value={confirm} onChange={setConfirm} />
                    <p className="auth-hint">{t('auth.passwordRule', { min: MIN_PASSWORD_LENGTH })}</p>
                    {error ? <p className="auth-error" role="alert">{error}</p> : null}
                    <div className="acct-form-actions">
                        <button type="button" className="acct-btn" onClick={onClose}>
                            {t('auth.cancel')}
                        </button>
                        <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !current}>
                            {busy ? t('auth.working') : t('auth.save')}
                        </button>
                    </div>
                </form>
            )}
        </Dialog>
    );
}

type Pane = { kind: 'list' } | { kind: 'add' } | { kind: 'reset'; username: string } | { kind: 'recovery' };

export function UserManagementDialog({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const auth = useAuth();
    const [users, setUsers] = useState<AuthUserRow[] | null>(null);
    const [pane, setPane] = useState<Pane>({ kind: 'list' });
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setUsers(await authListUsers());
            setError(null);
        } catch (err) {
            setError(authErrorMessage(t, err));
        }
    }, [t]);

    useEffect(() => {
        void load();
    }, [load]);

    const remove = async (username: string) => {
        if (!window.confirm(t('auth.confirmDelete', { name: username }))) return;
        try {
            await authDeleteUser(username);
            await load();
        } catch (err) {
            setError(authErrorMessage(t, err));
        }
    };

    const back = () => {
        setPane({ kind: 'list' });
        void load();
        auth?.refresh();
    };

    return (
        <Dialog title={t('auth.manageUsers')} onClose={onClose} wide>
            {pane.kind === 'add' ? (
                <AddUserPane onDone={back} onCancel={() => setPane({ kind: 'list' })} />
            ) : pane.kind === 'reset' ? (
                <ResetPasswordPane username={pane.username} onDone={back} onCancel={() => setPane({ kind: 'list' })} />
            ) : pane.kind === 'recovery' ? (
                <RegenerateRecoveryPane onDone={back} onCancel={() => setPane({ kind: 'list' })} />
            ) : (
                <div className="acct-form">
                    <p className="acct-modal-sub">{t('auth.manageUsersSub')}</p>
                    {error ? <p className="auth-error" role="alert">{error}</p> : null}
                    <ul className="auth-user-list">
                        {(users ?? []).map(u => {
                            const self = auth?.user.username.toLowerCase() === u.username.toLowerCase();
                            return (
                                <li key={u.username} className="auth-user-row">
                                    <span className="auth-user-name">
                                        {u.username}
                                        {self ? <span className="auth-badge">{t('auth.you')}</span> : null}
                                        {u.isAdmin ? <span className="auth-badge auth-badge-admin">{t('auth.admin')}</span> : null}
                                    </span>
                                    <span className="auth-user-actions">
                                        <button
                                            type="button"
                                            className="acct-icon-btn"
                                            title={t('auth.resetPasswordFor', { name: u.username })}
                                            aria-label={t('auth.resetPasswordFor', { name: u.username })}
                                            onClick={() => setPane({ kind: 'reset', username: u.username })}
                                        >
                                            <KeyRound size={13} />
                                        </button>
                                        {self ? null : (
                                            <button
                                                type="button"
                                                className="acct-icon-btn acct-icon-danger"
                                                title={t('auth.deleteUser', { name: u.username })}
                                                aria-label={t('auth.deleteUser', { name: u.username })}
                                                onClick={() => void remove(u.username)}
                                            >
                                                <Trash2 size={13} />
                                            </button>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="auth-actions-split">
                        <button type="button" className="acct-link" onClick={() => setPane({ kind: 'recovery' })}>
                            {t('auth.newRecoveryCode')}
                        </button>
                        <button type="button" className="acct-btn acct-btn-primary" onClick={() => setPane({ kind: 'add' })}>
                            {t('auth.addUser')}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
}

function AddUserPane({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [isAdmin, setIsAdmin] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const problem = passwordProblem(t, password, confirm);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
            await authCreateUser(username, password, isAdmin);
            onDone();
        } catch (err) {
            setError(authErrorMessage(t, err));
            setBusy(false);
        }
    };

    return (
        <form className="acct-form" onSubmit={submit}>
            <Field label={t('auth.username')} value={username} onChange={setUsername} type="text" autoComplete="off" autoFocus />
            <Field label={t('auth.password')} value={password} onChange={setPassword} />
            <Field label={t('auth.confirmPassword')} value={confirm} onChange={setConfirm} />
            <label className="auth-check">
                <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} />
                {t('auth.makeAdmin')}
            </label>
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <div className="acct-form-actions">
                <button type="button" className="acct-btn" onClick={onCancel}>
                    {t('auth.cancel')}
                </button>
                <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !username.trim()}>
                    {busy ? t('auth.working') : t('auth.addUser')}
                </button>
            </div>
        </form>
    );
}

function ResetPasswordPane({ username, onDone, onCancel }: { username: string; onDone: () => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const problem = passwordProblem(t, password, confirm);
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
            await authResetPassword(username, password);
            onDone();
        } catch (err) {
            setError(authErrorMessage(t, err));
            setBusy(false);
        }
    };

    return (
        <form className="acct-form" onSubmit={submit}>
            <p className="acct-modal-sub">{t('auth.resetPasswordFor', { name: username })}</p>
            <Field label={t('auth.newPassword')} value={password} onChange={setPassword} autoFocus />
            <Field label={t('auth.confirmPassword')} value={confirm} onChange={setConfirm} />
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <div className="acct-form-actions">
                <button type="button" className="acct-btn" onClick={onCancel}>
                    {t('auth.cancel')}
                </button>
                <button type="submit" className="acct-btn acct-btn-primary" disabled={busy}>
                    {busy ? t('auth.working') : t('auth.resetPassword')}
                </button>
            </div>
        </form>
    );
}

function RegenerateRecoveryPane({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState<string | null>(null);

    if (code) return <RecoveryCodePanel code={code} onContinue={onDone} />;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            setCode((await authRegenerateRecovery(password)).recoveryCode);
        } catch (err) {
            setError(authErrorMessage(t, err));
            setBusy(false);
        }
    };

    return (
        <form className="acct-form" onSubmit={submit}>
            <p className="acct-modal-sub">{t('auth.newRecoveryCodeSub')}</p>
            <Field label={t('auth.currentPassword')} value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <div className="acct-form-actions">
                <button type="button" className="acct-btn" onClick={onCancel}>
                    {t('auth.cancel')}
                </button>
                <button type="submit" className="acct-btn acct-btn-primary" disabled={busy || !password}>
                    {busy ? t('auth.working') : t('auth.generate')}
                </button>
            </div>
        </form>
    );
}
