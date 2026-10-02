import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Ellipsis, Pencil, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react';
import type { DuckieConversationSummary } from '../tauri-bridge';

type Props = {
    conversations: DuckieConversationSummary[];
    /** null = a new chat that has not been saved yet. */
    activeId: string | null;
    /** A reply is streaming: switching or deleting the active chat waits. */
    busy: boolean;
    hasWorkspace: boolean;
    error: string | null;
    onNew: () => void;
    onOpen: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onTogglePin: (conversation: DuckieConversationSummary) => void;
    onDelete: (id: string) => void;
};

/**
 * Chat history sidebar: new chat, recent conversations, and a per-item menu to
 * rename, pin or delete. Same markup and styles as Duckie's sidebar.
 */
export default function ConversationSidebar({
    conversations,
    activeId,
    busy,
    hasWorkspace,
    error,
    onNew,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
}: Props) {
    const { t } = useTranslation();
    const [menu, setMenu] = useState<{ id: string; top: number; left: number; confirmDelete: boolean } | null>(null);
    const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
    const renamingRef = useRef<{ id: string; draft: string } | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const menuConversation = menu ? conversations.find(c => c.id === menu.id) ?? null : null;

    const beginRename = useCallback((conv: DuckieConversationSummary) => {
        setMenu(null);
        const next = { id: conv.id, draft: conv.title };
        renamingRef.current = next;
        setRenaming(next);
    }, []);

    const updateRenameDraft = useCallback((draftTitle: string) => {
        setRenaming(prev => {
            const next = prev ? { ...prev, draft: draftTitle } : prev;
            renamingRef.current = next;
            return next;
        });
    }, []);

    const cancelRename = useCallback(() => {
        renamingRef.current = null;
        setRenaming(null);
    }, []);

    // Reads the ref, not state: Enter commits and then the input's blur fires
    // with a stale closure, and Escape must not be undone by that blur.
    const commitRename = useCallback(() => {
        const current = renamingRef.current;
        renamingRef.current = null;
        setRenaming(null);
        if (!current) return;
        const title = current.draft.trim();
        const existing = conversations.find(c => c.id === current.id);
        if (!title || title === existing?.title) return;
        onRename(current.id, title);
    }, [conversations, onRename]);

    const openMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, id: string) => {
        event.stopPropagation();
        if (menu?.id === id) {
            setMenu(null);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const menuHeight = 132;
        const menuWidth = 176;
        const below = rect.bottom + 4;
        const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 4) : below;
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
        setMenu({ id, top, left, confirmDelete: false });
    }, [menu]);

    // Close the item menu on any press outside it, when the window moves under
    // it, and on Escape - before the panel's own Escape handler closes the panel.
    useEffect(() => {
        if (!menu) return;
        const onPointerDown = (e: PointerEvent) => {
            if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
            setMenu(null);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setMenu(null);
        };
        const close = () => setMenu(null);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [menu]);

    return (
        <>
                <nav className="chat-history" aria-label={t('chat.history.recent')}>
                    <button
                        type="button"
                        className="chat-history-new"
                        onClick={onNew}
                        disabled={busy}
                        title={busy ? t('chat.history.busyHint') : undefined}
                    >
                        <SquarePen size={14} aria-hidden="true" />
                        <span>{t('chat.history.newChat')}</span>
                    </button>
                    <div className="chat-history-label">{t('chat.history.recent')}</div>
                    <div className="chat-history-list" onScroll={() => setMenu(null)}>
                        {!hasWorkspace ? (
                            <div className="chat-history-empty">{t('chat.history.noWorkspace')}</div>
                        ) : conversations.length === 0 ? (
                            <div className="chat-history-empty">{t('chat.history.empty')}</div>
                        ) : (
                            conversations.map(conv => {
                                const isActive = conv.id === activeId;
                                const title = conv.title || t('chat.history.untitled');
                                return (
                                    <div
                                        key={conv.id}
                                        className={`chat-history-item ${isActive ? 'chat-history-item-active' : ''} ${
                                            menu?.id === conv.id ? 'chat-history-item-menu-open' : ''
                                        }`}
                                    >
                                        {renaming?.id === conv.id ? (
                                            <input
                                                className="chat-history-rename"
                                                value={renaming.draft}
                                                autoFocus
                                                maxLength={120}
                                                aria-label={t('chat.history.rename')}
                                                onChange={e => updateRenameDraft(e.target.value)}
                                                onFocus={e => e.currentTarget.select()}
                                                onBlur={commitRename}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        commitRename();
                                                    } else if (e.key === 'Escape') {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        cancelRename();
                                                    }
                                                }}
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                className="chat-history-item-main"
                                                onClick={() => {
                                                    if (!isActive) onOpen(conv.id);
                                                }}
                                                onDoubleClick={() => beginRename(conv)}
                                                disabled={busy && !isActive}
                                                title={busy && !isActive ? t('chat.history.busyHint') : title}
                                                aria-current={isActive ? 'true' : undefined}
                                            >
                                                {conv.pinned ? (
                                                    <Pin size={11} className="chat-history-pin" aria-hidden="true" />
                                                ) : null}
                                                <span className="chat-history-title">{title}</span>
                                            </button>
                                        )}
                                        {renaming?.id === conv.id ? null : (
                                            <button
                                                type="button"
                                                className="chat-history-more"
                                                onClick={e => openMenu(e, conv.id)}
                                                title={t('chat.history.more')}
                                                aria-label={t('chat.history.more')}
                                                aria-haspopup="menu"
                                                aria-expanded={menu?.id === conv.id}
                                            >
                                                <Ellipsis size={14} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                    {error ? (
                        <div className="chat-history-error" role="alert" title={error}>
                            <AlertCircle size={12} aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                    ) : null}
                </nav>
                {menu && menuConversation
                    ? createPortal(
                          <div
                              ref={menuRef}
                              className="chat-history-menu"
                              role="menu"
                              style={{ top: menu.top, left: menu.left }}
                          >
                              {menu.confirmDelete ? (
                                  <div className="chat-history-confirm">
                                      <div className="chat-history-confirm-text">{t('chat.history.deleteConfirm')}</div>
                                      <div className="chat-history-confirm-actions">
                                          <button
                                              type="button"
                                              className="chat-history-confirm-cancel"
                                              onClick={() => setMenu(prev => (prev ? { ...prev, confirmDelete: false } : prev))}
                                          >
                                              {t('chat.history.cancel')}
                                          </button>
                                          <button
                                              type="button"
                                              className="chat-history-confirm-delete"
                                              onClick={() => {
                                                      setMenu(null);
                                                      onDelete(menuConversation.id);
                                                  }}
                                              autoFocus
                                          >
                                              {t('chat.history.deleteConfirmCta')}
                                          </button>
                                      </div>
                                  </div>
                              ) : (
                                  <>
                                      <button
                                          type="button"
                                          role="menuitem"
                                          className="chat-history-menu-item"
                                          onClick={() => beginRename(menuConversation)}
                                      >
                                          <Pencil size={13} aria-hidden="true" />
                                          <span>{t('chat.history.rename')}</span>
                                      </button>
                                      <button
                                          type="button"
                                          role="menuitem"
                                          className="chat-history-menu-item"
                                          onClick={() => {
                                              setMenu(null);
                                              onTogglePin(menuConversation);
                                          }}
                                      >
                                          {menuConversation.pinned ? (
                                              <PinOff size={13} aria-hidden="true" />
                                          ) : (
                                              <Pin size={13} aria-hidden="true" />
                                          )}
                                          <span>
                                              {menuConversation.pinned ? t('chat.history.unpin') : t('chat.history.pin')}
                                          </span>
                                      </button>
                                      <div className="chat-history-menu-sep" role="separator" />
                                      <button
                                          type="button"
                                          role="menuitem"
                                          className="chat-history-menu-item chat-history-menu-item-danger"
                                          disabled={busy && menuConversation.id === activeId}
                                          title={busy && menuConversation.id === activeId ? t('chat.history.busyHint') : undefined}
                                          onClick={() => setMenu(prev => (prev ? { ...prev, confirmDelete: true } : prev))}
                                      >
                                          <Trash2 size={13} aria-hidden="true" />
                                          <span>{t('chat.history.delete')}</span>
                                      </button>
                                  </>
                              )}
                          </div>,
                          document.body,
                      )
                    : null}
        </>
    );
}
