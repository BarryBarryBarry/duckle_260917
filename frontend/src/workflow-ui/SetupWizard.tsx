import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
    Check,
    Cloud,
    Copy,
    ExternalLink,
    HardDrive,
    Laptop,
    Loader2,
    Server,
    ShieldCheck,
} from 'lucide-react';
import {
    deployTargetClaim,
    deployTargetProbe,
    deployTargetSave,
    runnerStage,
    type StagedRunner,
} from '../tauri-bridge';
import { copyText, openExternal } from '../tauri-io';

/**
 * The one question asked on a first run, and the setup that follows if the answer is
 * "a server".
 *
 * Most people who download this are trying it out on their own machine, and making them
 * configure a team before they can draw a pipeline would be the worst thing we could do to
 * them. So local is a single click that changes nothing and never asks again.
 *
 * The server path exists because a Duckle server brought up in a cloud has nobody
 * administering it yet, and the alternative to finishing that here is a shell session on
 * the box. This app is the setup client: it asks the server which of the two it is, and
 * then either claims it or takes a key for one somebody else already claimed.
 */

type Props = {
    workspacePath: string;
    /** Called once the choice is made, with what was chosen. */
    onDone: (choice: 'local' | 'server') => void;
};

type Step = 'choose' | 'where' | 'standup' | 'address' | 'claim' | 'key' | 'done';

type Provider = 'custom' | 'aws' | 'gcp' | 'azure';

const DEPLOY_GUIDE = 'https://duckle.org/deploy.html';

/**
 * How to get a Duckle server running, per place it might run.
 *
 * Short on purpose. The full recipes - load balancers, secrets, autoscaling, the lot -
 * live on the deploy page, and repeating them here would mean two versions of the same
 * instructions drifting apart. What belongs in a wizard is the shortest path to a server
 * that answers, because the next thing this wizard does is claim it.
 *
 * The cloud commands run a container, so nothing has to be uploaded. Only the custom path
 * hands over a binary, and that binary comes out of this app rather than off the network.
 */
const PROVIDERS: Record<Provider, { brand?: string; command: string }> = {
    // Filled in once the runner is saved, because only then is there a real path to
    // put in it. Naming `duckle-runner` while the file sits somewhere else is not an
    // instruction, it is a riddle.
    custom: { command: '' },
    aws: {
        brand: 'AWS',
        command:
            'docker run -d --restart=always --name duckle -p 8080:8080 \\\n' +
            '  -v /srv/duckle:/workspace ghcr.io/slothflowlabs/duckle-web:latest \\\n' +
            '  duckle-runner serve --host 0.0.0.0 --port 8080 --workspace /workspace',
    },
    gcp: {
        brand: 'Google Cloud',
        command:
            'gcloud compute instances create-with-container duckle \\\n' +
            '  --machine-type=c3-standard-8 \\\n' +
            '  --container-image=ghcr.io/slothflowlabs/duckle-web:latest \\\n' +
            '  --container-command=duckle-runner \\\n' +
            '  --container-arg=serve --container-arg=--host --container-arg=0.0.0.0 \\\n' +
            '  --container-arg=--port --container-arg=8080',
    },
    azure: {
        brand: 'Azure',
        command:
            'docker run -d --restart=always --name duckle -p 8080:8080 \\\n' +
            '  -v /srv/duckle:/workspace ghcr.io/slothflowlabs/duckle-web:latest \\\n' +
            '  duckle-runner serve --host 0.0.0.0 --port 8080 --workspace /workspace',
    },
};

export default function SetupWizard({ workspacePath, onDone }: Props) {
    const { t } = useTranslation();
    const providerName = (id: Provider) => PROVIDERS[id].brand ?? t(`firstRun.wizard.providers.${id}.name`);
    const providerText = (id: Provider, key: string) => t(`firstRun.wizard.providers.${id}.${key}`);
    const code = { code: <code /> };
    const [step, setStep] = useState<Step>('choose');
    const [url, setUrl] = useState('');
    const [name, setName] = useState('production');
    const [admin, setAdmin] = useState('');
    // GHSA-x7pg: the code the server printed to its own output when it started.
    const [setupCode, setSetupCode] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [provider, setProvider] = useState<Provider>('custom');
    const [runner, setRunner] = useState<StagedRunner | null>(null);
    const [copied, setCopied] = useState(false);
    /**
     * The administrator token, shown once after claiming.
     *
     * The app keeps its own encrypted copy regardless; this is so the person who just
     * claimed the server can also open its console in a browser. Without it they
     * administered a server they could not sign in to, and had to run `console add-user`
     * on the box - the one shell step in a flow built to avoid needing one.
     */
    const [adminToken, setAdminToken] = useState<string | null>(null);

    const copy = async (text: string) => {
        setCopied(await copyText(text));
        window.setTimeout(() => setCopied(false), 1600);
    };

    // What to show in the command block. The cloud providers carry a fixed recipe; Custom
    // has none until the runner is saved, because the command has to name the file that was
    // actually written and the workspace it should serve.
    const command = provider === 'custom' ? (runner?.command ?? '') : PROVIDERS[provider].command;

    // The runner is not fetched, it is unpacked: both binaries are inside this app, so the
    // one handed over always matches this build and setup works with no network.
    const getRunner = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            // The open workspace is what this server should serve, so the command it hands
            // back already points at it. A relative ./duckle-workspace would have been a
            // folder that does not exist, relative to a directory nobody named.
            setRunner(
                await runnerStage(
                    provider === 'custom' ? 'native' : 'linux',
                    workspacePath || undefined,
                ),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [provider, workspacePath]);

    const fail = (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
    };

    // Ask the server what it is before asking the person anything. A server nobody has
    // claimed wants a name; one that is already set up wants a key. Guessing wrong means
    // asking for something they do not have yet.
    const probe = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const state = await deployTargetProbe(url);
            setBusy(false);
            setStep(state === 'unclaimed' ? 'claim' : 'key');
        } catch (e) {
            fail(e);
        }
    }, [url]);

    const claim = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            setAdminToken(await deployTargetClaim(workspacePath, name, url, admin, setupCode));
            setBusy(false);
            setStep('done');
        } catch (e) {
            fail(e);
        }
    }, [workspacePath, name, url, admin, setupCode]);

    const saveKey = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            await deployTargetSave(workspacePath, name, url, apiKey);
            setBusy(false);
            setStep('done');
        } catch (e) {
            fail(e);
        }
    }, [workspacePath, name, url, apiKey]);

    const body = (
        <div className="modal-backdrop">
            <div className="modal setup-card">
                {step === 'choose' && (
                    <>
                        <h2 className="setup-title">{t('firstRun.wizard.chooseTitle')}</h2>
                        <p className="setup-sub">{t('firstRun.wizard.chooseSub')}</p>
                        <div className="setup-choices">
                            <button className="setup-choice" onClick={() => onDone('local')}>
                                <Laptop size={22} />
                                <span className="setup-choice-title">{t('firstRun.wizard.localTitle')}</span>
                                <span className="setup-choice-sub">{t('firstRun.wizard.localSub')}</span>
                            </button>
                            <button className="setup-choice" onClick={() => setStep('where')}>
                                <Cloud size={22} />
                                <span className="setup-choice-title">{t('firstRun.wizard.teamTitle')}</span>
                                <span className="setup-choice-sub">{t('firstRun.wizard.teamSub')}</span>
                            </button>
                        </div>
                    </>
                )}

                {step === 'where' && (
                    <>
                        <h2 className="setup-title">{t('firstRun.wizard.whereTitle')}</h2>
                        <p className="setup-sub">{t('firstRun.wizard.whereSub')}</p>
                        <div className="setup-choices">
                            {(Object.keys(PROVIDERS) as Provider[]).map(id => (
                                <button
                                    key={id}
                                    className="setup-choice"
                                    onClick={() => {
                                        setProvider(id);
                                        setRunner(null);
                                        setError(null);
                                        setStep('standup');
                                    }}
                                >
                                    {id === 'custom' ? <HardDrive size={22} /> : <Cloud size={22} />}
                                    <span className="setup-choice-title">{providerName(id)}</span>
                                    <span className="setup-choice-sub">{providerText(id, 'blurb')}</span>
                                </button>
                            ))}
                        </div>
                        <div className="setup-actions">
                            <button className="setup-back" onClick={() => setStep('choose')}>
                                {t('firstRun.wizard.back')}
                            </button>
                        </div>
                    </>
                )}

                {step === 'standup' && (
                    <>
                        <h2 className="setup-title">
                            {provider === 'custom'
                                ? t('firstRun.wizard.standupCustom')
                                : t('firstRun.wizard.standupOn', { provider: providerName(provider) })}
                        </h2>
                        <p className="setup-sub">
                            {t('firstRun.wizard.standupSub', { runsOn: providerText(provider, 'runsOn') })}
                        </p>

                        <ol className="setup-steps">
                            {['step1', 'step2', 'step3'].map(k => (
                                <li key={k}>{providerText(provider, k)}</li>
                            ))}
                        </ol>

                        {provider === 'custom' ? (
                            <>
                                <button
                                    className="setup-alt setup-getrunner"
                                    onClick={getRunner}
                                    disabled={busy}
                                    type="button"
                                >
                                    {busy ? <Loader2 size={15} className="spin" /> : null}
                                    {runner ? t('firstRun.wizard.saveAgain') : t('firstRun.wizard.saveRunner')}
                                </button>
                                {runner ? (
                                    <p className="setup-note">
                                        <Check size={14} />
                                        <span>
                                            <Trans
                                                i18nKey="firstRun.wizard.runnerSaved"
                                                values={{ platform: runner.platform, folder: runner.folder }}
                                                components={code}
                                            />
                                        </span>
                                    </p>
                                ) : null}
                            </>
                        ) : null}

                        {/* The command only exists for Custom once the runner has been saved,
                            because until then there is no real path to put in it. */}
                        {command ? (
                            <div className="setup-command">
                                <pre>{command}</pre>
                                <button className="setup-alt" type="button" onClick={() => copy(command)}>
                                    <Copy size={13} /> {copied ? t('firstRun.wizard.copied') : t('firstRun.wizard.copy')}
                                </button>
                            </div>
                        ) : null}

                        {/* One element after the icon, not loose text: .setup-note is a flex
                            row, so every inline <code> would otherwise become its own flex
                            item and the sentence would come apart into columns. */}
                        <p className="setup-note">
                            <ShieldCheck size={14} />
                            <span>
                                <Trans i18nKey="firstRun.wizard.bindNote" components={code} />
                            </span>
                        </p>

                        {error && <div className="setup-error">{error}</div>}
                        <div className="setup-actions">
                            <button className="setup-back" onClick={() => setStep('where')}>
                                {t('firstRun.wizard.back')}
                            </button>
                            <button
                                className="setup-alt"
                                type="button"
                                onClick={() => void openExternal(DEPLOY_GUIDE)}
                            >
                                <ExternalLink size={13} /> {t('firstRun.wizard.fullGuide')}
                            </button>
                            <button className="setup-next" onClick={() => setStep('address')}>
                                {t('firstRun.wizard.running')}
                            </button>
                        </div>
                    </>
                )}

                {step === 'address' && (
                    <>
                        <h2 className="setup-title">{t('firstRun.wizard.addressTitle')}</h2>
                        <p className="setup-sub">
                            <Trans i18nKey="firstRun.wizard.addressSub" components={code} />
                        </p>
                        <label className="setup-label" htmlFor="setup-url">
                            {t('firstRun.wizard.address')}
                        </label>
                        <input
                            id="setup-url"
                            className="setup-input"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://duckle.internal"
                            autoFocus
                        />
                        <label className="setup-label" htmlFor="setup-name">
                            {t('firstRun.wizard.callIt')}
                        </label>
                        <input
                            id="setup-name"
                            className="setup-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="production"
                        />
                        {error && <div className="setup-error">{error}</div>}
                        <div className="setup-actions">
                            <button className="setup-back" onClick={() => setStep('standup')}>
                                {t('firstRun.wizard.back')}
                            </button>
                            <button className="setup-next" onClick={probe} disabled={busy || !url.trim()}>
                                {busy ? <Loader2 size={15} className="spin" /> : null}
                                {t('firstRun.wizard.continue')}
                            </button>
                        </div>
                    </>
                )}

                {step === 'claim' && (
                    <>
                        <h2 className="setup-title">{t('firstRun.wizard.claimTitle')}</h2>
                        <p className="setup-sub">{t('firstRun.wizard.claimSub')}</p>
                        <label className="setup-label" htmlFor="setup-admin">
                            {t('firstRun.wizard.yourName')}
                        </label>
                        <input
                            id="setup-admin"
                            className="setup-input"
                            value={admin}
                            onChange={(e) => setAdmin(e.target.value)}
                            placeholder={t('firstRun.wizard.namePlaceholder')}
                            autoFocus
                        />
                        <label className="setup-label" htmlFor="setup-code">
                            {t('firstRun.wizard.setupCode')}
                        </label>
                        <input
                            id="setup-code"
                            className="setup-input"
                            value={setupCode}
                            onChange={(e) => setSetupCode(e.target.value)}
                            placeholder={t('firstRun.wizard.codePlaceholder')}
                            spellCheck={false}
                            autoComplete="off"
                        />
                        <p className="setup-note">
                            <ShieldCheck size={14} />
                            <span>
                                <Trans i18nKey="firstRun.wizard.codeNote" components={code} />
                            </span>
                        </p>
                        <p className="setup-note">
                            <ShieldCheck size={14} />
                            <span>{t('firstRun.wizard.keyNote')}</span>
                        </p>
                        {error && <div className="setup-error">{error}</div>}
                        <div className="setup-actions">
                            <button className="setup-back" onClick={() => setStep('address')}>
                                {t('firstRun.wizard.back')}
                            </button>
                            <button
                                className="setup-next"
                                onClick={claim}
                                disabled={busy || !admin.trim() || !setupCode.trim()}
                            >
                                {busy ? <Loader2 size={15} className="spin" /> : null}
                                {t('firstRun.wizard.claim')}
                            </button>
                        </div>
                    </>
                )}

                {step === 'key' && (
                    <>
                        <h2 className="setup-title">{t('firstRun.wizard.keyTitle')}</h2>
                        <p className="setup-sub">{t('firstRun.wizard.keySub')}</p>
                        <label className="setup-label" htmlFor="setup-key">
                            {t('firstRun.wizard.key')}
                        </label>
                        <input
                            id="setup-key"
                            className="setup-input"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="duckle_..."
                            autoFocus
                        />
                        {error && <div className="setup-error">{error}</div>}
                        <div className="setup-actions">
                            <button className="setup-back" onClick={() => setStep('address')}>
                                {t('firstRun.wizard.back')}
                            </button>
                            <button
                                className="setup-next"
                                onClick={saveKey}
                                disabled={busy || !apiKey.trim()}
                            >
                                {busy ? <Loader2 size={15} className="spin" /> : null}
                                {t('firstRun.wizard.connect')}
                            </button>
                        </div>
                    </>
                )}

                {step === 'done' && (
                    <>
                        <div className="setup-done-mark">
                            <Check size={26} />
                        </div>
                        <h2 className="setup-title">{t('firstRun.wizard.doneTitle', { name })}</h2>
                        <p className="setup-sub">{t('firstRun.wizard.doneSub', { name })}</p>
                        {adminToken ? (
                            <>
                                <p className="setup-sub">
                                    <Trans i18nKey="firstRun.wizard.adminToken" values={{ url }} components={{ b: <b /> }} />
                                </p>
                                <div className="setup-command">
                                    <pre>{adminToken}</pre>
                                    <button
                                        className="setup-alt"
                                        type="button"
                                        onClick={() => copy(adminToken)}
                                    >
                                        <Copy size={13} /> {copied ? t('firstRun.wizard.copied') : t('firstRun.wizard.copy')}
                                    </button>
                                </div>
                                <p className="setup-note">
                                    <ShieldCheck size={14} />
                                    <span>{t('firstRun.wizard.tokenNote')}</span>
                                </p>
                            </>
                        ) : null}
                        <div className="setup-actions">
                            <button className="setup-next" onClick={() => onDone('server')}>
                                <Server size={15} /> {t('firstRun.wizard.start')}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );

    return createPortal(body, document.body);
}
