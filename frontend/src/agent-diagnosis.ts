// What the editor tells the Agent when the user asks it to diagnose a failed
// run from the bottom panel. It goes out as a `run_failure` entry in the
// message's selectedAssets; apps/desktop/src/agent_assets/SYSTEM.md tells the
// agent how to read it.
import type { Edge, Node } from '@xyflow/react';
import type { AgentConnectionContext, RunResult } from './tauri-bridge';
import type { DuckleNodeData } from './pipeline-types';
import type { ValidationResult } from './validation';
import type { RepoItem } from './repo-types';
import type { SourceRole } from './workflow-ui/AgentDataSources';

/** A message the editor asks the Agent panel to send on its own. */
export type AgentRequest = {
    /** Changes for every request, so the same one asked twice is sent twice. */
    id: number;
    prompt: string;
    selectedAssets: unknown[];
    connections: AgentConnectionContext[];
};

// Mirrors the engine's `is_secret_prop_key` (crates/duckdb-engine/src/util.rs),
// which decides what is redacted from run logs.
const SECRET_NEEDLES = [
    'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key',
    'privatekey', 'private_key', 'accesskey', 'access_key', 'accountkey',
    'clientsecret', 'client_secret', 'connectionstring', 'connection_string',
    'sas', 'credential',
];
const NAMES_SOMETHING_PUBLIC = new Set([
    'tokenurl', 'saslmechanism', 'saslusername', 'maxtokens', 'maxinputtokens',
    'maxoutputtokens', 'inputusdpermilliontokens', 'outputusdpermilliontokens',
]);

export function isSecretPropKey(key: string): boolean {
    const k = key.toLowerCase();
    if (k === 'pat') return true;
    if (NAMES_SOMETHING_PUBLIC.has(k)) return false;
    return SECRET_NEEDLES.some(n => k.includes(n));
}

const MAX_TEXT = 4000;
const MAX_LOG_LINES = 30;
const MAX_DETAILED_NODES = 40;
export const REDACTED = '[redacted]';

function clip(text: string): string {
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [${text.length - MAX_TEXT} more chars]` : text;
}

/** Copies a property value with credentials replaced. A `${...}` reference
 *  is kept: it names where the value comes from, not the value. */
export function redactSecrets(value: unknown, key?: string): unknown {
    if (key !== undefined && isSecretPropKey(key) && value !== null && value !== undefined && value !== '') {
        return typeof value === 'string' && /^\$\{[^}]+\}$/.test(value.trim()) ? value : REDACTED;
    }
    if (typeof value === 'string') return clip(value);
    if (Array.isArray(value)) return value.map(v => redactSecrets(v));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, k);
        return out;
    }
    return value;
}

function roleFor(componentId: string | undefined): SourceRole {
    if (componentId?.startsWith('src.')) return 'source';
    if (componentId?.startsWith('snk.')) return 'target';
    return 'both';
}

/** What the agent is told about a saved connection: never its secrets. */
export function connectionContext(item: RepoItem, role: SourceRole): AgentConnectionContext {
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof p[k] === 'string' && p[k] ? String(p[k]) : null);
    return {
        id: item.id,
        name: item.name,
        kind: text('kind'),
        host: text('host'),
        port: p.port === undefined || p.port === null || p.port === '' ? null : String(p.port),
        database: text('database'),
        schema: text('schema'),
        role,
    };
}

export type RunDiagnosisInput = {
    workspace: string;
    pipelineId: string;
    pipelineName: string;
    unsavedChanges: boolean;
    engine: string;
    nodes: Node<DuckleNodeData>[];
    edges: Edge[];
    runResult: RunResult;
    validation: ValidationResult;
    savedConnections: RepoItem[];
    /** Asked about one node; otherwise the whole run. */
    nodeId?: string;
};

export function buildRunDiagnosis(input: RunDiagnosisInput): {
    selectedAssets: unknown[];
    connections: AgentConnectionContext[];
    /** Nodes the request is about, failed ones first. */
    focusNodeIds: string[];
} {
    const { nodes, edges, runResult } = input;
    const failed = Object.entries(runResult.nodes)
        .filter(([, st]) => st.status === 'error')
        .map(([id]) => id);
    const focusNodeIds = input.nodeId ? [input.nodeId] : failed;

    // The nodes asked about and what feeds them: a bad input is a common cause.
    // A run that failed outside any node gets every node.
    const detailed = new Set<string>();
    if (focusNodeIds.length === 0) {
        for (const n of nodes) detailed.add(n.id);
    } else {
        for (const id of focusNodeIds) {
            detailed.add(id);
            for (const e of edges) if (e.target === id) detailed.add(e.source);
        }
    }

    const sep = input.workspace.includes('\\') ? '\\' : '/';
    const root = input.workspace.replace(/[\\/]+$/, '');
    const asset = {
        type: 'run_failure',
        pipeline: {
            id: input.pipelineId,
            name: input.pipelineName,
            path: [root, 'pipelines', `${input.pipelineId}.json`].join(sep),
            logName: input.pipelineId,
            unsavedChanges: input.unsavedChanges,
            engine: input.engine,
        },
        run: {
            status: runResult.status,
            error: runResult.error ? clip(runResult.error) : undefined,
            category: runResult.category,
            durationMs: runResult.duration_ms,
            log: (runResult.messages ?? []).slice(-MAX_LOG_LINES).map(l => ({ ...l, message: clip(l.message) })),
        },
        focusNodeIds,
        nodes: nodes.map(n => {
            const st = runResult.nodes[n.id];
            return {
                id: n.id,
                label: n.data.label,
                componentId: n.data.componentId,
                status: st?.status ?? 'not_run',
                rows: st?.rows,
                durationMs: st?.duration_ms,
                error: st?.error ? clip(st.error) : undefined,
                category: st?.category,
                failedSql: st?.sql ? clip(st.sql) : undefined,
            };
        }),
        edges: edges.map(e => ({
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
            targetHandle: e.targetHandle ?? undefined,
        })),
        nodeDetails: nodes
            .filter(n => detailed.has(n.id))
            .slice(0, MAX_DETAILED_NODES)
            .map(n => ({
                id: n.id,
                label: n.data.label,
                componentId: n.data.componentId,
                alias: n.data.alias,
                properties: redactSecrets(n.data.properties ?? {}),
                schema: n.data.schema?.map(c => ({ name: c.name, type: c.type, nullable: c.nullable })),
            })),
        validation: input.validation.issues.map(i => ({
            severity: i.severity,
            code: i.code,
            message: i.message,
            nodeId: i.nodeId,
        })),
    };

    // The saved connections the pipeline's nodes use, each with the role its
    // nodes give it.
    const roles = new Map<string, SourceRole>();
    for (const n of nodes) {
        const ref = n.data.properties?.connectionRef;
        if (typeof ref !== 'string' || !ref) continue;
        const role = roleFor(n.data.componentId);
        const prev = roles.get(ref);
        roles.set(ref, prev && prev !== role ? 'both' : role);
    }
    const connections = [...roles].flatMap(([id, role]) => {
        const item = input.savedConnections.find(c => c.id === id);
        return item ? [connectionContext(item, role)] : [];
    });

    return { selectedAssets: [asset], connections, focusNodeIds };
}
