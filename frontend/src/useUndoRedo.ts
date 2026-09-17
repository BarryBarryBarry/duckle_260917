// Canvas undo/redo: the React side of UndoHistory (undo-history.ts), which holds
// the per-pipeline history and decides what is a step. This hook feeds it the
// active pipeline, applies what undo/redo return, and binds the keys.
//
// Keyboard: Ctrl/Cmd+Z = undo; Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo. Ctrl+R is
// also bound to redo (and always suppresses the webview reload).
import { useCallback, useEffect, useRef, useState } from 'react';
import { UndoHistory, type CanvasSnapshot } from './undo-history';

export type { CanvasSnapshot };

const browserTimer = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
};

export function useUndoRedo(
    /** The workspace the pipelines belong to; a new one starts a fresh history. */
    scope: string,
    activeJobId: string,
    activePipeline: CanvasSnapshot,
    apply: (snapshot: CanvasSnapshot) => void,
) {
    const [, force] = useState(0);
    const history = useRef<UndoHistory | null>(null);
    if (history.current === null) {
        history.current = new UndoHistory(activeJobId, activePipeline, browserTimer, () =>
            force(v => v + 1),
        );
    }

    // Record history on meaningful changes (debounced inside UndoHistory).
    useEffect(() => {
        history.current!.observe(activeJobId, activePipeline, scope);
    }, [activePipeline, activeJobId, scope]);
    useEffect(() => () => history.current!.dispose(), []);

    const undo = useCallback(() => {
        const restore = history.current!.undo();
        if (restore) apply(restore);
    }, [apply]);

    const redo = useCallback(() => {
        const restore = history.current!.redo();
        if (restore) apply(restore);
    }, [apply]);

    const noteEdit = useCallback(() => history.current!.noteEdit(), []);

    // Keyboard shortcuts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = e.key.toLowerCase();
            // Ctrl+R: redo + always kill the webview reload.
            if (k === 'r') {
                e.preventDefault();
                redo();
                return;
            }
            // Don't hijack Ctrl+Z/Y while editing text - let the field's own
            // undo work.
            const el = document.activeElement as HTMLElement | null;
            const typing =
                !!el &&
                (el.tagName === 'INPUT' ||
                    el.tagName === 'TEXTAREA' ||
                    el.tagName === 'SELECT' ||
                    el.isContentEditable);
            if (typing) return;
            if (k === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo]);

    return {
        undo,
        redo,
        noteEdit,
        canUndo: history.current.canUndo(),
        canRedo: history.current.canRedo(),
    };
}
