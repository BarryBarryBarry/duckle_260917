// The step each node ran at in its pipeline's last run, shown on the node.
//
// Taken from the run, never from the canvas: editing, moving, adding or
// deleting nodes leaves the numbers alone, and only the next run replaces
// them. A node whose configuration changed since that run keeps its number but
// is marked stale.
import { createContext, useContext } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { TimelineEntry } from '../run-timeline';

export type StepSnapshot = {
    /** Identifies the run the numbers came from. */
    runAt: number;
    total: number;
    /** node id -> 1-based step, only for nodes that actually started. */
    steps: Record<string, number>;
    /** node id -> what the node was when the run began, see nodePrint. */
    prints: Record<string, string>;
};

export type NodeStep = { step: number; total: number; stale: boolean };

/**
 * What decides how a node runs: its component, settings, whether it is
 * disabled, and what feeds it. Name, position and the schema or sample rows a
 * run writes back are left out, so neither tidying the canvas nor the run
 * itself marks a node stale.
 */
export function nodePrint(node: Node, edges: Edge[]): string {
    const d = node.data as { componentId?: string; properties?: unknown; disabled?: boolean };
    const inputs = edges
        .filter(e => e.target === node.id)
        .map(e => {
            const type = (e.data as { connectionType?: string } | undefined)?.connectionType ?? '';
            return `${e.source}:${e.sourceHandle ?? ''}>${e.targetHandle ?? ''}:${type}`;
        })
        .sort();
    return JSON.stringify([d.componentId ?? null, d.properties ?? null, !!d.disabled, inputs]);
}

export function nodePrints(nodes: Node[], edges: Edge[]): Record<string, string> {
    return Object.fromEntries(nodes.map(n => [n.id, nodePrint(n, edges)]));
}

/**
 * The numbers a finished run leaves: each node that started gets its step in
 * the run's plan. Nodes the run never reached, skipped or ran in a parallel
 * branch get none. A run that executed nothing (it failed to compile) leaves
 * no numbers at all.
 */
export function snapshotSteps(
    timeline: TimelineEntry[] | undefined,
    runAt: number,
    prints: Record<string, string>,
): StepSnapshot {
    const steps: Record<string, number> = {};
    let total = 0;
    const start = timeline?.[0];
    if (start?.t === 'run-start') {
        total = start.plan.length;
        const planned = new Map(start.plan.map(s => [s.node_id, s.step]));
        for (const e of timeline!) {
            if (e.t !== 'stage-start') continue;
            const step = planned.get(e.nodeId);
            if (step !== undefined) steps[e.nodeId] = step;
        }
    }
    return { runAt, total, steps, prints };
}

/** The badge for each node still on the canvas that has a number. */
export function nodeSteps(snap: StepSnapshot | undefined, nodes: Node[], edges: Edge[]): Record<string, NodeStep> {
    if (!snap) return {};
    const out: Record<string, NodeStep> = {};
    for (const n of nodes) {
        const step = snap.steps[n.id];
        if (step === undefined) continue;
        out[n.id] = { step, total: snap.total, stale: snap.prints[n.id] !== nodePrint(n, edges) };
    }
    return out;
}

export const RunStepContext = createContext<Record<string, NodeStep>>({});

export function useRunStep(nodeId: string): NodeStep | undefined {
    return useContext(RunStepContext)[nodeId];
}
