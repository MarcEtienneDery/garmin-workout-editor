export {}; // a module of its own: the helpers below must not clash with those of the other model tests
/** workoutListModel.js orders and narrows the Workouts view's list. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require("../web/public/workoutListModel.js");

const row = (name: string, extra: Record<string, unknown> = {}) => ({ key: name, workoutName: name, workoutType: "running", plans: [], dates: [], state: "linked", ...extra });
const today = "2026-10-15";
const states: Record<string, string> = {};
const stateOf = (r: any) => states[r.key] ?? (r.state === "linked" ? "synced" : r.state);
const env = { stateOf, today };
const names = (rows: any[]) => rows.map((r) => r.workoutName);

beforeEach(() => { for (const k of Object.keys(states)) delete states[k]; });

describe("sorting", () => {
  it("puts the most recently updated first and leaves rows with no date in their own order after them", () => {
    const rows = [row("plan only 1", { updatedDate: undefined }), row("old", { updatedDate: "2026-01-02 10:00:00" }), row("new", { updatedDate: "2026-09-01T08:00:00.0" }), row("plan only 2")];
    expect(names(L.sortRows(rows, "updated", env))).toEqual(["new", "old", "plan only 1", "plan only 2"]);
  });

  it("sorts by name the way a person counts: W2 before W10, case aside", () => {
    expect(names(L.sortRows([row("Run W10"), row("run W2"), row("Bench"), row("Run W1")], "name", env))).toEqual(["Bench", "Run W1", "run W2", "Run W10"]);
  });

  it("sorts by type, then name, with an unnamed type as 'other'", () => {
    const rows = [row("b", { workoutType: "running" }), row("a", { workoutType: "strength_training" }), row("c", { workoutType: undefined }), row("a2", { workoutType: "running" })];
    expect(names(L.sortRows(rows, "type", env))).toEqual(["c", "a2", "b", "a"]);
  });

  it("puts what needs a look first: missing, can't check, differs, never uploaded, then up to date", () => {
    const rows = ["ok", "differs", "gone", "broken", "new", "garmin"].map((n) => row(n));
    Object.assign(states, { ok: "synced", differs: "modified", gone: "missing", broken: "error", new: "not-uploaded", garmin: "garmin-only" });
    expect(names(L.sortRows(rows, "status", env))).toEqual(["gone", "broken", "differs", "new", "garmin", "ok"]);
  });

  it("sorts by the next scheduled day from today, ignores days that are past, and puts the unscheduled last", () => {
    const rows = [
      row("past only", { dates: ["2026-10-01"] }),
      row("later", { dates: ["2026-11-02"] }),
      row("soon", { dates: ["2026-10-01", "2026-10-20", "2026-12-01"] }),
      row("today", { dates: ["2026-10-15"] }),
      row("none"),
    ];
    expect(names(L.sortRows(rows, "scheduled", env))).toEqual(["today", "soon", "later", "none", "past only"]);
    expect(L.nextDate(rows[2], today)).toBe("2026-10-20");
    expect(L.nextDate(rows[0], today)).toBeNull();
  });

  it("returns a new list and ignores an unknown key", () => {
    const rows = [row("b"), row("a")];
    expect(names(L.sortRows(rows, "name", env))).toEqual(["a", "b"]);
    expect(names(rows)).toEqual(["b", "a"]);
    expect(names(L.sortRows(rows, "bogus", env))).toEqual(["b", "a"]);
  });
});

describe("filtering", () => {
  const plan = (path: string) => ({ path, index: 0 });
  const rows = [
    row("Easy run", { plans: [plan("workout-plans/hm.json")], dates: ["2026-10-20"] }),
    row("Bench", { workoutType: "strength_training", plans: [plan("workout-plans/hm.json"), plan("workout-plans/july.json")] }),
    row("Hill repeats", { plans: [plan("workout-plans/july.json")], state: "not-uploaded" }),
    row("On Garmin only", { workoutType: "cycling", state: "garmin-only" }),
  ];
  Object.assign(states, {});

  it("keeps everything when nothing is set", () => {
    expect(L.filterRows(rows, {}, env)).toHaveLength(4);
    expect(L.filterRows(rows, undefined, env)).toHaveLength(4);
  });

  it("searches the words of the name, the type and the plan files, all of them", () => {
    expect(names(L.filterRows(rows, { query: "july" }, env))).toEqual(["Bench", "Hill repeats"]);
    expect(names(L.filterRows(rows, { query: "strength  bench" }, env))).toEqual(["Bench"]);
    expect(L.filterRows(rows, { query: "zzz" }, env)).toEqual([]);
  });

  it("filters by status group", () => {
    states.Bench = "modified";
    states["Easy run"] = "missing";
    expect(names(L.filterRows(rows, { status: "attention" }, env))).toEqual(["Easy run", "Bench"]);
    expect(names(L.filterRows(rows, { status: "ok" }, env))).toEqual([]);
    expect(names(L.filterRows(rows, { status: "notuploaded" }, env))).toEqual(["Hill repeats"]);
    expect(names(L.filterRows(rows, { status: "garminonly" }, env))).toEqual(["On Garmin only"]);
    delete states.Bench; delete states["Easy run"];
    expect(names(L.filterRows(rows, { status: "ok" }, env))).toEqual(["Easy run", "Bench"]);
  });

  it("filters by plan, and by being in no plan", () => {
    expect(names(L.filterRows(rows, { plan: "workout-plans/july.json" }, env))).toEqual(["Bench", "Hill repeats"]);
    expect(names(L.filterRows(rows, { plan: "none" }, env))).toEqual(["On Garmin only"]);
    expect(L.filterRows(rows, { plan: "all" }, env)).toHaveLength(4);
  });

  it("filters by type, several at once, and by upcoming", () => {
    expect(names(L.filterRows(rows, { types: new Set(["strength_training", "cycling"]) }, env))).toEqual(["Bench", "On Garmin only"]);
    expect(L.filterRows(rows, { types: new Set() }, env)).toHaveLength(4);
    expect(names(L.filterRows(rows, { upcoming: true }, env))).toEqual(["Easy run"]);
  });

  it("combines filters", () => {
    expect(names(L.filterRows(rows, { plan: "workout-plans/hm.json", types: new Set(["running"]), upcoming: true }, env))).toEqual(["Easy run"]);
    expect(L.filterRows(rows, { plan: "workout-plans/july.json", upcoming: true }, env)).toEqual([]);
  });

  it("counts types and plans for the controls, and says whether anything is filtered", () => {
    expect(L.typeCounts(rows)).toEqual([["running", 2], ["cycling", 1], ["strength_training", 1]]);
    expect(L.planCounts(rows)).toEqual([{ path: "workout-plans/hm.json", count: 2 }, { path: "workout-plans/july.json", count: 2 }]);
    expect(L.isFiltered({})).toBe(false);
    expect(L.isFiltered({ query: "  ", status: "all", plan: "all", types: new Set(), upcoming: false })).toBe(false);
    for (const set of [{ query: "x" }, { status: "ok" }, { plan: "none" }, { types: new Set(["running"]) }, { upcoming: true }]) expect(L.isFiltered(set)).toBe(true);
  });
});
