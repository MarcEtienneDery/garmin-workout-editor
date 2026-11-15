import { MIN_SPAN_DAYS, MIN_WEIGH_INS, STEADY_PER_WEEK_KG, bodyTrend } from "../shared/bodyTrend";
import { metricsFor } from "./fixtures/wellness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WM = require("../web/public/weightModel.js");

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const TODAY = day(20);

describe("weights", () => {
  it("says a weight in the unit picked, and a change with its sign", () => {
    expect(WM.weight(80, "kg")).toBe("80.0 kg");
    expect(WM.weight(80, "lb")).toBe("176.4 lb");
    expect(WM.weight(80, "nonsense")).toBe("176.4 lb");
    expect(WM.weight(null, "kg")).toBe("–");
    expect(WM.change(0.5, "kg")).toBe("+0.5 kg");
    expect(WM.change(-0.5, "kg")).toBe("−0.5 kg");
    expect(WM.change(-0.5, "lb")).toBe("−1.1 lb");
    expect(WM.change(0.01, "kg")).toBe("0.0 kg");
    expect(WM.change(undefined, "kg")).toBe("–");
  });

  it("says a change as a signed number without its unit, and a weight typed or shown in a box", () => {
    expect(WM.signed(0.5, "kg")).toBe("+0.5");
    expect(WM.signed(-0.5, "lb")).toBe("−1.1");
    expect(WM.signed(0.001, "kg")).toBe("0.0");
    expect(WM.signed(null, "kg")).toBe("–");
    expect(WM.parseWeight("176,4", "lb")).toBeCloseTo(80, 1);
    expect(WM.parseWeight(" 79.5 ", "kg")).toBe(79.5);
    for (const bad of ["", "  ", "abc", "-3", "0", null, undefined]) expect(WM.parseWeight(bad, "kg")).toBeNaN();
    expect(WM.weightInput(80, "lb")).toBe("176.4");
    expect(WM.weightInput(79.5, "kg")).toBe("79.5");
    expect(WM.weightInput(null, "kg")).toBe("");
  });
});

describe("the table", () => {
  const all = WM.GROUPS.flatMap((g: any) => g.fields);
  const sample = metricsFor("2026-01-01", { weightKg: 80, bodyFatPercent: 18.46, muscleKg: 36, bmi: 24.51, totalKcal: 2600, activeKcal: 650, bmrKcal: 1950 });
  const by = (key: string) => all.find((f: any) => f.key === key);

  it("reads each field in the unit", () => {
    expect(WM.cell(by("weightKg"), sample, "kg")).toBe("80.0 kg");
    expect(WM.cell(by("muscleKg"), sample, "lb")).toBe("79.4 lb");
    expect(WM.cell(by("bodyFatPercent"), sample, "kg")).toBe("18.5 %");
    expect(WM.cell(by("bmi"), sample, "kg")).toBe("24.5");
    expect(WM.cell(by("totalKcal"), sample, "kg")).toBe(`${(2600).toLocaleString()} kcal`);
    expect(WM.cell(by("weightKg"), metricsFor("2026-01-02"), "kg")).toBe("–");
  });

  it("lists only fields the server sends", () => {
    expect(all.map((f: any) => f.key).filter((k: string) => !Object.keys(sample).includes(k))).toEqual([]);
  });

  it("offers the weigh-in and the daily summary as the raw responses", () => {
    expect(WM.KINDS.map((k: any) => k.kind)).toEqual(["weight", "summary"]);
  });
});


// ── The line ────────────────────────────────────────────────────────────

/** Weigh-ins on every second day from the 1st, falling a tenth of a kilogram a day exactly (so −0.7 kg a week and no noise), and what the page gets of them. */
const falling = (extra: Record<string, unknown> = {}) => Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 2 === 0 && i <= 18 ? Math.round((82 - 0.1 * i) * 100) / 100 : null, totalKcal: 2500 + i, activeKcal: 500, bmrKcal: 2000, ...extra }));
const view = (days: any[], over: Record<string, unknown> = {}) => ({ today: TODAY, date: day(18), days, body: bodyTrend(days), goalKg: null, intake: null, ...over });

describe("the line through the weigh-ins", () => {
  it("is the one bodyTrend fits: the same rate, change and direction, over many kinds of weigh-ins", () => {
    const seed = (n: number) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const sets: [number, number][] = [[-0.06, 1.1], [0.0003, 0.4], [0.04, 0.9], [-0.3, 0.1], [0, 0], [0.02, 2]];
    for (const [slope, noise] of sets) {
      for (const every of [1, 2, 3, 5]) {
        const days = Array.from({ length: 60 }, (_, i) => metricsFor(day(i), { weightKg: i % every === 0 ? Math.round((83 + slope * i + (seed(i + every) - 0.5) * noise) * 100) / 100 : null }));
        const server = bodyTrend(days), mine = WM.trendOf(days);
        expect({ weighIns: mine.weighIns, perWeekKg: mine.perWeekKg, changeKg: mine.changeKg, direction: mine.direction }).toEqual({ weighIns: server.weighIns, perWeekKg: server.perWeekKg, changeKg: server.changeKg, direction: server.direction });
      }
    }
  });

  it("asks for what bodyTrend asks: three weigh-ins over at least a week, and calls under a tenth of a kilo a week steady", () => {
    expect(WM.LIMITS).toEqual({ STEADY_PER_WEEK_KG, MIN_WEIGH_INS, MIN_SPAN_DAYS });
    const three = (gap: number) => [0, gap, gap * 2].map((n) => ({ day: day(n), v: 80 + n * 0.01 }));
    expect(WM.fitLine(three(4))).not.toBeNull(); // 8 days
    expect(WM.fitLine(three(3))).toBeNull(); // 6 days: too short
    expect(WM.fitLine(three(4).slice(0, 2))).toBeNull(); // two weigh-ins
    expect(WM.fitLine([])).toBeNull();
  });

  it("gives the value of the line on any day, the rate a week, and how far the weigh-ins are from it", () => {
    const fit = WM.fitLine(WM.weightPoints(falling()));
    expect(fit.perWeek).toBeCloseTo(-0.7, 6);
    expect(fit.at(day(0))).toBeCloseTo(82, 6);
    expect(fit.at(day(30))).toBeCloseTo(79, 6); // past the last weigh-in too
    expect(fit.sigma).toBeCloseTo(0, 6);
    const noisy = WM.fitLine([[0, 80], [4, 81], [8, 79.4], [12, 80.6], [16, 79.2]].map(([n, v]) => ({ day: day(n), v })));
    expect(noisy.sigma).toBeGreaterThan(0.3);
    expect(noisy.swing).toBeCloseTo(noisy.sigma * 1.5, 9);
  });

  it("has a day for every day of the range, the ones nothing is stored for empty", () => {
    const sparse = falling().filter((d: any) => d.day !== day(5) && d.day !== day(6));
    const full = WM.fullDays(view(sparse), 21);
    expect(full.map((d: any) => d.day)).toEqual(Array.from({ length: 21 }, (_, i) => day(i)));
    expect(full[5]).toEqual(expect.objectContaining({ day: day(5), weightKg: null, totalKcal: null }));
    expect(full[4].weightKg).toBe(81.6);
    expect(WM.fullDays(view(sparse), 7).map((d: any) => d.day)).toEqual(Array.from({ length: 7 }, (_, i) => day(14 + i)));
  });
});

describe("where the weight is going", () => {
  it("says losing, the rate a week, what the line says and three figures", () => {
    const h = WM.hero(view(falling()), "kg", 21);
    expect(h).toMatchObject({ n: 10, dir: "losing", title: "Losing", rate: { kind: "rate", text: "−0.7 kg", per: "/ week" } });
    expect(h.summary).toBe("−1.8 kg over the 18 days between your first and last weigh-in, from 82.0 kg to 80.2 kg. A straight line fitted through 10 weigh-ins.");
    expect(h.tiles).toEqual([
      { label: "Last weigh-in", value: "80.2 kg", note: "Mon 19 Jan" },
      { label: "From your line", value: "0.0 kg", note: "inside the usual swing" },
      { label: "Weigh-ins", value: "10", of: "of 21 days", note: "usual swing ±0.0 kg" },
    ]);
    expect(h.projection.value).toBe("77.2 kg"); // the line four weeks from today
    expect(h.goal).toBeNull();
  });

  it("says the rate in pounds when asked, and gaining and steady in their own words", () => {
    expect(WM.hero(view(falling()), "lb", 21).rate.text).toBe("−1.5 lb");
    const gaining = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 3 === 0 ? 80 + 0.05 * i : null }));
    expect(WM.hero(view(gaining), "kg", 21)).toMatchObject({ dir: "gaining", title: "Gaining", rate: { kind: "rate", text: "+0.4 kg" } });
    const flat = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 7 === 0 ? [80, 80.02, 79.99, 80.01][i / 7] : null }));
    const steady = WM.hero(view(flat), "kg", 21);
    expect(steady).toMatchObject({ dir: "steady", title: "Steady", rate: { kind: "steady", text: "steady" }, projection: null });
    expect(steady.summary).toMatch(/^No change beyond the day-to-day swing, from 80\.0 kg to 80\.0 kg\./);
  });

  it("says what a trend needs when there are too few weigh-ins, and invents no line", () => {
    const two = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 3 ? 81 : i === 19 ? 80.5 : null }));
    const h = WM.hero(view(two), "kg", 21);
    expect(h).toMatchObject({ n: 2, dir: null, title: "Too early", rate: { kind: "none", text: "needs 3 weigh-ins over a week or more" }, projection: null });
    expect(h.summary).toBe("2 weigh-ins so far. A trend needs 3, spread over at least a week.");
    expect(h.tiles[1]).toEqual({ label: "From your line", value: "–", note: "no line yet" });
    expect(h.tiles[2].note).toBe("one a day is best");
    expect(WM.hero(view(Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 3 ? 81 : null }))), "kg", 21).summary).toBe("1 weigh-in so far. A trend needs 3, spread over at least a week.");
  });

  it("calls a weigh-in outside the usual swing outside it", () => {
    const days = falling();
    days[18] = { ...days[18], weightKg: 82 - 1.8 + 2.5 };
    expect(WM.hero(view(days), "kg", 21).tiles[1].note).toBe("outside the usual swing");
  });
});

describe("the goal against the line", () => {
  const hero = (goalKg: number | null, days = falling()) => WM.hero(view(days, { goalKg }), "kg", 21).goal;

  it("has none without a goal", () => {
    expect(hero(null)).toBeNull();
  });

  it("says how long the line takes when it moves toward the goal, and how far the last weigh-in is from it", () => {
    expect(hero(76)).toMatchObject({ state: "toward", chip: "Toward the goal", value: "76.0 kg", togo: "4.2 kg above", line: "At this rate, 76.0 kg is about 6 weeks away." });
    expect(hero(80.2 - 0.7 * 0.5)).toMatchObject({ state: "toward", line: expect.stringMatching(/about a week away\.$/) });
    expect(hero(60).line).toBe("At this rate, 60.0 kg is about 29 weeks away.");
    const slow = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 2 === 0 && i <= 18 ? Math.round((82 - 0.015 * i) * 1000) / 1000 : null }));
    expect(hero(60, slow)).toMatchObject({ state: "toward", line: "At this rate, 60.0 kg is more than two years away." }); // 0.1 kg a week is still a rate, and 22 kg is a long way
  });

  it("says away when the line moves from it, and claims no time", () => {
    expect(hero(85)).toMatchObject({ state: "away", chip: "Away from the goal", weeks: null, togo: "4.8 kg below", line: "The line is 4.8 kg below your goal of 85.0 kg, and moving away from it." });
  });

  it("says steady, and at the goal when the line is within 300 g of it", () => {
    const flat = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 7 === 0 ? 80 : null }));
    expect(WM.hero(view(flat, { goalKg: 75 }), "kg", 21).goal).toMatchObject({ state: "steady", chip: null, line: "The line is 5.0 kg above your goal of 75.0 kg, and steady." });
    expect(hero(80.4)).toMatchObject({ state: "reached", chip: "At the goal", line: "The line is at your goal of 80.4 kg." });
  });

  it("says nothing of the way there without a line", () => {
    const two = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 3 ? 81 : i === 19 ? 80.5 : null }));
    expect(hero(70, two)).toMatchObject({ state: "none", chip: null, line: null, togo: "10.5 kg above" });
  });

  it("says the goal in the unit", () => {
    expect(WM.hero(view(falling(), { goalKg: 76 }), "lb", 21).goal).toMatchObject({ value: "167.6 lb", togo: "9.3 lb above" });
  });
});

describe("the week of the day shown", () => {
  it("is the seven days from the Monday, each with its weigh-in and how far it sat from the line", () => {
    const strip = WM.weekStrip(view(falling()), "kg"); // the 19th is a Monday, today (the 21st) a Wednesday
    expect(strip.map((s: any) => `${s.weekday} ${s.number}`)).toEqual(["Mon 19", "Tue 20", "Wed 21", "Thu 22", "Fri 23", "Sat 24", "Sun 25"]);
    expect(strip.map((s: any) => s.state)).toEqual(["weighed", "none", "none", "future", "future", "future", "future"]);
    expect(strip[0]).toMatchObject({ kg: 80.2, text: "80.2", delta: "0.0", selected: true, today: false, label: "Mon 19 Jan, 80.2 kg, 0.0 kg from the line" });
    expect(strip[1]).toMatchObject({ kg: null, text: "–", delta: "none", label: "Tue 20 Jan, no weigh-in" });
    expect(strip[2].today).toBe(true);
    expect(strip[3]).toMatchObject({ text: "–", delta: "", label: "Thu 22 Jan, not yet" });
    expect(strip.filter((s: any) => s.selected)).toHaveLength(1);
  });

  it("says the weigh-in and not its distance when there is no line yet, and the weight in the unit", () => {
    const two = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 18 ? 80 : i === 5 ? 81 : null }));
    const [monday] = WM.weekStrip(view(two), "lb");
    expect(monday).toMatchObject({ text: "176.4", delta: "weigh-in", label: "Mon 19 Jan, 176.4 lb" });
  });

  it("has nothing without a day", () => {
    expect(WM.weekStrip(null, "kg")).toEqual([]);
    expect(WM.weekStrip({ days: [] }, "kg")).toEqual([]);
  });

  it("steps back to the first day of the range and forward to today", () => {
    expect(WM.canStep(view([], { date: day(0) }), 21, -1)).toBe(false); // the range starts on the 1st
    expect(WM.canStep(view([], { date: day(1) }), 21, -1)).toBe(true);
    expect(WM.canStep(view([], { date: TODAY }), 21, 1)).toBe(false);
    expect(WM.canStep(view([], { date: day(19) }), 21, 1)).toBe(true);
    expect(WM.canStep(null, 21, 1)).toBe(false);
  });
});

describe("the weeks one by one", () => {
  const rows = WM.byWeek(view(falling()), "kg", 21);

  it("lists the Monday weeks of the range, the newest first, with the average weigh-in and how many there were", () => {
    expect(rows.map((r: any) => r.label)).toEqual(["19 Jan – 25 Jan", "12 Jan – 18 Jan", "5 Jan – 11 Jan", "29 Dec – 4 Jan"]);
    expect(rows.map((r: any) => r.n)).toEqual([1, 3, 4, 2]);
    expect(rows.map((r: any) => r.note)).toEqual(["this week, so far · 1 weigh-in", "3 weigh-ins", "4 weigh-ins", "2 weigh-ins"]);
    expect(rows[1].avgKg).toBeCloseTo(80.6, 6);
    expect(rows[1].avg).toBe("80.6 kg");
  });

  it("gives the change from the week before, and none for the first week of the range", () => {
    expect(rows[0].deltaKg).toBeCloseTo(-0.4, 6);
    expect(rows[1].change).toBe("−0.7 kg");
    expect(rows[2].change).toBe("−0.6 kg");
    expect(rows[3]).toMatchObject({ change: "–", deltaKg: null, fill: 0 });
  });

  it("fills a bar by the change, 1.2 kg being a whole half and no more", () => {
    expect(rows[1].fill).toBeCloseTo(-0.7 / 1.2, 6);
    const jump = falling();
    jump[18] = { ...jump[18], weightKg: 90 };
    expect(WM.byWeek(view(jump), "kg", 21)[0].fill).toBe(1);
  });

  it("is of the weeks asked for, and says a week with no weigh-in so", () => {
    expect(WM.byWeek(view(falling()), "kg", 21, 2)).toHaveLength(2);
    const gap = falling().map((d: any) => (d.day >= day(11) && d.day <= day(17) ? { ...d, weightKg: null } : d));
    const week = WM.byWeek(view(gap), "kg", 21).find((r: any) => r.monday === day(11));
    expect(week).toMatchObject({ n: 0, avg: "–", note: "no weigh-ins", change: "–" });
  });
});

describe("the calories", () => {
  it("averages what Garmin counted as burned on the finished days, and splits it, with the last 14 days as bars", () => {
    const b = WM.burned(view(falling()));
    expect(b).toMatchObject({ total: 2510, active: 500, rest: 2010, days: 20, max: 2519 }); // today is not over
    expect(b.bars).toHaveLength(14);
    expect(b.bars[13]).toMatchObject({ day: day(19), total: 2519, active: 500, rest: 2019 });
    expect(b.foot).toBe("20 full days · Garmin's estimate from the watch · the last 14 days above");
  });

  it("says nothing without a finished day, and has no split without the active calories", () => {
    expect(WM.burned(view([metricsFor(TODAY, { totalKcal: 900 })]))).toBeNull();
    expect(WM.burned(view(falling({ activeKcal: null })))).toMatchObject({ total: 2510, active: null, rest: null });
  });

  const intake = (over: Record<string, unknown>) => WM.intakeCard(view(falling(), { intake: { loggedDays: 12, days: 10, eatenKcal: 2100, burnedKcal: 2600 }, ...over }), "kg");

  it("sets the calories eaten against the burn as a rate a week by the numbers, against the scale's", () => {
    const card = intake({});
    expect(card).toMatchObject({ eaten: 2100, burned: 2600, days: 10, loggedDays: 12 });
    expect(card.perWeekKg).toBeCloseTo((-500 * 7) / 7700, 6);
    expect(card.parts.map((p: any) => p.t).join("")).toBe("On the 10 days with food logged, that is −0.5 kg a week by the numbers, against −0.7 kg on the scale. A day without a log counts as unknown, not zero, so a gap usually means food that was not logged.");
    expect(card.parts.filter((p: any) => p.strong).map((p: any) => p.t)).toEqual(["−0.5 kg a week", "−0.7 kg"]);
  });

  it("calls under three days too few to set against the scale, and leaves the scale out with no line", () => {
    const few = intake({ intake: { loggedDays: 2, days: 2, eatenKcal: 2100, burnedKcal: 2600 } });
    expect(few.perWeekKg).toBeNull();
    expect(few.parts.map((p: any) => p.t).join("")).toMatch(/^On the 2 days with food logged, that is too few to set against the scale\./);
    const noLine = WM.intakeCard({ ...view(falling()), body: bodyTrend([]), intake: { loggedDays: 12, days: 10, eatenKcal: 2100, burnedKcal: 2600 } }, "kg");
    expect(noLine.parts.map((p: any) => p.t).join("")).toMatch(/^On the 10 days with food logged, that is −0\.5 kg a week by the numbers\. A day/);
  });

  it("is none without a day that has both", () => {
    expect(intake({ intake: null })).toBeNull();
    expect(intake({ intake: { loggedDays: 3, days: 0, eatenKcal: null, burnedKcal: null } })).toBeNull();
    expect(intake({ intake: { loggedDays: 0, days: 0, eatenKcal: null, burnedKcal: null } })).toBeNull();
  });

  it("says one day in the singular", () => {
    expect(intake({ intake: { loggedDays: 1, days: 1, eatenKcal: 2100, burnedKcal: 2600 } }).parts[0].t).toBe("On the 1 day with food logged, ");
  });
});

describe("what the scale measured", () => {
  /** Weight falling a tenth a day on every second day, with the body fat given by `fat(i)`. */
  const withFat = (fat: (i: number) => number, kg = (i: number) => 82 - 0.1 * i) =>
    Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 2 === 0 && i <= 18 ? Math.round(kg(i) * 100) / 100 : null, bodyFatPercent: i % 2 === 0 && i <= 18 ? Math.round(fat(i) * 10) / 10 : null, muscleKg: i % 2 === 0 && i <= 18 ? 36 - 0.02 * i : null, bmi: i % 2 === 0 && i <= 18 ? 24.5 - 0.03 * i : null }));

  it("has a Body tab only when the scale gave a body fat", () => {
    expect(WM.hasBody(view(falling()))).toBe(false);
    expect(WM.tabs(view(falling()))).toEqual(["weight", "data"]);
    expect(WM.hasBody(view(withFat(() => 20)))).toBe(true);
    expect(WM.tabs(view(withFat(() => 20)))).toEqual(["weight", "body", "data"]);
  });

  it("shows the last body fat, muscle and BMI with how the line through them moved, and a small picture", () => {
    const snap = WM.bodySnapshot(view(withFat((i) => 20 - 0.05 * i)), "kg");
    expect(snap.map((r: any) => r.label)).toEqual(["Body fat", "Muscle", "BMI"]);
    expect(snap[0]).toMatchObject({ value: "19.1 %", day: "Mon 19 Jan", change: "−0.9 pts" });
    expect(snap[1]).toMatchObject({ value: "35.6 kg", change: "−0.4 kg" });
    expect(snap[2]).toMatchObject({ value: "24.0", change: "" });
    expect(snap[0].spark).toHaveLength(10);
    expect(WM.bodySnapshot(view(falling()), "kg")).toBeNull();
  });

  it("makes the three figures of the Body tab", () => {
    const tiles = WM.bodyTiles(view(withFat((i) => 20 - 0.05 * i)), "lb");
    expect(tiles.map((t: any) => t.label)).toEqual(["Body fat", "Muscle", "BMI"]);
    expect(tiles[0]).toEqual({ label: "Body fat", value: "19.1 %", note: "Mon 19 Jan · −0.9 pts over the range" });
    expect(tiles[1].value).toBe("78.6 lb");
    expect(tiles[2].note).toBe("Mon 19 Jan · from the weight and your height");
  });

  it("splits a loss into fat and lean, and says what part of it was fat when both fell", () => {
    const c = WM.came(view(withFat(() => 20)), "kg"); // 20 % of every weigh-in is fat: a fifth of the loss
    expect(c.rows.map((r: any) => r.label)).toEqual(["Fat mass", "Lean mass", "Weight"]);
    expect(c.rows[0].kg).toBeCloseTo(-1.8 * 0.2, 1);
    expect(c.rows[1].kg).toBeCloseTo(-1.8 * 0.8, 1);
    expect(c.rows[2].kg).toBeCloseTo(c.rows[0].kg + c.rows[1].kg, 9);
    expect(c.share).toBe(20);
    expect(c.line).toBe("About 20 % of the loss was fat.");
    expect(c.rows[2].text).toBe("−1.8 kg");
    expect(Math.max(...c.rows.map((r: any) => Math.abs(r.frac)))).toBeLessThanOrEqual(1);
  });

  it("puts no number to the share when one fell and the other rose, and says none of a gain", () => {
    const mixed = WM.came(view(withFat((i) => 25 - 0.4 * i, (i) => 80 - 0.05 * i)), "kg");
    expect(mixed.share).toBeNull();
    expect(mixed.line).toBe("The loss was fat: lean mass rose.");
    const leanLoss = WM.came(view(withFat((i) => 20 + 0.4 * i, (i) => 80 - 0.1 * i)), "kg");
    expect(leanLoss.share).toBeNull();
    expect(leanLoss.line).toBe("The loss was lean mass: fat mass rose.");
    const gain = WM.came(view(withFat(() => 20, (i) => 80 + 0.1 * i)), "kg");
    expect(gain.share).toBeNull();
    expect(gain.line).toBe("");
    expect(gain.rows[2].kg).toBeGreaterThan(0);
  });

  it("splits nothing without a line through both, from too few days the scale measured both", () => {
    const few = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 3 || i === 19 ? 80 : null, bodyFatPercent: i === 3 || i === 19 ? 20 : null }));
    expect(WM.came(view(few), "kg")).toBeNull();
    expect(WM.bodySpecs(view(few), "kg").map((s: any) => s.id)).toEqual(["fat"]);
  });
});

describe("the charts", () => {
  const goalView = view(falling(), { goalKg: 76 });

  it("draws the weigh-ins as dots, the line, the usual swing as a band and the goal, in the unit", () => {
    const spec = WM.weightSpec(goalView, "lb"), full = WM.fullDays(goalView, 21), at = (n: number) => full[n];
    expect(spec).toMatchObject({ id: "weight", kind: "dots", unit: "lb" });
    expect(spec.value(at(4))).toBeCloseTo(81.6 * 2.2046226, 3);
    expect(spec.value(at(5))).toBeNull(); // a day with no weigh-in has no dot
    expect(spec.ref.label).toBe("trend line");
    expect(spec.ref.value(at(4))).toBeCloseTo(81.6 * 2.2046226, 3); // the line through the weigh-ins
    expect(spec.ref.value(at(5))).toBeCloseTo(81.5 * 2.2046226, 3); // and through the days between
    const [lo, hi] = spec.band(at(4));
    expect(hi).toBeGreaterThanOrEqual(lo);
    expect(spec.goal).toEqual({ value: expect.closeTo(76 * 2.2046226, 3), label: "goal 167.6 lb" });
    expect(spec.read(at(4))).toBe("179.9 lb · 0.0 lb from the line");
    expect(spec.read(at(5))).toBe("no weigh-in");
  });

  it("has no line, band or goal without them", () => {
    const two = view(Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i === 3 ? 81 : i === 19 ? 80.5 : null })));
    const spec = WM.weightSpec(two, "kg");
    expect([spec.ref, spec.band, spec.goal, spec.bandLabel]).toEqual([undefined, undefined, undefined, undefined]);
    expect(spec.read(WM.fullDays(two, 21)[3])).toBe("81.0 kg");
  });

  it("names the swing with its size", () => {
    const noisy = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 3 === 0 ? 80 + (i % 2 ? 0.6 : -0.6) : null }));
    expect(WM.weightSpec(view(noisy), "kg").bandLabel).toMatch(/^usual day-to-day swing \(±\d\.\d kg\)$/);
  });

  it("draws the Body tab's change of fat and lean, the body fat and the muscle", () => {
    const days = Array.from({ length: 21 }, (_, i) => metricsFor(day(i), { weightKg: i % 2 === 0 ? 82 - 0.1 * i : null, bodyFatPercent: i % 2 === 0 ? 20 - 0.05 * i : null, muscleKg: i % 2 === 0 ? 36 - 0.02 * i : null }));
    const specs = WM.bodySpecs(view(days), "kg"), full = WM.fullDays(view(days), 21);
    expect(specs.map((s: any) => s.id)).toEqual(["compare", "fat", "muscle"]);
    const compare = specs[0];
    expect(compare.second.label).toBe("lean mass");
    expect(compare.value(full[0])).toBeCloseTo(0, 1); // both start at nothing on the first weigh-in
    expect(compare.second.value(full[0])).toBeCloseTo(0, 1);
    expect(compare.value(full[1])).toBeNull();
    expect(compare.value(full[18])).toBeLessThan(0);
    expect(specs[1].value(full[2])).toBeCloseTo(19.9, 1);
    expect(specs[2].read(full[0])).toBe("36.0 kg");
    expect(WM.bodySpecs(view(falling()), "kg").map((s: any) => s.id)).toEqual(["fat"]);
  });
});
