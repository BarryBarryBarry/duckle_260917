import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';

type ThemeContextValue = {
    theme: Theme;
    toggle: () => void;
    set: (t: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
    theme: 'light',
    toggle: () => {},
    set: () => {},
});

const STORAGE_KEY = 'duckle:theme';

function readInitialTheme(): Theme {
    if (typeof window === 'undefined') return 'light';
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch {
        /* ignore */
    }
    return 'light';
}

// The stylesheet's base :root is the dark theme and light is a [data-theme]
// override, so the attribute has to be on <html> before the first paint.
// ThemeProvider's effect runs after it, which would flash a dark window on
// every start now that light is the default - so seed it here, at import
// time, which is still well before React renders.
if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = readInitialTheme();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useState<Theme>(readInitialTheme);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            /* ignore */
        }
    }, [theme]);

    const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

    return (
        <ThemeContext.Provider value={{ theme, toggle, set: setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextValue {
    return useContext(ThemeContext);
}
