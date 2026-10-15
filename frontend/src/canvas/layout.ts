import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { DuckleNodeData } from '../pipeline-types';

/** Every node card renders at this width (see `.node` in styles.css). */
export const NODE_WIDTH = 240;
const RANK_GAP = 120; // space between dependency columns (rows when top-to-bottom)
const NODE_GAP = 48; // space between nodes in one column (row when top-to-bottom)

/** Which way a pipeline flows on the canvas: left-to-right or top-to-bottom. */
export type LayoutDirection = 'LR' | 'TB';
export const DEFAULT_LAYOUT_DIRECTION: LayoutDirection = 'LR';

export function normalizeLayoutDirection(value: unknown): LayoutDirection {
    return value === 'TB' ? 'TB' : DEFAULT_LAYOUT_DIRECTION;
}
const ORIGIN_X = 80;
const ORIGIN_Y = 80;
// Header plus one port row: used until React Flow has measured a node.
const FALLBACK_NODE_H = 120;

function nodeHeight(n: Node): number {
    const h = (n.measured?.height ?? n.height) as number | undefined;
    return h && h > 0 ? h : FALLBACK_NODE_H;
}

function linksBetween(nodes: Node[], edges: Edge[]): Edge[] {
    const ids = new Set(nodes.map(n => n.id));
    return edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
}

/**
 * Arrange nodes in dependency columns with dagre: every node to the right of
 * what feeds it, columns spaced by the fixed card width, nodes in a column
 * stacked by their real height and ordered to keep edges from crossing.
 * `'TB'` turns columns into rows: every node below what feeds it. Cycles and
 * disconnected nodes are placed too.
 */
export function layoutByDependency(
    nodes: Node<DuckleNodeData>[],
    edges: Edge[],
    direction: LayoutDirection = DEFAULT_LAYOUT_DIRECTION,
): Node<DuckleNodeData>[] {
    if (nodes.length === 0) return nodes;

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direction, ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight(n) });
    linksBetween(nodes, edges).forEach((e, i) => g.setEdge(e.source, e.target, {}, e.id ?? String(i)));
    dagre.layout(g);

    let minX = Infinity;
    let minY = Infinity;
    for (const n of nodes) {
        const p = g.node(n.id);
        minX = Math.min(minX, p.x - p.width / 2);
        minY = Math.min(minY, p.y - p.height / 2);
    }
    return nodes.map(n => {
        const p = g.node(n.id);
        return {
            ...n,
            position: {
                x: Math.round(p.x - p.width / 2 - minX + ORIGIN_X),
                y: Math.round(p.y - p.height / 2 - minY + ORIGIN_Y),
            },
        };
    });
}

export type NodeBox = { id: string; x: number; y: number; width: number; height: number };

/** Whether any two node cards overlap, or sit closer than `minGap` pixels. */
export function nodesOverlap(boxes: NodeBox[], minGap = 0): boolean {
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
            const b = sorted[j];
            if (b.x >= a.x + a.width + minGap) break;
            if (b.y < a.y + a.height + minGap && a.y < b.y + b.height + minGap) return true;
        }
    }
    return false;
}

/**
 * A 1-based number per node in dependency order: columns by longest path from
 * a source, then top to bottom (left to right on a tie) inside a column. With
 * `'TB'` the columns are rows, numbered left to right (top to bottom on a tie).
 * Every node is numbered after everything that feeds it; nodes caught in a
 * cycle come last.
 */
export function nodeSequence(
    nodes: Node[],
    edges: Edge[],
    direction: LayoutDirection = DEFAULT_LAYOUT_DIRECTION,
): Map<string, number> {
    const outgoing = new Map<string, string[]>(nodes.map(n => [n.id, []]));
    const remaining = new Map<string, number>(nodes.map(n => [n.id, 0]));
    for (const e of linksBetween(nodes, edges)) {
        outgoing.get(e.source)!.push(e.target);
        remaining.set(e.target, remaining.get(e.target)! + 1);
    }
    const rank = new Map<string, number>();
    const queue = nodes.filter(n => remaining.get(n.id) === 0).map(n => n.id);
    for (const id of queue) rank.set(id, 0);
    while (queue.length > 0) {
        const id = queue.shift()!;
        for (const t of outgoing.get(id)!) {
            rank.set(t, Math.max(rank.get(t) ?? 0, rank.get(id)! + 1));
            const left = remaining.get(t)! - 1;
            remaining.set(t, left);
            if (left === 0) queue.push(t);
        }
    }
    const settled = (id: string) => remaining.get(id) === 0;
    const cycleRank = Math.max(-1, ...nodes.filter(n => settled(n.id)).map(n => rank.get(n.id)!)) + 1;
    const rankOf = (id: string) => (settled(id) ? rank.get(id)! : cycleRank);
    const across = direction === 'TB' ? 'x' : 'y';
    const along = direction === 'TB' ? 'y' : 'x';
    const ordered = [...nodes].sort(
        (a, b) =>
            rankOf(a.id) - rankOf(b.id) ||
            a.position[across] - b.position[across] ||
            a.position[along] - b.position[along],
    );
    return new Map(ordered.map((n, i) => [n.id, i + 1]));
}
