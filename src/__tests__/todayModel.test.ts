export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TM = require("../web/public/todayModel.js");

const TODAY = "2026-10-18"; // a Sunday
const NOW = Date.parse("2026-10-18T15:00:00Z");
const n = (v: number) => v.toLocaleString();

const view = (over: Record<string, unknown> = {}) => ({
  today: TODAY,
  day: { day: TODAY, steps: 4491, bodyBatteryWake: 72, bodyBatteryLow: 26, avgStress: 32, sleepSeconds: 27_000, sleepNeedMinutes: 480, sleepScore: 82, restingHr: 55 },
  progress: { fetchedAt: NOW - 12 * 60_000, stepGoal: 6230, intensityGoal: 150, distanceMeters: 3444, bodyBatteryNow: 31, watchSyncedAt: NOW - 3 * 3_600_000 },
  week: { start: "2026-10-12", minutes: 95, daysStored: 7, days: 7 },
  readiness: { band: "as-planned", score: 54, confidence: "high", suggestion: "A normal day: train as planned." },
  workouts: [],
  activities: [],
  food: { day: TODAY, kcal: 1500, proteinG: 90, carbsG: 150, fatG: 50, entries: 4, burnedKcal: 1209, burnedSoFar: true, netKcal: 291, meals: undefined },
  ...over,
});
const tile = (v: any, id: string) => TM.progressTiles(v).find((t: any) => t.id === id);

describe("how old the numbers are", () => {
  it("says the age in the largest fitting unit", () => {
    expect(TM.ago(NOW - 20_000, NOW)).toBe("just now");
    expect(TM.ago(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(TM.ago(NOW - 3 * 3_600_000 - 59_000, NOW)).toBe("3 h ago");
    expect(TM.ago(NOW - 25 * 3_600_000, NOW)).toBe("1 day ago");
    expect(TM.ago(NOW - 49 * 3_600_000, NOW)).toBe("2 days ago");
    expect(TM.ago(NOW + 5000, NOW)).toBe("just now"); // a clock a little ahead of the server's
    expect(TM.ago(null, NOW)).toBe("");
  });

  it("gives both the watch's last sync and the fetch, because the steps are only as new as the watch", () => {
    expect(TM.freshness(view(), NOW)).toEqual({ text: "Watch synced 3 h ago · fetched 12 min ago", stale: false });
  });

  it("says Fetched alone when Garmin gave no watch time, and calls a fetch older than half an hour stale", () => {
    const old = view({ progress: { fetchedAt: NOW - 40 * 60_000, stepGoal: null, intensityGoal: null, distanceMeters: null, bodyBatteryNow: null, watchSyncedAt: null } });
    expect(TM.freshness(old, NOW)).toEqual({ text: "Fetched 40 min ago", stale: true });
  });

  it("says plainly that nothing is stored when there is no summary", () => {
    const none = TM.freshness(view({ progress: null }), NOW);
    expect(none.stale).toBe(true);
    expect(none.text).toMatch(/not stored yet/);
  });
});

describe("the progress tiles", () => {
  it("shows the steps against the goal, with the distance", () => {
    const steps = tile(view(), "steps");
    expect(steps).toMatchObject({ label: "Steps", value: n(4491), pct: 72, done: false, go: "recovery" });
    expect(steps.note).toBe(`of ${n(6230)} · 72% · 3.4 km`);
  });

  it("marks the goal met past 100 %, and keeps the percentage honest", () => {
    const met = tile(view({ day: { steps: 8000 } }), "steps");
    expect(met.pct).toBe(128);
    expect(met.done).toBe(true);
  });

  it("never turns a missing step count into zero", () => {
    for (const v of [view({ day: null, progress: null }), view({ day: { steps: null } })]) {
      const steps = tile(v, "steps");
      expect(steps.value).toBe("–");
      expect(steps.note).toBe("not synced yet");
      expect(steps.pct).toBeNull();
      expect(steps.done).toBe(false);
    }
  });

  it("shows steps without a bar when Garmin gave no goal", () => {
    const steps = tile(view({ progress: { ...view().progress, stepGoal: null, distanceMeters: null } }), "steps");
    expect(steps).toMatchObject({ value: n(4491), pct: null, note: "steps" });
  });

  it("counts the intensity minutes of the week against the weekly goal", () => {
    expect(tile(view(), "intensity")).toMatchObject({ value: "95", pct: 63, done: false, note: "of 150 this week · 63%" });
  });

  it("says when some days of the week have no summary stored, so a short total is not taken for the truth", () => {
    const partial = tile(view({ week: { start: "2026-10-12", minutes: 40, daysStored: 4, days: 7 } }), "intensity");
    expect(partial.note).toBe("of 150 this week · 27% · 4 of 7 days stored");
  });

  it("shows no intensity total when the week has nothing stored", () => {
    const none = tile(view({ week: { start: "2026-10-12", minutes: 0, daysStored: 0, days: 7 } }), "intensity");
    expect(none).toMatchObject({ value: "–", note: "not synced yet", pct: null });
  });

  it("shows the Body Battery now as its own bar, with the morning figure and the stress", () => {
    expect(tile(view(), "battery")).toMatchObject({ value: "31", pct: 31, note: "woke at 72 · low 26 · stress 32" });
    expect(tile(view({ progress: { ...view().progress, bodyBatteryNow: 140 } }), "battery").pct).toBe(100);
    expect(tile(view({ day: null, progress: null }), "battery")).toMatchObject({ value: "–", pct: null, note: "no reading yet" });
  });

  it("shows last night's sleep against the need", () => {
    expect(tile(view(), "sleep")).toMatchObject({ value: "7 h 30", pct: 94, done: false, note: "score 82 · need 8 h 00 · resting HR 55" });
    expect(tile(view({ day: { steps: 1 } }), "sleep")).toMatchObject({ value: "–", pct: null, note: "none stored for last night" });
  });
});

describe("the food tiles", () => {
  it("are the Food view's: eaten, burned so far, the difference and the macros", () => {
    const tiles = TM.foodTiles(view());
    expect(tiles.map((t: any) => t.label)).toEqual(["Eaten", "Burned", "Eaten − burned", "Macros"]);
    expect(tiles.every((t: any) => t.go === "food")).toBe(true);
    expect(tiles[0].value).toBe(`${n(1500)} kcal`);
    expect(tiles[1].note).toBe("so far today, by Garmin");
  });

  it("say nothing is logged rather than zero", () => {
    const tiles = TM.foodTiles(view({ food: { day: TODAY, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entries: 0, burnedKcal: 1209, burnedSoFar: true, netKcal: null } }));
    expect(tiles[0]).toMatchObject({ value: "–", note: "nothing logged" });
  });
});

describe("the workouts", () => {
  const w = (over: Record<string, unknown>) => ({ date: TODAY, path: "workout-plans/a.json", index: 0, name: "Upper A", type: "strength_training", seconds: 3300, done: false, ...over });

  it("lists today even when nothing is planned, with the days after it that have a workout", () => {
    expect(TM.workoutDays(view())).toEqual([{ date: TODAY, label: "Today", today: true, items: [], done: 0 }]);
    const days = TM.workoutDays(view({ workouts: [w({}), w({ date: "2026-10-19", name: "Easy run", type: "running", seconds: 2400 }), w({ date: "2026-10-21", name: "Lower", seconds: null })] }));
    expect(days.map((d: any) => d.label)).toEqual(["Today", "Tomorrow", "Wed 21 Oct"]);
    expect(days[1].items[0]).toEqual({ name: "Easy run", meta: "Running · 40 min", done: false, path: "workout-plans/a.json", index: 0 });
    expect(days[2].items[0].meta).toBe("Strength training");
  });

  it("counts what is done today", () => {
    const today = TM.workoutDays(view({ workouts: [w({ done: true }), w({ index: 1, name: "Core" })] }))[0];
    expect(today.items.map((i: any) => i.done)).toEqual([true, false]);
    expect(today.done).toBe(1);
  });

  it("totals a workout from its steps when it is asked to, and marks a time that rests on an assumed pace", () => {
    const run = w({ name: "Rehearsal", type: "running", seconds: null, workout: { steps: [] } });
    const days = TM.workoutDays(view({ workouts: [run, w({ index: 1, name: "Plain", seconds: 3300, workout: {} })] }), (workout: any) => (workout.steps ? { seconds: 3720, meters: 11000, assumed: true } : { seconds: 0, meters: 0, assumed: false }));
    expect(days[0].items.map((i: any) => i.meta)).toEqual(["Running · 11 km · ~1 h 02 min", "Strength training · 55 min"]); // no steps: the plan's own estimate
    const exact = TM.workoutDays(view({ workouts: [run] }), () => ({ seconds: 1800, meters: 5000, assumed: false }))[0].items[0].meta;
    expect(exact).toBe("Running · 5 km · 30 min");
  });

  it("lists the days in date order whatever order the workouts come in", () => {
    const days = TM.workoutDays(view({ workouts: [w({ date: "2026-10-20" }), w({ date: "2026-10-19" })] }));
    expect(days.map((d: any) => d.date)).toEqual([TODAY, "2026-10-19", "2026-10-20"]);
  });

  it("says the type in words", () => {
    expect(TM.typeLabel("strength_training")).toBe("Strength training");
    expect(TM.typeLabel(null)).toBe("");
  });
});

describe("what was done today", () => {
  it("says when, how far, how long and the calories", () => {
    expect(TM.activityLine({ id: "1", name: "Morning run", time: "07:12", km: 8.24, seconds: 2710, calories: 520 })).toEqual({ id: "1", name: "Morning run", meta: `07:12 · 8.2 km · 45 min · ${n(520)} kcal` });
  });

  it("leaves out what the activity lacks", () => {
    expect(TM.activityLine({ id: "2", name: "Strength", time: "18:00", km: null, seconds: 3000, calories: null }).meta).toBe("18:00 · 50 min");
  });
});

describe("the readiness", () => {
  it("is the band's words, the score and the suggestion", () => {
    expect(TM.readinessLine(view().readiness)).toEqual({ label: "As planned", cls: "plan", score: 54, text: "A normal day: train as planned." });
    expect(TM.readinessLine({ band: "back-off", score: 30, confidence: "low", suggestion: "Easy." }).cls).toBe("back");
    expect(TM.readinessLine({ band: "unknown", score: null, confidence: "low", suggestion: "x" }).label).toBe("Not enough data");
  });
});
