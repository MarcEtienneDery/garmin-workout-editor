import * as path from "path";
import { getDataRoot } from "../profileLoader";
import { SqliteStore } from "./sqliteStore";

export * from "./types";
export { normalizeLogicalPath, profileOfPath, summarizeText } from "./paths";
export { exportFiles } from "./transfer";
export { SqliteStore, KEEP_REVISIONS } from "./sqliteStore";
export * from "./activities";
export { TokenTable, type StoredToken } from "./tokens";
export * from "./wellness";

/** Where the SQLite database lives: GARMIN_STORE_PATH, else <data root>/garmin.db. */
export const getStorePath = (): string => (process.env.GARMIN_STORE_PATH ? path.resolve(process.env.GARMIN_STORE_PATH) : path.join(getDataRoot(), "garmin.db"));

let open: { file: string; store: SqliteStore } | undefined;

/** The store for this process, opened on first use (and again if the database path changes). */
export function getStore(): SqliteStore {
  const file = getStorePath();
  if (open?.file === file) return open.store;
  closeStore();
  open = { file, store: SqliteStore.open(file) };
  return open.store;
}

export function closeStore(): void {
  open?.store.close();
  open = undefined;
}
