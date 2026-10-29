import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KEEP_REVISIONS, SqliteStore, StoreError, closeStore, exportFiles, getStore, normalizeLogicalPath } from "../shared/store";
import { runStoreCli } from "../storeCli";

const plan = (name: string, extra: object = {}) =>
  JSON.stringify({ weekStart: "2026-10-12", weekEnd: "2026-10-18", workouts: [{ workoutName: name }], ...extra });

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof StoreError ? error.code : `other: ${(error as Error).message}`;
  }
  return undefined;
};

describe("logical paths", () => {
  it("accepts documents under the two roots and nothing else", () => {
    expect(normalizeLogicalPath("./workout-plans/a.json")).toBe("workout-plans/a.json");
    expect(normalizeLogicalPath("data\\MED\\x.json")).toBe("data/MED/x.json");
    for (const bad of ["a.json", "workout-plans/a.txt", "workout-plans/../a.json", "workout-plans/.hidden.json", "workout-plans//a.json", "data/a.json", "data/.MED/a.json", "other/a.json", "workout-plans/a\0.json"]) {
      expect(codeOf(() => normalizeLogicalPath(bad))).toBe("invalid_path");
    }
  });
});

describe("documents", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-docs-"));
    store = SqliteStore.open(path.join(dir, "garmin.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates, reads, lists and describes documents", () => {
    const meta = store.put("workout-plans/a.json", plan("A"), { create: true, source: "web" });
    store.put("data/MED/training-plan.json", "{}");
    expect(meta).toMatchObject({ path: "workout-plans/a.json", size: plan("A").length, summary: { workoutCount: 1, weekStart: "2026-10-12", weekEnd: "2026-10-18" } });
    expect(store.get("workout-plans/a.json")?.text).toBe(plan("A"));
    expect(store.get("workout-plans/missing.json")).toBeUndefined();
    expect(store.list().map((m) => m.path)).toEqual(["data/MED/training-plan.json", "workout-plans/a.json"]);
    expect(store.list("data/MED/").map((m) => m.path)).toEqual(["data/MED/training-plan.json"]);
    expect(store.head("data/MED/training-plan.json")?.owner).toBe("MED");
  });

  it("refuses to create over a document, to replace a missing one, and to save over a newer version", () => {
    const first = store.put("workout-plans/a.json", plan("A"));
    expect(codeOf(() => store.put("workout-plans/a.json", "[]", { create: true }))).toBe("exists");
    expect(codeOf(() => store.put("workout-plans/none.json", "[]", { replace: true }))).toBe("not_found");
    expect(codeOf(() => store.put("workout-plans/none.json", "[]", { expectedVersion: 1 }))).toBe("not_found");

    const second = store.put("workout-plans/a.json", plan("B"), { expectedVersion: first.version });
    expect(second.version).not.toBe(first.version);
    expect(codeOf(() => store.put("workout-plans/a.json", plan("C"), { expectedVersion: first.version }))).toBe("conflict");
    expect(store.get("workout-plans/a.json")?.text).toBe(plan("B"));
    expect(codeOf(() => store.remove("workout-plans/a.json", { expectedVersion: first.version }))).toBe("conflict");
  });

  it("changes a document in one step", () => {
    store.put("workout-plans/a.json", plan("A"));
    const meta = store.update("workout-plans/a.json", (text) => JSON.stringify({ ...JSON.parse(text), notes: "n" }));
    expect(JSON.parse(store.get("workout-plans/a.json")!.text).notes).toBe("n");
    expect(meta.path).toBe("workout-plans/a.json");
    expect(codeOf(() => store.update("workout-plans/none.json", (t) => t))).toBe("not_found");
  });

  it("archives a document without saving it, and keeps it archived through saves and renames", () => {
    const first = store.put("workout-plans/a.json", plan("A"));
    expect(first.archivedAt).toBeNull();
    expect(codeOf(() => store.setArchived("workout-plans/none.json", true))).toBe("not_found");

    const archived = store.setArchived("workout-plans/a.json", true);
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.version).toBe(first.version); // a mark on the row, not a save
    expect(store.history("workout-plans/a.json")).toEqual([]);
    expect(store.setArchived("workout-plans/a.json", true).archivedAt).toBe(archived.archivedAt); // the first date stays

    expect(store.put("workout-plans/a.json", plan("B")).archivedAt).toBe(archived.archivedAt);
    expect(store.rename("workout-plans/a.json", "workout-plans/b.json").archivedAt).toBe(archived.archivedAt);
    expect(store.list().map((m) => [m.path, m.archivedAt !== null])).toEqual([["workout-plans/b.json", true]]);

    expect(store.setArchived("workout-plans/b.json", false).archivedAt).toBeNull();
    store.setArchived("workout-plans/b.json", true);
    store.remove("workout-plans/b.json");
    expect(store.put("workout-plans/b.json", plan("C")).archivedAt).toBeNull(); // made again, it is a new plan
  });

  it("gives a database made before archiving the column", () => {
    store.put("workout-plans/a.json", plan("A"));
    store.close();
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(path.join(dir, "garmin.db"));
    raw.exec("ALTER TABLE documents DROP COLUMN archived_at");
    raw.close();
    store = SqliteStore.open(path.join(dir, "garmin.db"));
    expect(store.head("workout-plans/a.json")?.archivedAt).toBeNull();
    expect(store.setArchived("workout-plans/a.json", true).archivedAt).not.toBeNull();
  });

  it("removes and renames", () => {
    store.put("workout-plans/a.json", plan("A"));
    store.put("workout-plans/b.json", plan("B"));
    expect(codeOf(() => store.rename("workout-plans/a.json", "workout-plans/b.json"))).toBe("exists");
    expect(codeOf(() => store.rename("workout-plans/none.json", "workout-plans/c.json"))).toBe("not_found");
    expect(store.rename("workout-plans/a.json", "workout-plans/c.json").path).toBe("workout-plans/c.json");
    expect(store.get("workout-plans/a.json")).toBeUndefined();
    expect(store.get("workout-plans/c.json")?.text).toBe(plan("A"));

    store.remove("workout-plans/c.json");
    expect(store.head("workout-plans/c.json")).toBeUndefined();
    expect(codeOf(() => store.remove("workout-plans/c.json"))).toBe("not_found");
  });
});

describe("history, ownership and sharing", () => {
  let dir: string;
  let store: SqliteStore;
  const file = () => path.join(dir, "garmin.db");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-sqlite-"));
    store = SqliteStore.open(file());
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the versions it replaces, newest first, and says who saved them", () => {
    store.put("workout-plans/a.json", plan("one"), { source: "web" });
    store.put("workout-plans/a.json", plan("two"), { source: "mcp" });
    store.put("workout-plans/a.json", plan("three"), { source: "web" });

    const history = store.history("workout-plans/a.json");
    expect(history.map((r) => r.source)).toEqual(["mcp", "web"]);
    expect(history.map((r) => r.version)).toEqual([2, 1]);
    expect(store.revision("workout-plans/a.json", history[1].id)?.text).toBe(plan("one"));
    expect(store.revision("workout-plans/other.json", history[1].id)).toBeUndefined();
  });

  it("does not record a save that changes nothing", () => {
    const first = store.put("workout-plans/a.json", plan("one"));
    const again = store.put("workout-plans/a.json", plan("one"), { expectedVersion: first.version });
    expect(again.version).toBe(first.version);
    expect(store.history("workout-plans/a.json")).toEqual([]);
  });

  it("keeps a bounded history", () => {
    for (let i = 0; i < KEEP_REVISIONS + 10; i++) store.put("workout-plans/a.json", plan(`v${i}`));
    const history = store.history("workout-plans/a.json", 1000);
    expect(history).toHaveLength(KEEP_REVISIONS);
    expect(store.revision("workout-plans/a.json", history[0].id)?.text).toBe(plan(`v${KEEP_REVISIONS + 8}`));
  });

  it("lets a deleted document be found and brought back, with a version no old editor holds", () => {
    const original = store.put("workout-plans/a.json", plan("one"));
    store.remove("workout-plans/a.json");
    expect(store.get("workout-plans/a.json")).toBeUndefined();

    const [gone] = store.deleted();
    expect(gone).toMatchObject({ path: "workout-plans/a.json", version: original.version });
    const restored = store.put("workout-plans/a.json", store.revision(gone.path, gone.id)!.text, { create: true, source: "restore" });
    expect(restored.version).toBeGreaterThan(original.version);
    expect(codeOf(() => store.put("workout-plans/a.json", plan("two"), { expectedVersion: original.version }))).toBe("conflict");
    expect(store.deleted()).toEqual([]);
  });

  it("moves history with a rename", () => {
    store.put("workout-plans/a.json", plan("one"));
    store.put("workout-plans/a.json", plan("two"));
    store.rename("workout-plans/a.json", "workout-plans/b.json");
    expect(store.history("workout-plans/a.json")).toEqual([]);
    expect(store.history("workout-plans/b.json")).toHaveLength(1);
  });

  it("owns plans by profile: data/<profile>/ always, workout-plans/ when asked", () => {
    expect(store.put("workout-plans/shared.json", "[]").owner).toBeNull();
    expect(store.put("workout-plans/mine.json", "[]", { owner: "MED" }).owner).toBe("MED");
    expect(store.put("data/SAM/w.json", "[]", { owner: "MED" }).owner).toBe("SAM");
    expect(store.put("workout-plans/mine.json", "{}", { owner: "SAM" }).owner).toBe("MED"); // only a new document takes an owner

    expect(store.setOwner("workout-plans/shared.json", "SAM").owner).toBe("SAM");
    expect(store.setOwner("workout-plans/shared.json", null).owner).toBeNull();
    expect(codeOf(() => store.setOwner("data/SAM/w.json", "MED"))).toBe("invalid_path");
    expect(store.rename("workout-plans/mine.json", "workout-plans/mine2.json").owner).toBe("MED");
    expect(store.rename("workout-plans/mine2.json", "data/SAM/mine.json").owner).toBe("SAM");
  });

  it("is shared by two connections to the same file, like the MCP server and the web editor", () => {
    const other = SqliteStore.open(file());
    try {
      const mine = store.put("workout-plans/a.json", plan("one"));
      expect(other.get("workout-plans/a.json")?.text).toBe(plan("one"));

      other.put("workout-plans/a.json", plan("theirs"), { expectedVersion: mine.version });
      expect(codeOf(() => store.put("workout-plans/a.json", plan("mine"), { expectedVersion: mine.version }))).toBe("conflict");
      expect(store.get("workout-plans/a.json")?.text).toBe(plan("theirs"));
    } finally {
      other.close();
    }
  });

  it("rolls a failed change back completely", () => {
    store.put("workout-plans/a.json", plan("one"));
    expect(() =>
      store.update("workout-plans/a.json", () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(store.get("workout-plans/a.json")?.text).toBe(plan("one"));
    expect(store.put("workout-plans/a.json", plan("two")).version).toBe(2); // and the store is still usable
  });
});

describe("export", () => {
  let dir: string;
  const saved = { data: process.env.GARMIN_DATA_DIR, path: process.env.GARMIN_STORE_PATH };
  const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-export-"));
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
    delete process.env.GARMIN_STORE_PATH;
  });
  afterEach(() => {
    closeStore();
    restore("GARMIN_DATA_DIR", saved.data);
    restore("GARMIN_STORE_PATH", saved.path);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the database in the data directory, and writes the documents back out as files", () => {
    const store = getStore();
    expect(store.location).toBe(path.join(dir, "data", "garmin.db"));
    expect(store.list()).toEqual([]);

    store.put("workout-plans/a.json", plan("A"));
    store.put("data/MED/workouts.json", "[]");
    const out = path.join(dir, "out");
    expect(exportFiles(store, out).sort()).toEqual(["data/MED/workouts.json", "workout-plans/a.json"]);
    expect(fs.readFileSync(path.join(out, "workout-plans", "a.json"), "utf8")).toBe(plan("A"));
  });

  it("follows GARMIN_STORE_PATH", () => {
    process.env.GARMIN_STORE_PATH = path.join(dir, "elsewhere", "x.db");
    expect(getStore().location).toBe(path.join(dir, "elsewhere", "x.db"));
  });
});

describe("store command line", () => {
  let dir: string;
  const saved = { data: process.env.GARMIN_DATA_DIR, path: process.env.GARMIN_STORE_PATH };
  const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  const run = (...args: string[]) => {
    const lines: string[] = [];
    const code = runStoreCli(args, (line) => lines.push(line));
    return { code, lines };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-cli-"));
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
    delete process.env.GARMIN_STORE_PATH;
  });
  afterEach(() => {
    closeStore();
    restore("GARMIN_DATA_DIR", saved.data);
    restore("GARMIN_STORE_PATH", saved.path);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("walks through history, restore and the trash", () => {
    const store = getStore();
    store.put("workout-plans/a.json", plan("one"), { source: "web" });
    store.put("workout-plans/a.json", plan("two"), { source: "mcp" });

    const history = run("history", "workout-plans/a.json").lines;
    expect(history[0]).toMatch(/^now\tv2\t.*\tmcp$/);
    expect(history[1]).toMatch(/^#\d+\tv1\t.*\tweb$/);

    expect(run("restore", "workout-plans/a.json").lines[0]).toMatch(/Restored workout-plans\/a.json from revision #\d+ \(saved .* by web\); now v3/);
    expect(run("show", "workout-plans/a.json").lines[0]).toBe(plan("one"));

    store.remove("workout-plans/a.json");
    expect(run("trash").lines[0]).toMatch(/^workout-plans\/a.json\t#\d+/);
    run("restore", "workout-plans/a.json");
    expect(store.get("workout-plans/a.json")?.text).toBe(plan("one"));
    expect(run("trash").lines).toEqual(["0 deleted document(s); restore one with: restore <path>"]);
  });

  it("lists, assigns owners and reports mistakes", () => {
    const store = getStore();
    store.put("workout-plans/a.json", "[]");
    expect(run("list", "workout-plans/").lines[0]).toMatch(/^workout-plans\/a.json\tv1\t2 B/);
    expect(run("owner", "workout-plans/a.json", "MED").lines).toEqual(["workout-plans/a.json is now owned by MED"]);
    expect(run("owner", "workout-plans/a.json", "shared").lines).toEqual(["workout-plans/a.json is now shared"]);
    expect(() => run("restore", "workout-plans/none.json")).toThrow(/Nothing to restore/);
    expect(() => run("history", "workout-plans/none.json")).toThrow(/No document or history/);
    expect(() => run("show", "../x.json")).toThrow(StoreError);
    expect(run("bogus").code).toBe(2);
  });
});
