// The user guide as a right-hand tool window: the bundled Markdown manual with
// a table of contents, in-guide anchor links, and click-to-enlarge images.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, BookOpen, Loader2, Maximize2, Minimize2, X } from 'lucide-react';
import { loadManual, resolveGuideImage, slugifyHeading } from '../guide';
import { openExternal } from '../tauri-io';
import { useMaximized } from './maximize';

/** The guide keeps its own width: reading wants more room than Properties
 *  or the Agent, so it may grow well past their shared limit. */
export const GUIDE_WIDTH = {
    storageKey: 'duckle.guide.width',
    defaultWidth: 480,
    minWidth: 280,
    maxWidth: 1600,
} as const;

type TocEntry = { id: string; text: string; level: number };
type ZoomedImage = { src: string; alt: string };

export default function GuidePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t, i18n } = useTranslation();
    const [content, setContent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [toc, setToc] = useState<TocEntry[]>([]);
    const [zoomed, setZoomed] = useState<ZoomedImage | null>(null);
    const [maximized, setMaximized] = useMaximized(open);
    const scrollRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        setError(null);
        loadManual(i18n.language)
            .then(text => {
                if (!cancelled) setContent(text);
            })
            .catch(e => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [i18n.language]);

    // Heading ids are assigned from the rendered DOM, so the table of contents
    // and in-guide `#anchor` links agree on one slug per heading.
    useLayoutEffect(() => {
        const body = bodyRef.current;
        if (!body || content === null) return;
        const seen = new Map<string, number>();
        const entries: TocEntry[] = [];
        body.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4').forEach(h => {
            const text = h.textContent ?? '';
            const base = slugifyHeading(text) || 'section';
            const n = seen.get(base) ?? 0;
            seen.set(base, n + 1);
            h.id = n === 0 ? base : `${base}-${n}`;
            const level = Number(h.tagName.slice(1));
            if (level === 2 || level === 3) entries.push({ id: h.id, text, level });
        });
        setToc(entries);
        scrollRef.current?.scrollTo({ top: 0 });
    }, [content]);

    const scrollToAnchor = useCallback((id: string) => {
        const target = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    const handleLink = useCallback(
        (e: ReactMouseEvent<HTMLAnchorElement>, href: string | undefined) => {
            e.preventDefault();
            if (!href) return;
            if (href.startsWith('#')) {
                scrollToAnchor(decodeURIComponent(href.slice(1)));
            } else if (/^(https?:|mailto:)/i.test(href)) {
                void openExternal(href);
            }
        },
        [scrollToAnchor],
    );

    // Esc closes an enlarged image first, then leaves the maximized view.
    useEffect(() => {
        if (!zoomed && !maximized) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (zoomed) setZoomed(null);
            else setMaximized(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [zoomed, maximized]);

    const components = useMemo<Components>(
        () => ({
            a: ({ href, children, title }) => (
                <a href={href} title={title} onClick={e => handleLink(e, href)}>
                    {children}
                </a>
            ),
            img: ({ src, alt, title }) => {
                const url = resolveGuideImage(typeof src === 'string' ? src : undefined);
                if (!url) return null;
                return (
                    <img
                        src={url}
                        alt={alt ?? ''}
                        title={title ?? t('guide.zoomImage')}
                        loading="lazy"
                        className="guide-image"
                        onClick={() => setZoomed({ src: url, alt: alt ?? '' })}
                    />
                );
            },
        }),
        [handleLink, t],
    );

    const maximizeLabel = maximized
        ? t('panel.restoreSize', { name: t('guide.title') })
        : t('panel.maximize', { name: t('guide.title') });

    return (
        <aside className={`guide-panel${maximized ? ' tool-maximized' : ''}`} aria-label={t('guide.title')}>
            <header className="guide-panel-head">
                <div className="guide-panel-title">
                    <BookOpen size={14} aria-hidden="true" />
                    <span>{t('guide.title')}</span>
                </div>
                <div className="guide-panel-actions">
                    <button
                        type="button"
                        className="guide-panel-btn"
                        onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                        title={t('guide.backToTop')}
                        aria-label={t('guide.backToTop')}
                    >
                        <ArrowUp size={14} />
                    </button>
                    <button
                        type="button"
                        className="guide-panel-btn"
                        onClick={() => setMaximized(m => !m)}
                        title={maximizeLabel}
                        aria-label={maximizeLabel}
                        aria-pressed={maximized}
                    >
                        {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button
                        type="button"
                        className="guide-panel-btn"
                        onClick={onClose}
                        title={t('common.close')}
                        aria-label={t('common.close')}
                    >
                        <X size={14} />
                    </button>
                </div>
            </header>

            <div className="guide-panel-scroll" ref={scrollRef}>
                {error ? (
                    <div className="guide-panel-state">{t('guide.loadFailed', { error })}</div>
                ) : content === null ? (
                    <div className="guide-panel-state">
                        <Loader2 size={16} className="spin" />
                        <span>{t('common.loading')}</span>
                    </div>
                ) : (
                    <>
                        {toc.length > 0 ? (
                            <nav className="guide-toc" aria-label={t('guide.toc')}>
                                <div className="guide-toc-title">{t('guide.toc')}</div>
                                <ul>
                                    {toc.map(entry => (
                                        <li key={entry.id} className={`guide-toc-l${entry.level}`}>
                                            <a href={`#${entry.id}`} onClick={e => handleLink(e, `#${entry.id}`)}>
                                                {entry.text}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </nav>
                        ) : null}
                        <div className="markdown-body guide-body" ref={bodyRef}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                                {content}
                            </ReactMarkdown>
                        </div>
                    </>
                )}
            </div>

            {zoomed
                ? createPortal(
                      <div
                          className="guide-lightbox"
                          role="dialog"
                          aria-modal="true"
                          aria-label={zoomed.alt || t('guide.zoomImage')}
                          onClick={() => setZoomed(null)}
                      >
                          <img src={zoomed.src} alt={zoomed.alt} />
                          {zoomed.alt ? <div className="guide-lightbox-caption">{zoomed.alt}</div> : null}
                      </div>,
                      document.body,
                  )
                : null}
        </aside>
    );
}
