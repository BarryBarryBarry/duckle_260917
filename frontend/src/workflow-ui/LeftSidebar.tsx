import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Boxes, FolderTree } from 'lucide-react';
import Palette from './Palette';
import ProjectTree from './ProjectTree';
import type { RepoItem } from '../repo-types';

const WIDTH_KEY = 'duckle.leftSidebar.width';
const DEFAULT_WIDTH = 272;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

function savedWidth(): number {
    try {
        const saved = Number(localStorage.getItem(WIDTH_KEY));
        return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
    } catch {
        return DEFAULT_WIDTH;
    }
}

function storeWidth(width: number) {
    try {
        localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
        /* localStorage unavailable - non-fatal */
    }
}

type SideTab = 'project' | 'palette';

type Props = {
    repoItems: RepoItem[];
    activeJobId: string;
    openJobIds: Set<string>;
    onOpenPipeline: (id: string) => void;
    onOpenItem: (item: RepoItem) => void;
    onNewPipeline: (parentId: string) => void;
    onNewFolder: (parentId: string) => void;
    /** Undefined in the web editor, where the engine-side translator is unreachable. */
    onImportJob?: () => void;
    onNewContext: (parentId: string) => void;
    onNewDocument: (parentId: string) => void;
    onNewRoutine: (parentId: string) => void;
    onNewDive: (parentId: string) => void;
    onNewDashboard: (parentId: string) => void;
    onRenameRepoItem: (id: string, newName: string) => void;
    onDuplicateRepoItem: (id: string) => void;
    onDeleteRepoItem: (id: string) => void;
    onMoveRepoItem: (id: string, newParentId: string) => void;
    onSchedulePipeline: (id: string) => void;
    onBackfillPipeline: (id: string) => void;
    onBuildPipeline: (id: string) => void;
    onDeployPipeline?: (id: string) => void;
    /** Plan 003: open the workspace's run metrics page. */
    onOpenRunMetrics?: () => void;
    /** Hidden from the top bar's sidebar toggle; stays mounted so its state survives. */
    hidden?: boolean;
};

export default function LeftSidebar({
    repoItems,
    activeJobId,
    openJobIds,
    onOpenPipeline,
    onOpenItem,
    onNewPipeline,
    onNewFolder,
    onImportJob,
    onNewContext,
    onNewDocument,
    onNewRoutine,
    onNewDive,
    onNewDashboard,
    onRenameRepoItem,
    onDuplicateRepoItem,
    onDeleteRepoItem,
    onMoveRepoItem,
    onSchedulePipeline,
    onBackfillPipeline,
    onBuildPipeline,
    onDeployPipeline,
    onOpenRunMetrics,
    hidden = false,
}: Props) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<SideTab>('palette');
    // Drag the right edge to resize; double-click it to go back to the default.
    const [width, setWidth] = useState(savedWidth);
    const widthRef = useRef(width);
    const [resizing, setResizing] = useState(false);

    const startResize = (e: ReactMouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        // What is on screen: the CSS may have narrowed it to fit a small window.
        const shown = e.currentTarget.parentElement?.getBoundingClientRect().width;
        const startW = shown ? Math.round(shown) : widthRef.current;
        // Never squeeze the canvas below a usable width, nor snap narrower than
        // the panel already is on a small window.
        const max = Math.max(startW, Math.min(MAX_WIDTH, window.innerWidth - 480));
        setResizing(true);
        const onMove = (ev: MouseEvent) => {
            const next = Math.max(MIN_WIDTH, Math.min(max, startW + (ev.clientX - startX)));
            widthRef.current = next;
            setWidth(next);
        };
        const onUp = () => {
            setResizing(false);
            storeWidth(widthRef.current);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    const resetWidth = () => {
        widthRef.current = DEFAULT_WIDTH;
        setWidth(DEFAULT_WIDTH);
        storeWidth(DEFAULT_WIDTH);
    };

    return (
        <aside
            className={'left-sidebar' + (hidden ? ' is-hidden' : '') + (resizing ? ' is-resizing' : '')}
            style={{ width }}
            data-tour="palette"
            aria-hidden={hidden || undefined}
        >
            <div
                className="left-sidebar-resize"
                onMouseDown={startResize}
                onDoubleClick={resetWidth}
                aria-hidden="true"
            />
            <div className="left-sidebar-tabs" role="tablist" aria-label={t('sidebar.ariaLabel')}>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'project'}
                    className="left-sidebar-tab"
                    onClick={() => setTab('project')}
                >
                    <FolderTree className="left-sidebar-tab-icon" size={13} aria-hidden="true" />
                    {t('sidebar.project')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'palette'}
                    className="left-sidebar-tab"
                    onClick={() => setTab('palette')}
                >
                    <Boxes className="left-sidebar-tab-icon" size={13} aria-hidden="true" />
                    {t('sidebar.components')}
                </button>
                {onOpenRunMetrics ? (
                    <button
                        type="button"
                        className="left-sidebar-tab left-sidebar-action"
                        title={t('metrics.open')}
                        onClick={onOpenRunMetrics}
                    >
                        <Activity className="left-sidebar-tab-icon" size={13} aria-hidden="true" />
                        {t('metrics.title')}
                    </button>
                ) : null}
            </div>
            <div className="left-sidebar-body">
                {tab === 'palette' ? (
                    <Palette />
                ) : (
                    <ProjectTree
                        items={repoItems}
                        activeJobId={activeJobId}
                        openJobIds={openJobIds}
                        onOpenPipeline={onOpenPipeline}
                        onOpenItem={onOpenItem}
                        onNewPipeline={onNewPipeline}
                        onNewFolder={onNewFolder}
                        onImportJob={onImportJob}
                        onNewContext={onNewContext}
                        onNewDocument={onNewDocument}
                        onNewRoutine={onNewRoutine}
                        onNewDive={onNewDive}
                        onNewDashboard={onNewDashboard}
                        onRename={onRenameRepoItem}
                        onDuplicate={onDuplicateRepoItem}
                        onDelete={onDeleteRepoItem}
                        onMove={onMoveRepoItem}
                        onSchedulePipeline={onSchedulePipeline}
                        onBackfillPipeline={onBackfillPipeline}
                        onBuildPipeline={onBuildPipeline}
                        onDeployPipeline={onDeployPipeline}
                    />
                )}
            </div>
        </aside>
    );
}
