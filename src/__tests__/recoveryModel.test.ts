import { metricsFor } from "./fixtures/wellness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RM = require("../web/public/recoveryModel.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WM = require("../web/public/weightModel.js");

describe("days and numbers", () => {
  it("says a day without putting it through Date's parser", () => {
    expect(RM.dayLabel("2026-10-18")).toBe("Sun 18 Oct");
    expect(RM.dayLabel("2026-01-01")).toBe("Thu 1 Jan");
    expect(RM.shortDay("2026-03-05")).toBe("5 Mar");
    expect(RM.addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(RM.addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formats numbers, hours and sizes, with an en dash for a day without a value", () => {
    expect(RM.num(57, 0, " ms")).toBe("57 ms");
    expect(RM.num(null)).toBe("–");
    expect(RM.num(undefined)).toBe("–");
    expect(RM.num(14.26, 1, " /min")).toBe("14.3 /min");
    expect(RM.hm(27_000)).toBe("7 h 30");
    expect(RM.hm(3_660)).toBe("1 h 01");
    expect(RM.hm(0)).toBe("–");
    expect(RM.hm(null)).toBe("–");
    expect(RM.hours(27_000)).toBe("7.5 h");
    expect(RM.size(900)).toBe("900 B");
    expect(RM.size(2_048)).toBe("2.0 KB");
    expect(RM.size(131_072)).toBe("128 KB");
    expect(RM.size(3 * 1_048_576)).toBe("3.0 MB");
  });

  it("names the bands and colours the dots of the scores", () => {
    expect(RM.bandInfo("go-harder")).toEqual({ label: "Go harder", cls: "go" });
    expect(RM.bandInfo("back-off").cls).toBe("back");
    expect(RM.bandInfo("whatever").cls).toBe("unknown");
    expect([-2, -1, 0, 1, 2].map(RM.pip)).toEqual(["m2", "m1", "z", "p1", "p2"]);
  });
});

describe("the daily table", () => {
  const all = RM.GROUPS.flatMap((g: any) => g.fields);

  it("lists only fields the server sends, and every one of them once", () => {
    const sent = Object.keys(metricsFor("2026-01-01"));
    expect(all.map((f: any) => f.key).filter((k: string) => !sent.includes(k))).toEqual([]);
    expect(new Set(all.map((f: any) => f.key)).size).toBe(all.length);
    // and the two tables show everything the server sends but the day itself, none of it twice
    const weightView = WM.GROUPS.flatMap((g: any) => g.fields.map((f: any) => f.key));
    expect(sent.filter((k) => k !== "day" && !all.some((f: any) => f.key === k) && !weightView.includes(k))).toEqual([]);
    expect(weightView.filter((k: string) => all.some((f: any) => f.key === k))).toEqual([]);
  });

  it("reads each field the way its kind says", () => {
    const day = metricsFor("2026-01-01", { sleepSeconds: 25_200, sleepNeedMinutes: 480, hrvLastNight: 52, hrvStatus: "UNBALANCED", avgSleepRespiration: 14.25, steps: 12_345 });
    const by = (key: string) => all.find((f: any) => f.key === key);
    expect(RM.cell(by("sleepSeconds"), day)).toBe("7 h 00");
    expect(RM.cell(by("sleepNeedMinutes"), day)).toBe("8 h 00");
    expect(RM.cell(by("hrvLastNight"), day)).toBe("52 ms");
    expect(RM.cell(by("hrvStatus"), day)).toBe("unbalanced");
    expect(RM.cell(by("avgSleepRespiration"), day)).toBe("14.3 /min");
    expect(RM.cell(by("steps"), day)).toBe((12_345).toLocaleString());
    expect(RM.cell(by("restingHr"), day)).toBe("–");
    expect(RM.cell(by("hrvLowUpper"), day)).toBe("–");
  });
});

describe("scales", () => {
  it("rounds to a step, leaves room, and holds a given minimum or maximum", () => {
    const s = RM.scale([52, 57, 61, 49]);
    expect(s.min).toBeLessThanOrEqual(49);
    expect(s.max).toBeGreaterThanOrEqual(61);
    expect(s.ticks.length).toBeGreaterThanOrEqual(2);
    expect(s.ticks.every((t: number) => t >= s.min && t <= s.max)).toBe(true);
    expect(RM.scale([10, 80], { min: 0, max: 100 })).toEqual(expect.objectContaining({ min: 0, max: 100 }));
  });

  it("takes the band and the reference line into account, and skips what is missing", () => {
    const s = RM.scale([55, null, 57], { include: [40, 70, null] });
    expect(s.min).toBeLessThanOrEqual(40);
    expect(s.max).toBeGreaterThanOrEqual(70);
  });

  it("copes with a single value and with none", () => {
    const one = RM.scale([50]);
    expect(one.min).toBeLessThan(50);
    expect(one.max).toBeGreaterThan(50);
    expect(RM.scale([])).toBeNull();
    expect(RM.scale([null, undefined])).toBeNull();
  });

  it("picks round steps", () => {
    expect(RM.niceStep(100, 4)).toBe(20);
    expect(RM.niceStep(7, 3)).toBe(2);
    expect(RM.niceStep(0.9, 3)).toBeCloseTo(0.2);
  });
});

describe("the charts", () => {
  const day = metricsFor("2026-01-01", { hrvLastNight: 57, hrvBalancedLow: 50, hrvBalancedHigh: 65, restingHr: 50, restingHr7d: 51, sleepSeconds: 27_000, sleepScore: 82, bodyBatteryWake: 75, bodyBatteryLow: 20, bodyBatteryHigh: 90, avgStress: 28, maxStress: 80, steps: 8000, avgSleepRespiration: 14.44, avgWakingRespiration: 15.2 });
  const by = (id: string) => RM.CHARTS.find((c: any) => c.id === id);

  it("says what is under the cursor for each chart", () => {
    expect(by("hrv").read(day)).toBe("57 ms · balanced 50–65");
    expect(by("rhr").read(day)).toBe("50 bpm · 7-day 51");
    expect(by("resp").read(day)).toBe("14.4 /min asleep · 15.2 awake");
    expect(by("sleep").read(day)).toBe("7 h 30 · score 82");
    expect(by("bb").read(day)).toBe("75 on waking · 20–90 over the day");
    expect(by("stress").read(day)).toBe("average 28 · max 80");
    expect(by("steps").read(day)).toBe(`${(8000).toLocaleString()} steps`);
    for (const c of RM.CHARTS) expect(c.read(metricsFor("2026-01-02"))).toBe("–");
  });

  it("reads only fields the server sends", () => {
    const empty = metricsFor("2026-01-01");
    for (const c of RM.CHARTS) {
      expect(() => c.read(empty)).not.toThrow();
      for (const p of c.parts || []) expect(Object.keys(empty)).toContain(p.key);
    }
  });

  it("names the stress levels as Garmin does", () => {
    expect([10, 25, 26, 50, 51, 75, 76, 100].map(RM.stressClass)).toEqual(["s0", "s0", "s1", "s1", "s2", "s2", "s3", "s3"]);
    expect(RM.stressClass(null)).toBe("");
  });
});

describe("Garmin's responses", () => {
  it("lists the kinds the server keeps, in the order it fetches them", () => {
    expect(RM.KINDS.map((k: any) => k.kind)).toEqual(["summary", "sleep", "hrv", "heart_rate", "stress", "body_battery", "respiration", "spo2"]);
  });

  it("prints lists of numbers on one line and leaves the structure indented", () => {
    const text = RM.compactJson({ a: [1, 2, 3], b: [[1, 2], [3, 4]], c: { d: "x", e: [] }, f: null, g: ["a", "b"] });
    expect(text).toContain('"a": [1, 2, 3]');
    expect(text).toContain("[1, 2],");
    expect(text).toContain('"e": []');
    expect(text).toContain('"g": ["a", "b"]');
    expect(JSON.parse(text)).toEqual({ a: [1, 2, 3], b: [[1, 2], [3, 4]], c: { d: "x", e: [] }, f: null, g: ["a", "b"] });
  });
});
