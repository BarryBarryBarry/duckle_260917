import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    BookMarked,
    Boxes,
    ChevronLeft,
    ClipboardCheck,
    Database,
    GitBranch,
    LayoutGrid,
    Library,
    ListChecks,
    ListOrdered,
    Package,
    ScrollText,
    Settings as SettingsIcon,
    ShieldCheck,
    Sparkles,
    Timer,
    Upload,
    Users,
    Waypoints,
    Workflow,
    X,
} from 'lucide-react';

// The Home launcher: one screen listing everything Duckle can do, so a
// capability is discoverable without knowing which menu hides it.
//
// The reason this file is shaped the way it is: Duckle has now shipped two
// features that existed in the engine and were unreachable from the UI, and a
// launcher is exactly the surface where that failure becomes advertising. So
// "is it built" is encoded in the TYPE, not in a boolean somebody remembers to
// set. A module is either `ready` and carries the function that opens it, or it
// is `planned` and structurally cannot carry one. There is no third state where
// a tile looks live and does nothing, because such a tile cannot be written.

export type ModuleGroup = 'build' | 'operate' | 'govern';

type ModuleBase = {
    id: string;
    name: string;
    /** Plain words, no jargon: what a person gets, not how it works. */
    blurb: string;
    group: ModuleGroup;
    icon: typeof Workflow;
};

/** Shipped, and `open` is what opens it. Non-optional on purpose. */
export type ReadyModule = ModuleBase & {
    status: 'ready';
    open: () => void;
    /** Honest caveat shown on the tile, e.g. a first-use download. */
    note?: string;
    /** Set when the module needs something first, e.g. an open pipeline. */
    disabledReason?: string;
};

/** On the roadmap. `open` is forbidden, so the tile cannot be clicked. */
export type PlannedModule = ModuleBase & {
    status: 'planned';
    open?: never;
    /** What exists today that people confuse this with. */
    note?: string;
};

export type LauncherModule = ReadyModule | PlannedModule;

const GROUP_ORDER: ModuleGroup[] = ['build', 'operate', 'govern'];

const GROUP_LABEL: Record<ModuleGroup, string> = {
    build: 'Build',
    operate: 'Operate',
    govern: 'Govern',
};

/** Home is these three. Everything else is one level in. */
const GROUP_CARD: Record<ModuleGroup, { blurb: string; icon: typeof Workflow }> = {
    build: {
        blurb: 'Design a pipeline, import an existing job, or have AI draft one',
        icon: Workflow,
    },
    operate: {
        blurb: 'Run it, schedule it, ship it to a server, and keep the credentials',
        icon: Timer,
    },
    govern: {
        blurb: 'Prove where the data came from and who is allowed to touch it',
        icon: ShieldCheck,
    },
};

/** Everything the launcher needs from App, so this file owns no app state. */
export type LauncherActions = {
    openDesigner: () => void;
    importJob?: () => void;
    /** Absent when the Duckie assistant is hidden (see features.ts). */
    openDuckie?: () => void;
    openMcp: () => void;
    openRuns: () => void;
    openSchedules: () => void;
    openPlans: () => void;
    openBuild: () => void;
    openWebConsole?: () => void;
    openLineage: () => void;
    openTrust: () => void;
    openCatalog: () => void;
    openDataQuality: () => void;
    openConnections: () => void;
    openGit: () => void;
    openSettings: () => void;
    /** Empty string when nothing is open; gates the per-pipeline modules. */
    activePipelineId: string;
};

export function buildModules(a: LauncherActions): LauncherModule[] {
    const needsPipeline = a.activePipelineId ? undefined : 'Open a pipeline first';

    const mods: LauncherModule[] = [
        // ---- Build ----
        {
            id: 'designer',
            name: 'Pipeline Designer',
            blurb: 'Draw a pipeline on the canvas and run it',
            group: 'build',
            icon: Workflow,
            status: 'ready',
            open: a.openDesigner,
        },
        {
            id: 'mcp',
            name: 'AI Agents',
            blurb: 'Let Claude or Cursor build and run your pipelines',
            group: 'build',
            icon: Boxes,
            status: 'ready',
            open: a.openMcp,
        },

        // ---- Operate ----
        {
            id: 'runs',
            name: 'Runs',
            blurb: 'What ran, how long it took, and what failed',
            group: 'operate',
            icon: ListChecks,
            status: 'ready',
            open: a.openRuns,
            note: 'History is per pipeline; the web console lists them all',
            disabledReason: needsPipeline,
        },
        {
            id: 'schedules',
            name: 'Schedules',
            blurb: 'Run a pipeline on a clock, an interval, or a file landing',
            group: 'operate',
            icon: Timer,
            status: 'ready',
            open: a.openSchedules,
            disabledReason: needsPipeline,
        },
        {
            id: 'plans',
            name: 'Plans',
            blurb: 'Run several pipelines in the order they have to run',
            group: 'operate',
            icon: ListOrdered,
            status: 'ready',
            open: a.openPlans,
            // No disabledReason: a plan belongs to the workspace and orders pipelines
            // across it, so it is worth opening before any one of them is.
        },
        {
            id: 'build',
            name: 'Build and Deploy',
            blurb: 'Package a pipeline into one file that runs on a server',
            group: 'operate',
            icon: Package,
            status: 'ready',
            open: a.openBuild,
            disabledReason: needsPipeline,
        },
        {
            id: 'alerting',
            name: 'Alerting',
            blurb: 'Tell a human when an overnight run fails',
            group: 'operate',
            icon: AlertTriangle,
            status: 'planned',
        },

        // ---- Govern ----
        {
            id: 'lineage',
            name: 'Lineage',
            blurb: 'Trace any output column back to the columns it came from',
            group: 'govern',
            icon: Waypoints,
            status: 'ready',
            open: a.openLineage,
        },
        {
            id: 'trust',
            name: 'Trust Report',
            blurb: 'A scored, itemised health check of the open pipeline',
            group: 'govern',
            icon: ShieldCheck,
            status: 'ready',
            open: a.openTrust,
        },
        {
            id: 'dq',
            name: 'Data Quality',
            blurb: 'Validate, profile, cleanse and mask data as it moves',
            group: 'build',
            icon: ClipboardCheck,
            status: 'ready',
            open: a.openDataQuality,
            note: 'These are canvas components, not a separate screen',
        },
        {
            id: 'catalog',
            name: 'Data Catalog',
            blurb: 'A searchable inventory of every dataset, with owners and tags',
            group: 'govern',
            icon: Library,
            status: 'ready',
            open: a.openCatalog,
        },
        {
            id: 'glossary',
            name: 'Business Glossary',
            blurb: 'Agreed definitions of business terms, linked down to columns',
            group: 'govern',
            icon: BookMarked,
            status: 'planned',
        },
        {
            id: 'mdm',
            name: 'Master Data',
            blurb: 'One golden record per customer, product or supplier',
            group: 'govern',
            icon: Database,
            status: 'planned',
            note: 'Matching and survivorship components already run on the canvas',
        },
        {
            id: 'stewardship',
            name: 'Stewardship',
            blurb: 'A queue where the business fixes the records that failed',
            group: 'govern',
            icon: Users,
            status: 'planned',
        },
        {
            id: 'impact',
            name: 'Impact Analysis',
            blurb: 'Before you change a column, see everything that breaks',
            group: 'govern',
            icon: LayoutGrid,
            status: 'planned',
            note: 'Lineage already shows impact inside a single pipeline',
        },

        // ---- Operate (continued) ----
        {
            id: 'connections',
            name: 'Connections',
            blurb: 'Save credentials once and reuse them across pipelines',
            group: 'operate',
            icon: Database,
            status: 'ready',
            open: a.openConnections,
        },
        {
            id: 'git',
            name: 'Version Control',
            blurb: 'Commit, push and pull your workspace',
            group: 'operate',
            icon: GitBranch,
            status: 'ready',
            open: a.openGit,
        },
        {
            id: 'settings',
            name: 'Settings',
            blurb: 'Engine, AI, proxy, memory and appearance',
            group: 'operate',
            icon: SettingsIcon,
            status: 'ready',
            open: a.openSettings,
        },
        {
            id: 'audit',
            name: 'Audit Log',
            blurb: 'A tamper-evident record of who changed and ran what',
            group: 'govern',
            icon: ScrollText,
            status: 'planned',
        },
        {
            id: 'rbac',
            name: 'Users and Roles',
            blurb: 'Who may design, who may run, who may only look',
            group: 'govern',
            icon: Users,
            status: 'planned',
        },
    ];

    if (a.openDuckie) {
        mods.splice(1, 0, {
            id: 'duckie',
            name: 'Duckie AI',
            blurb: 'Describe a pipeline in plain English and check what it builds',
            group: 'build',
            icon: Sparkles,
            status: 'ready',
            open: a.openDuckie,
            note: 'First use downloads a model, or point it at your own AI endpoint',
        });
    }
    if (a.importJob) {
        mods.splice(1, 0, {
            id: 'import',
            name: 'Import a Job',
            blurb: 'Translate a Talend .item job into a Duckle pipeline',
            group: 'build',
            icon: Upload,
            status: 'ready',
            open: a.importJob,
        });
    }
    if (a.openWebConsole) {
        mods.push({
            id: 'webconsole',
            name: 'Web Console',
            blurb: 'Run and schedule from a browser, on a server',
            group: 'operate',
            icon: Boxes,
            status: 'ready',
            open: a.openWebConsole,
            note: 'Needs a build with the runner bundled',
        });
    }
    return mods;
}

type Props = {
    open: boolean;
    onClose: () => void;
    actions: LauncherActions;
    workspaceName: string | null;
    showOnStartup: boolean;
    onToggleShowOnStartup: (next: boolean) => void;
};

export default function HomeLauncher({
    open,
    onClose,
    actions,
    workspaceName,
    showOnStartup,
    onToggleShowOnStartup,
}: Props) {
    const { t } = useTranslation();
    const closeRef = useRef<HTMLButtonElement>(null);
    // Home is three tiles. Picking one drills into that group.
    const [openGroup, setOpenGroup] = useState<ModuleGroup | null>(null);

    useEffect(() => {
        if (!open) setOpenGroup(null);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            // Escape steps back out of a group before it closes Home.
            if (openGroup) setOpenGroup(null);
            else onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose, openGroup]);

    if (!open) return null;

    const modules = buildModules(actions);
    const readyCount = modules.filter(m => m.status === 'ready').length;
    const shown = openGroup ? modules.filter(m => m.group === openGroup) : [];

    return (
        <div className="home-launcher" role="dialog" aria-modal="true" aria-label={t('launcher.title', 'Home')}>
            <div className={'home-launcher-inner' + (openGroup ? '' : ' is-home')}>
                <header className="home-launcher-head">
                    <div>
                        <h1>{t('launcher.title', 'Home')}</h1>
                        <p className="home-launcher-sub">
                            {workspaceName
                                ? t('launcher.subtitleWs', 'Workspace: {{name}}', { name: workspaceName })
                                : t('launcher.subtitle', 'Pick what you want to do')}
                        </p>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        className="home-launcher-close"
                        onClick={onClose}
                        aria-label={t('common.close', 'Close')}
                    >
                        <X size={18} />
                    </button>
                </header>

                <div className="home-launcher-body">
                    {!openGroup ? (
                        <div className="home-launcher-groups">
                            {GROUP_ORDER.map(group => {
                                const card = GROUP_CARD[group];
                                const GroupIcon = card.icon;
                                const inGroup = modules.filter(m => m.group === group);
                                const ready = inGroup.filter(m => m.status === 'ready').length;
                                return (
                                    <button
                                        key={group}
                                        type="button"
                                        className="home-group-tile"
                                        onClick={() => setOpenGroup(group)}
                                    >
                                        <span className="home-group-rule" aria-hidden="true" />
                                        <span className="home-group-top">
                                            <GroupIcon size={15} />
                                            <span className="home-group-name">
                                                {t(`launcher.group.${group}`, GROUP_LABEL[group])}
                                            </span>
                                        </span>
                                        <span className="home-group-blurb">{card.blurb}</span>
                                        <span className="home-group-foot">
                                            {/* The bar is the readiness number drawn, not decoration:
                                                Govern reading a third full is the enterprise gap. */}
                                            <span className="home-group-meter" aria-hidden="true">
                                                <span
                                                    className="home-group-meter-fill"
                                                    style={{
                                                        width: `${Math.round((ready / Math.max(inGroup.length, 1)) * 100)}%`,
                                                    }}
                                                />
                                            </span>
                                            <span className="home-group-count">
                                                {t('launcher.groupCount', '{{ready}} of {{total}} ready', {
                                                    ready,
                                                    total: inGroup.length,
                                                })}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <section className="home-launcher-group">
                            <button
                                type="button"
                                className="home-launcher-back"
                                onClick={() => setOpenGroup(null)}
                            >
                                <ChevronLeft size={14} />
                                {t(`launcher.group.${openGroup}`, GROUP_LABEL[openGroup])}
                            </button>
                            <div className="home-launcher-grid">
                                {shown.map(m => {
                                        const Icon = m.icon;
                                        // A planned module has no `open` by type, so this
                                        // renders a non-interactive element - it is not a
                                        // button that silently does nothing.
                                        if (m.status === 'planned') {
                                            return (
                                                <div key={m.id} className="home-tile is-planned" aria-disabled="true">
                                                    <span className="home-tile-icon"><Icon size={17} /></span>
                                                    <span className="home-tile-name">
                                                        {m.name}
                                                        <span className="home-tile-badge">
                                                            {t('launcher.planned', 'Planned')}
                                                        </span>
                                                    </span>
                                                    <span className="home-tile-blurb">{m.blurb}</span>
                                                    {m.note ? <span className="home-tile-note">{m.note}</span> : null}
                                                </div>
                                            );
                                        }
                                        const blocked = m.disabledReason;
                                        return (
                                            <button
                                                key={m.id}
                                                type="button"
                                                className={'home-tile' + (blocked ? ' is-blocked' : '')}
                                                disabled={!!blocked}
                                                title={blocked ?? m.blurb}
                                                onClick={() => {
                                                    onClose();
                                                    m.open();
                                                }}
                                            >
                                                <span className="home-tile-icon"><Icon size={17} /></span>
                                                <span className="home-tile-name">{m.name}</span>
                                                <span className="home-tile-blurb">{m.blurb}</span>
                                                {blocked ? (
                                                    <span className="home-tile-note">{blocked}</span>
                                                ) : m.note ? (
                                                    <span className="home-tile-note">{m.note}</span>
                                                ) : null}
                                            </button>
                                        );
                                })}
                            </div>
                        </section>
                    )}
                </div>

                <footer className="home-launcher-foot">
                    <label className="home-launcher-startup">
                        <input
                            type="checkbox"
                            checked={showOnStartup}
                            onChange={e => onToggleShowOnStartup(e.target.checked)}
                        />
                        {t('launcher.showOnStartup', 'Show this when Duckle opens')}
                    </label>
                    <span className="home-launcher-count">
                        {t('launcher.readyCount', '{{n}} available now', { n: readyCount })}
                    </span>
                </footer>
            </div>
        </div>
    );
}
