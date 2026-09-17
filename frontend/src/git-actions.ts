/**
 * Whether a Git panel action rewrites files in the workspace.
 *
 * A pull or a branch checkout changes the pipelines and connections on disk,
 * while the editor still holds the ones it loaded before. Left there, the first
 * edit afterwards autosaved the old copies back over what git had just brought
 * in. After one of these the workspace is reloaded from disk, whether or not the
 * action succeeded: a pull that stops on a conflict has already rewritten files.
 */
export function gitActionRewritesFiles(label: string): boolean {
    return label === 'pull' || label === 'checkout';
}
