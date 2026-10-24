import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../tauri-dialog';
import { routeTitleBarDoubleClick, toggleMaximizeWindow } from './window-maximize';

/**
 * Minimize / maximize / close controls for the frameless window,
 * rendered into Duckle's own topbar. Only shows under Tauri - in the
 * browser the OS chrome (or none) applies.
 */
export default function WindowControls() {
    const { t } = useTranslation();
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        if (!isTauri()) return;
        routeTitleBarDoubleClick();
        const win = getCurrentWindow();
        let unlisten: (() => void) | undefined;
        void win.isMaximized().then(setMaximized).catch(() => {});
        win.onResized(() => {
            void win.isMaximized().then(setMaximized).catch(() => {});
        })
            .then(u => {
                unlisten = u;
            })
            .catch(() => {});
        return () => unlisten?.();
    }, []);

    if (!isTauri()) return null;
    const win = getCurrentWindow();

    return (
        <div className="win-controls">
            <button
                type="button"
                className="win-ctl"
                title={t('window.minimize')}
                aria-label={t('window.minimize')}
                onClick={() => void win.minimize()}
            >
                <Minus size={15} />
            </button>
            <button
                type="button"
                className="win-ctl"
                title={maximized ? t('window.restore') : t('window.maximize')}
                aria-label={maximized ? t('window.restore') : t('window.maximize')}
                onClick={() => void toggleMaximizeWindow()}
            >
                {maximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button
                type="button"
                className="win-ctl win-ctl-close"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={() => void win.close()}
            >
                <X size={15} />
            </button>
        </div>
    );
}
