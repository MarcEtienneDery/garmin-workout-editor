import { StoreError, type DocSummary } from "./types";

/** Most characters of a profile name: it is a folder name (data/<name>/), so it must fit one. */
export const MAX_PROFILE_NAME = 64;
export const PROFILE_NAME_REGEX = new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_PROFILE_NAME}}$`);
export const MAX_SUMMARY_BYTES = 5 * 1024 * 1024;

/**
 * Canonical form of a logical path ("workout-plans/x.json", "data/MED/x.json"). Only .json
 * documents under those two roots exist; data/ documents sit in a profile folder; no hidden or
 * relative segments.
 */
export function normalizeLogicalPath(logicalPath: string): string {
  if (typeof logicalPath !== "string" || logicalPath.includes("\0")) {
    throw new StoreError("invalid_path", "Invalid path");
  }
  const normalized = logicalPath.replace(/\\/g, "/").replace(/^\.\//, "");

  const match = /^(workout-plans|data)\/(.+)$/.exec(normalized);
  if (!match) {
    throw new StoreError("invalid_path", `Path must start with "workout-plans/" or "data/" (got "${logicalPath}").`);
  }
  const segments = match[2].split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
    throw new StoreError("invalid_path", `Path "${logicalPath}" is not allowed (no "..", empty or hidden segments).`);
  }
  if (!normalized.endsWith(".json")) {
    throw new StoreError("invalid_path", `Only .json files are accessible (got "${logicalPath}").`);
  }
  if (match[1] === "data" && (segments.length < 2 || !PROFILE_NAME_REGEX.test(segments[0]))) {
    throw new StoreError("invalid_path", `Path "${logicalPath}" must be data/<profile>/<name>.json.`);
  }
  return normalized;
}

/** The profile a data/<profile>/ path belongs to; undefined under workout-plans/. */
export function profileOfPath(logicalPath: string): string | undefined {
  return /^data\/([^/]+)\//.exec(logicalPath)?.[1];
}

/** Cheap description of a plan document for list views. */
export function summarizeText(text: string): DocSummary {
  if (Buffer.byteLength(text) > MAX_SUMMARY_BYTES) return {};
  try {
    const data: any = JSON.parse(text);
    const summary: DocSummary = {};
    const workouts = Array.isArray(data) ? data : data?.workouts;
    if (Array.isArray(workouts)) summary.workoutCount = workouts.length;
    if (typeof data?.weekStart === "string") summary.weekStart = data.weekStart;
    if (typeof data?.weekEnd === "string") summary.weekEnd = data.weekEnd;
    return summary;
  } catch {
    return {}; // listed anyway; the editor flags it
  }
}
