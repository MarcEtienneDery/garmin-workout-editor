import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeStore, getStore } from "../shared/store";
import { readinessAt, readinessDays } from "../shared/wellnessReport";
import { hrvResponse, sleepResponse, summaryResponse } from "./fixtures/wellness";

const PROFILE = "SAM";
const DAY = 86_400_000;
const day = (n: number) => new Date(Date.parse("2026-10-31T00:00:00Z") - n * DAY).toISOString().slice(0, 10);

let dir: string, saved: string | undefined;
beforeEach(() => {
  saved = process.env.GARMIN_STORE_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-days-"));
  process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.GARMIN_STORE_PATH; else process.env.GARMIN_STORE_PATH = saved;
});

/** `n` days stored, the last one the 31st: a steady week-in week-out, with the HRV of the newest days dropping. */
function fill(n: number, hrvOf: (back: number) => number = () => 50): void {
  for (let back = 0; back < n; back++) {
    const d = day(back), hrv = hrvOf(back);
    getStore().wellness.put(PROFILE, d, "sleep", sleepResponse({ hrv }));
    getStore().wellness.put(PROFILE, d, "hrv", hrvResponse({ last: hrv }));
    getStore().wellness.put(PROFILE, d, "summary", summaryResponse({ rhr: 50 }));
  }
}

describe("readinessDays", () => {
  it("gives a band and a score for each day from the first to the last, oldest first", () => {
    fill(45);
    const days = readinessDays(getStore(), PROFILE, day(6), day(0));
    expect(days.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(day));
    for (const d of days) expect(d).toEqual({ day: d.day, band: expect.stringMatching(/go-harder|as-planned|back-off/), score: expect.any(Number) });
  });

  it("says of each day what readinessAt says of it: a day reads only the days before it", () => {
    fill(60, (back) => (back < 3 ? 38 : 50 + (back % 4))); // the last three nights are poor
    for (const d of readinessDays(getStore(), PROFILE, day(9), day(0))) {
      const one = readinessAt(getStore(), PROFILE, d.day).readiness;
      expect({ band: d.band, score: d.score }).toEqual({ band: one.band, score: one.score });
    }
  });

  it("tells a day after a poor night from the ones before it", () => {
    fill(60, (back) => (back === 0 ? 30 : 50));
    const [before, last] = readinessDays(getStore(), PROFILE, day(1), day(0));
    expect(before.band).not.toBe("back-off");
    expect(last.band).toBe("back-off"); // an HRV far under the range sets Back off by itself
    expect(last.score!).toBeLessThan(before.score!);
  });

  it("leaves a day with nothing stored unknown, with no score", () => {
    fill(20);
    const days = readinessDays(getStore(), PROFILE, day(25), day(0));
    expect(days[0]).toEqual({ day: day(25), band: "unknown", score: null });
    expect(days[days.length - 1].band).not.toBe("unknown");
  });

  it("gives nothing for a first day after the last, and one day for the same day twice", () => {
    fill(40);
    expect(readinessDays(getStore(), PROFILE, day(0), day(1))).toEqual([]);
    expect(readinessDays(getStore(), PROFILE, day(2), day(2))).toHaveLength(1);
  });

  it("keeps one profile's days from another's", () => {
    fill(40);
    expect(readinessDays(getStore(), "OTHER", day(3), day(0)).every((d) => d.band === "unknown" && d.score === null)).toBe(true);
  });
});
