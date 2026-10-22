/**
 * readiness.ts — how recovered a person is on a day, from what the stored health data says, as a band for the day's
 * workout: go harder, as planned, or back off.
 *
 * Garmin computes no readiness for every watch (the vívoactive 5 has none), so this reads the signals that exist:
 * last night's HRV against Garmin's own baseline band, the resting heart rate against the person's own recent normal,
 * the night's length and score against the sleep Garmin says is needed, the Body Battery on waking, yesterday's stress,
 * and the load of the last days (session RPE × minutes, else heart rate, and Garmin's intensity minutes for the effort no session holds). Each signal scores -2 to +2 for the day with
 * the reason; the weighted mean is the score and the band. A signal Garmin has no data for is left out, and it lowers the
 * confidence: it never counts as fine. The thresholds are constants below, meant to be tuned; this is a heuristic for
 * adjusting training, not a medical measure.
 *
 * A day D is read as: sleep and HRV of the night that ended on the morning of D, the resting heart rate and Body Battery
 * of D, yesterday's (D-1) stress, and the sessions that started before D began. The answer therefore depends on D and the
 * stored data only, never on the clock.
 */
import type { LoadRow } from "./store/activities";
import type { DayMetrics, NumOrNull } from "./store/wellness";

/** Days of history the person's own normal is taken from, and the fewest that make a normal. */
export const BASELINE_DAYS = 28;
export const MIN_BASELINE_DAYS = 14;
/**
 * The weighted mean of the signals (each -1 to +1) from which the day is a push or a back-off. Pushing asks for more
 * than backing off: it takes most signals clearly good, while a few mildly poor ones are enough to ease off.
 */
export const GO_HARDER_AT = 0.4;
export const BACK_OFF_AT = -0.25;
/** A session rated this hard or harder (RPE out of 100) counts as a hard one. */
export const HARD_RPE = 70;
/** What the sleep needs is when Garmin does not say. */
const DEFAULT_SLEEP_NEED_HOURS = 7.5;

const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;

export type Band = "go-harder" | "as-planned" | "back-off" | "unknown";

export interface Signal {
  name: "hrv" | "restingHr" | "sleep" | "bodyBattery" | "stress" | "load";
  /** What was measured, and what it is compared with. */
  value: string;
  baseline: string | null;
  /** -2 (well below normal for training) to +2 (well above). */
  score: number;
  weight: number;
  reason: string;
}

export interface LoadSummary {
  /** Load units (RPE-like intensity 1-10 × minutes) of the 3 days before, and the usual for 3 days over the 28 before that. */
  acute: number;
  usual: number | null;
  ratio: number | null;
  sessions: number;
  hoursSinceHard: number | null;
  /** The day's intensity minutes Garmin counts all day, recorded or not (a walk the watch noticed itself), the same way; null when too few days are stored. */
  intensity: IntensitySummary | null;
}

export interface IntensitySummary {
  /** Moderate minutes plus twice the vigorous ones over the 3 days before, and the usual for 3 days over the 28 before that. */
  acute: number;
  usual: number | null;
  ratio: number | null;
}

export interface Readiness {
  date: string;
  band: Band;
  /** 0-100, 50 is a normal day; null when the band is unknown. */
  score: number | null;
  confidence: "high" | "medium" | "low";
  signals: Signal[];
  /** Signals the stored data cannot say, with why. */
  missing: string[];
  load: LoadSummary | null;
  suggestion: string;
}

const SUGGESTIONS: Record<Band, string> = {
  "go-harder": "Recovered well: it is a good day to push. Train at the top of the planned range, add a set or two on the main lifts or run the faster end of the pace range. One hard session, then check again.",
  "as-planned": "A normal day: train as planned.",
  "back-off": "Under-recovered: keep the day easy or lighter. Cut the volume by about a quarter, or lower the intensity a notch (RPE -1 to -2), or swap in easy aerobic work, and keep the heavy or fast work for another day.",
  unknown: "Not enough data to judge the day: train as planned and go by feel.",
};

const WEIGHTS = { hrv: 2, restingHr: 1.5, sleep: 1.5, bodyBattery: 1, stress: 0.5, load: 1 } as const;
const CORE: Signal["name"][] = ["hrv", "restingHr", "sleep"];

const present = (v: NumOrNull | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const roundAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fix = (x: number, digits = 0) => String(+x.toFixed(digits));
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => new Date(dayStart(day) + n * DAY_MS).toISOString().slice(0, 10);
const naive = (local: string) => Date.parse(`${local.replace(" ", "T").slice(0, 19)}Z`);

type Scored = Omit<Signal, "name" | "weight"> | { missing: string };

function hrvSignal(t: DayMetrics): Scored {
  const last = t.hrvLastNight;
  if (!present(last)) return { missing: "no HRV for the night" };
  const { hrvBalancedLow: low, hrvBalancedHigh: high, hrvWeeklyAvg: weekly, hrvLowUpper: lowUpper } = t;
  const status = t.hrvStatus ? ` (Garmin: ${t.hrvStatus.toLowerCase()})` : "";
  if (present(low) && present(high)) {
    const baseline = `balanced ${fix(low)}-${fix(high)} ms${present(weekly) ? `, 7-day average ${fix(weekly)}` : ""}`;
    if (last >= high) return { value: `${fix(last)} ms`, baseline, score: 1, reason: `above your balanced range${status}` };
    if (last >= low) return { value: `${fix(last)} ms`, baseline, score: present(weekly) && last >= weekly ? 1 : 0, reason: `within your balanced range${status}` };
    const well = present(lowUpper) ? last < lowUpper : last < low * 0.9;
    return { value: `${fix(last)} ms`, baseline, score: well ? -2 : -1, reason: `${well ? "well below" : "a little below"} your balanced range${status}` };
  }
  if (present(weekly) && weekly > 0) {
    const ratio = last / weekly;
    return { value: `${fix(last)} ms`, baseline: `7-day average ${fix(weekly)} ms`, score: ratio >= 1.05 ? 1 : ratio >= 0.9 ? 0 : ratio >= 0.8 ? -1 : -2, reason: `${fix(ratio * 100)}% of your 7-day average${status}` };
  }
  return { missing: "HRV has no baseline to compare with" };
}

function restingHrSignal(t: DayMetrics, history: DayMetrics[]): Scored {
  if (!present(t.restingHr)) return { missing: "no resting heart rate for the day" };
  const prior = history.map((h) => h.restingHr).filter(present);
  let base: number, label: string;
  if (prior.length >= MIN_BASELINE_DAYS) [base, label] = [median(prior), `median of the last ${prior.length} days`];
  else if (present(t.restingHr7d)) [base, label] = [t.restingHr7d, `7-day average (only ${prior.length} days stored)`];
  else return { missing: "no resting heart rate baseline yet" };
  const delta = t.restingHr - base;
  const score = delta >= 5 ? -2 : delta >= 3 ? -1 : delta <= -2 ? 1 : 0;
  return { value: `${fix(t.restingHr)} bpm`, baseline: `${fix(base)} bpm, ${label}`, score, reason: delta === 0 ? "at your normal" : `${fix(Math.abs(delta), 1)} bpm ${delta > 0 ? "above" : "below"} your normal` };
}

function sleepSignal(t: DayMetrics): Scored {
  if (!present(t.sleepSeconds) || t.sleepSeconds <= 0) return { missing: "no sleep recorded for the night" };
  const hours = t.sleepSeconds / 3600, need = present(t.sleepNeedMinutes) && t.sleepNeedMinutes > 0 ? t.sleepNeedMinutes / 60 : DEFAULT_SLEEP_NEED_HOURS;
  const ratio = hours / need;
  const byLength = ratio >= 0.95 ? 1 : ratio >= 0.85 ? 0 : ratio >= 0.7 ? -1 : -2;
  const s = t.sleepScore;
  const byScore = !present(s) ? null : s >= 90 ? 2 : s >= 80 ? 1 : s >= 60 ? 0 : s >= 40 ? -1 : -2;
  return {
    value: `${fix(hours, 1)} h${present(s) ? `, score ${fix(s)}` : ""}`,
    baseline: `need ${fix(need, 1)} h${present(t.sleepNeedMinutes) ? "" : " (assumed)"}`,
    score: byScore === null ? byLength : roundAway((byLength + byScore) / 2),
    reason: `${fix(ratio * 100)}% of the sleep needed${present(t.awakeCount) ? `, ${fix(t.awakeCount)} awakenings` : ""}`,
  };
}

function bodyBatterySignal(t: DayMetrics): Scored {
  const b = t.bodyBatteryWake;
  if (!present(b)) return { missing: "no Body Battery on waking" };
  return { value: fix(b), baseline: null, score: b >= 80 ? 2 : b >= 65 ? 1 : b >= 45 ? 0 : b >= 30 ? -1 : -2, reason: "Body Battery on waking (0-100)" };
}

function stressSignal(prev: DayMetrics | undefined): Scored {
  const s = prev?.avgStress;
  if (!present(s) || s < 0) return { missing: "no stress figure for yesterday" };
  return { value: fix(s), baseline: null, score: s >= 60 ? -2 : s >= 45 ? -1 : s <= 25 ? 1 : 0, reason: "yesterday's average stress (0-100)" };
}

/** The intensity minutes of a stored day as Garmin counts them toward its goal: moderate plus twice the vigorous. Null when the day has none stored. */
export const dayIntensityMinutes = (m: Pick<DayMetrics, "moderateMinutes" | "vigorousMinutes">): number | null =>
  m.moderateMinutes === null && m.vigorousMinutes === null ? null : (m.moderateMinutes ?? 0) + 2 * (m.vigorousMinutes ?? 0);

/**
 * Garmin's intensity minutes of the 3 days before a day against the usual for 3 days over the 28 before them. They count all
 * day, whatever recorded the effort, so they carry what no session holds. A day with nothing stored is unknown, not zero: the
 * 3 days are scaled up from the days stored (at least 2 of them) and the usual is the average of the stored days (at least 14).
 */
function intensitySummary(metrics: DayMetrics[], date: string): IntensitySummary | null {
  const minutes = (from: string, to: string) => metrics.filter((m) => m.day >= from && m.day < to).map(dayIntensityMinutes).filter(present);
  const recent = minutes(addDays(date, -3), date), earlier = minutes(addDays(date, -31), addDays(date, -3));
  const per3Days = (xs: number[]) => (xs.reduce((a, x) => a + x, 0) / xs.length) * 3;
  if (recent.length < 2) return null;
  const acute = per3Days(recent), usual = earlier.length >= MIN_BASELINE_DAYS ? per3Days(earlier) : null;
  return { acute: Math.round(acute), usual: usual === null ? null : Math.round(usual), ratio: usual !== null && usual > 0 ? Math.round((acute / usual) * 100) / 100 : null };
}

/**
 * The load before a day began: the sessions of the 31 days before (the effort times the minutes) and Garmin's intensity minutes
 * of the same days. The score is read from the higher of the two ratios against the usual, so a heavy few days show whichever
 * way they were heavy. Null when there are no sessions in the 31 days and no intensity minutes to go by.
 */
export function loadSummary(rows: LoadRow[], date: string, metrics: DayMetrics[] = []): (LoadSummary & { score: number }) | null {
  const start = dayStart(date), acuteFrom = start - 3 * DAY_MS, from = start - 31 * DAY_MS;
  const sessions = rows.filter((r) => r.seconds !== null && r.seconds > 0 && naive(r.startLocal) >= from && naive(r.startLocal) < start);
  const intensity = intensitySummary(metrics, date);
  if (!sessions.length && !intensity) return null;
  const refMax = Math.max(0, ...sessions.map((r) => r.maxHr ?? 0)) || 190;
  /** RPE-like intensity, 1-10: the rated effort, else the average heart rate against the highest seen, else a plain 4. */
  const effort = (r: LoadRow) => (r.rpe !== null ? clamp(r.rpe / 10, 1, 10) : r.avgHr !== null ? clamp(((r.avgHr / refMax - 0.5) / 0.5) * 10, 1, 10) : 4);
  const units = (r: LoadRow) => ((r.seconds ?? 0) / 60) * effort(r);
  const recent = sessions.filter((r) => naive(r.startLocal) >= acuteFrom);
  const acute = recent.reduce((a, r) => a + units(r), 0);
  const before = sessions.filter((r) => naive(r.startLocal) < acuteFrom);
  const usual = before.length ? (before.reduce((a, r) => a + units(r), 0) / 28) * 3 : null;
  const ratio = usual !== null && usual > 0 ? acute / usual : null;
  const hard = sessions.filter((r) => (r.rpe !== null ? r.rpe >= HARD_RPE : effort(r) >= 7.5) && naive(r.startLocal) >= start - 3 * DAY_MS);
  const lastHard = hard.length ? Math.max(...hard.map((r) => naive(r.startLocal))) : null;
  const hoursSinceHard = lastHard === null ? null : (start - lastHard) / HOUR_MS;
  const ratios = [ratio, intensity?.ratio ?? null].filter(present);
  const worst = ratios.length ? Math.max(...ratios) : null;
  const byRatio = worst === null ? 0 : worst >= 1.6 ? -2 : worst >= 1.3 ? -1 : worst <= 0.7 ? 1 : 0;
  const score = clamp(byRatio + (hoursSinceHard !== null && hoursSinceHard < 24 ? -1 : 0), -2, 1);
  return { acute: Math.round(acute), usual: usual === null ? null : Math.round(usual), ratio: ratio === null ? null : Math.round(ratio * 100) / 100, sessions: recent.length, hoursSinceHard: hoursSinceHard === null ? null : Math.round(hoursSinceHard), intensity, score };
}

function loadSignal(load: ReturnType<typeof loadSummary>): Scored {
  if (!load) return { missing: "no sessions in the last 31 days and no intensity minutes stored" };
  const hard = load.hoursSinceHard !== null && load.hoursSinceHard < 24;
  const pct = (r: number | null) => (r === null ? null : `${fix(r * 100)}%`);
  const parts = [
    load.ratio !== null ? `sessions at ${pct(load.ratio)} of your usual 3 days` : null,
    load.intensity?.ratio != null ? `intensity minutes at ${pct(load.intensity.ratio)} of your usual` : null,
    hard ? `a hard session ${fix(load.hoursSinceHard!)} h before the day` : null,
  ].filter(Boolean);
  const intensity = load.intensity ? `, ${load.intensity.acute} intensity min` : "";
  const usual = [load.usual === null ? null : `${load.usual} units`, load.intensity?.usual != null ? `${load.intensity.usual} intensity min` : null].filter(Boolean);
  return {
    value: `${load.sessions} session${load.sessions === 1 ? "" : "s"}${intensity} in the 3 days before`,
    baseline: usual.length ? `usual about ${usual.join(", ")}` : null,
    score: load.score,
    reason: parts.length ? parts.join("; ") : "no usual to compare with yet",
  };
}

/**
 * How ready the person is on `date`. `metrics` are the stored days (any order, ideally the 28 before `date` and `date`);
 * `load` the activities of the 31 days before.
 */
export function computeReadiness(metrics: DayMetrics[], load: LoadRow[], date: string): Readiness {
  const byDay = new Map(metrics.map((m) => [m.day, m]));
  const from = addDays(date, -BASELINE_DAYS);
  const history = metrics.filter((m) => m.day >= from && m.day < date);
  const today = byDay.get(date);
  const summary = loadSummary(load, date, metrics);

  const scored: [Signal["name"], Scored][] = [
    ["hrv", today ? hrvSignal(today) : { missing: "no data stored for the day" }],
    ["restingHr", today ? restingHrSignal(today, history) : { missing: "no data stored for the day" }],
    ["sleep", today ? sleepSignal(today) : { missing: "no data stored for the day" }],
    ["bodyBattery", today ? bodyBatterySignal(today) : { missing: "no data stored for the day" }],
    ["stress", stressSignal(byDay.get(addDays(date, -1)))],
    ["load", loadSignal(summary)],
  ];
  const signals: Signal[] = [], missing: string[] = [];
  for (const [name, s] of scored) {
    if ("missing" in s) missing.push(`${name}: ${s.missing}`);
    else signals.push({ name, weight: WEIGHTS[name], ...s });
  }

  const core = signals.filter((s) => CORE.includes(s.name));
  const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
  const mean = totalWeight ? signals.reduce((a, s) => a + (s.weight * s.score) / 2, 0) / totalWeight : 0;
  const confidence: Readiness["confidence"] = core.length === 3 && signals.length >= 4 ? "high" : core.length >= 2 ? "medium" : "low";
  const hrv = signals.find((s) => s.name === "hrv");

  let band: Band;
  if (signals.length < 2 || core.length === 0) band = "unknown";
  else if (mean <= BACK_OFF_AT || hrv?.score === -2) band = "back-off";
  else if (mean >= GO_HARDER_AT && confidence !== "low" && core.every((s) => s.score >= 0)) band = "go-harder";
  else band = "as-planned";

  return {
    date,
    band,
    score: band === "unknown" ? null : Math.round(50 + 50 * mean),
    confidence,
    signals,
    missing,
    load: summary && { acute: summary.acute, usual: summary.usual, ratio: summary.ratio, sessions: summary.sessions, hoursSinceHard: summary.hoursSinceHard, intensity: summary.intensity },
    suggestion: SUGGESTIONS[band],
  };
}

/** The person's own normal over the days before `date`: medians of the signals that have enough days. */
export function baselines(metrics: DayMetrics[], date: string): { days: number; hrv: NumOrNull; restingHr: NumOrNull; sleepHours: NumOrNull; bodyBatteryWake: NumOrNull; sleepRespiration: NumOrNull } {
  const from = addDays(date, -BASELINE_DAYS), history = metrics.filter((m) => m.day >= from && m.day < date);
  const med = (values: NumOrNull[], scale = 1): NumOrNull => {
    const xs = values.filter(present);
    return xs.length >= MIN_BASELINE_DAYS ? Math.round((median(xs) / scale) * 10) / 10 : null;
  };
  return {
    days: history.length,
    hrv: med(history.map((h) => h.hrvLastNight)),
    restingHr: med(history.map((h) => h.restingHr)),
    sleepHours: med(history.map((h) => h.sleepSeconds), 3600),
    bodyBatteryWake: med(history.map((h) => h.bodyBatteryWake)),
    sleepRespiration: med(history.map((h) => h.avgSleepRespiration)),
  };
}
