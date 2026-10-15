import * as fs from "fs";
import * as path from "path";
import { PROFILE_NAME_REGEX } from "./paths";
import type { Store } from "./types";

export interface Transfer {
  done: string[];
  skipped: string[];
}

const jsonFilesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
        .map((e) => e.name)
    : [];

/**
 * Load the JSON files of the old layout (plansDir/*.json, dataRoot/<profile>/*.json) into the store.
 * The files are only read, never changed. Documents already in the store are kept unless `overwrite`.
 */
export function importFiles(store: Store, dirs: { plansDir: string; dataRoot: string }, options: { overwrite?: boolean } = {}): Transfer {
  const result: Transfer = { done: [], skipped: [] };
  const take = (logical: string, file: string) => {
    if (!options.overwrite && store.head(logical)) return void result.skipped.push(logical);
    const stat = fs.statSync(file);
    store.put(logical, fs.readFileSync(file, "utf8"), { source: "import", updatedAt: Math.round(stat.mtimeMs) });
    result.done.push(logical);
  };

  for (const name of jsonFilesIn(dirs.plansDir)) take(`workout-plans/${name}`, path.join(dirs.plansDir, name));
  const profiles = fs.existsSync(dirs.dataRoot)
    ? fs
        .readdirSync(dirs.dataRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && PROFILE_NAME_REGEX.test(e.name))
        .map((e) => e.name)
        .sort()
    : [];
  for (const profile of profiles) {
    for (const name of jsonFilesIn(path.join(dirs.dataRoot, profile))) {
      take(`data/${profile}/${name}`, path.join(dirs.dataRoot, profile, name));
    }
  }
  return result;
}

/** Write every document as a plain file under `dir`, in the same layout the old file storage used. */
export function exportFiles(store: Store, dir: string): Transfer {
  const result: Transfer = { done: [], skipped: [] };
  for (const meta of store.list()) {
    const doc = store.get(meta.path);
    if (!doc) continue;
    const file = path.join(dir, meta.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.text, "utf8");
    fs.utimesSync(file, new Date(doc.updatedAt), new Date(doc.updatedAt));
    result.done.push(meta.path);
  }
  return result;
}
