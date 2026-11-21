import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LeaseLost } from "../../shared/activitySync";
import { WELLNESS_KINDS, type WellnessKind, getStore } from "../../shared/store";
import { bodyRange, readinessAt, wellnessRange, withScaleWeighIns } from "../../shared/wellnessReport";
import { BACKFILL_DAYS, RECENT_DAYS, type WellnessSource, addDays, isWellnessBackfilling, localToday, startWellnessBackfill, syncWellness, wellnessStatus, withWellnessLease } from "../../shared/wellnessSync";
import { garminConnected } from "../../shared/profileLoader";
import { type Session, dataProfile, getSession, getSettings, requireAuth, runTool } from "../context";
import { detailGapMs, holder, locked } from "./activities";
import { READ_GARMIN, isoDate, profileArg } from "./garmin";

const BASE = "https://connectapi.garmin.com";

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

const NOW_KINDS: WellnessKind[] = ["summary", "sleep", "hrv", "weight"];
const MAX_RANGE_DAYS = 120;
const keptDays = (): number => Math.min(MAX_RANGE_DAYS, Math.max(RECENT_DAYS, Math.floor(Number(process.env.WELLNESS_DAYS)) || BACKFILL_DAYS));
const filledDays = (span = 0): number => Math.min(MAX_RANGE_DAYS, Math.max(keptDays(), Math.floor(span) || 0));

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

export async function refreshWellness(profile?: string, options: { manual?: boolean } = {}): Promise<{ fetched: number; busy: boolean; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (isWellnessBackfilling(store, name)) return { fetched: 0, busy: true, error: null };
  const wait = Math.max(store.wellness.state(name).retryAfter ?? 0, store.activities.state(name).retryAfter ?? 0);
  if (Date.now() < wait) return { fetched: 0, busy: false, error: store.wellness.state(name).error ?? store.activities.state(name).error ?? "Garmin asked to wait." };
  try {
    const leased = await withWellnessLease(store, name, holder(), async (renew) => {
      const source = wellnessSourceFor(session), today = localToday(store, name), gapMs = detailGapMs();
      return syncWellness(store, name, source, { today, days: RECENT_DAYS, kinds: options.manual ? WELLNESS_KINDS : NOW_KINDS, renew, gapMs, manual: options.manual });
    });
    if (!leased.ok) return { fetched: 0, busy: true, error: null };
    return { fetched: leased.value.fetched, busy: false, error: leased.value.stopped };
  } catch (error) {
    return { fetched: 0, busy: error instanceof LeaseLost, error: error instanceof LeaseLost ? null : errorText(error) };
  }
}

export function rereadWeighIns(profile?: string): number {
  const store = getStore(), name = dataProfile(profile), today = localToday(store, name);
  return store.wellness.forgetEmptyWeighIns(name, addDays(today, -(keptDays() - 1)), today);
}

export function startBackgroundWellness(profile?: string, span = 0): { started: boolean; reason?: string } {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (session.mock) return { started: false, reason: "Mock mode." };
  const { started, reason } = startWellnessBackfill(store, name, wellnessSourceFor(session), { holder: holder(), today: localToday(store, name), days: filledDays(span), gapMs: detailGapMs() });
  return { started, reason };
}

export function wellnessSyncStatus(profile: string, span = 0) {
  const store = getStore();
  return wellnessStatus(store, profile, localToday(store, profile), Date.now(), filledDays(span));
}

function syncNote(profile: string, refreshError: string | null, background: { started: boolean }, connected = true) {
  const status = connected ? wellnessSyncStatus(profile) : { ...wellnessSyncStatus(profile), pending: 0, syncing: false, error: null };
  return {
    ...status,
    ...(connected ? {} : { garmin: "not connected" }),
    ...(refreshError || status.error ? { error: refreshError ?? status.error } : {}),
    note: !connected
      ? `Profile "${profile}" has no Garmin login, so this is only the health data already stored.`
      : status.syncing || background.started ? `The last ${keptDays()} days are being stored in the background; baselines get better as they fill in.` : undefined,
  };
}

const MOCK = { mock: true, note: "Mock mode: there is no wellness data." };

export interface GetReadinessArgs {
  profile?: string;
  date?: string;
}

export async function getReadiness(args: GetReadinessArgs) {
  if (getSettings().mock) return MOCK;
  const store = getStore(), name = dataProfile(args.profile), today = localToday(store, name), date = args.date ?? today;
  const connected = garminConnected(name);
  const refreshed = connected && date >= addDays(today, -RECENT_DAYS) ? await refreshWellness(name) : { fetched: 0, busy: false, error: null };
  const background = connected ? startBackgroundWellness(name) : { started: false };
  const { readiness, daysStored } = readinessAt(store, name, date);
  return { profile: name, ...readiness, daysStored, sync: syncNote(name, refreshed.error, background, connected) };
}

export interface GetWellnessArgs {
  profile?: string;
  from?: string;
  to?: string;
  days: number;
  rawKinds?: WellnessKind[];
}

export async function getWellness(args: GetWellnessArgs) {
  if (getSettings().mock) return MOCK;
  const store = getStore(), name = dataProfile(args.profile), today = localToday(store, name);
  const to = args.to ?? today, from = args.from ?? addDays(to, -(args.days - 1));
  if (from > to) throw new Error("from is after to.");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) throw new Error(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  if (args.rawKinds?.length && from !== to) throw new Error("rawKinds returns Garmin's full responses, so ask for one day (from = to).");

  const connected = garminConnected(name);
  const refreshed = connected && to >= addDays(today, -RECENT_DAYS) ? await refreshWellness(name) : { fetched: 0, busy: false, error: null };
  const background = connected ? startBackgroundWellness(name) : { started: false };
  const range = wellnessRange(store, name, from, to);
  const days = withScaleWeighIns(store, name, from, to, range.days);
  const { baselines } = range;
  const raw = args.rawKinds?.length ? Object.fromEntries(args.rawKinds.map((k) => [k, store.wellness.get(name, from, k)])) : undefined;
  return {
    profile: name,
    from,
    to,
    baselines,
    body: bodyRange(store, name, from, to).body,
    days: days.reverse(),
    ...(raw && { raw }),
    sync: syncNote(name, refreshed.error, background, connected),
  };
}

export function registerWellnessTools(server: McpServer): void {
  server.registerTool(
    "get_readiness",
    {
      title: "Get readiness for a day's workout",
      description:
        "How recovered the person is on a day (today by default), as a band for that day's workout: \"go-harder\", \"as-planned\" or \"back-off\", with a 0-100 score, the signals behind it (last night's HRV against Garmin's baseline band, resting heart rate against their own 28-day normal, sleep length and score against the sleep needed, Body Battery on waking, yesterday's stress, and the load of the last days from session RPE and duration, and from Garmin's all-day intensity minutes, which include effort nobody recorded as an activity), what is missing, and a suggestion. Use it before planning or adjusting a day's workout: push a little when recovered, ease off when not. Each signal says why it scored as it did, so explain the call to the user rather than just repeating the band. It is a heuristic, not medical advice. Reads the database; Garmin is asked only for the last days' sleep, HRV, daily summary and weigh-in, and the last 60 days of everything fill in the background (see `sync`).",
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
