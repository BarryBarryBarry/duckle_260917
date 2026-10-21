import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Check, Clipboard, Loader2, X } from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { copyText } from '../tauri-io';
import { isWebBackend } from '../web-fs';
import {
    mcpConnectionInfo,
    connectClaudeCode,
    mcpInjectConfig,
    type McpConnInfo,
    type McpClient,
} from '../tauri-bridge';

type Busy = null | 'claude_code' | 'claude_desktop' | 'cursor';

/**
 * Compact popup that connects Duckle to an MCP-capable AI (Claude Code,
 * Claude Desktop, Cursor, etc.). It bundles the duckle-mcp server with the
 * real resolved paths filled in: one-click connect buttons per client, with
 * the raw command + config tucked into collapsible sections.
 */
export function McpModal({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    // A simple read-only prompt the user can paste to confirm the connection.
    const samplePrompt = t('mcp.samplePrompt');
    const [info, setInfo] = useState<McpConnInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [busy, setBusy] = useState<Busy>(null);
    const [msg, setMsg] = useState<{ ok: boolean; text?: string; label?: string } | null>(null);

    useEffect(() => {
        let alive = true;
        // The bridge refuses in the web editor with an English message; show the localized one.
        if (isWebBackend()) {
            setError(t('mcp.webUnavailable'));
            return;
        }
        mcpConnectionInfo()
            .then(i => { if (alive) setInfo(i); })
            .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
    }, [t]);

    const copy = async (key: string, text: string) => {
        if (await copyText(text)) {
            setCopied(key);
            setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
        }
    };

    const connectClaude = async () => {
        setBusy('claude_code');
        setMsg(null);
        try {
            await connectClaudeCode();
            setMsg({ ok: true, label: 'Claude Code' });
        } catch (e) {
            setMsg({ ok: false, text: String(e) });
        } finally {
            setBusy(null);
        }
    };

    const inject = async (client: McpClient, label: string) => {
        setBusy(client);
        setMsg(null);
        try {
            await mcpInjectConfig(client);
            setMsg({ ok: true, label });
        } catch (e) {
            setMsg({ ok: false, text: String(e) });
        } finally {
            setBusy(null);
        }
    };

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };

    return createPortal(
        <div className="modal-backdrop" onClick={handleBackdrop}>
            <div className="modal mcp-modal" role="dialog" aria-modal="true" aria-label={t('mcp.short')}>
                <div className="modal-header">
                    <div className="modal-title">
                        <ClaudeIcon size={16} className="claude-icon claude-icon-glow" />
                        <span style={{ marginLeft: 8 }}>{t('mcp.title')}</span>
                    </div>
                    <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>
                        <X size={16} />
                    </button>
                </div>

                <div className="modal-body">
                    {error ? (
                        <p className="mcp-warn">{t('mcp.loadError', { error })}</p>
                    ) : !info ? (
                        <p className="mcp-muted"><Loader2 size={14} className="spin" /> {t('mcp.preparing')}</p>
                    ) : (
                        <>
                            <p className="mcp-muted">{t('mcp.intro')}</p>

                            {!info.bundled && (
                                <p className="mcp-warn">
                                    <Trans i18nKey="mcp.notBundled" components={{ code: <code /> }} />
                                </p>
                            )}
                            {info.bundled && !info.duckdbFound && (
                                <p className="mcp-warn">{t('mcp.noDuckdb')}</p>
                            )}

                            {msg && (msg.ok ? (
                                <div className="mcp-ok">
                                    {t('mcp.added', { client: msg.label })}
                                    <div className="mcp-sample">
                                        <code className="mcp-code">{samplePrompt}</code>
                                        <button type="button" className="btn mcp-copy" onClick={() => void copy('sample', samplePrompt)}>
                                            {copied === 'sample' ? <><Check size={12} /> {t('mcp.copied')}</> : <><Clipboard size={12} /> {t('mcp.copy')}</>}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <p className="mcp-warn">{msg.text}</p>
                            ))}

                            {/* Claude Code */}
                            <div className="mcp-section">
                                <div className="mcp-section-title">Claude Code</div>
                                <div className="mcp-actions">
                                    <button
                                        type="button"
                                        className="btn btn-claude"
                                        onClick={() => void connectClaude()}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'claude_code'
                                            ? <><Loader2 size={13} className="spin" /> {t('mcp.connecting')}</>
                                            : t('mcp.connectClaudeCode')}
                                    </button>
                                    <button type="button" className="btn mcp-copy" onClick={() => void copy('cmd', info.claudeCommand)}>
                                        {copied === 'cmd' ? <><Check size={12} /> {t('mcp.copied')}</> : <><Clipboard size={12} /> {t('mcp.copyCommand')}</>}
                                    </button>
                                </div>
                                <details className="mcp-disclose">
                                    <summary>{t('mcp.showCommand')}</summary>
                                    <code className="mcp-code">{info.claudeCommand}</code>
                                </details>
                            </div>

                            {/* Claude Desktop / Cursor / other */}
                            <div className="mcp-section">
                                <div className="mcp-section-title">{t('mcp.otherClients')}</div>
                                <div className="mcp-actions">
                                    <button
                                        type="button"
                                        className="btn btn-claude"
                                        onClick={() => void inject('claude_desktop', 'Claude Desktop')}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'claude_desktop'
                                            ? <><Loader2 size={13} className="spin" /> {t('mcp.adding')}</>
                                            : t('mcp.addTo', { client: 'Claude Desktop' })}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-claude"
                                        onClick={() => void inject('cursor', 'Cursor')}
                                        disabled={!info.bundled || busy !== null}
                                    >
                                        {busy === 'cursor'
                                            ? <><Loader2 size={13} className="spin" /> {t('mcp.adding')}</>
                                            : t('mcp.addTo', { client: 'Cursor' })}
                                    </button>
                                    <button type="button" className="btn mcp-copy" onClick={() => void copy('json', info.configJson)}>
                                        {copied === 'json' ? <><Check size={12} /> {t('mcp.copied')}</> : <><Clipboard size={12} /> {t('mcp.copyConfig')}</>}
                                    </button>
                                </div>
                                <p className="mcp-hint">{t('mcp.hint')}</p>
                                <details className="mcp-disclose">
                                    <summary>{t('mcp.showConfig')}</summary>
                                    <pre className="mcp-code mcp-pre">{info.configJson}</pre>
                                </details>
                            </div>

                            <details className="mcp-paths">
                                <summary>{t('mcp.resolvedPaths')}</summary>
                                <div className="mcp-kv"><span>{t('mcp.mcpServer')}</span><code>{info.mcpPath || t('mcp.pathNotBundled')}</code></div>
                                <div className="mcp-kv"><span>DuckDB</span><code>{info.duckdbPath || t('mcp.pathNotInstalled')}</code></div>
                                <div className="mcp-kv"><span>{t('mcp.runner')}</span><code>{info.runnerPath || t('mcp.pathNotBundled')}</code></div>
                            </details>
                        </>
                    )}
                </div>

                <div className="modal-footer">
                    <button type="button" className="btn" onClick={onClose}>{t('mcp.done')}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
