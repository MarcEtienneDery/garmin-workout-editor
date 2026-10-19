/**
 * The wellness tools' side of the wellness store: Garmin as a WellnessSource, a refresh of the last days, and the answers
 * to get_readiness and get_wellness, read from the database. The sync itself is shared/wellnessSync.ts, the reading of
 * the data shared/readiness.ts.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LeaseLost } from "../../shared/activitySync";
import { WELLNESS_KINDS, type WellnessKind, getStore } from "../../shared/store";
import { bodyTrend } from "../../shared/bodyTrend";
import { readinessAt, wellnessRange } from "../../shared/wellnessReport";
import { BACKFILL_DAYS, type WellnessSource, addDays, isWellnessBackfilling, localToday, startWellnessBackfill, syncWellness, wellnessStatus, withWellnessLease } from "../../shared/wellnessSync";
import { type Session, getSession, requireAuth, runTool } from "../context";
import { detailGapMs, holder, locked } from "./activities";
import { READ_GARMIN, isoDate, profileArg } from "./garmin";

const BASE = "https://connectapi.garmin.com";

/** Where Garmin keeps each kind, for a day (and the user's display name, which two of them are filed under). */
const URLS: Record<WellnessKind, (day: string, name: string) => string> = {
  summary: (d, n) => `/usersummary-service/usersummary/daily/${n}?calendarDate=${d}`,
  sleep: (d) => `/sleep-service/sleep/dailySleepData?date=${d}&nonSleepBufferMinutes=60`,
  hrv: (d) => `/hrv-service/hrv/${d}`,
  heart_rate: (d, n) => `/wellness-service/wellness/dailyHeartRate/${n}?date=${d}`,
  stress: (d) => `/wellness-service/wellness/dailyStress/${d}`,
  body_battery: (d) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${d}&endDate=${d}`,
  respiration: (d) => `/wellness-service/wellness/daily/respiration/${d}`,
  spo2: (d) => `/wellness-service/wellness/daily/spo2/${d}`,
  weight: (d) => `/weight-service/weight/dayview/${d}`,
};

/** What a readiness is made of, and the weigh-in (one call, and a person who has just weighed in wants to see it): fetched at once for the last days, the rest of the kinds fill in the background. */
const NOW_KINDS: WellnessKind[] = ["summary", "sleep", "hrv", "weight"];
/** The last days whose responses are fetched again by a call, as the watch syncs late. */
const RECENT_DAYS = 3;
/** A page that shows today's steps asks for the day's summary again when it is older than this, instead of REFRESH_MS. */
const FRESH_MS = 60_000;
const MAX_RANGE_DAYS = 120;
/** How many days the background sync keeps: 60, or WELLNESS_DAYS. */
const keptDays = (): number => Math.min(MAX_RANGE_DAYS, Math.max(RECENT_DAYS, Math.floor(Number(process.env.WELLNESS_DAYS)) || BACKFILL_DAYS));

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Garmin, one call at a time, signed in on first use. */
export function wellnessSourceFor(session: Session): WellnessSource {
  let signedIn = false, displayName: string | undefined;
  return {
    async fetch(kind, day) {
      if (!signedIn) {
        await locked(() => requireAuth(session));
        signedIn = true;
      }
      return locked(async () => {
        displayName ??= (await session.garminClient.getClient().getUserProfile()).displayName;
        return session.garminClient.getClientAny().client.get(`${BASE}${URLS[kind](day, displayName as string)}`);
      });
    },
  };
}

/**
 * Fetch the last days' readiness kinds now, unless a background sync is on it or Garmin said to wait. Never throws.
 * `fresh` also fetches today's summary again unless it was fetched a minute ago, so the steps on screen are not up to half an hour old.
 */
export async function refreshWellness(profile?: string, options: { fresh?: boolean } = {}): Promise<{ fetched: number; busy: boolean; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (isWellnessBackfilling(store, name)) return { fetched: 0, busy: true, error: null };
  const wait = Math.max(store.wellness.state(name).retryAfter ?? 0, store.activities.state(name).retryAfter ?? 0);
  if (Date.now() < wait) return { fetched: 0, busy: false, error: store.wellness.state(name).error ?? store.activities.state(name).error ?? "Garmin asked to wait." };
  try {
    const leased = await withWellnessLease(store, name, holder(), async (renew) => {
      const source = wellnessSourceFor(session), today = localToday(store, name), gapMs = detailGapMs();
      const found = await syncWellness(store, name, source, { today, days: RECENT_DAYS, kinds: NOW_KINDS, renew, gapMs });
      if (!options.fresh || found.stopped) return found;
      const again = await syncWellness(store, name, source, { today, days: 1, kinds: ["summary"], staleMs: FRESH_MS, renew, gapMs });
      return { fetched: found.fetched + again.fetched, failed: found.failed + again.failed, stopped: again.stopped };
    });
    if (!leased.ok) return { fetched: 0, busy: true, error: null };
    return { fetched: leased.value.fetched, busy: false, error: leased.value.stopped };
  } catch (error) {
    return { fetched: 0, busy: error instanceof LeaseLost, error: error instanceof LeaseLost ? null : errorText(error) };
  }
}

/** Forget the empty weigh-in answers of the kept days, so the next fill asks Garmin again (a weigh-in may have been added there since). */
export function rereadWeighIns(profile?: string): number {
  const store = getStore(), name = getSession(profile).profile.name, today = localToday(store, name);
  return store.wellness.forgetEmptyWeighIns(name, addDays(today, -(keptDays() - 1)), today);
}

/** Keep filling the table in the background: the last 60 days, every kind. A no-op when all is stored. */
export function startBackgroundWellness(profile?: string): { started: boolean; reason?: string } {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (session.mock) return { started: false, reason: "Mock mode." };
  const { started, reason } = startWellnessBackfill(store, name, wellnessSourceFor(session), { holder: holder(), today: localToday(store, name), days: keptDays(), gapMs: detailGapMs() });
  return { started, reason };
}

/** How the wellness sync stands, for a profile: what is stored, what is still to fetch, whether it runs, and why it stopped. */
export function wellnessSyncStatus(profile: string) {
  const store = getStore();
  return wellnessStatus(store, profile, localToday(store, profile), Date.now(), keptDays());
}

/** What a result says of the sync: how much is stored, whether it fills in the background, and why it stopped early. */
function syncNote(profile: string, refreshError: string | null, background: { started: boolean }) {
  const status = wellnessSyncStatus(profile);
  return {
    ...status,
    ...(refreshError || status.error ? { error: refreshError ?? status.error } : {}),
    note: status.syncing || background.started ? `The last ${keptDays()} days are being stored in the background; baselines get better as they fill in.` : undefined,
  };
}

const MOCK = { mock: true, note: "Mock mode: there is no wellness data." };

export interface GetReadinessArgs {
  profile?: string;
  date?: string;
}

/** How recovered the person is on a day (today by default), with the signals behind it and what to do with the day's workout. */
export async function getReadiness(args: GetReadinessArgs) {
  const session = getSession(args.profile);
  if (session.mock) return MOCK;
  const store = getStore(), name = session.profile.name, today = localToday(store, name), date = args.date ?? today;
  const refreshed = date >= addDays(today, -RECENT_DAYS) ? await refreshWellness(args.profile) : { fetched: 0, busy: false, error: null };
  const background = startBackgroundWellness(args.profile);
  const { readiness, daysStored } = readinessAt(store, name, date);
  return { profile: name, ...readiness, daysStored, sync: syncNote(name, refreshed.error, background) };
}

export interface GetWellnessArgs {
  profile?: string;
  from?: string;
  to?: string;
  days: number;
  rawKinds?: WellnessKind[];
}

/** The stored daily health data over a range (the last `days` days by default), newest first, with the person's own normal. */
export async function getWellness(args: GetWellnessArgs) {
  const session = getSession(args.profile);
  if (session.mock) return MOCK;
  const store = getStore(), name = session.profile.name, today = localToday(store, name);
  const to = args.to ?? today, from = args.from ?? addDays(to, -(args.days - 1));
  if (from > to) throw new Error("from is after to.");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) throw new Error(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  if (args.rawKinds?.length && from !== to) throw new Error("rawKinds returns Garmin's full responses, so ask for one day (from = to).");

  const refreshed = to >= addDays(today, -RECENT_DAYS) ? await refreshWellness(args.profile) : { fetched: 0, busy: false, error: null };
  const background = startBackgroundWellness(args.profile);
  const { baselines, days } = wellnessRange(store, name, from, to);
  const raw = args.rawKinds?.length ? Object.fromEntries(args.rawKinds.map((k) => [k, store.wellness.get(name, from, k)])) : undefined;
  return {
    profile: name,
    from,
    to,
    baselines,
    body: bodyTrend(days),
    days: days.reverse(),
    ...(raw && { raw }),
    sync: syncNote(name, refreshed.error, background),
  };
}

export function registerWellnessTools(server: McpServer): void {
  server.registerTool(
    "get_readiness",
    {
      title: "Get readiness for a day's workout",
      description:
        "How recovered the person is on a day (today by default), as a band for that day's workout: \"go-harder\", \"as-planned\" or \"back-off\", with a 0-100 score, the signals behind it (last night's HRV against Garmin's baseline band, resting heart rate against their own 28-day normal, sleep length and score against the sleep needed, Body Battery on waking, yesterday's stress, and the load of the last days from session RPE and duration), what is missing, and a suggestion. Use it before planning or adjusting a day's workout: push a little when recovered, ease off when not. Each signal says why it scored as it did, so explain the call to the user rather than just repeating the band. It is a heuristic, not medical advice. Reads the database; Garmin is asked only for the last days' sleep, HRV, daily summary and weigh-in, and the last 60 days of everything fill in the background (see `sync`).",
      inputSchema: {
        profile: profileArg,
        date: isoDate.optional().describe("The day, YYYY-MM-DD (the user's local day). Default: today."),
      },
      annotations: READ_GARMIN,
    },
    (args) => runTool(() => getReadiness(args))
  );

  server.registerTool(
    "get_wellness",
    {
      title: "Get daily health data",
      description:
        "The stored daily health data per day, newest first: sleep (length, stages, score, need, awakenings), HRV (last night, 7-day average, Garmin's balanced range, status), resting heart rate and its 7-day average, Body Battery (on waking, high, low, charged, drained), stress, respiration, SpO2, steps and intensity minutes, calories burned (total, active, resting), weight and body composition (weight and muscle in kg, body fat %, BMI; null on days with no weigh-in), plus the person's own normal (`baselines`, 28-day medians) and `body`, the weight trend over the range (latest, first, change and kg per week). Default: the last 14 days; at most 120. A day's sleep and HRV are the night that ended that morning. With rawKinds and a single day (from = to) it also returns Garmin's complete stored responses for those kinds. Reads the database; the last days are refreshed from Garmin, the rest of the last 60 days fills in the background (see `sync`).",
      inputSchema: {
        profile: profileArg,
        from: isoDate.optional().describe("First day, YYYY-MM-DD. Default: `days` before `to`."),
        to: isoDate.optional().describe("Last day, YYYY-MM-DD. Default: today."),
        days: z.number().int().min(1).max(MAX_RANGE_DAYS).default(14).describe("How many days when `from` is not given."),
        rawKinds: z.array(z.enum(WELLNESS_KINDS)).optional().describe("Return Garmin's full stored responses of these kinds for the single day from = to (large: sleep alone is about 100 KB)."),
      },
      annotations: READ_GARMIN,
    },
    (args) => runTool(() => getWellness(args))
  );
}
