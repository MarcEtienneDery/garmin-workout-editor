
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

export interface DocSummary {
  workoutCount?: number;
  weekStart?: string;
  weekEnd?: string;
}

export interface DocMeta {
  path: string;
  owner: string | null;
  size: number;
  version: number;
  updatedAt: number;
  source: string;
  summary: DocSummary;
  archivedAt: number | null;
}

export interface StoredDoc extends DocMeta {
  text: string;
}

export interface RevisionMeta {
  id: number;
  version: number;
  savedAt: number;
  source: string;
  size: number;
}

export interface PutOptions {
  create?: boolean;
  replace?: boolean;
  expectedVersion?: number;
  source?: string;
  owner?: string | null;
}
