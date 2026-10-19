// Shared by the right-hand panels (Properties, Agent, Guide): a
// maximized view that covers everything below the top bar, and a resize limit
// that never squeezes the canvas below a usable width.
import { useEffect, useState, type RefObject } from 'react';

/** The canvas never gets narrower than this while a side panel is dragged. */
export const MIN_CANVAS_WIDTH = 480;

/** Widest a panel now `startWidth` wide may be dragged: it grows only by what
 *  the canvas can give up, so panels on both sides cannot crowd it out. */
export function maxPanelWidth(startWidth: number, maxWidth: number): number {
    const canvas = document.querySelector('.canvas-shell')?.getBoundingClientRect().width;
    const room = canvas !== undefined ? startWidth + canvas - MIN_CANVAS_WIDTH : window.innerWidth - MIN_CANVAS_WIDTH;
    return Math.max(startWidth, Math.min(maxWidth, room));
}

/**
 * Maximized state for a side panel. It resets whenever the panel is hidden.
 * With `escapeRef`, Esc pressed inside the panel (or with nothing focused)
 * restores it; Esc inside a dialog opened from the panel is left alone.
 */
export function useMaximized(active: boolean, escapeRef?: RefObject<HTMLElement | null>) {
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        if (!active) setMaximized(false);
    }, [active]);

    useEffect(() => {
        if (!maximized || !escapeRef) return;
        const onKey = (e: KeyboardEvent) => {
            // Not gated on defaultPrevented: React Flow marks every Esc handled.
            if (e.key !== 'Escape') return;
            const target = e.target as Node | null;
            if (target && target !== document.body && !escapeRef.current?.contains(target)) return;
            setMaximized(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [maximized, escapeRef]);

    return [maximized, setMaximized] as const;
}
