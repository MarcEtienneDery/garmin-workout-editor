import * as fs from "fs";
import * as path from "path";
import { profileOfPath, summarizeText } from "./paths";
import { StoreError, type DocMeta, type PutOptions, type RevisionMeta, type StoredDoc } from "./types";

// node:sqlite ships with Node (22.13+), so the image needs no native module. @types/node 20 has no
// typings for it, hence the small interfaces below and the typed require in open().
interface Row {
  [column: string]: any;
}
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Superseded versions kept per document. */
export const KEEP_REVISIONS = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  path       TEXT PRIMARY KEY,
  owner      TEXT,
  text       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source     TEXT NOT NULL,
  summary    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  path     TEXT NOT NULL,
  version  INTEGER NOT NULL,
  text     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  source   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_by_path ON revisions (path, id);
`;

const META_COLUMNS = "path, owner, size, version, updated_at, source, summary";

const toMeta = (r: Row): DocMeta => ({
  path: r.path,
  owner: r.owner ?? null,
  size: r.size,
  version: r.version,
  updatedAt: r.updated_at,
  source: r.source,
  summary: JSON.parse(r.summary),
});

const toRevision = (r: Row): RevisionMeta => ({ id: r.id, version: r.version, savedAt: r.saved_at, source: r.source, size: r.size });

/**
 * One SQLite file shared by the MCP server and the web editor (two processes). Every write runs in an
 * IMMEDIATE transaction, so concurrent writers queue instead of overwriting each other, and the
 * rollback journal keeps the database a single, copy-safe file between writes.
 */
export class SqliteStore {
  private depth = 0;

  private constructor(
    private readonly db: Database,
    /** Where it lives, for logs. */
    readonly location: string
  ) {}

  static open(file: string): SqliteStore {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => Database };
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    const store = new SqliteStore(db, file);
    store.tx(() => db.exec(SCHEMA));
    return store;
  }

  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    } finally {
      this.depth--;
    }
  }

  private row(documentPath: string): Row | undefined {
    return this.db.prepare("SELECT * FROM documents WHERE path = ?").get(documentPath);
  }

  /** Metadata of the documents whose path starts with `prefix` (all by default), ordered by path. */
  list(prefix = ""): DocMeta[] {
    return this.db
      .prepare(`SELECT ${META_COLUMNS} FROM documents WHERE substr(path, 1, ?) = ? ORDER BY path`)
      .all(prefix.length, prefix)
      .map(toMeta);
  }

  head(documentPath: string): DocMeta | undefined {
    const r = this.db.prepare(`SELECT ${META_COLUMNS} FROM documents WHERE path = ?`).get(documentPath);
    return r && toMeta(r);
  }

  get(documentPath: string): StoredDoc | undefined {
    const r = this.row(documentPath);
    return r && { ...toMeta(r), text: r.text };
  }

  /** Create or replace. Saving the text that is already there changes nothing. */
  put(documentPath: string, text: string, options: PutOptions = {}): DocMeta {
    return this.tx(() => this.write(documentPath, text, options));
  }

  /** Read-modify-write that no other writer can interleave with. `change` must be synchronous. */
  update(documentPath: string, change: (text: string) => string, options: { source?: string } = {}): DocMeta {
    return this.tx(() => {
      const current = this.row(documentPath);
      if (!current) throw new StoreError("not_found", `File not found: ${documentPath}`);
      return this.write(documentPath, change(current.text), { replace: true, source: options.source });
    });
  }

  private write(documentPath: string, text: string, options: PutOptions): DocMeta {
    const current = this.row(documentPath);
    const source = options.source ?? "unknown";
    const now = Date.now();
    const summary = JSON.stringify(summarizeText(text));
    const size = Buffer.byteLength(text);

    if (!current) {
      if (options.replace || options.expectedVersion !== undefined) {
        throw new StoreError("not_found", `File not found: ${documentPath}`);
      }
      // A path that was deleted and made again must not reuse a version an old editor may still hold.
      const last = this.db.prepare("SELECT MAX(version) AS v FROM revisions WHERE path = ?").get(documentPath);
      const owner = profileOfPath(documentPath) ?? options.owner ?? null;
      this.db
        .prepare("INSERT INTO documents (path, owner, text, size, version, updated_at, source, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(documentPath, owner, text, size, (last?.v ?? 0) + 1, now, source, summary);
      return this.head(documentPath)!;
    }

    if (options.create) throw new StoreError("exists", `${documentPath} already exists`);
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new StoreError("conflict", `${documentPath} changed since you opened it.`);
    }
    if (current.text === text) return toMeta(current);

    this.archive(current);
    this.db
      .prepare("UPDATE documents SET text = ?, size = ?, version = ?, updated_at = ?, source = ?, summary = ? WHERE path = ?")
      .run(text, size, current.version + 1, now, source, summary, documentPath);
    return this.head(documentPath)!;
  }

  /** Keep the version that is about to be replaced or removed. */
  private archive(r: Row): void {
    this.db
      .prepare("INSERT INTO revisions (path, version, text, size, saved_at, source) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.path, r.version, r.text, r.size, r.updated_at, r.source);
    this.db
      .prepare("DELETE FROM revisions WHERE path = ? AND id NOT IN (SELECT id FROM revisions WHERE path = ? ORDER BY id DESC LIMIT ?)")
      .run(r.path, r.path, KEEP_REVISIONS);
  }

  remove(documentPath: string, options: { expectedVersion?: number; source?: string } = {}): void {
    this.tx(() => {
      const current = this.row(documentPath);
      if (!current) throw new StoreError("not_found", `File not found: ${documentPath}`);
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new StoreError("conflict", `${documentPath} changed since you opened it.`);
      }
      this.archive(current);
      this.db.prepare("DELETE FROM documents WHERE path = ?").run(documentPath);
    });
  }

  rename(from: string, to: string): DocMeta {
    return this.tx(() => {
      const current = this.row(from);
      if (!current) throw new StoreError("not_found", `File not found: ${from}`);
      if (this.row(to)) throw new StoreError("exists", `${to} already exists`);
      const owner = profileOfPath(to) ?? (profileOfPath(from) ? null : (current.owner ?? null));
      this.db.prepare("UPDATE documents SET path = ?, owner = ? WHERE path = ?").run(to, owner, from);
      this.db.prepare("UPDATE revisions SET path = ? WHERE path = ?").run(to, from);
      return this.head(to)!;
    });
  }

  setOwner(documentPath: string, owner: string | null): DocMeta {
    return this.tx(() => {
      const current = this.row(documentPath);
      if (!current) throw new StoreError("not_found", `File not found: ${documentPath}`);
      if (profileOfPath(documentPath)) throw new StoreError("invalid_path", `${documentPath} always belongs to its profile folder.`);
      this.db.prepare("UPDATE documents SET owner = ? WHERE path = ?").run(owner, documentPath);
      return this.head(documentPath)!;
    });
  }

  /** Earlier versions, newest first. */
  history(documentPath: string, limit = 50): RevisionMeta[] {
    return this.db
      .prepare("SELECT id, version, saved_at, source, size FROM revisions WHERE path = ? ORDER BY id DESC LIMIT ?")
      .all(documentPath, limit)
      .map(toRevision);
  }

  revision(documentPath: string, id: number): (RevisionMeta & { text: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM revisions WHERE path = ? AND id = ?").get(documentPath, id);
    return r && { ...toRevision(r), text: r.text };
  }

  /** Documents that were deleted and can still be restored from their last revision. */
  deleted(): (RevisionMeta & { path: string })[] {
    return this.db
      .prepare(
        `SELECT id, path, version, saved_at, source, size FROM revisions
         WHERE id IN (SELECT MAX(id) FROM revisions GROUP BY path)
           AND path NOT IN (SELECT path FROM documents)
         ORDER BY path`
      )
      .all()
      .map((r) => ({ ...toRevision(r), path: r.path }));
  }

  close(): void {
    this.db.close();
  }
}
