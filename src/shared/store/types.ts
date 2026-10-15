/**
 * The document store behind plans and per-profile data. A document is a JSON text addressed by a
 * logical path ("workout-plans/x.json", "data/<profile>/x.json"); the MCP tools, the web editor and
 * the CLI all go through this interface, so the backend (SQLite, or plain files) is a deployment choice.
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
  /** Opaque token that changes with every save; compare it for equality, never for order across backends. */
  version: number;
  updatedAt: number;
  /** Who saved this version: "web", "mcp", "cli", "import", "restore". */
  source: string;
  summary: DocSummary;
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
  /** Keep this timestamp instead of now (used when importing files). */
  updatedAt?: number;
}

export interface Store {
  readonly kind: "sqlite" | "files";
  /** Where it lives, for logs. */
  readonly location: string;
  /** Metadata of the documents whose path starts with `prefix` (all by default), ordered by path. */
  list(prefix?: string): DocMeta[];
  head(path: string): DocMeta | undefined;
  get(path: string): StoredDoc | undefined;
  /** Create or replace. Saving the text that is already there changes nothing. */
  put(path: string, text: string, options?: PutOptions): DocMeta;
  /** Read-modify-write that no other writer can interleave with. `change` must be synchronous. */
  update(path: string, change: (text: string) => string, options?: { source?: string }): DocMeta;
  remove(path: string, options?: { expectedVersion?: number; source?: string }): void;
  rename(from: string, to: string): DocMeta;
  setOwner(path: string, owner: string | null): DocMeta;
  /** Earlier versions, newest first. The file backend keeps none. */
  history(path: string, limit?: number): RevisionMeta[];
  revision(path: string, id: number): (RevisionMeta & { text: string }) | undefined;
  /** Documents that were deleted and can still be restored from their last revision. */
  deleted(): (RevisionMeta & { path: string })[];
  close(): void;
}
