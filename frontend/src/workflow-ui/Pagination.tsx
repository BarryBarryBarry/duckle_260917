// A plain page navigator: first, previous, numbered pages with gaps, next,
// last, a page-size choice and the total. The frontend has no UI library, so
// this is the one the run metrics page uses.

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { pageItems, totalPages } from './run-metrics-format';

type Props = {
    page: number;
    pageSize: number;
    total: number;
    pageSizes: readonly number[];
    onPage: (page: number) => void;
    onPageSize: (size: number) => void;
};

export default function Pagination({ page, pageSize, total, pageSizes, onPage, onPageSize }: Props) {
    const { t } = useTranslation();
    const pages = totalPages(total, pageSize);
    const go = (p: number) => {
        if (p >= 1 && p <= pages && p !== page) onPage(p);
    };
    const step = (label: string, target: number, disabled: boolean, icon: ReactNode) => (
        <button
            type="button"
            className="pager-btn"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => go(target)}
        >
            {icon}
        </button>
    );
    return (
        <nav className="pager" aria-label={t('metrics.pager.ariaLabel')}>
            <span className="pager-total">{t('metrics.pager.total', { count: total })}</span>
            {step(t('metrics.pager.first'), 1, page <= 1, <ChevronsLeft size={14} />)}
            {step(t('metrics.pager.previous'), page - 1, page <= 1, <ChevronLeft size={14} />)}
            {pageItems(page, pages).map((item, i) =>
                item === 'gap' ? (
                    <span key={`gap-${i}`} className="pager-gap">
                        …
                    </span>
                ) : (
                    <button
                        key={item}
                        type="button"
                        className={`pager-btn pager-num${item === page ? ' pager-current' : ''}`}
                        aria-current={item === page ? 'page' : undefined}
                        onClick={() => go(item)}
                    >
                        {item}
                    </button>
                ),
            )}
            {step(t('metrics.pager.next'), page + 1, page >= pages, <ChevronRight size={14} />)}
            {step(t('metrics.pager.last'), pages, page >= pages, <ChevronsRight size={14} />)}
            <select
                className="pager-size"
                aria-label={t('metrics.pager.pageSize')}
                value={pageSize}
                onChange={(e) => onPageSize(Number(e.target.value))}
            >
                {pageSizes.map((s) => (
                    <option key={s} value={s}>
                        {t('metrics.pager.perPage', { count: s })}
                    </option>
                ))}
            </select>
        </nav>
    );
}
