import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize, primaryMonitor } from '@tauri-apps/api/window';
import { isTauri } from '../tauri-dialog';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
/** The window's restored size, as a share of the work area. */
const RESTORE_SHARE = 0.8;
/** tauri.conf.json minWidth / minHeight, in logical pixels. */
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 600;

/**
 * Maximize or restore the main window.
 *
 * On macOS the window is frameless, so Tauri counts it as maximized when it
 * fills the work area, and restoring returns it to the size it had before it
 * was maximized. The app opens maximized from the configured 1400x900, which
 * a laptop screen clamps to the whole work area, so restoring changed nothing.
 * There, restore to a centred share of the work area instead.
 */
export async function toggleMaximizeWindow(): Promise<void> {
    const win = getCurrentWindow();
    if (!IS_MAC) return win.toggleMaximize();
    if (!(await win.isMaximized())) return win.maximize();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor) return win.toggleMaximize();
    const { position, size } = monitor.workArea;
    const scale = monitor.scaleFactor;
    const width = Math.min(size.width, Math.max(Math.round(size.width * RESTORE_SHARE), Math.round(MIN_WIDTH * scale)));
    const height = Math.min(size.height, Math.max(Math.round(size.height * RESTORE_SHARE), Math.round(MIN_HEIGHT * scale)));
    await win.setSize(new PhysicalSize(width, height));
    await win.setPosition(
        new PhysicalPosition(position.x + Math.round((size.width - width) / 2), position.y + Math.round((size.height - height) / 2)),
    );
}

function inDragRegion(e: MouseEvent): boolean {
    for (const el of e.composedPath()) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.hasAttribute('data-tauri-drag-region')) return true;
        // A clickable element between the cursor and the region keeps the click.
        if (el.matches('button, a, input, select, textarea, [role="button"]')) return false;
    }
    return false;
}

let doubleClickInstalled = false;

/**
 * Tauri maximizes on a double-click in a drag region (on mouseup, on macOS)
 * with its own toggle, which has the same problem. Take that double-click
 * first and use the toggle above. Once per page.
 */
export function routeTitleBarDoubleClick(): void {
    if (doubleClickInstalled || !IS_MAC || !isTauri()) return;
    doubleClickInstalled = true;
    let downX = 0;
    let downY = 0;
    window.addEventListener(
        'mousedown',
        e => {
            if (e.button === 0 && e.detail === 2) {
                downX = e.clientX;
                downY = e.clientY;
            }
        },
        true,
    );
    window.addEventListener(
        'mouseup',
        e => {
            if (e.button !== 0 || e.detail !== 2 || !inDragRegion(e)) return;
            e.stopImmediatePropagation();
            // As macOS does: a double-click that moved is not one.
            if (e.clientX === downX && e.clientY === downY) void toggleMaximizeWindow();
        },
        true,
    );
}
