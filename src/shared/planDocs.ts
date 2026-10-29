import type { DocMeta, SqliteStore } from "./store";

/** Plans bigger than this are not opened to look inside them. */
export const MAX_SCAN_BYTES = 5 * 1024 * 1024;

// Library snapshots written by export_workouts: copies of Garmin's list, not plans to edit.
const EXPORT_FILE = /^workouts(-raw)?\.json$/;

export const isExportSnapshot = (logical: string): boolean => EXPORT_FILE.test(logical.slice(logical.lastIndexOf("/") + 1));

/**
 * The plan documents a profile works with: the shared ones and its own in workout-plans/, and its data/<profile>/ files (the export
 * snapshots are not plans). An archived plan is not among them: it is put away, so the Today view, the Calendar and the Workouts
 * view do not look at it, and the workouts it names are not "in use" by it.
 */
export function activePlanDocs(store: SqliteStore, profile: string): DocMeta[] {
  return store.list().filter((meta) => {
    if (meta.archivedAt !== null || meta.size > MAX_SCAN_BYTES) return false;
    const isPlan = meta.path.startsWith("workout-plans/") && (meta.owner === null || meta.owner === profile);
    const isOwnData = meta.path.startsWith(`data/${profile}/`) && !isExportSnapshot(meta.path);
    return isPlan || isOwnData;
  });
}
