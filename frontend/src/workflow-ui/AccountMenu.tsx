import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, KeyRound, Lock, LogOut, Users } from 'lucide-react';
import { useAuth } from '../auth/AuthGate';
import { ChangePasswordDialog, UserManagementDialog } from '../auth/AccountDialogs';

/** Up to two uppercase initials for the avatar. */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
    return (
        <span
            className="acct-avatar-initials"
            style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
            aria-hidden="true"
        >
            {initials(name)}
        </span>
    );
}

/** Top-right chip for the signed-in user (desktop sign-in, auth/AuthGate.tsx).
   The menu is portaled to <body> so the topbar's backdrop-filter (which
   creates a containing block / stacking context) can't clip it. Renders
   nothing where there is no desktop sign-in (the web build). */
export function AccountChip() {
    const { t } = useTranslation();
    const auth = useAuth();
    const [open, setOpen] = useState(false);
    const [dialog, setDialog] = useState<null | 'password' | 'users'>(null);
    const chipRef = useRef<HTMLButtonElement>(null);
    const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 56, right: 12 });

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    if (!auth) return null;
    const { user } = auth;

    const openMenu = () => {
        const r = chipRef.current?.getBoundingClientRect();
        if (r) setMenuPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
        setOpen(true);
    };
    const pick = (action: () => void) => () => {
        setOpen(false);
        action();
    };

    return (
        <div className="acct-wrap">
            <button
                ref={chipRef}
                type="button"
                className="acct-chip"
                onClick={() => (open ? setOpen(false) : openMenu())}
                title={t('auth.signedInAs', { name: user.username })}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <Avatar name={user.username} />
                <span className="acct-chip-name">{user.username}</span>
                <ChevronDown size={13} className="acct-chip-caret" />
            </button>

            {open
                ? createPortal(
                      <>
                          <div className="acct-backdrop" onClick={() => setOpen(false)} />
                          <div className="acct-menu acct-menu-auth" role="menu" style={{ top: menuPos.top, right: menuPos.right }}>
                              <div className="acct-menu-user">
                                  <Avatar name={user.username} size={32} />
                                  <div className="acct-menu-user-text">
                                      <span className="acct-menu-name">{user.username}</span>
                                      <span className="acct-menu-role">{user.isAdmin ? t('auth.admin') : t('auth.user')}</span>
                                  </div>
                              </div>
                              <button type="button" role="menuitem" className="acct-menu-add" onClick={pick(auth.lock)}>
                                  <Lock size={15} /> {t('auth.lockNow')}
                              </button>
                              <button type="button" role="menuitem" className="acct-menu-add" onClick={pick(() => setDialog('password'))}>
                                  <KeyRound size={15} /> {t('auth.changePassword')}
                              </button>
                              {user.isAdmin ? (
                                  <button type="button" role="menuitem" className="acct-menu-add" onClick={pick(() => setDialog('users'))}>
                                      <Users size={15} /> {t('auth.manageUsers')}
                                  </button>
                              ) : null}
                              <button type="button" role="menuitem" className="acct-menu-add" onClick={pick(auth.signOut)}>
                                  <LogOut size={15} /> {t('auth.signOut')}
                              </button>
                          </div>
                      </>,
                      document.body,
                  )
                : null}

            {dialog === 'password' ? <ChangePasswordDialog onClose={() => setDialog(null)} /> : null}
            {dialog === 'users' ? <UserManagementDialog onClose={() => setDialog(null)} /> : null}
        </div>
    );
}
