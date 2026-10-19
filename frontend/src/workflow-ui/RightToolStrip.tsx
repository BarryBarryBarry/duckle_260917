// The tool strip on the workspace's right edge, as in IntelliJ IDEA: one
// icon-and-label button per tool window. A tool window opens docked between
// the canvas and the strip, one at a time; its button is lit while it is open.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export type RightTool = 'properties' | 'agent' | 'guide';

/** One width for every right-hand tool window, so switching between them
 *  does not resize the canvas. */
export const RIGHT_TOOL_WIDTH = {
    storageKey: 'duckle.properties.width',
    defaultWidth: 352,
    minWidth: 280,
    maxWidth: 720,
} as const;

export function savedRightToolWidth(): number {
    const { storageKey, defaultWidth, minWidth, maxWidth } = RIGHT_TOOL_WIDTH;
    try {
        const saved = Number(localStorage.getItem(storageKey));
        return saved >= minWidth && saved <= maxWidth ? saved : defaultWidth;
    } catch {
        return defaultWidth;
    }
}

export type ToolStripItem = {
    id: RightTool;
    label: string;
    icon: ReactNode;
    disabled?: boolean;
    title?: string;
    /** `data-tour` for the guided tour. */
    tour?: string;
};

export function RightToolStrip({
    items,
    active,
    onToggle,
    ariaLabel,
}: {
    items: ToolStripItem[];
    active: RightTool | null;
    /** Clicking the open tool hides it; any other opens it in its place. */
    onToggle: (id: RightTool) => void;
    ariaLabel: string;
}) {
    return (
        <nav className="tool-strip" aria-label={ariaLabel}>
            {items.map(item => (
                <button
                    key={item.id}
                    type="button"
                    className={`tool-strip-btn${active === item.id ? ' tool-strip-btn-active' : ''}`}
                    onClick={() => onToggle(item.id)}
                    disabled={item.disabled}
                    title={item.title ?? item.label}
                    aria-pressed={active === item.id}
                    data-tour={item.tour}
                >
                    <span className="tool-strip-icon">{item.icon}</span>
                    <span className="tool-strip-label">{item.label}</span>
                </button>
            ))}
        </nav>
    );
}

const clampWidth = (w: number, min: number, max: number) => Math.max(min, Math.min(max, w));

/** A docked tool window: fills the workspace's height, and its left edge drags
 *  to resize it. The width persists per machine. `hidden` keeps the content
 *  mounted, so a running conversation survives switching tools. */
export function SideToolWindow({
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    hidden,
    children,
}: {
    storageKey: string;
    defaultWidth: number;
    minWidth: number;
    maxWidth: number;
    hidden: boolean;
    children: ReactNode;
}) {
    const [width, setWidth] = useState(() => {
        const saved = Number(localStorage.getItem(storageKey));
        return saved >= minWidth && saved <= maxWidth ? saved : defaultWidth;
    });
    const widthRef = useRef(width);
    const [resizing, setResizing] = useState(false);

    // Another tool window may share this width and have resized it meanwhile.
    useEffect(() => {
        if (hidden) return;
        const saved = Number(localStorage.getItem(storageKey));
        if (saved >= minWidth && saved <= maxWidth && saved !== widthRef.current) {
            widthRef.current = saved;
            setWidth(saved);
        }
    }, [hidden, storageKey, minWidth, maxWidth]);

    const startResize = (e: ReactMouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = widthRef.current;
        // Never squeeze the canvas below a usable width.
        const max = Math.min(maxWidth, Math.max(minWidth, window.innerWidth - 480));
        setResizing(true);
        const onMove = (ev: MouseEvent) => {
            const next = clampWidth(startW + (startX - ev.clientX), minWidth, max);
            widthRef.current = next;
            setWidth(next);
        };
        const onUp = () => {
            setResizing(false);
            try {
                localStorage.setItem(storageKey, String(widthRef.current));
            } catch {
                /* localStorage unavailable - non-fatal */
            }
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    return (
        <div
            className={`tool-window${resizing ? ' tool-window-resizing' : ''}`}
            style={{ width }}
            hidden={hidden}
        >
            <div className="tool-window-resize" onMouseDown={startResize} aria-hidden="true" />
            {children}
        </div>
    );
}
