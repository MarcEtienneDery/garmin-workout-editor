import * as fs from "fs";
import * as path from "path";
import { profileOfPath, summarizeText } from "./paths";
import { StoreError, type DocMeta, type PutOptions, type RevisionMeta, type Store, type StoredDoc } from "./types";

/**
 * The original layout: one JSON file per document under workout-plans/ and data/<profile>/. Kept as a
 * fallback (GARMIN_STORE=files). It has no history, no owners and the version is the file's mtime.
 */
export class FileStore implements Store {
  readonly kind = "files";

  constructor(
    private readonly plansDir: string,
    private readonly dataRoot: string
  ) {}

  get location(): string {
    return `${this.plansDir} + ${this.dataRoot}`;
  }

  private root(logicalRoot: "data" | "workout-plans"): string {
    return logicalRoot === "data" ? this.dataRoot : this.plansDir;
  }

  private nearestExistingRealpath(target: string): string {
    let current = target;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return fs.realpathSync(current);
  }

  /** Absolute file for a normalized logical path; refuses symlinks that lead out of the volume. */
  private absolute(logicalPath: string): string {
    const [logicalRoot, ...rest] = logicalPath.split("/");
    const base = this.root(logicalRoot as "data" | "workout-plans");
    const full = path.resolve(base, ...rest);
    const realBase = this.nearestExistingRealpath(base);
    const realFull = this.nearestExistingRealpath(full);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) {
      throw new StoreError("invalid_path", `Path "${logicalPath}" escapes ${logicalRoot}/.`);
    }
    return full;
  }

  private logical(absolute: string): string | undefined {
    for (const logicalRoot of ["data", "workout-plans"] as const) {
      const rel = path.relative(this.root(logicalRoot), absolute);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `${logicalRoot}/${rel.split(path.sep).join("/")}`;
    }
    return undefined;
  }

  private metaOf(logicalPath: string, absolute: string, text?: string): DocMeta {
    const stat = fs.statSync(absolute);
    return {
      path: logicalPath,
      owner: profileOfPath(logicalPath) ?? null,
      size: stat.size,
      version: stat.mtimeMs,
      updatedAt: stat.mtimeMs,
      source: "file",
      summary: summarizeText(text ?? fs.readFileSync(absolute, "utf8")),
    };
  }

  private jsonFilesIn(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name));
  }

  list(prefix = ""): DocMeta[] {
    const profileDirs = fs.existsSync(this.dataRoot)
      ? fs
          .readdirSync(this.dataRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(e.name))
          .map((e) => path.join(this.dataRoot, e.name))
      : [];
    return [this.plansDir, ...profileDirs]
      .flatMap((dir) => this.jsonFilesIn(dir))
      .map((file) => ({ file, logical: this.logical(file)! }))
      .filter(({ logical }) => logical.startsWith(prefix))
      .map(({ file, logical }) => this.metaOf(logical, file))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  head(documentPath: string): DocMeta | undefined {
    const file = this.absolute(documentPath);
    return fs.existsSync(file) ? this.metaOf(documentPath, file) : undefined;
  }

  get(documentPath: string): StoredDoc | undefined {
    const file = this.absolute(documentPath);
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, "utf8");
    return { ...this.metaOf(documentPath, file, text), text };
  }

  put(documentPath: string, text: string, options: PutOptions = {}): DocMeta {
    const file = this.absolute(documentPath);
    const exists = fs.existsSync(file);
    if (options.create && exists) throw new StoreError("exists", `${documentPath} already exists`);
    if ((options.replace || options.expectedVersion !== undefined) && !exists) {
      throw new StoreError("not_found", `File not found: ${documentPath}`);
    }
    if (options.expectedVersion !== undefined && fs.statSync(file).mtimeMs !== options.expectedVersion) {
      throw new StoreError("conflict", `${documentPath} changed since you opened it.`);
    }
    const before = exists ? fs.statSync(file).mtimeMs : undefined;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    // The mtime is the version: two saves in the same instant must still differ.
    if (before !== undefined && fs.statSync(file).mtimeMs === before) {
      const later = new Date(before + 1);
      fs.utimesSync(file, later, later);
    }
    return this.metaOf(documentPath, file, text);
  }

  update(documentPath: string, change: (text: string) => string, options: { source?: string } = {}): DocMeta {
    const current = this.get(documentPath);
    if (!current) throw new StoreError("not_found", `File not found: ${documentPath}`);
    return this.put(documentPath, change(current.text), { replace: true, source: options.source });
  }

  remove(documentPath: string, options: { expectedVersion?: number } = {}): void {
    const file = this.absolute(documentPath);
    if (!fs.existsSync(file)) throw new StoreError("not_found", `File not found: ${documentPath}`);
    if (options.expectedVersion !== undefined && fs.statSync(file).mtimeMs !== options.expectedVersion) {
      throw new StoreError("conflict", `${documentPath} changed since you opened it.`);
    }
    fs.unlinkSync(file);
  }

  rename(from: string, to: string): DocMeta {
    const source = this.absolute(from);
    const target = this.absolute(to);
    if (!fs.existsSync(source)) throw new StoreError("not_found", `File not found: ${from}`);
    if (fs.existsSync(target)) throw new StoreError("exists", `${to} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return this.metaOf(to, target);
  }

  setOwner(): DocMeta {
    throw new StoreError("invalid_path", "The file backend has no owners (GARMIN_STORE=sqlite).");
  }

  history(): RevisionMeta[] {
    return [];
  }

  revision(): undefined {
    return undefined;
  }

  deleted(): [] {
    return [];
  }

  close(): void {}
}
