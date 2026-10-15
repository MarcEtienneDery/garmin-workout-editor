import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "./sqliteStore";

/** Write every document as a plain file under `dir` (same logical paths), e.g. as a copy to keep elsewhere. */
export function exportFiles(store: SqliteStore, dir: string): string[] {
  const written: string[] = [];
  for (const meta of store.list()) {
    const doc = store.get(meta.path);
    if (!doc) continue;
    const file = path.join(dir, meta.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc.text, "utf8");
    fs.utimesSync(file, new Date(doc.updatedAt), new Date(doc.updatedAt));
    written.push(meta.path);
  }
  return written;
}
