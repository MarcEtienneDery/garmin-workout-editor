import * as path from "path";
import { getDataRoot, getPlansDir } from "../profileLoader";
import { FileStore } from "./fileStore";
import { SqliteStore } from "./sqliteStore";
import { importFiles } from "./transfer";
import type { Store } from "./types";

export * from "./types";
export { normalizeLogicalPath, profileOfPath, summarizeText } from "./paths";
export { exportFiles, importFiles } from "./transfer";
export { FileStore } from "./fileStore";
export { SqliteStore, KEEP_REVISIONS } from "./sqliteStore";

/** Where the SQLite database lives: GARMIN_STORE_PATH, else <data root>/garmin.db. */
export const getStorePath = (): string => (process.env.GARMIN_STORE_PATH ? path.resolve(process.env.GARMIN_STORE_PATH) : path.join(getDataRoot(), "garmin.db"));

const useFiles = (): boolean => process.env.GARMIN_STORE === "files";

let open: { key: string; store: Store } | undefined;

/**
 * The store for this process, opened on first use. SQLite by default (GARMIN_STORE=files keeps the
 * old one-file-per-plan layout). The first time a database is opened, the JSON files of the old
 * layout are imported once: the files stay where they are and are never read again.
 */
export function getStore(): Store {
  const key = useFiles() ? `files:${getPlansDir()}:${getDataRoot()}` : `sqlite:${getStorePath()}`;
  if (open?.key === key) return open.store;
  closeStore();

  let store: Store;
  if (useFiles()) {
    store = new FileStore(getPlansDir(), getDataRoot());
  } else {
    const sqlite = SqliteStore.open(getStorePath());
    sqlite.runOnce("import-files", () => {
      const { done } = importFiles(sqlite, { plansDir: getPlansDir(), dataRoot: getDataRoot() });
      if (done.length) console.error(`[store] imported ${done.length} file(s) into ${getStorePath()}`);
    });
    store = sqlite;
  }
  open = { key, store };
  return store;
}

export function closeStore(): void {
  open?.store.close();
  open = undefined;
}
