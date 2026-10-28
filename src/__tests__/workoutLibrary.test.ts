// A tiny in-memory Garmin: createWorkout stores what it is sent, the way Garmin does.
const mockGarmin = {
  library: new Map<number, any>(),
  nextId: 1000,
  clock: 0,
  scheduled: [] as { workoutId: number; date: string }[],
  failCreate: false,
  failSchedule: false,
  calls: { getWorkouts: 0, getWorkoutDetail: 0 },
};

jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(function () {
    return {
      login: jest.fn().mockResolvedValue(true),
      getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
      exportToken: jest.fn().mockReturnValue({ oauth1: {}, oauth2: {} }),
      getWorkouts: jest.fn(async () => {
        mockGarmin.calls.getWorkouts++;
        return [...mockGarmin.library.values()].map((w) => ({
          workoutId: w.workoutId,
          workoutName: w.workoutName,
          description: w.description,
          sportType: w.sportType,
          updatedDate: w.updatedDate,
        }));
      }),
      getWorkoutDetail: jest.fn(async ({ workoutId }: { workoutId: string }) => {
        mockGarmin.calls.getWorkoutDetail++;
        const found = mockGarmin.library.get(Number(workoutId));
        if (!found) throw new Error("404 not found");
        return structuredClone(found);
      }),
      createWorkout: jest.fn(async (workout: any) => {
        if (mockGarmin.failCreate) throw new Error("500 boom");
        const stored = { ...structuredClone(workout), workoutId: mockGarmin.nextId++, updatedDate: String(++mockGarmin.clock) };
        mockGarmin.library.set(stored.workoutId, stored);
        return stored;
      }),
      deleteWorkout: jest.fn(async ({ workoutId }: { workoutId: string }) => {
        if (!mockGarmin.library.delete(Number(workoutId))) throw new Error("404 not found");
      }),
      scheduleWorkout: jest.fn(async ({ workoutId }: { workoutId: number }, date: Date) => {
        if (mockGarmin.failSchedule) throw new Error("ERROR: (500), Internal Server Error, {}");
        mockGarmin.scheduled.push({ workoutId: Number(workoutId), date: date.toISOString().slice(0, 10) });
      }),
    };
  }),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compareWorkouts } from "../shared/workoutSync";
import { configureMcp } from "../mcp/context";
import { type NewWorkout, diffPlanWorkout } from "../mcp/tools/plans";
import { checkWorkoutSync, createWorkout, deleteLibraryWorkout, getLibraryWorkout, invalidateLibrary, listLibraryWorkouts, saveWorkout, scheduleWorkout, uploadAndSchedulePlan, uploadPlan } from "../mcp/tools/garmin";
import { closeStore, getStore } from "../shared/store";
import { seedProfile } from "./fixtures/profiles";

const squat = (): any => ({
  workoutName: "Squat day",
  workoutType: "strength_training",
  description: "Heavy",
  scheduledDate: ["2000-01-01", "2999-01-01"],
  sendToDevice: true,
  steps: [
    { stepType: "interval", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5, reps: 5, weight: 225, restTimeSeconds: 120, numberOfRepeats: 3, repeatGroupIndex: 4 },
    { stepType: "interval", exerciseName: "PULL_UP", targetType: "no.target", endCondition: "reps", endConditionValue: 8, reps: 8 },
  ],
});

describe("compareWorkouts", () => {
  const base: any = {
    workoutName: "A",
    workoutType: "running",
    steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 60, durationSeconds: 60, stepOrder: 1 }],
  };

  it("finds nothing when only noise differs", () => {
    const other = structuredClone(base);
    other.workoutId = 7;
    other.description = "";
    other.steps[0].stepOrder = 9;
    other.steps[0].targetValueOne = 0;
    other.steps[0].weight = null;
    expect(compareWorkouts(base, other)).toEqual([]);
  });

  it("says what differs", () => {
    const other = structuredClone(base);
    other.workoutName = "B";
    other.steps[0].endConditionValue = 90;
    other.steps.push({ stepType: "rest" });
    const found = compareWorkouts(base, other);
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/^Name:/), expect.stringMatching(/Steps: 1 in the plan, 2 on Garmin/), expect.stringMatching(/Step 1.*endConditionValue is 60 in the plan, 90 on Garmin/)]));
  });

  it("can skip steps, treats cardio as running and ignores how repeat groups are numbered", () => {
    expect(compareWorkouts({ ...base, steps: [] }, base, { ignoreSteps: true })).toEqual([]);
    expect(compareWorkouts({ ...base, workoutType: "cardio" }, base)).toEqual([]);
    const group = (index: number, repeats: number) => ({ stepType: "interval", targetType: "no.target", numberOfRepeats: repeats, repeatGroupIndex: index });
    expect(compareWorkouts({ ...base, steps: [group(5, 3), group(5, 3), group(9, 1)] }, { ...base, steps: [group(0, 3), group(0, 3), group(1, 1)] })).toEqual([]);
    expect(compareWorkouts({ ...base, steps: [group(0, 3), group(1, 3)] }, { ...base, steps: [group(0, 3), group(0, 3)] })).not.toEqual([]);
  });

  it("caps a long list", () => {
    const many = (n: number) => ({ ...base, steps: Array.from({ length: 30 }, () => ({ stepType: "interval", reps: n })) });
    const found = compareWorkouts(many(1), many(2));
    expect(found).toHaveLength(11);
    expect(found[10]).toMatch(/…and 20 more/);
  });
});

describe("workouts on Garmin", () => {
  let dir: string;
  const saved = { data: process.env.GARMIN_DATA_DIR, store: process.env.GARMIN_STORE_PATH };

  beforeAll(() => {
    for (const method of ["log", "warn", "error"] as const) jest.spyOn(console, method).mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workout-library-"));
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
    delete process.env.GARMIN_STORE_PATH;
    seedProfile("TEST", { garmin: true });
    configureMcp({ mock: false, defaultProfile: "TEST" });
  });

  afterAll(() => {
    jest.restoreAllMocks();
    closeStore();
    configureMcp({ mock: true, defaultProfile: undefined });
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved.data === undefined) delete process.env.GARMIN_DATA_DIR; else process.env.GARMIN_DATA_DIR = saved.data;
    if (saved.store === undefined) delete process.env.GARMIN_STORE_PATH; else process.env.GARMIN_STORE_PATH = saved.store;
  });

  beforeEach(() => {
    mockGarmin.library.clear();
    mockGarmin.scheduled = [];
    mockGarmin.failCreate = false;
    mockGarmin.failSchedule = false;
    mockGarmin.calls = { getWorkouts: 0, getWorkoutDetail: 0 };
    invalidateLibrary("TEST");
  });

  it("says whether each plan workout is up to date on Garmin", async () => {
    const plan = [squat(), { ...squat(), workoutName: "Never uploaded" }, { ...squat(), workoutName: "Gone", workoutId: 31337 }];
    const { workoutId } = await saveWorkout("TEST", plan[0]);
    plan[0].workoutId = workoutId;

    const first = await checkWorkoutSync("TEST", plan);
    expect(first.map((s) => s.state)).toEqual(["synced", "not-uploaded", "missing"]);

    plan[0].steps[0].weight = 235;
    plan[0].description = "Heavier";
    const edited = await checkWorkoutSync("TEST", plan);
    expect(edited[0].state).toBe("modified");
    expect(edited[0].differences).toEqual(expect.arrayContaining(["Description differs", expect.stringMatching(/Step 1 \(BARBELL_BACK_SQUAT\): weight is 235 in the plan, 225 on Garmin/)]));
    expect(diffPlanWorkout(plan[0], (await getLibraryWorkout("TEST", workoutId))!)).toHaveLength(2);
  });

  it("lists the library once and fetches a workout's steps again only when it changes", async () => {
    const a = (await saveWorkout("TEST", squat())).workoutId;
    const plan = [{ ...squat(), workoutId: a }];
    await checkWorkoutSync("TEST", plan);
    await checkWorkoutSync("TEST", plan);
    expect(mockGarmin.calls).toEqual({ getWorkouts: 1, getWorkoutDetail: 1 });

    await checkWorkoutSync("TEST", plan, true); // refresh re-lists, but the workout itself is unchanged
    expect(mockGarmin.calls).toEqual({ getWorkouts: 2, getWorkoutDetail: 1 });

    mockGarmin.library.get(Number(a)).updatedDate = "edited in the Garmin app";
    mockGarmin.library.get(Number(a)).workoutName = "Renamed on Garmin";
    const seen = await checkWorkoutSync("TEST", plan, true);
    expect(seen[0]).toEqual({ index: 0, state: "modified", differences: [expect.stringMatching(/^Name:/)] });
    expect(mockGarmin.calls.getWorkoutDetail).toBe(2);
  });

  it("replaces a workout that already has an id and reschedules only upcoming dates when asked", async () => {
    const first = await saveWorkout("TEST", squat());
    expect(mockGarmin.scheduled).toEqual([]);

    const again = await saveWorkout("TEST", { ...squat(), workoutId: first.workoutId }, true);
    expect(again.workoutId).not.toBe(first.workoutId);
    expect(again.previousWorkoutId).toBe(first.workoutId);
    expect([...mockGarmin.library.keys()]).toEqual([again.workoutId]);
    expect(mockGarmin.scheduled).toEqual([{ workoutId: again.workoutId, date: "2999-01-01" }]);
  });

  it("fails loudly when Garmin refuses the workout", async () => {
    mockGarmin.failCreate = true;
    await expect(saveWorkout("TEST", squat())).rejects.toThrow(/did not accept/);

    mockGarmin.failCreate = false;
    const { workoutId } = await saveWorkout("TEST", squat());
    mockGarmin.failCreate = true;
    await expect(saveWorkout("TEST", { ...squat(), workoutId })).rejects.toThrow(/did not accept/);
  });

  it("deletes a workout and drops it from the listing", async () => {
    const { workoutId } = await saveWorkout("TEST", squat());
    expect(await listLibraryWorkouts("TEST")).toEqual([expect.objectContaining({ workoutId, workoutName: "Squat day", workoutType: "strength_training" })]);
    await deleteLibraryWorkout("TEST", workoutId);
    expect(await listLibraryWorkouts("TEST")).toEqual([]);
    await expect(deleteLibraryWorkout("TEST", workoutId)).rejects.toThrow(/404/);
  });

  describe("deleting or replacing one workout of many", () => {
    const named = (i: number) => ({ ...squat(), workoutName: `Workout ${i}` });
    /** Save `n` workouts and check them once, so the listing and every workout's steps are cached; the counters then start from zero. */
    const checked = async (n: number) => {
      const plan: any[] = [];
      for (let i = 0; i < n; i++) plan.push({ ...named(i), workoutId: (await saveWorkout("TEST", named(i))).workoutId });
      expect((await checkWorkoutSync("TEST", plan)).every((s) => s.state === "synced")).toBe(true);
      mockGarmin.calls = { getWorkouts: 0, getWorkoutDetail: 0 };
      return plan;
    };

    it("asks Garmin for nothing again when one is deleted: the listing is patched and the others' steps stay cached", async () => {
      const plan = await checked(5);
      await deleteLibraryWorkout("TEST", plan[0].workoutId);
      expect(mockGarmin.calls).toEqual({ getWorkouts: 0, getWorkoutDetail: 0 });

      const rest = plan.slice(1);
      expect((await checkWorkoutSync("TEST", rest)).map((s) => s.state)).toEqual(["synced", "synced", "synced", "synced"]);
      expect((await listLibraryWorkouts("TEST")).map((w) => w.workoutName)).toEqual(["Workout 1", "Workout 2", "Workout 3", "Workout 4"]);
      expect((await checkWorkoutSync("TEST", [plan[0]]))[0].state).toBe("missing"); // the deleted one is gone, not served from the cache
      expect(mockGarmin.calls.getWorkouts).toBe(0);
    });

    it("lists again after a replace, but fetches only the replaced workout's steps", async () => {
      const plan = await checked(5);
      const { workoutId } = await saveWorkout("TEST", plan[0]); // deleted and recreated under a new id
      plan[0].workoutId = workoutId;
      mockGarmin.calls = { getWorkouts: 0, getWorkoutDetail: 0 };

      expect((await checkWorkoutSync("TEST", plan)).map((s) => s.state)).toEqual(["synced", "synced", "synced", "synced", "synced"]);
      expect(mockGarmin.calls).toEqual({ getWorkouts: 1, getWorkoutDetail: 1 });
    });

    it("looks at Garmin again when a delete fails, since the workout may be gone already", async () => {
      const plan = await checked(2);
      mockGarmin.library.delete(Number(plan[0].workoutId)); // removed in the Garmin app
      await expect(deleteLibraryWorkout("TEST", plan[0].workoutId)).rejects.toThrow(/404/);
      expect((await listLibraryWorkouts("TEST")).map((w) => w.workoutName)).toEqual(["Workout 1"]);
      expect(mockGarmin.calls.getWorkouts).toBe(1);
    });

    it("lists again after a delete from a full listing, which may now show an older workout", async () => {
      const plan = await checked(1);
      for (let i = 0; i < 99; i++) mockGarmin.library.set(5000 + i, { workoutId: 5000 + i, workoutName: `Filler ${i}`, updatedDate: "1" });
      expect(await listLibraryWorkouts("TEST", true)).toHaveLength(100);
      mockGarmin.calls = { getWorkouts: 0, getWorkoutDetail: 0 };

      await deleteLibraryWorkout("TEST", plan[0].workoutId);
      expect(await listLibraryWorkouts("TEST")).toHaveLength(99);
      expect(mockGarmin.calls.getWorkouts).toBe(1);
    });
  });

  describe("plans in the store", () => {
    const planDoc = (workouts: any[]) => JSON.stringify({ generatedAt: "2026-10-11T00:00:00Z", weekStart: "2026-10-12", weekEnd: "2026-10-18", workouts }, null, 2);
    const idsIn = (logical: string) => JSON.parse(getStore().get(logical)!.text).workouts.map((w: any) => w.workoutId);

    it("writes the new workoutIds back into the plan and keeps the version it had", async () => {
      getStore().put("workout-plans/up.json", planDoc([squat()]), { source: "web" });
      const result = await uploadPlan("TEST", "workout-plans/up.json");
      expect(result).toMatchObject({ path: "workout-plans/up.json", status: "ok", successful: 1 });

      const [id] = idsIn("workout-plans/up.json");
      expect(mockGarmin.library.has(Number(id))).toBe(true);
      expect(getStore().head("workout-plans/up.json")?.source).toBe("mcp");
      const [before] = getStore().history("workout-plans/up.json");
      expect(JSON.parse(getStore().revision("workout-plans/up.json", before.id)!.text).workouts[0].workoutId).toBeUndefined();
    });

    it("replaces the workout it already uploaded instead of duplicating it", async () => {
      getStore().put("workout-plans/again.json", planDoc([squat()]));
      await uploadPlan("TEST", "workout-plans/again.json");
      const [first] = idsIn("workout-plans/again.json");
      await uploadPlan("TEST", "workout-plans/again.json");
      const [second] = idsIn("workout-plans/again.json");
      expect(second).not.toBe(first);
      expect([...mockGarmin.library.keys()]).toEqual([Number(second)]);
    });

    it("uploads and schedules a plan and stores the ids", async () => {
      getStore().put("workout-plans/both.json", planDoc([squat()]));
      const result = await uploadAndSchedulePlan("TEST", "workout-plans/both.json");
      expect(result).toMatchObject({ path: "workout-plans/both.json", writtenBack: true });
      const [id] = idsIn("workout-plans/both.json");
      expect(mockGarmin.scheduled).toEqual([
        { workoutId: Number(id), date: "2000-01-01" },
        { workoutId: Number(id), date: "2999-01-01" },
      ]);
    });

    it("says so when the plan is not in the store", async () => {
      await expect(uploadPlan("TEST", "workout-plans/none.json")).rejects.toThrow(/File not found/);
      await expect(uploadAndSchedulePlan("TEST", "workout-plans/none.json")).rejects.toThrow(/File not found/);
    });
  });

  describe("one workout and no plan", () => {
    const run = (): NewWorkout => ({
      workoutName: "Easy 5k",
      workoutType: "running",
      description: "Just run",
      steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000, distanceMeters: 5000 }],
    });

    describe("createWorkout", () => {
      it("makes a workout in the library from the workout alone: no plan is written and nothing is scheduled", async () => {
        const plans = getStore().list("workout-plans/").map((d) => d.path);
        const out = await createWorkout("TEST", run());
        expect(out).toMatchObject({ workoutName: "Easy 5k", workoutType: "running", stepCount: 1, workoutId: expect.any(Number) });

        const stored = mockGarmin.library.get(out.workoutId!);
        expect(stored).toMatchObject({ workoutName: "Easy 5k", description: "Just run", sportType: { sportTypeKey: "running" } });
        expect(stored.workoutSegments[0].workoutSteps).toEqual([expect.objectContaining({ endConditionValue: 5000 })]);
        expect(mockGarmin.scheduled).toEqual([]);
        expect(getStore().list("workout-plans/").map((d) => d.path)).toEqual(plans);
      });

      it("always makes a new workout: it never replaces one, even when it is handed an id", async () => {
        const first = await createWorkout("TEST", run());
        const second = await createWorkout("TEST", run());
        expect(second.workoutId).not.toBe(first.workoutId);

        await createWorkout("TEST", { ...run(), workoutId: first.workoutId } as NewWorkout);
        expect(mockGarmin.library.has(first.workoutId!)).toBe(true);
        expect(mockGarmin.library.size).toBe(3);
      });

      it("checks the workout first and makes nothing when it is wrong", async () => {
        const bad = { ...run(), steps: [{ ...run().steps[0], exerciseName: "NOT_A_REAL_EXERCISE" }] };
        await expect(createWorkout("TEST", bad)).rejects.toThrow(/Workout not created: .*Unknown exerciseName/);
        expect(mockGarmin.library.size).toBe(0);
      });

      it("with dryRun only checks it", async () => {
        expect(await createWorkout("TEST", run(), true)).toMatchObject({ dryRun: true, valid: true, stepCount: 1 });
        expect(mockGarmin.library.size).toBe(0);
        await expect(createWorkout("TEST", { ...run(), steps: [{ stepType: "sprint" }] } as any, true)).rejects.toThrow(/Workout not created/);
      });

      it("fails loudly when Garmin refuses the workout", async () => {
        mockGarmin.failCreate = true;
        await expect(createWorkout("TEST", run())).rejects.toThrow(/did not accept/);
        expect(mockGarmin.library.size).toBe(0);
      });

      it("shows in the listing the web editor holds, which would otherwise be a minute old", async () => {
        expect(await listLibraryWorkouts("TEST")).toEqual([]);
        const { workoutId } = await createWorkout("TEST", run());
        expect((await listLibraryWorkouts("TEST")).map((w) => w.workoutId)).toEqual([workoutId]);
      });
    });

    describe("scheduleWorkout", () => {
      it("puts a workout of the library on the day asked for, and says which workout it was", async () => {
        const { workoutId } = await createWorkout("TEST", run());
        const out = await scheduleWorkout("TEST", workoutId!, "2026-11-02");
        expect(out).toEqual({ workoutId, workoutName: "Easy 5k", date: "2026-11-02" });
        expect(mockGarmin.scheduled).toEqual([{ workoutId, date: "2026-11-02" }]);
      });

      it("takes any workout of the library, with its id as a number or as text: one made in the Garmin app, say", async () => {
        mockGarmin.library.set(777, { workoutId: 777, workoutName: "Made in the app", updatedDate: "1" });
        expect(await scheduleWorkout("TEST", "777", "2026-11-03")).toMatchObject({ workoutId: 777, workoutName: "Made in the app" });
        await scheduleWorkout("TEST", 777, "2026-11-04");
        expect(mockGarmin.scheduled).toEqual([{ workoutId: 777, date: "2026-11-03" }, { workoutId: 777, date: "2026-11-04" }]);
      });

      it("schedules a past day too, since the calendar takes it", async () => {
        const { workoutId } = await createWorkout("TEST", run());
        await scheduleWorkout("TEST", workoutId!, "2020-01-31");
        expect(mockGarmin.scheduled).toEqual([{ workoutId, date: "2020-01-31" }]);
      });

      it("says so when Garmin has no such workout, and schedules nothing: the old id of a workout that was uploaded again, say", async () => {
        const first = await saveWorkout("TEST", squat());
        const second = await saveWorkout("TEST", { ...squat(), workoutId: first.workoutId });
        expect(second.workoutId).not.toBe(first.workoutId);

        await expect(scheduleWorkout("TEST", first.workoutId, "2026-11-02")).rejects.toThrow(new RegExp(`did not return workout ${first.workoutId}.*list_workouts`));
        await expect(scheduleWorkout("TEST", 424242, "2026-11-02")).rejects.toThrow(/did not return workout 424242/);
        expect(mockGarmin.scheduled).toEqual([]);
      });

      it("does not report a day Garmin refused as scheduled", async () => {
        const { workoutId } = await createWorkout("TEST", run());
        mockGarmin.failSchedule = true;
        await expect(scheduleWorkout("TEST", workoutId!, "2026-11-02")).rejects.toThrow(/500/);
        expect(mockGarmin.scheduled).toEqual([]);
      });

      it("refuses a day that does not exist and an id that is not one before it asks Garmin anything", async () => {
        const { workoutId } = await createWorkout("TEST", run());
        mockGarmin.calls = { getWorkouts: 0, getWorkoutDetail: 0 };
        for (const day of ["2026-02-30", "2026-13-01", "2026-11-31", "tomorrow", ""]) {
          await expect(scheduleWorkout("TEST", workoutId!, day)).rejects.toThrow(/is not a day/);
        }
        for (const id of ["abc", "12ab", "", 0, -3, 1.5, Number.NaN, 2 ** 60]) {
          await expect(scheduleWorkout("TEST", id, "2026-11-02")).rejects.toThrow(/workoutId must be the number of a workout/);
        }
        expect(mockGarmin.calls.getWorkoutDetail).toBe(0);
        expect(mockGarmin.scheduled).toEqual([]);
      });

      it("accepts the last day of a leap year, which a calendar-blind check would refuse or move", async () => {
        const { workoutId } = await createWorkout("TEST", run());
        await scheduleWorkout("TEST", workoutId!, "2028-02-29");
        await expect(scheduleWorkout("TEST", workoutId!, "2027-02-29")).rejects.toThrow(/is not a day/);
        expect(mockGarmin.scheduled).toEqual([{ workoutId, date: "2028-02-29" }]);
      });
    });

    it("creates a workout and puts it on a day with two calls", async () => {
      const { workoutId } = await createWorkout("TEST", run());
      await scheduleWorkout("TEST", workoutId!, "2026-11-05");
      expect(mockGarmin.scheduled).toEqual([{ workoutId, date: "2026-11-05" }]);
      expect(mockGarmin.library.size).toBe(1);
    });
  });
});
