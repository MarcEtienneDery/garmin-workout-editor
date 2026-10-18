import { bodyTrend } from "../shared/bodyTrend";
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

describe("the figures", () => {
  const days = (rows: [number, number | null, number | null][]) =>
    Array.from({ length: 21 }, (_, i) => {
      const w = rows.find(([n]) => n === i);
      return metricsFor(day(i), { weightKg: w ? w[1] : null, bodyFatPercent: w ? w[2] : null, totalKcal: 2500 + i, activeKcal: 500, bmrKcal: 2000 });
    });
  const view = (rows: [number, number | null, number | null][]) => { const d = days(rows); return { body: bodyTrend(d), days: d, today: TODAY }; };

  it("shows the last weigh-in, the trend, the count and the calories of the full days", () => {
    const [last, trend, count, burned] = WM.figures(view([[0, 82, 19], [7, 81.5, null], [14, 81, null], [18, 80.8, 18.2]]), "kg");
    expect(last).toEqual({ label: "Last weigh-in", value: "80.8 kg", note: "19 Jan · 18.2 % fat" });
    expect(trend.label).toBe("Trend");
    expect(trend.value).toMatch(/^−0\.\d kg \/ week$/);
    expect(trend.note).toMatch(/^losing · −\d\.\d kg from 1 Jan to 19 Jan$/);
    expect(count).toEqual({ label: "Weigh-ins", value: "4", note: "in 21 days" });
    expect(burned.label).toBe("Burned a day");
    expect(burned.value).toBe(`${(2510).toLocaleString()} kcal`); // days 0..19 are over; today (day 20) is not counted
    expect(burned.note).toBe("500 active · 20 full days");
  });

  it("says what is missing instead of inventing a number", () => {
    const [last, trend, count, burned] = WM.figures({ body: bodyTrend([]), days: [metricsFor(TODAY, { totalKcal: 900 })], today: TODAY }, "lb");
    expect(last).toEqual({ label: "Last weigh-in", value: "–", note: "none in these days" });
    expect(trend.value).toBe("–");
    expect(count.value).toBe("0");
    expect(burned).toEqual({ label: "Burned a day", value: "–", note: "no full day stored" });
  });

  it("calls a flat weight steady", () => {
    const [, trend] = WM.figures(view([[0, 80, null], [7, 80.02, null], [14, 79.99, null]]), "kg");
    expect(trend.value).toBe("steady");
    expect(trend.note).toMatch(/^steady · /);
  });
});

describe("the charts", () => {
  const weighed = metricsFor("2026-01-01", { weightKg: 80, bodyFatPercent: 18.5, muscleKg: 36, totalKcal: 2600, activeKcal: 650, bmrKcal: 1950 });
  const bare = metricsFor("2026-01-02");

  it("always draws the weight and the calories, and the scale's extras once there are some", () => {
    expect(WM.charts([bare], "kg").map((c: any) => c.id)).toEqual(["weight", "burned"]);
    expect(WM.charts([bare, weighed], "kg").map((c: any) => c.id)).toEqual(["weight", "fat", "muscle", "burned"]);
  });

  it("puts the weight in the unit, joins the weigh-ins across the days between and says them under the cursor", () => {
    const [weight, , muscle, burned] = WM.charts([weighed], "lb");
    expect(weight.unit).toBe("lb");
    expect(weight.connect).toBe(true);
    expect(weight.value(weighed)).toBeCloseTo(176.37, 1);
    expect(weight.value(bare)).toBeNull();
    expect(weight.read(weighed)).toBe("176.4 lb · 18.5 % fat");
    expect(muscle.read(weighed)).toBe("79.4 lb");
    expect(burned.read(weighed)).toBe(`${(2600).toLocaleString()} kcal · 650 active`);
    for (const c of WM.charts([weighed], "kg")) expect(c.read(bare)).toBe("–");
  });

  it("stacks the resting and the active calories from fields the server sends", () => {
    const burned = WM.charts([weighed], "kg").find((c: any) => c.id === "burned");
    expect(burned.parts.map((p: any) => p.key)).toEqual(["bmrKcal", "activeKcal"]);
    for (const p of burned.parts) expect(Object.keys(weighed)).toContain(p.key);
  });
});
