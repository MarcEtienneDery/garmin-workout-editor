import type { DocMeta, SqliteStore } from "./store";

export const MAX_SCAN_BYTES = 5 * 1024 * 1024;

const EXPORT_FILE = /^workouts(-raw)?\.json$/;

export const isExportSnapshot = (logical: string): boolean => EXPORT_FILE.test(logical.slice(logical.lastIndexOf("/") + 1));

export function activePlanDocs(store: SqliteStore, profile: string): DocMeta[] {
  return store.list().filter((meta) => {
    if (meta.archivedAt !== null || meta.size > MAX_SCAN_BYTES) return false;
    const isPlan = meta.path.startsWith("workout-plans/") && (meta.owner === null || meta.owner === profile);
    const isOwnData = meta.path.startsWith(`data/${profile}/`) && !isExportSnapshot(meta.path);
    return isPlan || isOwnData;
  });
}
