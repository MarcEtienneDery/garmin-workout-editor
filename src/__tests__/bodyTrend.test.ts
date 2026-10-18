import { MIN_SPAN_DAYS, MIN_WEIGH_INS, STEADY_PER_WEEK_KG, bodyTrend } from "../shared/bodyTrend";
import { metricsFor } from "./fixtures/wellness";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const weighed = (n: number, kg: number | null, fat: number | null = null) => metricsFor(day(n), { weightKg: kg, bodyFatPercent: fat });

describe("bodyTrend", () => {
  it("has nothing to say without a weigh-in", () => {
    expect(bodyTrend([])).toEqual({ weighIns: 0, latest: null, first: null, perWeekKg: null, changeKg: null, direction: null });
    expect(bodyTrend([weighed(0, null), weighed(1, null)]).weighIns).toBe(0);
  });

  it("gives the last and first weigh-in but no trend until there are enough, spread enough", () => {
    expect(MIN_WEIGH_INS).toBe(3);
    const few = bodyTrend([weighed(0, 80), weighed(9, 79)]);
    expect(few).toEqual(expect.objectContaining({ weighIns: 2, latest: { day: day(9), kg: 79, bodyFatPercent: null }, first: { day: day(0), kg: 80 }, perWeekKg: null, direction: null }));
    const close = bodyTrend([weighed(0, 80), weighed(2, 80.5), weighed(MIN_SPAN_DAYS - 1, 81)]);
    expect(close.perWeekKg).toBeNull();
    expect(bodyTrend([weighed(0, 80), weighed(3, 80.2), weighed(MIN_SPAN_DAYS, 80.4)]).perWeekKg).not.toBeNull();
  });

  it("fits a line through every weigh-in, in any order, and says which way it goes", () => {
    // 0.5 kg a week down, the days between left out and the order shuffled
    const losing = bodyTrend([weighed(14, 79), weighed(0, 80), weighed(7, 79.5), weighed(10, 79.3)].map((d) => d));
    expect(losing.direction).toBe("losing");
    expect(losing.perWeekKg).toBeCloseTo(-0.5, 1);
    expect(losing.changeKg).toBeCloseTo(-1, 1);
    expect(losing.latest!.kg).toBe(79);
    expect(bodyTrend([weighed(0, 70), weighed(7, 70.6), weighed(14, 71.2)]).direction).toBe("gaining");
  });

  it("is not thrown by one heavy day, and calls a flat line steady", () => {
    const noisy = bodyTrend([weighed(0, 80), weighed(3, 80.6), weighed(7, 79.8), weighed(10, 80.4), weighed(14, 80)]);
    expect(Math.abs(noisy.perWeekKg!)).toBeLessThan(STEADY_PER_WEEK_KG);
    expect(noisy.direction).toBe("steady");
  });

  it("carries the body fat of the last weigh-in", () => {
    expect(bodyTrend([weighed(0, 80, 20.04), weighed(1, 80, 19.46)]).latest).toEqual({ day: day(1), kg: 80, bodyFatPercent: 19.5 });
  });
});
