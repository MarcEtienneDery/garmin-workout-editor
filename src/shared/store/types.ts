/**
 * The document store behind plans and per-profile data. A document is a JSON text addressed by a
 * logical path ("workout-plans/x.json", "data/<profile>/x.json"); the MCP tools, the web editor and
 * the CLI all go through SqliteStore.
 */

export type StoreErrorCode = "not_found" | "exists" | "conflict" | "invalid_path";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** What list views show without opening the document. */
export interface DocSummary {
  workoutCount?: number;
  weekStart?: string;
  weekEnd?: string;
}

export interface DocMeta {
  path: string;
  /** The profile that owns it; null = shared. data/<profile>/ documents always belong to <profile>. */
  owner: string | null;
  size: number;
  /** Counts the saves of this path; compare it for equality to detect that someone else saved. */
  version: number;
  updatedAt: number;
  /** Who saved this version: "web", "mcp", "cli", "restore". */
  source: string;
  summary: DocSummary;
  /** When the plan was archived (put away: off the calendar and the Today view, off Garmin); null = active. Saving a new text keeps it. */
  archivedAt: number | null;
}

export interface StoredDoc extends DocMeta {
  text: string;
}

/** A superseded (or deleted) version of a document. */
export interface RevisionMeta {
  id: number;
  version: number;
  savedAt: number;
  source: string;
  size: number;
}

export interface PutOptions {
  /** Fail with "exists" if the document is already there. */
  create?: boolean;
  /** Fail with "not_found" if the document is not there. */
  replace?: boolean;
  /** Fail with "conflict" unless the stored version is this one (implies replace). */
  expectedVersion?: number;
  source?: string;
  /** Owner of a new document under workout-plans/. Ignored when it already exists. */
  owner?: string | null;
}
