/**
 * Whether Live mode may run up to this node to preview it.
 *
 * A Live preview is a partial run: the target node and everything upstream of
 * it. Running up to a SINK writes - a file, a table, a replace-mode table while
 * its settings are still half-typed - and a sink has no preview rows to show for
 * it. Of the three places that start a preview, selecting a node and switching
 * Live on both skipped sinks, and editing a field did not: pausing while typing a
 * sink's path wrote output to the half-typed path.
 *
 * So the rule is applied where a preview STARTS, which every trigger reaches,
 * rather than repeated at each trigger where the next one can leave it out.
 */
export function livePreviewable(componentId: string | undefined | null): boolean {
    return !(componentId ?? '').startsWith('snk.');
}
