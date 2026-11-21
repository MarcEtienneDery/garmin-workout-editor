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
    expect(by("intensity").read({ ...day, moderateMinutes: 30, vigorousMinutes: 14 })).toBe("58 min · 30 moderate, 14 vigorous");
    expect(by("intensity").read({ ...day, moderateMinutes: null, vigorousMinutes: 5 })).toBe("10 min · 0 moderate, 5 vigorous");
    expect(by("intensity").read({ ...day, moderateMinutes: 0, vigorousMinutes: 0 })).toBe("0 min · 0 moderate, 0 vigorous");
    for (const c of RM.CHARTS) expect(c.read(metricsFor("2026-01-02"))).toBe("–");
  });

  describe("the 3-day average of the intensity minutes", () => {
    const days = (minutes: ([number, number] | null)[]) => minutes.map((m, i) => metricsFor(`2026-01-${String(i + 1).padStart(2, "0")}`, m ? { moderateMinutes: m[0], vigorousMinutes: m[1] } : {}));
    const ref = (ds: any[], i: number) => by("intensity").ref.value(ds[i], i, ds);

    it("counts the moderate minutes and twice the vigorous ones", () => {
      expect([[30, 14], [0, 5], [10, 0]].map(([m, v]) => RM.intensityMinutes({ moderateMinutes: m, vigorousMinutes: v }))).toEqual([58, 10, 10]);
      expect(RM.intensityMinutes({ moderateMinutes: null, vigorousMinutes: null })).toBeNull();
    });

    it("is the mean of the day and the two before it, and of fewer at the start of the range", () => {
      const ds = days([[30, 0], [60, 0], [0, 45], [0, 0]]);
      expect([0, 1, 2, 3].map((i) => ref(ds, i))).toEqual([30, 45, 60, 50]);
    });

    it("leaves out a day with nothing stored instead of counting it as zero, and has no value on such a day", () => {
      const ds = days([[30, 0], null, [60, 0], [0, 0]]);
      expect(ref(ds, 1)).toBeNull();
      expect(ref(ds, 2)).toBe(45);
      expect(ref(ds, 3)).toBe(30);
    });

    it("is said with the day under the cursor, when the days are known", () => {
      const ds = days([[30, 0], [60, 0], [0, 45]]);
      expect(by("intensity").read(ds[2], 2, ds)).toBe("90 min · 3-day average 60 · 0 moderate, 45 vigorous");
      expect(by("intensity").read(ds[2])).toBe("90 min · 0 moderate, 45 vigorous");
    });
  });

  it("piles the vigorous minutes at twice their weight on the moderate ones, so a bar is the day's total", () => {
    const [moderate, vigorous] = by("intensity").parts;
    expect([moderate.weight ?? 1, vigorous.weight]).toEqual([1, 2]);
    expect(by("intensity").scaleBy).toBe(1);
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


import { BACK_OFF_AT, GO_HARDER_AT } from "../shared/readiness";

const signal = (name: string, score: number, extra: Record<string, unknown> = {}) => ({ name, value: "1", baseline: null, score, weight: name === "hrv" ? 2 : 1, reason: "r", ...extra });
const readiness = (over: Record<string, unknown> = {}) => ({
  date: "2026-10-18", band: "as-planned", score: 52, confidence: "high", missing: [], load: null, suggestion: "A normal day: train as planned.",
  signals: [signal("hrv", 0), signal("restingHr", 1), signal("sleep", 1), signal("bodyBattery", 1), signal("stress", 0), signal("load", -1)], ...over,
});
const words = (line: { text: string }[]) => line.map((s) => s.text).join("");

describe("the zones of the score", () => {
  it("start where the server's thresholds put them (the score is 50 + 50 × the weighted mean)", () => {
    expect(RM.BACK_OFF_SCORE).toBe(50 + 50 * BACK_OFF_AT);
    expect(RM.GO_HARDER_SCORE).toBe(50 + 50 * GO_HARDER_AT);
  });

  it("names the zone of a score, and none for a day without one", () => {
    expect([0, 31, 37, 37.4, 38, 52, 69, 70, 100].map(RM.zoneOf)).toEqual(["back", "back", "back", "back", "plan", "plan", "plan", "go", "go"]);
    expect(RM.zoneOf(null)).toBe("");
    expect(RM.zoneOf(undefined)).toBe("");
  });

  it("draws the gauge: the place of the score on the half circle, the three zones and the one it is in", () => {
    const g = RM.gauge(readiness());
    expect(g).toMatchObject({ score: 52, at: 0.52, zone: "plan" });
    expect(g.zones).toEqual([{ cls: "back", from: 0, to: 37.5 }, { cls: "plan", from: 37.5, to: 70 }, { cls: "go", from: 70, to: 100 }]);
    expect(g.label).toBe("Score 52 of 100, in the As planned zone");
    expect(RM.gauge(readiness({ band: "unknown", score: null }))).toBeNull();
    expect(RM.gauge(null)).toBeNull();
  });
});

describe("the week strip", () => {
  const week = [["12", "as-planned", 61], ["13", "go-harder", 74], ["14", "as-planned", 58], ["15", "back-off", 33], ["16", "unknown", null], ["17", "unknown", null], ["18", "unknown", null]].map(([d, band, score]) => ({ day: `2026-10-${d}`, band, score }));
  const data = { week, date: "2026-10-15", today: "2026-10-16" };

  it("is empty without a week", () => {
    expect(RM.weekStrip({})).toEqual([]);
    expect(RM.weekStrip(null)).toEqual([]);
  });

  it("has the seven days, Monday first, with their weekday, number and score", () => {
    const strip = RM.weekStrip(data);
    expect(strip.map((d: any) => `${d.weekday} ${d.number}`)).toEqual(["Mon 12", "Tue 13", "Wed 14", "Thu 15", "Fri 16", "Sat 17", "Sun 18"]);
    expect(strip.map((d: any) => d.text)).toEqual(["61", "74", "58", "33", "–", "–", "–"]);
  });

  it("gives each day its zone (the band's class), and says no verdict for a day that cannot be judged and not yet for a day to come", () => {
    const strip = RM.weekStrip(data);
    expect(strip.map((d: any) => d.zone)).toEqual(["plan", "go", "plan", "back", "none", "future", "future"]);
    expect(strip[0].name).toBe("as planned");
    expect(strip[1].name).toBe("go harder");
    expect(strip[4].name).toBe("");
    expect(strip[4].label).toBe("Fri 16 Oct, no verdict");
    expect(strip[5].label).toBe("Sat 17 Oct, not yet");
  });

  it("says each day in words for a screen reader, with its band and score", () => {
    expect(RM.weekStrip(data)[3].label).toBe("Thu 15 Oct, back off, 33 of 100");
    expect(RM.weekStrip(data)[1].label).toBe("Tue 13 Oct, go harder, 74 of 100");
  });

  it("marks today and the day shown", () => {
    const strip = RM.weekStrip(data);
    expect(strip.filter((d: any) => d.today).map((d: any) => d.day)).toEqual(["2026-10-16"]);
    expect(strip.filter((d: any) => d.selected).map((d: any) => d.day)).toEqual(["2026-10-15"]);
  });
});

describe("what would change the verdict", () => {
  it("says for As planned how far Go harder is, what it needs besides the score, and where Back off starts", () => {
    const line = RM.changeLine(readiness());
    expect(words(line)).toBe("Go harder needs a score of 70 (18 more) with HRV, resting heart rate and sleep at normal or better. Back off starts under 38 (15 less), or if HRV falls well below your range.");
    expect(line.filter((s: any) => s.strong).map((s: any) => s.text)).toEqual(["Go harder", "Back off"]);
  });

  it("names the core signals under normal, which Go harder waits for", () => {
    const r = readiness({ signals: [signal("hrv", 0), signal("restingHr", -1), signal("sleep", -1), signal("load", 1)] });
    expect(words(RM.changeLine(r))).toContain("needs a score of 70 (18 more), and resting heart rate and sleep have to reach normal.");
    const one = readiness({ signals: [signal("hrv", 0), signal("restingHr", 0), signal("sleep", -1)] });
    expect(words(RM.changeLine(one))).toContain("and sleep has to reach normal.");
  });

  it("says when the score is enough and something else is not, and when the confidence is low", () => {
    const enough = readiness({ score: 72, signals: [signal("hrv", 1), signal("restingHr", 1), signal("sleep", -1)] });
    expect(words(RM.changeLine(enough))).toContain("needs more than the score (it is enough at 72): sleep has to reach normal.");
    const low = readiness({ score: 60, confidence: "low", signals: [signal("hrv", 1), signal("restingHr", 1)] });
    expect(words(RM.changeLine(low))).toContain("needs a score of 70 (10 more), and more signals are needed to be sure.");
  });

  it("says for Go harder what holds it", () => {
    const line = RM.changeLine(readiness({ band: "go-harder", score: 76 }));
    expect(words(line)).toBe("Holding Go harder takes a score of 70 or more and HRV, resting heart rate and sleep all at normal or better. One hard session, then it reads the load again.");
  });

  it("says for Back off by a low score how far As planned is", () => {
    const line = RM.changeLine(readiness({ band: "back-off", score: 31, signals: [signal("hrv", -1), signal("sleep", -2)] }));
    expect(words(line)).toBe("As planned comes back at a score of 38 (7 more).");
  });

  it("says that an HRV well below its range sets Back off by itself, and when As planned comes back", () => {
    const forced = RM.changeLine(readiness({ band: "back-off", score: 52, signals: [signal("hrv", -2), signal("restingHr", 1), signal("sleep", 1)] }));
    expect(words(forced)).toBe("HRV well below your range sets Back off whatever the rest says. As planned comes back when HRV is back in your range.");
    const both = RM.changeLine(readiness({ band: "back-off", score: 31, signals: [signal("hrv", -2), signal("sleep", -2)] }));
    expect(words(both)).toBe("HRV well below your range sets Back off whatever the rest says. As planned comes back at a score of 38 (7 more) once HRV is back in your range.");
  });

  it("says nothing for a day that cannot be judged", () => {
    expect(RM.changeLine(readiness({ band: "unknown", score: null, signals: [] }))).toEqual([]);
    expect(RM.changeLine(null)).toEqual([]);
  });
});

describe("the signals of the day", () => {
  it("lists them with their name, value, reason and baseline, HRV as the one that counts most", () => {
    const rows = RM.signalRows(readiness());
    expect(rows.map((r: any) => r.name)).toEqual(["HRV", "Resting heart rate", "Sleep", "Body Battery", "Stress yesterday", "Training load"]);
    expect(rows.map((r: any) => r.most)).toEqual([true, false, false, false, false, false]);
    expect(rows[0]).toMatchObject({ key: "hrv", value: "1", reason: "r", baseline: null, score: 0 });
  });

  it("marks none as counting most when they all count the same", () => {
    expect(RM.signalRows(readiness({ signals: [signal("sleep", 1), signal("stress", 0)] })).map((r: any) => r.most)).toEqual([false, false]);
  });

  it("puts the meter on the step of the score: five steps from well below normal to well above", () => {
    const steps = (score: number) => RM.signalMeter(signal("sleep", score)).steps.indexOf(true);
    expect([-2, -1, 0, 1, 2].map(steps)).toEqual([0, 1, 2, 3, 4]);
    expect(RM.signalMeter(signal("sleep", 1)).pip).toBe("p1");
    expect(RM.signalMeter(signal("hrv", -2)).label).toBe("HRV: well below your normal");
    expect(RM.signalMeter(signal("sleep", 0)).label).toBe("Sleep: at your normal");
    expect(steps(5)).toBe(4);
  });

  it("says what was not counted, with the signals' names", () => {
    const r = readiness({ missing: ["stress: no stress figure for yesterday", "load: no sessions in the last 31 days and no intensity minutes stored"] });
    expect(RM.notCounted(r)).toBe("Not counted: Stress yesterday: no stress figure for yesterday; Training load: no sessions in the last 31 days and no intensity minutes stored.");
    expect(RM.notCounted(readiness())).toBe("");
  });
});

describe("the load of the days before", () => {
  const load = (over: Record<string, unknown> = {}) => ({ sessions: 4, acute: 1085, usual: 651, ratio: 1.67, hoursSinceHard: 31.4, intensity: { acute: 120, usual: 120, ratio: 1 }, ...over });

  it("is null without a load", () => {
    expect(RM.loadBars(readiness())).toBeNull();
  });

  it("draws the sessions and the intensity minutes each against its usual, on a track of twice the usual", () => {
    const l = RM.loadBars(readiness({ load: load() }));
    expect(l.bars).toHaveLength(2);
    expect(l.bars[0]).toMatchObject({ label: "Last 3 days · 4 sessions", value: `${(1085).toLocaleString()} units`, pct: 167, usual: "usual 651", cls: "veryheavy" });
    expect(l.bars[0].fill).toBeCloseTo(83.5);
    expect(l.bars[1]).toMatchObject({ label: "Intensity minutes, last 3 days", value: "120 min", pct: 100, fill: 50, cls: "usual", usual: "usual 120" });
    expect(l.sessions).toBe(4);
    expect(l.hard).toBe("31 h ago");
  });

  it("classes the load as the server scores it: light to 70 %, usual under 130 %, heavy from 130 %, very heavy from 160 %", () => {
    const cls = (ratio: number) => RM.loadBars(readiness({ load: load({ ratio, intensity: null }) })).bars[0].cls;
    expect([0.5, 0.7, 0.71, 1.29, 1.3, 1.59, 1.6, 2.4].map(cls)).toEqual(["light", "light", "usual", "usual", "heavy", "heavy", "veryheavy", "veryheavy"]);
  });

  it("caps the fill at the track, and has no fill without a usual to compare with", () => {
    expect(RM.loadBars(readiness({ load: load({ ratio: 3, intensity: null }) })).bars[0].fill).toBe(100);
    const none = RM.loadBars(readiness({ load: load({ ratio: null, usual: null, intensity: null }) })).bars[0];
    expect(none).toMatchObject({ fill: null, pct: null, usual: "no usual to compare with yet", cls: "usual" });
  });

  it("has no intensity bar without intensity minutes, and says no hard session when there was none", () => {
    const l = RM.loadBars(readiness({ load: load({ intensity: null, hoursSinceHard: null }) }));
    expect(l.bars).toHaveLength(1);
    expect(l.hard).toBe("none in 3 days");
    expect(RM.loadBars(readiness({ load: load({ sessions: 1 }) })).bars[0].label).toBe("Last 3 days · 1 session");
  });
});

describe("last night", () => {
  const night = (over: Record<string, unknown> = {}) => ({ sleepSeconds: 25_020, sleepScore: 82, sleepNeedMinutes: 480, deepSeconds: 4_500, remSeconds: 6_480, lightSeconds: 16_020, awakeSeconds: 900, awakeCount: 2, sleepStress: 18, ...over });

  it("is null without sleep stored", () => {
    expect(RM.sleepCard(null)).toBeNull();
    expect(RM.sleepCard(night({ sleepSeconds: null }))).toBeNull();
    expect(RM.sleepCard(night({ sleepSeconds: 0 }))).toBeNull();
  });

  it("gives the time, the score, the stages as shares of the stages and what was slept against the need", () => {
    const s = RM.sleepCard(night());
    expect(s).toMatchObject({ time: "6 h 57", score: 82, pct: 87, fill: 87, cls: "warn", need: "8 h", wakings: 2, stress: 18 });
    expect(s.stages.map((x: any) => [x.cls, x.label, x.text])).toEqual([["deep", "Deep", "1 h 15"], ["rem", "REM", "1 h 48"], ["light", "Light", "4 h 27"], ["awake", "Awake", "0 h 15"]]);
    expect(s.stages.reduce((a: number, x: any) => a + x.width, 0)).toBeCloseTo(100);
  });

  it("colours the need as ok from 95 %, warn from 80 % and short under", () => {
    const cls = (seconds: number) => RM.sleepCard(night({ sleepSeconds: seconds })).cls;
    expect([29_000, 28_800, 23_000, 22_000, 14_000].map(cls)).toEqual(["ok", "ok", "warn", "short", "short"]);
    expect(RM.sleepCard(night({ sleepSeconds: 40_000 })).fill).toBe(100);
  });

  it("leaves out what is not stored, rather than a zero", () => {
    const s = RM.sleepCard(night({ sleepNeedMinutes: null, sleepScore: null, awakeCount: null, sleepStress: null, awakeSeconds: null, deepSeconds: null }));
    expect(s).toMatchObject({ score: null, pct: null, fill: null, cls: "", need: null, wakings: null, stress: null });
    expect(s.stages.map((x: any) => x.cls)).toEqual(["rem", "light"]);
  });

  it("says a need that is not whole hours with its minutes", () => {
    expect(RM.sleepCard(night({ sleepNeedMinutes: 450 })).need).toBe("7 h 30");
  });
});

describe("the readiness chart", () => {
  const data = {
    days: [{ day: "2026-10-16", hrvLastNight: 50 }, { day: "2026-10-17", hrvLastNight: 52 }, { day: "2026-10-18", hrvLastNight: 40 }],
    readinessDays: [{ day: "2026-10-16", band: "as-planned", score: 52 }, { day: "2026-10-17", band: "go-harder", score: 74 }, { day: "2026-10-18", band: "unknown", score: null }],
  };

  it("merges each day's readiness into the days of the range, a day without one unknown", () => {
    const days = RM.chartDays(data);
    expect(days.map((d: any) => [d.readinessScore, d.readinessBand])).toEqual([[52, "as-planned"], [74, "go-harder"], [null, "unknown"]]);
    expect(days[0].hrvLastNight).toBe(50);
    expect(RM.chartDays({ days: data.days })[0]).toMatchObject({ readinessScore: null, readinessBand: "unknown" });
    expect(RM.chartDays(null)).toEqual([]);
  });

  it("is the first of the trends, a bar for a day's score in the colour of its zone, and the normal day as the reference", () => {
    expect(RM.TRENDS[0]).toBe(RM.READINESS_CHART);
    expect(RM.TRENDS.slice(1)).toEqual(RM.CHARTS);
    const c = RM.READINESS_CHART, days = RM.chartDays(data);
    expect(c).toMatchObject({ kind: "bars", min: 0, max: 100, goal: { value: 50, label: "A normal day, 50" } });
    expect(days.map(c.color)).toEqual(["plan", "go", ""]);
    expect(days.map(c.value)).toEqual([52, 74, null]);
    expect(days.map((d: any) => c.read(d))).toEqual(["52 · as planned", "74 · go harder", "no verdict"]);
    expect(c.colorKeys).toEqual({ back: "Back off", plan: "As planned", go: "Go harder" });
  });
});
