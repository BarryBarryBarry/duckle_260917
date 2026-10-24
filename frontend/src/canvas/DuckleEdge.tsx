import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath,
    type Edge,
    type EdgeProps,
} from '@xyflow/react';
import { metaFor, type ConnectionType } from './connection-types';
import { useRunStatus } from './run-status-context';

export type DuckleEdgeData = {
    connectionType: ConnectionType;
    label?: string;
    condition?: string;
};

export type DuckleEdgeType = Edge<DuckleEdgeData, 'duckle'>;

/** Arrowhead size in canvas units; it scales with zoom like the line. */
const ARROW_SIZE = 10;
/** Where the tip sits: past 10 it stops short of the path's end, so the
 *  target port's dot does not cover it. */
const ARROW_REF_X = 13;

export default function DuckleEdge(props: EdgeProps<DuckleEdgeType>) {
    const {
        id,
        source,
        target,
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        data,
        selected,
        markerEnd,
    } = props;

    const [path, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    const type = (data?.connectionType ?? 'main') as ConnectionType;
    const meta = metaFor(type);
    const showLabel = Boolean(meta.badge || data?.label || data?.condition);

    const sourceStatus = useRunStatus(source);
    const targetStatus = useRunStatus(target);
    const isFlowing =
        sourceStatus?.status === 'running' || targetStatus?.status === 'running';
    const sourceDone =
        sourceStatus?.status === 'ok' || sourceStatus?.status === 'error';
    const targetDone =
        targetStatus?.status === 'ok' || targetStatus?.status === 'error';
    const isCompleted = sourceDone && targetDone;
    const color = selected ? 'var(--accent-strong)' : meta.color;
    // One arrowhead per edge, so it takes the edge's own colour (a marker's
    // fill cannot follow the line it ends). It fades with the line, which
    // carries the opacity, and stays solid while the line is dashed.
    const arrowId = `duckle-arrow-${id.replace(/[^\w-]/g, '_')}`;

    return (
        <>
            <defs>
                <marker
                    id={arrowId}
                    viewBox="0 0 10 10"
                    refX={ARROW_REF_X}
                    refY="5"
                    markerWidth={ARROW_SIZE}
                    markerHeight={ARROW_SIZE}
                    markerUnits="userSpaceOnUse"
                    orient="auto-start-reverse"
                >
                    <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: color }} />
                </marker>
            </defs>
            <BaseEdge
                id={id}
                path={path}
                markerEnd={markerEnd ?? `url(#${arrowId})`}
                className={
                    'duckle-edge' +
                    (isFlowing ? ' is-flowing' : '') +
                    (isCompleted ? ' is-completed' : '')
                }
                style={{
                    stroke: color,
                    strokeDasharray: isFlowing
                        ? '8 4'
                        : meta.dash ?? undefined,
                    strokeWidth: selected ? meta.width + 0.6 : meta.width,
                    filter: selected ? 'drop-shadow(0 0 6px var(--accent-glow))' : undefined,
                    opacity: isCompleted && !selected ? 0.55 : undefined,
                }}
            />
            {showLabel ? (
                <EdgeLabelRenderer>
                    <div
                        className={
                            'edge-label edge-label-' +
                            meta.group +
                            ' edge-label-' +
                            type +
                            (selected ? ' is-selected' : '')
                        }
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: 'all',
                        }}
                    >
                        {data?.label ? <span className="edge-label-name">{data.label}</span> : null}
                        {meta.badge ? <span className="edge-label-badge">{meta.badge}</span> : null}
                        {data?.condition ? (
                            <span className="edge-label-cond" title={data.condition}>
                                {truncate(data.condition, 40)}
                            </span>
                        ) : null}
                    </div>
                </EdgeLabelRenderer>
            ) : null}
        </>
    );
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
