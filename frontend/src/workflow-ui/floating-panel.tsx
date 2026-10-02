// Floating panel window behaviour shared by the Duckie and Pi Agent chat
// panels: drag by the header with edge snapping, resize from every edge and
// corner, minimize, maximize, a collapsible history sidebar, and a layout
// remembered per panel in localStorage. Moved verbatim out of ChatPanel.
import { useCallback, useEffect, useRef, useState } from 'react';

const CHAT_PANEL_WIDTH = 420;
const CHAT_PANEL_MAX_WIDTH = 620;
const CHAT_PANEL_MAX_HEIGHT = 760;
/** Smallest the panel may be dragged to before the edge stops following. */
const CHAT_PANEL_MIN_WIDTH = 360;
const CHAT_PANEL_MIN_HEIGHT = 360;
const CHAT_PANEL_MARGIN = 16;
/** Width of the chat-history sidebar; the panel grows by this much when it is shown. */
const CHAT_SIDEBAR_WIDTH = 216;
const CHAT_PANEL_SNAP_DISTANCE = 28;
/** Height of the header strip, which is all that is left when minimized. */
const CHAT_PANEL_COLLAPSED_HEIGHT = 82;
/** How far the pointer must travel before a press on the header counts as a
 *  drag. Below this a press is just a click and leaves the panel untouched. */
const DRAG_THRESHOLD = 4;

export type PanelRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type PanelLayout = PanelRect & {
    /** Whether the chat-history sidebar is shown. */
    sidebar: boolean;
    /** Minimized: only the header strip is drawn. */
    collapsed: boolean;
    /** Maximized: fills the work area, ignoring the default size caps. */
    maximized: boolean;
    /** The rect to go back to when un-maximizing. */
    restore: PanelRect | null;
};

/** Every edge and corner, so the panel resizes in all four directions. */
export type ResizeMode =
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right';

const RESIZE_MODES: ResizeMode[] = [
    'top',
    'bottom',
    'left',
    'right',
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
];

function resizeLabel(mode: ResizeMode, name: string): string {
    switch (mode) {
        case 'top':
            return `拖动以调整 ${name} 面板高度（上边缘）`;
        case 'bottom':
            return `拖动以调整 ${name} 面板高度（下边缘）`;
        case 'left':
            return `拖动以调整 ${name} 面板宽度（左边缘）`;
        case 'right':
            return `拖动以调整 ${name} 面板宽度（右边缘）`;
        case 'top-left':
            return `拖动以调整 ${name} 面板大小（左上角）`;
        case 'top-right':
            return `拖动以调整 ${name} 面板大小（右上角）`;
        case 'bottom-left':
            return `拖动以调整 ${name} 面板大小（左下角）`;
        case 'bottom-right':
            return `拖动以调整 ${name} 面板大小（右下角）`;
    }
}


export function useFloatingPanel(storageKey: string, name: string) {
    const [panelLayout, setPanelLayout] = useState<PanelLayout | null>(null);
    const [dragging, setDragging] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [resizeHover, setResizeHover] = useState<ResizeMode | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; started: boolean } | null>(null);
    const resizeRef = useRef<{
        pointerId: number;
        mode: ResizeMode;
        startX: number;
        startY: number;
        origin: PanelRect;
    } | null>(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const saved = readSavedPanelLayout(storageKey);
        setPanelLayout(clampPanelLayout(saved ?? defaultPanelLayout()));
    }, []);

    useEffect(() => {
        if (!panelLayout || typeof window === 'undefined') return;
        window.localStorage.setItem(storageKey, JSON.stringify(panelLayout));
    }, [panelLayout, storageKey]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onResize = () => setPanelLayout(prev => clampPanelLayout(prev ?? defaultPanelLayout()));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        document.body.classList.toggle('chat-panel-dragging-body', dragging || resizing);
        return () => document.body.classList.remove('chat-panel-dragging-body');
    }, [dragging, resizing]);

    const handleHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, input, textarea, select, a')) return;
        const start = panelLayout ?? defaultPanelLayout();
        // Nothing is committed here, not even for a maximized panel: a press
        // is not yet a drag, and restoring on press alone would shrink the
        // panel on a plain click of the header.
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: start.x,
            originY: start.y,
            started: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    }, [panelLayout]);

    const handleHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const totalX = event.clientX - drag.startX;
        const totalY = event.clientY - drag.startY;
        if (!drag.started) {
            // Wait for real movement before treating the gesture as a drag, so
            // a click (or a click that wobbles by a pixel) leaves the panel be.
            if (Math.abs(totalX) < DRAG_THRESHOLD && Math.abs(totalY) < DRAG_THRESHOLD) return;
            drag.started = true;
            setDragging(true);
        }
        setPanelLayout(prev => {
            let base = prev ?? defaultPanelLayout();
            if (base.maximized) {
                // First real movement on a maximized panel restores it, the way
                // a desktop window does. The anchor uses the point the user
                // pressed, so the cursor keeps the same relative spot on the
                // header and the panel does not jump out from under it.
                const restore = base.restore ?? defaultPanelLayout(base.sidebar);
                const ratio = (drag.startX - base.x) / Math.max(1, base.width);
                drag.originX = drag.startX - restore.width * ratio;
                drag.originY = base.y;
                base = {
                    ...base,
                    width: restore.width,
                    height: restore.height,
                    maximized: false,
                    restore: null,
                };
            }
            return clampPanelLayout({
                ...base,
                x: drag.originX + totalX,
                y: drag.originY + totalY,
            });
        });
    }, []);

    const finishDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const started = drag.started;
        dragRef.current = null;
        setDragging(false);
        // A click that never became a drag must not snap the panel around.
        if (started) setPanelLayout(prev => (prev ? snapPanelLayout(prev) : prev));
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    const handleResizePointerDown = useCallback((
        event: React.PointerEvent<HTMLButtonElement>,
        mode: ResizeMode,
    ) => {
        if (event.button !== 0) return;
        const base = panelLayout ?? defaultPanelLayout();
        resizeRef.current = {
            pointerId: event.pointerId,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            origin: { x: base.x, y: base.y, width: base.width, height: base.height },
        };
        setResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.stopPropagation();
    }, [panelLayout]);

    const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            const next = resizeRect(
                resize.origin,
                resize.mode,
                event.clientX - resize.startX,
                event.clientY - resize.startY,
                minPanelWidth(base.sidebar),
            );
            // A resized panel is no longer "maximized", so the restore button
            // does not snap away the size the user just dragged.
            return clampPanelLayout({ ...base, ...next, maximized: false });
        });
    }, []);

    const finishResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    /** Minimize: collapse to the header strip. Restores the previous height. */
    const toggleCollapsed = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            return clampPanelLayout({ ...base, collapsed: !base.collapsed });
        });
    }, []);

    /** Maximize / restore. The pre-maximize rect is kept so restoring puts the
     *  panel back exactly where it was rather than at the default position. */
    const toggleMaximized = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            if (base.maximized) {
                const restore = base.restore ?? defaultPanelLayout(base.sidebar);
                return clampPanelLayout({
                    ...base,
                    ...restore,
                    sidebar: base.sidebar,
                    collapsed: false,
                    maximized: false,
                    restore: null,
                });
            }
            return clampPanelLayout({
                ...base,
                ...maximizedRect(),
                collapsed: false,
                maximized: true,
                restore: { x: base.x, y: base.y, width: base.width, height: base.height },
            });
        });
    }, []);

    const resetPanelLayout = useCallback(() => {
        setPanelLayout(prev => clampPanelLayout(defaultPanelLayout(prev?.sidebar ?? true)));
    }, []);

    /** Showing the sidebar grows the panel leftwards by its width (and hiding
     *  shrinks it back), so the conversation column keeps its size and the
     *  panel's right edge stays put. */
    const toggleSidebar = useCallback(() => {
        setPanelLayout(prev => {
            const base = prev ?? defaultPanelLayout();
            const sidebar = !base.sidebar;
            if (base.maximized) return clampPanelLayout({ ...base, sidebar });
            const delta = sidebar ? CHAT_SIDEBAR_WIDTH : -CHAT_SIDEBAR_WIDTH;
            return clampPanelLayout({
                ...base,
                sidebar,
                width: base.width + delta,
                x: base.x - delta,
            });
        });
    }, []);

    const currentLayout = panelLayout ?? defaultPanelLayout();
    const panelStyle = {
        left: currentLayout.x,
        top: currentLayout.y,
        width: currentLayout.width,
        height: currentLayout.collapsed ? undefined : currentLayout.height,
    };

    const resizeHandles = currentLayout.collapsed ? null : (
        <>
            {RESIZE_MODES.map(mode => (
                <button
                    key={mode}
                    type="button"
                    className={`chat-panel-resize-handle chat-panel-resize-handle-${mode} ${
                        resizeHover === mode ? 'chat-panel-resize-handle-visible' : ''
                    }`}
                    aria-label={resizeLabel(mode, name)}
                    title={resizeLabel(mode, name)}
                    onPointerDown={event => handleResizePointerDown(event, mode)}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={finishResize}
                    onPointerCancel={finishResize}
                    onMouseEnter={() => setResizeHover(mode)}
                    onMouseLeave={() => setResizeHover(prev => (prev === mode ? null : prev))}
                />
            ))}
        </>
    );

    return {
        layout: currentLayout,
        panelStyle,
        dragging,
        resizing,
        headerProps: {
            onPointerDown: handleHeaderPointerDown,
            onPointerMove: handleHeaderPointerMove,
            onPointerUp: finishDrag,
            onPointerCancel: finishDrag,
            onDoubleClick: resetPanelLayout,
        },
        resizeHandles,
        toggleCollapsed,
        toggleMaximized,
        toggleSidebar,
    };
}

function readSavedPanelLayout(storageKey: string): PanelLayout | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
            x?: unknown;
            y?: unknown;
            width?: unknown;
            height?: unknown;
            sidebar?: unknown;
            collapsed?: unknown;
            maximized?: unknown;
            restore?: unknown;
        };
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return {
                x: parsed.x,
                y: parsed.y,
                width: typeof parsed.width === 'number' ? parsed.width : CHAT_PANEL_WIDTH,
                height: typeof parsed.height === 'number' ? parsed.height : CHAT_PANEL_MAX_HEIGHT,
                // Layouts saved before the sidebar existed get it shown; the
                // clamp then widens them to fit.
                sidebar: parsed.sidebar !== false,
                collapsed: parsed.collapsed === true,
                maximized: parsed.maximized === true,
                restore: readRect(parsed.restore),
            };
        }
    } catch {
        // Ignore malformed saved positions and fall back to the default.
    }
    return null;
}

function readRect(value: unknown): PanelRect | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number'
    ) {
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
}

function sidebarExtra(sidebar: boolean): number {
    return sidebar ? CHAT_SIDEBAR_WIDTH : 0;
}

function minPanelWidth(sidebar: boolean): number {
    return CHAT_PANEL_MIN_WIDTH + sidebarExtra(sidebar);
}

function defaultPanelLayout(sidebar = true): PanelLayout {
    if (typeof window === 'undefined') {
        return {
            x: CHAT_PANEL_MARGIN,
            y: CHAT_PANEL_MARGIN,
            width: CHAT_PANEL_WIDTH + sidebarExtra(sidebar),
            height: CHAT_PANEL_MAX_HEIGHT,
            sidebar,
            collapsed: false,
            maximized: false,
            restore: null,
        };
    }
    const topbarHeight = readTopbarHeight();
    const width = Math.min(
        CHAT_PANEL_MAX_WIDTH + sidebarExtra(sidebar),
        Math.min(CHAT_PANEL_WIDTH + sidebarExtra(sidebar), window.innerWidth - CHAT_PANEL_MARGIN * 2),
    );
    const height = Math.min(
        CHAT_PANEL_MAX_HEIGHT,
        Math.max(CHAT_PANEL_MIN_HEIGHT, window.innerHeight - topbarHeight - 24),
    );
    return {
        x: Math.max(CHAT_PANEL_MARGIN, window.innerWidth - width - CHAT_PANEL_MARGIN),
        y: topbarHeight + 10,
        width,
        height,
        sidebar,
        collapsed: false,
        maximized: false,
        restore: null,
    };
}

/** The rectangle the panel is allowed to live in: below the topbar, inset by
 *  the margin on the other three sides. */
function panelWorkArea() {
    const top = readTopbarHeight() + 8;
    return {
        top,
        left: CHAT_PANEL_MARGIN,
        right: Math.max(CHAT_PANEL_MARGIN, window.innerWidth - CHAT_PANEL_MARGIN),
        bottom: Math.max(top, window.innerHeight - CHAT_PANEL_MARGIN),
    };
}

/** Maximizing fills the work area, so it deliberately ignores the default
 *  size caps that keep a freshly opened panel a comfortable reading width.
 *  It does not force the minimum size either: in a window too short for it,
 *  overflowing the work area would push the composer off-screen. */
function maximizedRect(): PanelRect {
    const area = panelWorkArea();
    return {
        x: area.left,
        y: area.top,
        width: area.right - area.left,
        height: area.bottom - area.top,
    };
}

function clampPanelLayout(layout: PanelLayout): PanelLayout {
    if (typeof window === 'undefined') return layout;
    if (layout.maximized) {
        return { ...layout, ...maximizedRect() };
    }
    const area = panelWorkArea();
    const availableWidth = area.right - area.left;
    const availableHeight = area.bottom - area.top;
    // A dragged edge may legitimately grow the panel past the default caps,
    // so the only hard limit is the work area itself.
    const width = clampSize(layout.width, minPanelWidth(layout.sidebar), availableWidth);
    const height = clampSize(layout.height, CHAT_PANEL_MIN_HEIGHT, availableHeight);
    // While minimized only the header is on screen, so that is what has to
    // stay inside the work area - not the height it will restore to.
    const occupiedHeight = layout.collapsed ? CHAT_PANEL_COLLAPSED_HEIGHT : height;
    const maxX = Math.max(area.left, area.right - width);
    const maxY = Math.max(area.top, area.bottom - occupiedHeight);
    return {
        ...layout,
        width,
        height,
        x: Math.min(Math.max(layout.x, area.left), maxX),
        y: Math.min(Math.max(layout.y, area.top), maxY),
    };
}

/** Keeps a dimension inside [min, max] even when the available space is
 *  smaller than the minimum (a very short window), where max wins. */
function clampSize(value: number, min: number, max: number): number {
    if (max <= min) return max;
    return Math.min(Math.max(value, min), max);
}

/** Resizes by moving only the dragged edges, so the opposite edge stays put
 *  even when the drag runs into the minimum size. Anchoring it this way is
 *  what stops the panel from sliding away under the cursor. */
function resizeRect(
    origin: PanelRect,
    mode: ResizeMode,
    deltaX: number,
    deltaY: number,
    minWidth: number,
): PanelRect {
    const area = panelWorkArea();
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;

    if (mode.includes('left')) {
        left = Math.min(Math.max(origin.x + deltaX, area.left), right - minWidth);
    }
    if (mode.includes('right')) {
        right = Math.max(Math.min(right + deltaX, area.right), left + minWidth);
    }
    if (mode.includes('top')) {
        top = Math.min(Math.max(origin.y + deltaY, area.top), bottom - CHAT_PANEL_MIN_HEIGHT);
    }
    if (mode.includes('bottom')) {
        bottom = Math.max(Math.min(bottom + deltaY, area.bottom), top + CHAT_PANEL_MIN_HEIGHT);
    }

    return { x: left, y: top, width: right - left, height: bottom - top };
}

function snapPanelLayout(layout: PanelLayout): PanelLayout {
    if (typeof window === 'undefined') return layout;
    const next = { ...layout };
    const maxX = Math.max(CHAT_PANEL_MARGIN, window.innerWidth - next.width - CHAT_PANEL_MARGIN);
    const minY = readTopbarHeight() + 8;
    if (Math.abs(next.x - CHAT_PANEL_MARGIN) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.x = CHAT_PANEL_MARGIN;
    }
    if (Math.abs(next.x - maxX) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.x = maxX;
    }
    if (Math.abs(next.y - minY) <= CHAT_PANEL_SNAP_DISTANCE) {
        next.y = minY;
    }
    return clampPanelLayout(next);
}

function readTopbarHeight() {
    if (typeof window === 'undefined') return 56;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim();
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : 56;
}

