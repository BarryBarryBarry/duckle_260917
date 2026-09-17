import type { Schedule, ScheduleKind } from './tauri-bridge';

/** The fields the desktop Schedules dialog edits. */
export type ScheduleEdit = {
    id: string;
    pipelineId: string;
    name: string;
    enabled: boolean;
    kind: ScheduleKind;
};

/**
 * Run a Schedules-dialog action; the message to show when it fails, else null.
 *
 * "Run now" and "Delete" awaited their command inside try/finally with no catch,
 * so a failure became an unhandled rejection and the dialog showed nothing -
 * including "already running in this workspace, so this run was refused", which
 * is exactly what the person pressing Run now needs to read.
 */
export async function scheduleActionError(action: () => Promise<unknown>): Promise<string | null> {
    try {
        await action();
        return null;
    } catch (err) {
        return String(err);
    }
}

/**
 * The record the desktop Schedules dialog saves: the schedule as it was loaded,
 * with only the fields the dialog edits replaced.
 *
 * The store holds more than the dialog shows - a timezone, an exclusion
 * calendar, a misfire policy and catch-up bounds, set through the server API -
 * and the desktop upsert replaces the whole record. Building a fresh object from
 * the dialog's own fields sent none of them, so renaming a schedule put a
 * Brussels 03:00 job back on the machine's clock and switched off its
 * maintenance calendar. The fix belongs here rather than in the upsert: there,
 * "not sent" and "cleared" arrive as the same default, and a merge would make an
 * exclusion calendar impossible to clear.
 */
export function scheduleForSave(loaded: Schedule | undefined, edit: ScheduleEdit): Schedule {
    return {
        ...loaded,
        id: edit.id,
        pipeline_id: edit.pipelineId,
        name: edit.name.trim() || 'Schedule',
        enabled: edit.enabled,
        kind: edit.kind,
    };
}
