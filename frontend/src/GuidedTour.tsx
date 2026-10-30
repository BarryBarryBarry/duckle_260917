import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isWebBackend } from './web-fs';
import { placeTip, type Box, type Placement } from './tour-place';

// First-run guided tour: a spotlight walkthrough of the core surfaces. Anchors
// to [data-tour="..."] markers; if a marker is missing the step degrades to a
// centered card, so the tour never breaks. Dismissal persists to localStorage;
// re-launch by dispatching window event "duckle:start-tour".

// Bumped to v3: the tour is now surface-aware (a step that targets a button only
// the desktop app shows is dropped on the self-hosted web editor, so the step
// count and spotlights always match what is on screen), and gained Save,
// Run-parameters and Trust coverage plus richer how-to copy.
// Bumped to v4: added a Live preview step (the lightning toggle is otherwise
// easy to miss), so prior users who finished v3 see it once.
// Bumped to v5: the tour now covers every capability rather than the editor
// alone, is grouped into chapters, and is walked rather than skipped on a first
// run. Anyone who finished v4 sees the fuller one once.
const SEEN_KEY = 'duckle.tour.v5.done';

/** Fired when the tour finishes or is skipped, so Home can take the screen after it. */
export const TOUR_FINISHED_EVENT = 'duckle:tour-finished';

/**
 * Whether this machine has already been walked through the tour.
 *
 * Exported because Home has to know: on a first run the tour goes first and Home waits for
 * it. Two "here is Duckle" screens competing for the same moment is worse than either of
 * them alone, and the tour is the one that explains what Home is for.
 */
export function tourAlreadySeen(): boolean {
    try {
        return !!localStorage.getItem(SEEN_KEY);
    } catch {
        // Storage off: treat it as seen, so a browser that cannot remember never traps
        // somebody in a tour on every single launch.
        return true;
    }
}

// 'both' shows everywhere; 'desktop' only in the Tauri app; 'web' only in the
// self-hosted web editor. Undefined is treated as 'both'.
type Surface = 'both' | 'desktop' | 'web';
type Chapter = 'build' | 'operate' | 'govern' | 'finish';
interface Step {
    sel: string | null;
    /** Text key under guidedTour.steps.<id> (title and body) in the locale files. */
    id: string;
    /** Which part of the product this belongs to, shown above the title. */
    chapter?: Chapter;
    placement?: Placement;
    surface?: Surface;
    /**
     * Drop this step when its element is not on screen, instead of degrading to a
     * centered card.
     *
     * The default degrade is right for a step about something that is always there and
     * merely could not be measured. It is wrong for a button the user has switched off in
     * Settings, or one that needs an open workspace: teaching a control that is not there
     * is worse than saying nothing, and on a first run it cannot be skipped past.
     */
    requireAnchor?: boolean;
}

const ALL_STEPS: Step[] = [
    {
        sel: null,
        id: 'welcome',
        placement: 'center',
    },

    // ---- Build -------------------------------------------------------------
    {
        sel: '[data-tour="palette"]',
        chapter: 'build',
        id: 'palette',
        placement: 'right',
    },
    {
        sel: '[data-tour="canvas"]',
        chapter: 'build',
        id: 'canvas',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="properties"]',
        chapter: 'build',
        id: 'properties',
        placement: 'left',
    },
    {
        sel: '[data-tour="tabs"]',
        chapter: 'build',
        id: 'tabs',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="save"]',
        chapter: 'build',
        id: 'save',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="run"]',
        chapter: 'build',
        id: 'run',
        placement: 'bottom',
    },
    {
        sel: '[data-tour="live"]',
        chapter: 'build',
        id: 'live',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="bottom"]',
        chapter: 'build',
        id: 'bottom',
        placement: 'top',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="duckie"]',
        chapter: 'build',
        id: 'duckie',
        placement: 'bottom',
        requireAnchor: true,
    },

    // ---- Operate -----------------------------------------------------------
    {
        sel: '[data-tour="home"]',
        chapter: 'operate',
        id: 'home',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="home"]',
        chapter: 'operate',
        id: 'schedules',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="dashboard"]',
        chapter: 'operate',
        id: 'dashboard',
        placement: 'bottom',
        surface: 'desktop',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="git"]',
        chapter: 'operate',
        id: 'git',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="context"]',
        chapter: 'operate',
        id: 'context',
        placement: 'bottom',
        requireAnchor: true,
    },

    // ---- Govern ------------------------------------------------------------
    {
        sel: '[data-tour="lineage"]',
        chapter: 'govern',
        id: 'lineage',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="trust"]',
        chapter: 'govern',
        id: 'trust',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="dives"]',
        chapter: 'govern',
        id: 'dives',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="home"]',
        chapter: 'govern',
        id: 'catalog',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: '[data-tour="topbar"]',
        chapter: 'govern',
        id: 'mcp',
        placement: 'bottom',
    },

    // ---- Finish ------------------------------------------------------------
    {
        sel: '[data-tour="settings"]',
        chapter: 'finish',
        id: 'settings',
        placement: 'bottom',
        requireAnchor: true,
    },
    {
        sel: null,
        chapter: 'finish',
        id: 'finish',
        placement: 'center',
    },
];

// Keep only the steps that apply to the current surface, so the step count and
// the spotlights always match what is actually on screen. The desktop-only
// dashboard button, for example, is not rendered in the web editor, so its step
// is dropped there rather than degrading to an anchorless centered card.
const onWeb = isWebBackend();
const forThisSurface: Step[] = ALL_STEPS.filter((s) => {
    const surface = s.surface ?? 'both';
    return surface === 'both' || (surface === 'desktop' && !onWeb) || (surface === 'web' && onWeb);
});

/**
 * The steps to actually walk, decided when the tour opens rather than at import.
 *
 * Surface is known at build time, but a great deal is not: the Dives button can be switched
 * off in Settings, the console button needs an open workspace, the context switcher only
 * appears once a context exists. Those are decided by the state of the app at the moment
 * somebody opens the tour, so the list is built then.
 *
 * A step marked `requireAnchor` whose element is absent is dropped. Everything else keeps
 * the old forgiving behaviour: a missing anchor degrades to a centered card rather than
 * breaking the tour.
 */
function stepsOnScreen(): Step[] {
    return forThisSurface.filter((s) => {
        if (!s.requireAnchor || !s.sel) return true;
        const el = document.querySelector(s.sel) as HTMLElement | null;
        if (!el) return false;
        // Present in the DOM but not shown: a display:none ancestor gives a zero box, and
        // spotlighting it would dim the screen around nothing.
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
    });
}

type TourProps = {
    /**
     * Whether the app is past its startup screens and the workspace is really usable.
     *
     * The tour used to work this out by looking for known overlay classes, and that was
     * wrong twice: first the Home launcher, then the account dialog, each a class it had
     * never heard of, each ending with a tour spotlighting things behind a screen somebody
     * was still filling in. App is the only thing that knows which gates are open, so it
     * says so, and the guesswork is gone.
     */
    ready?: boolean;
};

export function GuidedTour({ ready = true }: TourProps) {
    const { t } = useTranslation();
    const [active, setActive] = useState(false);
    // Whether this is the first run rather than a replay.
    //
    // On a first run the tour has to be walked: it is the only moment we know somebody is
    // looking, and a product with this much in it is not discoverable by clicking around.
    // Replaying it from Settings is a different situation - they already know what it is and
    // asked for it - so there the Skip button comes back and the dimmed backdrop closes it.
    const [mandatory, setMandatory] = useState(false);
    const [i, setI] = useState(0);
    const [box, setBox] = useState<Box | null>(null);
    const [steps, setSteps] = useState<Step[]>(forThisSurface);
    const tipRef = useRef<HTMLDivElement>(null);
    const [tipH, setTipH] = useState(280);

    // Open on first run, once the app says its startup screens are done AND the workspace
    // UI is really mounted (poll for the canvas anchor).
    //
    // `ready` is the important half. Anything still owning the screen - engine setup, the
    // account dialog, the workspace picker, the local-or-server question, Home - keeps it
    // false, and none of them have to be recognised by class here. The canvas poll stays
    // because "App thinks it is ready" and "the canvas has actually painted" are different
    // moments, and the spotlight needs the second one.
    useEffect(() => {
        if (!ready) return;
        if (localStorage.getItem(SEEN_KEY)) return;
        let tries = 0;
        const iv = setInterval(() => {
            // Any other modal opened by hand still defers, and does not burn the timeout.
            if (document.querySelector('.modal-backdrop')) return;
            tries += 1;
            if (document.querySelector('[data-tour="canvas"]')) {
                clearInterval(iv);
                setSteps(stepsOnScreen());
                setMandatory(true);
                setActive(true);
            } else if (tries > 40) {
                clearInterval(iv);
            }
        }, 600);
        return () => clearInterval(iv);
    }, [ready]);
    useEffect(() => {
        const start = () => {
            setI(0);
            setSteps(stepsOnScreen());
            setMandatory(false);
            setActive(true);
        };
        window.addEventListener('duckle:start-tour', start);
        return () => window.removeEventListener('duckle:start-tour', start);
    }, []);

    const measure = useCallback(() => {
        const step = steps[i];
        if (!step?.sel) {
            setBox(null);
            return;
        }
        const el = document.querySelector(step.sel) as HTMLElement | null;
        if (!el) {
            setBox(null);
            return;
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
            setBox(null);
            return;
        }
        setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    }, [i]);

    useLayoutEffect(() => {
        if (!active) return;
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
        };
    }, [active, measure]);

    // Every render, because anything that re-renders can change the card's height. It runs
    // before paint, so a first guess is never seen.
    useLayoutEffect(() => {
        if (tipRef.current) setTipH(tipRef.current.offsetHeight);
    });

    if (!active) return null;

    const step = steps[i];
    const last = i === steps.length - 1;
    const close = () => {
        localStorage.setItem(SEEN_KEY, '1');
        setActive(false);
        // Home held back for this. Telling it we are done is what lets a first run be
        // tour-then-Home rather than the two of them arriving together.
        window.dispatchEvent(new Event(TOUR_FINISHED_EVENT));
    };
    const next = () => (last ? close() : setI((n) => n + 1));
    const back = () => setI((n) => Math.max(0, n - 1));

    // Very large targets get a centered card since "beside" has no room (e.g. the canvas).
    const PAD = 10;
    const TIP_W = 340;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const big = !!box && box.height > vh * 0.7 && box.width > vw * 0.45;
    // Numbers rather than a centring transform, which tour-pop overrides while it plays.
    const tipStyle: React.CSSProperties =
        !box || big
            ? { top: Math.max(12, (vh - tipH) / 2), left: Math.max(12, (vw - TIP_W) / 2) }
            : placeTip(box, step.placement ?? 'bottom', { width: vw, height: vh }, { width: TIP_W, height: tipH });

    return (
        <div className="tour-root" role="dialog" aria-modal="true" aria-label={t('guidedTour.ariaLabel')}>
            {/* Spotlight: a transparent box with a huge shadow dims everything else. */}
            {box ? (
                <div
                    className="tour-spotlight"
                    style={{
                        top: box.top - PAD,
                        left: box.left - PAD,
                        width: box.width + PAD * 2,
                        height: box.height + PAD * 2,
                    }}
                />
            ) : (
                // A click outside closes a replay, but not the first run: there is no Skip
                // there, and a stray click on the dimmed area must not become one.
                <div className="tour-dim" onClick={mandatory ? undefined : close} />
            )}
            <div className="tour-tip" ref={tipRef} style={{ ...tipStyle, width: TIP_W }}>
                <div className="tour-progress">
                    {step.chapter ? <span className="tour-chapter">{t(`guidedTour.chapters.${step.chapter}`)}</span> : null}
                    {t('guidedTour.progress', { n: i + 1, total: steps.length })}
                </div>
                <h3 className="tour-title">{t(`guidedTour.steps.${step.id}.title`)}</h3>
                <p className="tour-body">{t(`guidedTour.steps.${step.id}.body`)}</p>
                <div className="tour-dots">
                    {steps.map((_, n) => (
                        <span key={n} className={n === i ? 'tour-dot on' : 'tour-dot'} />
                    ))}
                </div>
                <div className="tour-actions">
                    {mandatory ? (
                        // Says how much is left, so walking it feels finite rather than
                        // open-ended. It replaces Skip rather than sitting beside it, which
                        // keeps the row's layout identical either way.
                        <span className="tour-remaining">
                            {last ? t('guidedTour.lastOne') : t('guidedTour.toGo', { n: steps.length - i - 1 })}
                        </span>
                    ) : (
                        <button type="button" className="tour-skip" onClick={close}>
                            {t('guidedTour.skip')}
                        </button>
                    )}
                    <div className="tour-nav">
                        {i > 0 ? (
                            <button type="button" className="tour-btn" onClick={back}>
                                {t('guidedTour.back')}
                            </button>
                        ) : null}
                        <button type="button" className="tour-btn primary" onClick={next}>
                            {last ? t('guidedTour.getStarted') : t('guidedTour.next')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
