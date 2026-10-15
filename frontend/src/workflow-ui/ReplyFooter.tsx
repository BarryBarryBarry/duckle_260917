// The strip under a finished assistant reply: copy, token usage, time taken
// and the time it finished. Shared by the Duckie and Pi Agent chat panels.
import { useCallback, useEffect, useState } from 'react';
import { Check, Clock, Copy, Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

export type ReplyUsage = {
    input?: number;
    output?: number;
    total?: number;
    cacheRead?: number;
    /** Model calls the turn made. */
    calls?: number;
};

export default function ReplyFooter({
    text,
    usage,
    startedAt,
    finishedAt: finished,
    reportedTitle,
    estimateTitle,
}: {
    /** What the copy button copies. */
    text: string;
    usage?: ReplyUsage;
    startedAt?: number;
    finishedAt?: number;
    /** Tooltip for a usage figure the agent reported. */
    reportedTitle: string;
    /** Tooltip for the length-based estimate used when it reported none. */
    estimateTitle: string;
}) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1600);
        return () => window.clearTimeout(timer);
    }, [copied]);

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }, [text]);

    const tokens = formatTokenUsage(text, usage, reportedTitle, estimateTitle);
    const elapsed = formatElapsed(startedAt, finished);
    const finishedAt = finished ? formatClock(finished) : null;

    return (
        <div className="chat-bubble-footer">
            <button
                type="button"
                className={`chat-bubble-footer-btn ${copied ? 'chat-bubble-footer-btn-done' : ''}`}
                onClick={() => void copy()}
                title={copied ? t('reply.copied') : t('reply.copy')}
                aria-label={copied ? t('reply.copied') : t('reply.copy')}
            >
                {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <div className="chat-bubble-metrics">
                {tokens ? (
                    <span className="chat-bubble-metric" title={tokens.title}>
                        <Gauge size={12} aria-hidden="true" />
                        {t('reply.usage', { value: tokens.label })}
                    </span>
                ) : null}
                {elapsed ? (
                    <span className="chat-bubble-metric">
                        <Clock size={12} aria-hidden="true" />
                        {t('reply.elapsed', { value: elapsed })}
                    </span>
                ) : null}
                {finishedAt ? <span className="chat-bubble-metric">{finishedAt}</span> : null}
            </div>
        </div>
    );
}

/** The agent does not always report token counts, so an estimate is labelled
 *  as one rather than presented as a real accounting figure. */
function formatTokenUsage(
    text: string,
    usage: ReplyUsage | undefined,
    reportedTitle: string,
    estimateTitle: string,
): { label: string; title: string } | null {
    const reported = usage?.total ?? sumTokens(usage?.input, usage?.output);
    if (reported != null) {
        const parts: string[] = [];
        if (usage?.input != null) {
            const cached = usage.cacheRead != null && usage.input > 0
                ? i18n.t('reply.cacheHit', {
                      count: formatTokenCount(usage.cacheRead),
                      pct: ((usage.cacheRead / usage.input) * 100).toFixed(1),
                  })
                : '';
            parts.push(i18n.t('reply.input', { count: formatTokenCount(usage.input) }) + cached);
        }
        if (usage?.output != null) parts.push(i18n.t('reply.output', { count: formatTokenCount(usage.output) }));
        if (usage?.calls != null) parts.push(i18n.t('reply.calls', { count: usage.calls }));
        return {
            label: `${formatTokenCount(reported)} tok`,
            title: parts.length ? parts.join(' · ') : reportedTitle,
        };
    }
    if (!text) return null;
    const estimated = Math.max(1, Math.round(text.length / 3.2));
    return {
        label: `≈${formatTokenCount(estimated)} tok`,
        title: estimateTitle,
    };
}

function sumTokens(input?: number, output?: number): number | null {
    if (input == null && output == null) return null;
    return (input ?? 0) + (output ?? 0);
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}

function formatElapsed(startedAt?: number, finishedAt?: number): string | null {
    if (startedAt == null || finishedAt == null || finishedAt < startedAt) return null;
    const seconds = Math.round((finishedAt - startedAt) / 1000);
    if (seconds < 60) return i18n.t('reply.seconds', { s: seconds });
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return i18n.t('reply.minutes', { m: minutes, s: String(rest).padStart(2, '0') });
}

function formatClock(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
    });
}

