import { Decoder, Stream } from "@garmin/fitsdk";
import { SETTLE_MS, dueProfiles, recentFit, syncRenpho, testRenphoLogin } from "../shared/renphoSync";
import { SqliteStore } from "../shared/store";
import { fakeRenpho, loginHandler, renphoRow, renphoWith } from "./fixtures/renpho";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-18T15:00:00Z");
let store: SqliteStore;
const savedTz = process.env.GARMIN_TZ;

beforeEach(() => {
  process.env.GARMIN_TZ = "UTC";
  store = SqliteStore.open(":memory:");
  store.credentials.put("MED", "renpho", "me@x.y", "pw");
  store.renpho.saveSettings("MED", { fetchEnabled: true });
});
afterEach(() => {
  store.close();
  if (savedTz === undefined) delete process.env.GARMIN_TZ; else process.env.GARMIN_TZ = savedTz;
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => renphoRow(i + 1));
const run = (fetchFn: typeof fetch, options: Partial<Parameters<typeof syncRenpho>[2]> = {}) => syncRenpho(store, "MED", { holder: "a", fetch: fetchFn, now: T0, ...options });
const fitCount = (bytes: Uint8Array) => (new Decoder(Stream.fromByteArray(Array.from(bytes))).read().messages as any).weightScaleMesgs.length as number;

describe("when a run goes ahead", () => {
  it("needs a saved login, the switch on (a run by hand excepted), and no earlier refusal of the login", async () => {
    const { fetchFn, calls } = renphoWith(rows(1));
    store.credentials.delete("MED", "renpho");
    expect(await run(fetchFn)).toEqual(expect.objectContaining({ ran: false, reason: "No Renpho login is saved." }));
    store.credentials.put("MED", "renpho", "me@x.y", "pw");
    store.renpho.saveSettings("MED", { fetchEnabled: false });
    expect((await run(fetchFn)).reason).toMatch(/switched off/);
    expect((await run(fetchFn, { manual: true })).ran).toBe(true); // a person asked for it
    store.renpho.saveSettings("MED", { fetchEnabled: true });
    store.renpho.saveState("MED", { error: "refused", errorKind: "login" });
    expect((await run(fetchFn)).reason).toMatch(/refused the login/);
    expect((await run(fetchFn, { manual: true })).ran).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("is refused while another run holds the lease, and gives the lease back when it is done", async () => {
    const { fetchFn } = renphoWith(rows(1));
    store.renpho.claim("MED", "other", 60_000, T0);
    expect(await run(fetchFn)).toEqual(expect.objectContaining({ ran: false, reason: "A run is already going." }));
    store.renpho.release("MED", "other");
    expect((await run(fetchFn)).ran).toBe(true);
    expect(store.renpho.state("MED").holder).toBeNull();
  });
});

describe("fetching", () => {
  it("keeps the account's weigh-ins as Renpho sent them, leaves other people's on the scale out, and schedules the next run", async () => {
    const { fetchFn } = renphoWith([...rows(3), renphoRow(9, { bUserId: "999" })]);
    const result = await run(fetchFn);
    expect(result).toEqual({ ran: true, seen: 3, added: 3, others: 1, uploaded: 0, error: null });
    const kept = store.renpho.measurements("MED");
    expect(kept.map((m) => m.id)).toEqual(["3", "2", "1"]);
    expect(kept[0].data).toEqual(renphoRow(3)); // exactly as it came
    expect(kept[0]).toEqual(expect.objectContaining({ measuredAt: renphoRow(3).timeStamp * 1000, day: "2025-10-12" }));
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ lastRunAt: T0, lastOkAt: T0, nextRunAt: T0 + 3 * HOUR, error: null, errorKind: null }));
    expect(store.renpho.logLines("MED").map((l) => l.message)).toEqual([expect.stringMatching(/Renpho holds 3 weigh-ins of this account \(and 1 of other people on the scale, left out\); 3 new/), "Scheduled run started."]);
    expect(JSON.stringify(store.renpho.logLines("MED"))).not.toContain("pw");
  });

  it("adds only what is new the next time", async () => {
    await run(renphoWith(rows(2)).fetchFn);
    const second = await run(renphoWith(rows(3)).fetchFn, { now: T0 + 3 * HOUR });
    expect(second).toEqual(expect.objectContaining({ seen: 3, added: 1 }));
    expect(store.renpho.counts("MED").total).toBe(3);
  });

  it("takes the day of a weigh-in in the user's zone", async () => {
    process.env.GARMIN_TZ = "America/Toronto";
    const late = renphoRow(1, { timeStamp: Date.parse("2026-10-18T02:30:00Z") / 1000 }); // 22:30 the evening before in Toronto
    await run(renphoWith([late]).fetchFn);
    expect(store.renpho.measurements("MED")[0].day).toBe("2026-10-17");
  });

  it("stops the schedule on a refused login, never retries it by itself, and a good login test lets it go on", async () => {
    const refused = fakeRenpho({ "renpho-aggregation/user/login": () => ({ __raw: { code: 5001, msg: "no" } }) }).fetchFn;
    const result = await run(refused);
    expect(result).toEqual(expect.objectContaining({ ran: true, added: 0, error: expect.stringMatching(/did not accept the login/) }));
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ errorKind: "login", nextRunAt: null }));
    expect(store.renpho.logLines("MED")[0]).toEqual(expect.objectContaining({ level: "error", message: expect.stringMatching(/stop until the login is saved or tested again/) }));
    expect(dueProfiles(store, T0 + 99 * HOUR)).toEqual([]);
    const ok = await testRenphoLogin(store, "MED", renphoWith([]).fetchFn, T0 + HOUR);
    expect(ok).toEqual({ ok: true, message: expect.stringMatching(/accepted the login \(1 scale table/) });
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ error: null, errorKind: null }));
    expect(dueProfiles(store, T0 + 99 * HOUR)).toEqual(["MED"]);
  });

  it("waits hours after a rate limit, and the interval after another failure", async () => {
    const limited = fakeRenpho({ ...loginHandler, "renpho-aggregation/device/count": () => new Response("", { status: 429 }) }).fetchFn;
    expect((await run(limited)).error).toMatch(/too many requests/);
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ errorKind: "other", nextRunAt: T0 + 6 * HOUR }));
    store.renpho.saveSettings("MED", { intervalHours: 1 });
    const broken = fakeRenpho({ ...loginHandler, "renpho-aggregation/device/count": () => new Response("", { status: 500 }) }).fetchFn;
    await run(broken, { now: T0 + 7 * HOUR });
    expect(store.renpho.state("MED").nextRunAt).toBe(T0 + 8 * HOUR);
    expect(dueProfiles(store, T0 + 7.5 * HOUR)).toEqual([]);
    expect(dueProfiles(store, T0 + 8 * HOUR)).toEqual(["MED"]);
  });

  it("reports a failed login test without changing a working schedule", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await testRenphoLogin(store, "MED", down)).toEqual({ ok: false, message: expect.stringMatching(/Could not reach Renpho: offline/) });
    expect(store.renpho.state("MED").errorKind).toBeNull(); // not a refusal
    store.credentials.delete("MED", "renpho");
    expect(await testRenphoLogin(store, "MED")).toEqual({ ok: false, message: "No Renpho login is saved." });
  });
});

describe("uploading to Garmin", () => {
  beforeEach(() => store.renpho.saveSettings("MED", { pushEnabled: true }));

  it("sends the weigh-ins that are not on Garmin as one FIT file, once", async () => {
    const pushed: number[] = [];
    const push = async (fit: Uint8Array, n: number) => { pushed.push(fitCount(fit)); return n === 3 ? "taken in" : ""; };
    const first = await run(renphoWith(rows(3)).fetchFn, { push });
    expect(first).toEqual(expect.objectContaining({ added: 3, uploaded: 3, error: null }));
    expect(pushed).toEqual([3]);
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pushed: 3, pending: 0 }));
    expect(store.renpho.logLines("MED")[0].message).toBe("Uploaded 3 weigh-ins to Garmin: taken in.");
    await run(renphoWith(rows(3)).fetchFn, { push, now: T0 + 3 * HOUR });
    expect(pushed).toEqual([3]); // never again
    await run(renphoWith(rows(4)).fetchFn, { push, now: T0 + 6 * HOUR });
    expect(pushed).toEqual([3, 1]); // only the new one
  });

  it("holds back what is older than the start day", async () => {
    const day = (id: number) => new Date(renphoRow(id).timeStamp * 1000).toISOString().slice(0, 10);
    store.renpho.saveSettings("MED", { pushSince: day(3) });
    const pushed: number[] = [];
    await run(renphoWith(rows(5)).fetchFn, { push: async (fit) => { pushed.push(fitCount(fit)); return ""; } });
    expect(pushed).toEqual([3]);
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pushed: 3, pending: 2 }));
  });

  it("keeps the weigh-ins and the reason when the upload fails, and tries them again on the next run", async () => {
    let fails = true;
    const push = async () => { if (fails) throw new Error("Garmin refused the file: bad file"); return "taken in"; };
    const failed = await run(renphoWith(rows(2)).fetchFn, { push });
    expect(failed.error).toBe("Upload to Garmin failed: Garmin refused the file: bad file");
    expect(failed.uploaded).toBe(0);
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pending: 2, failed: 2 }));
    expect(store.renpho.measurements("MED")[0].pushError).toMatch(/bad file/);
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ error: failed.error, errorKind: "other" }));
    fails = false;
    const again = await run(renphoWith(rows(2)).fetchFn, { push, now: T0 + 3 * HOUR });
    expect(again).toEqual(expect.objectContaining({ uploaded: 2, error: null }));
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pushed: 2, pending: 0, failed: 0 }));
    expect(store.renpho.state("MED").error).toBeNull();
  });

  it("splits a long backlog into files of a hundred, and stops at the first that fails", async () => {
    const sizes: number[] = [];
    let calls = 0;
    const push = async (fit: Uint8Array) => { sizes.push(fitCount(fit)); if (++calls === 2) throw new Error("no"); return ""; };
    const result = await run(renphoWith(rows(250)).fetchFn, { push });
    expect(sizes).toEqual([100, 100]);
    expect(result.uploaded).toBe(100);
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pushed: 100, pending: 150 }));
  });

  it("does not upload a weigh-in Renpho gave no weight for, and says why it stays", async () => {
    const pushed: number[] = [];
    await run(renphoWith([renphoRow(1), renphoRow(2, { weight: null })]).fetchFn, { push: async (fit) => { pushed.push(fitCount(fit)); return ""; } });
    expect(pushed).toEqual([1]);
    expect(store.renpho.measurements("MED").find((m) => m.id === "2")!.pushError).toBe("Renpho gave no weight for this weigh-in.");
  });

  it("only fetches when the run cannot reach Garmin, and says so", async () => {
    const result = await run(renphoWith(rows(1)).fetchFn);
    expect(result).toEqual(expect.objectContaining({ added: 1, uploaded: 0 }));
    expect(store.renpho.logLines("MED")[0]).toEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/cannot reach Garmin/) }));
  });

  it("forgets Garmin's stored answer for the days uploaded earlier once Garmin has had time, so the Weight view reads them again", async () => {
    const day = new Date(renphoRow(1).timeStamp * 1000).toISOString().slice(0, 10);
    store.wellness.put("MED", day, "weight", { dateWeightList: [], totalAverage: null });
    const push = async () => "taken in";
    await run(renphoWith(rows(1)).fetchFn, { push });
    expect(store.wellness.get("MED", day, "weight")).not.toBeNull(); // too soon: Garmin may not have it yet
    await run(renphoWith(rows(1)).fetchFn, { push, now: T0 + SETTLE_MS + 1 });
    expect(store.wellness.get("MED", day, "weight")).toBeNull();
    store.wellness.put("MED", day, "weight", { dateWeightList: [{ weight: 81_700 }] });
    await run(renphoWith(rows(1)).fetchFn, { push, now: T0 + 2 * SETTLE_MS });
    expect(store.wellness.get("MED", day, "weight")).not.toBeNull(); // once only
  });
});

describe("a FIT file by hand", () => {
  it("holds the newest weigh-ins, and nothing when none is kept", async () => {
    expect(recentFit(store, "MED", 3)).toBeNull();
    await run(renphoWith(rows(5)).fetchFn);
    const fit = recentFit(store, "MED", 3)!;
    expect(fit.weighIns).toBe(3);
    expect(fitCount(fit.bytes)).toBe(3);
    expect(recentFit(store, "MED", 50)!.weighIns).toBe(5);
  });
});

describe("the runs that are due", () => {
  it("are the profiles that are switched on, past their next run and not running now", () => {
    store.renpho.saveSettings("SAM", { fetchEnabled: true });
    store.renpho.saveSettings("OFF", { fetchEnabled: false });
    expect(dueProfiles(store, T0)).toEqual(["MED", "SAM"]); // never run: due now
    store.renpho.saveState("MED", { nextRunAt: T0 + HOUR });
    store.renpho.claim("SAM", "x", 60_000, T0);
    expect(dueProfiles(store, T0)).toEqual([]);
    expect(dueProfiles(store, T0 + HOUR)).toEqual(["MED", "SAM"]); // SAM's lease has run out by then
  });
});
