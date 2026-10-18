/**
 * wellnessReport.ts — what the stored daily health data says, read from the database: the readiness for a day, and the
 * days of a range with the person's own normal. The MCP tools and the web view both answer from these, so they cannot disagree.
 */
import { BASELINE_DAYS, baselines, computeReadiness, type Readiness } from "./readiness";
import type { DayMetrics, SqliteStore } from "./store";
import { addDays } from "./wellnessSync";

/** Days of activities the load of a readiness is worked out from. */
const LOAD_DAYS = 31;

/** How ready the person is on `date`, and how many days of data it was worked out from. */
export function readinessAt(store: SqliteStore, profile: string, date: string): { readiness: Readiness; daysStored: number } {
  const metrics = store.wellness.metrics(profile, addDays(date, -BASELINE_DAYS), date);
  const load = store.activities.loadRows(profile, `${addDays(date, -LOAD_DAYS)} 00:00:00`);
  return { readiness: computeReadiness(metrics, load, date), daysStored: metrics.length };
}

/** The stored days from `from` to `to`, oldest first, with the person's own normal over the 28 days before `to`. */
export function wellnessRange(store: SqliteStore, profile: string, from: string, to: string): { baselines: ReturnType<typeof baselines>; days: DayMetrics[] } {
  const all = store.wellness.metrics(profile, addDays(from, -BASELINE_DAYS), to);
  return { baselines: baselines(all, to), days: all.filter((m) => m.day >= from) };
}
