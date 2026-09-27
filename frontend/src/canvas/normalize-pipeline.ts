import type { Edge, Node } from '@xyflow/react';
import { getManifest } from '../workflow-ui/fields/component-manifests';
import type { DuckleNodeData } from '../pipeline-types';

type FlowType = 'source' | 'transform' | 'sink';

const FLOW_TYPES = new Set<string>(['source', 'transform', 'sink']);
const X_STEP = 280;
const Y_STEP = 150;

/**
 * The canvas node type for a component. The canvas registers only these three;
 * control / quality / custom components render as transforms, exactly as the
 * palette's drop handler maps them.
 */
export function flowTypeForComponent(componentId: string | undefined): FlowType {
    const kind = getManifest(componentId)?.kind;
    if (kind === 'source' || kind === 'sink') return kind;
    if (kind) return 'transform';
    if (componentId?.startsWith('src.')) return 'source';
    if (componentId?.startsWith('snk.')) return 'sink';
    return 'transform';
}

function portType(componentId: string | undefined, side: 'inputs' | 'outputs', handle: string): string | undefined {
    return getManifest(componentId)?.ports?.[side]?.find(p => p.id === handle)?.type;
}

function hasPosition(node: Node): boolean {
    return typeof node.position?.x === 'number' && typeof node.position?.y === 'number';
}

/** Left-to-right layers by longest path from a root, for nodes with no position. */
function layeredPositions(nodes: Node[], edges: Edge[]): Map<string, { x: number; y: number }> {
    const indegree = new Map(nodes.map(n => [n.id, 0]));
    const next = new Map<string, string[]>();
    for (const e of edges) {
        if (!indegree.has(e.source) || !indegree.has(e.target)) continue;
        indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
        next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    }
    const depth = new Map<string, number>();
    const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
    for (const id of queue) depth.set(id, 0);
    while (queue.length) {
        const id = queue.shift()!;
        for (const t of next.get(id) ?? []) {
            depth.set(t, Math.max(depth.get(t) ?? 0, (depth.get(id) ?? 0) + 1));
            const left = (indegree.get(t) ?? 1) - 1;
            indegree.set(t, left);
            if (left === 0) queue.push(t);
        }
    }
    const last = Math.max(-1, ...depth.values()) + 1;
    const rows = new Map<number, number>();
    const out = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
        const d = depth.get(n.id) ?? last;
        const row = rows.get(d) ?? 0;
        rows.set(d, row + 1);
        out.set(n.id, { x: d * X_STEP, y: row * Y_STEP });
    }
    return out;
}

/**
 * Fill in the canvas fields a pipeline is missing. The engine runs on
 * `componentId` alone, so a pipeline written by an agent can validate and run
 * while lacking what the canvas renders from: a node without a registered
 * `type` is drawn as a bare label box with no ports (it can be neither edited
 * nor wired), and an edge without `sourceHandle` is dropped because Duckle
 * nodes expose named handles. Existing values are never overridden, and the
 * same object comes back when nothing was missing.
 */
export function normalizePipelineForCanvas<T extends { nodes?: Node<DuckleNodeData>[]; edges?: Edge[] }>(
    pipeline: T,
): T {
    const nodes = Array.isArray(pipeline?.nodes) ? pipeline.nodes : [];
    const edges = Array.isArray(pipeline?.edges) ? pipeline.edges : [];
    const needsLayout = nodes.some(n => !hasPosition(n));
    const layout = needsLayout ? layeredPositions(nodes, edges) : null;
    let changed = false;

    const nextNodes = nodes.map(n => {
        const typeOk = typeof n.type === 'string' && FLOW_TYPES.has(n.type);
        const positionOk = hasPosition(n);
        const componentId = n.data?.componentId;
        const labelOk = typeof n.data?.label === 'string' && n.data.label.trim() !== '';
        if (typeOk && positionOk && labelOk && n.data) return n;
        changed = true;
        return {
            ...n,
            type: typeOk ? n.type : flowTypeForComponent(componentId),
            position: positionOk ? n.position : layout?.get(n.id) ?? { x: 0, y: 0 },
            data: {
                ...(n.data ?? {}),
                label: labelOk ? n.data.label : componentId ?? n.id,
                properties: n.data?.properties ?? {},
            } as DuckleNodeData,
        };
    });

    const componentOf = new Map(nextNodes.map(n => [n.id, n.data?.componentId]));
    const nextEdges = edges.map(e => {
        const data = (e.data ?? {}) as { connectionType?: string };
        if (e.sourceHandle && e.targetHandle && data.connectionType) return e;
        changed = true;
        const sourceHandle = e.sourceHandle || 'main';
        const targetHandle = e.targetHandle || 'main';
        // A second input (lookup) is named by the target port and a reject
        // branch by the source port, as the connection picker does.
        const byTarget = portType(componentOf.get(e.target), 'inputs', targetHandle);
        const bySource = portType(componentOf.get(e.source), 'outputs', sourceHandle);
        const connectionType =
            data.connectionType ??
            (byTarget && byTarget !== 'main' ? byTarget : bySource && bySource !== 'main' ? bySource : 'main');
        return { ...e, sourceHandle, targetHandle, data: { ...data, connectionType } };
    });

    return changed ? { ...pipeline, nodes: nextNodes, edges: nextEdges } : pipeline;
}
