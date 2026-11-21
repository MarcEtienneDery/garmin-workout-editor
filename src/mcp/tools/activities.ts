import { getLastNWeeksStart } from "../../activityExporter";
import { lapIntervals } from "../../shared/activityChart";
import { type ActivitySource, COOL_OFF_MS, LeaseLost, SETTLE_MS, isBackfilling, startBackfill, syncCharts, syncDetails, syncList, syncStatus, withLease, type SyncStatus } from "../../shared/activitySync";
import { getStore } from "../../shared/store";
import { garminConnected } from "../../shared/profileLoader";
import { type Session, dataProfile, getDataExporter, getSession, getSettings, requireAuth, runCaptured } from "../context";

const PROCESS = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
let operations = 0;
export const holder = () => `${PROCESS}:${++operations}`;
const INLINE_DETAILS = 30;
const INLINE_CHARTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const detailGapMs = (): number | undefined => (process.env.GARMIN_DETAIL_GAP_MS ? Number(process.env.GARMIN_DETAIL_GAP_MS) : undefined);

export async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const outcome = await runCaptured(fn);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function sourceFor(session: Session): ActivitySource {
  const client = () => session.garminClient.getClientAny();
  let signedIn = false;
  const ready = async () => {
    if (!signedIn) {
      await locked(() => requireAuth(session));
      signedIn = true;
    }
  };
  return {
    async listPage(offset, limit) {
      await ready();
      return locked(async () => (await client().getActivities(offset, limit)) ?? []);
    },
    async fetchDetail({ id, type }) {
      await ready();
      return locked(async () => {
        const details = await client().getActivity({ activityId: id });
        let fullExerciseSets: unknown;
        if (type === "strength_training") {
          await sleep(200);
          try {
            fullExerciseSets = await session.garminClient.getActivityExerciseSets(id);
          } catch {
          }
        }
        return { ...details, ...(fullExerciseSets !== undefined && { fullExerciseSets }) };
      });
    },
    async fetchChart({ id }) {
      await ready();
      const details = await locked(() => session.garminClient.getActivityDetails(id));
      const optional = async (call: () => Promise<unknown>) => {
        await sleep(detailGapMs() ?? 300);
        try {
          return await locked(call as () => Promise<any>);
        } catch (error) {
          if (/\((404|400)\)/.test(errorText(error))) return undefined;
          throw error;
        }
      };
      const splits = await optional(() => session.garminClient.getActivitySplits(id));
      const zones = await optional(() => session.garminClient.getActivityHrZones(id));
      return { details, splits, zones };
    },
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function refreshActivities(profile?: string): Promise<{ added: number; busy: boolean; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (isBackfilling(store, name)) return { added: 0, busy: true, error: null };
  try {
    const leased = await withLease(store, name, holder(), (renew) => syncList(store, name, sourceFor(session), { renew }));
    return leased.ok ? { added: leased.value.added, busy: false, error: null } : { added: 0, busy: true, error: null };
  } catch (error) {
    if (error instanceof LeaseLost) return { added: 0, busy: true, error: null };
    store.activities.saveProgress(name, { error: errorText(error), retryAfter: Date.now() + COOL_OFF_MS });
    return { added: 0, busy: false, error: errorText(error) };
  }
}

export async function fetchDetailsNow(profile: string | undefined, ids: string[], limit = INLINE_DETAILS): Promise<{ fetched: number; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (!ids.length || isBackfilling(store, name)) return { fetched: 0, error: null };
  try {
    const leased = await withLease(store, name, holder(), (renew) => syncDetails(store, name, sourceFor(session), { ids, limit, renew, gapMs: detailGapMs() }));
    if (!leased.ok) return { fetched: 0, error: null };
    return { fetched: leased.value.fetched, error: leased.value.stopped };
  } catch (error) {
    return { fetched: 0, error: error instanceof LeaseLost ? null : errorText(error) };
  }
}

export async function fetchChartNow(profile: string | undefined, id: string): Promise<{ fetched: number; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (isBackfilling(store, name)) return { fetched: 0, error: null };
  try {
    const leased = await withLease(store, name, holder(), (renew) => syncCharts(store, name, sourceFor(session), { ids: [id], limit: 1, renew, gapMs: detailGapMs() }));
    if (!leased.ok) return { fetched: 0, error: null };
    return { fetched: leased.value.fetched, error: leased.value.stopped };
  } catch (error) {
    return { fetched: 0, error: error instanceof LeaseLost ? null : errorText(error) };
  }
}

export function startBackgroundSync(profile?: string): { started: boolean; reason?: string } {
  const session = getSession(profile);
  if (session.mock) return { started: false, reason: "Mock mode." };
  const { started, reason } = startBackfill(getStore(), session.profile.name, sourceFor(session), { holder: holder(), gapMs: detailGapMs() });
  return { started, reason };
}

export function activitySyncStatus(profile?: string): SyncStatus {
  return syncStatus(getStore(), dataProfile(profile));
}


export type ActivityPeriod = "last-week" | "this-week" | "last-4-weeks" | "all";

export interface GetActivitiesArgs {
  profile?: string;
  limit: number;
  period: ActivityPeriod;
  weekStart?: string;
  weekEnd?: string;
  type?: string;
  includeDetails: boolean;
}

const gmtText = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const DAY_MS = 86_400_000;

function rangeFor(args: GetActivitiesArgs): { from?: string; to?: string } {
  const startOf = (isoDay: string) => Date.parse(`${isoDay}T00:00:00Z`);
  const customStart = args.weekStart ?? (args.weekEnd ? "1970-01-01" : undefined);
  let from: number | undefined;
  if (customStart) from = startOf(customStart) - DAY_MS;
  else if (args.period === "last-4-weeks") from = startOf(getLastNWeeksStart(4)) - DAY_MS;
  else if (args.period === "last-week") from = Date.now() - 15 * DAY_MS;
  else if (args.period === "this-week") from = Date.now() - 8 * DAY_MS;
  const to = args.weekEnd ? startOf(args.weekEnd) + 2 * DAY_MS : undefined;
  return { from: from === undefined ? undefined : gmtText(new Date(from)), to: to === undefined ? undefined : gmtText(new Date(to)) };
}

export async function getActivities(args: GetActivitiesArgs) {
  const options = {
    filterToLastWeek: !args.weekStart && !args.weekEnd && args.period === "last-week",
    filterToThisWeek: !args.weekStart && !args.weekEnd && args.period === "this-week",
    typeFilter: args.type,
    customWeekStart: args.weekStart ?? (args.weekEnd ? "1970-01-01" : args.period === "last-4-weeks" ? getLastNWeeksStart(4) : args.period === "all" ? "1970-01-01" : undefined),
    customWeekEnd: args.weekEnd,
  };

  if (getSettings().mock) {
    const session = getSession(args.profile);
    const raw = await session.exporter.fetchActivities(args.limit, args.includeDetails);
    if (raw.length === 0) throw new Error("No mock activities.");
    return { ...session.exporter.buildExtractedActivities(raw, options), mock: true };
  }

  const store = getStore(), name = dataProfile(args.profile), exporter = getDataExporter();
  const connected = garminConnected(name);
  const refreshed = connected ? await refreshActivities(name) : { added: 0, busy: false, error: null };
  const range = rangeFor(args);
  const inRange = () => store.activities.between(name, { ...range, type: args.type });
  let rows = inRange();

  let detailsError: string | null = null;
  if (args.includeDetails) {
    const lacking = new Set(store.activities.needingDetail(name, { settleMs: SETTLE_MS }).map((r) => r.id));
    const ids = rows.filter((r) => lacking.has(r.id)).map((r) => r.id);
    const got = connected ? await fetchDetailsNow(name, ids) : { fetched: 0, error: null };
    detailsError = got.error;
    if (got.fetched > 0) rows = inRange();
  }

  const raw = rows.map((r) => ({ ...r.raw, ...(r.detail ?? {}) }));
  const data = exporter.buildExtractedActivities(raw, options);
  const total = data.activities.length;
  const shown = data.activities.slice(0, args.limit);
  const runs = shown.filter((a: any) => a.activityType === "running").map((a: any) => String(a.id));
  if (connected && args.includeDetails && runs.length) {
    for (const { id } of store.activities.needingChart(name, { ids: runs, limit: INLINE_CHARTS })) await fetchChartNow(name, id);
  }
  const activities = shown.map((a: any) => {
    if (a.activityType !== "running") return a;
    const laps = lapIntervals(store.activities.getChart(name, String(a.id)));
    return laps.length ? { ...a, exerciseSets: laps } : a;
  });
  const background = connected ? startBackgroundSync(name) : { started: false };

  const sync = connected ? activitySyncStatus(name) : { ...activitySyncStatus(name), pendingDetails: 0, pendingCharts: 0, syncing: false, error: null };
  return {
    ...data,
    totalActivities: activities.length,
    total,
    truncated: total > activities.length,
    activities,
    sync: {
      ...sync,
      added: refreshed.added,
      ...(refreshed.error || detailsError ? { error: refreshed.error ?? detailsError } : {}),
      ...(connected ? {} : { garmin: "not connected" }),
      note: !connected
        ? `Profile "${name}" has no Garmin login, so these are only the activities already stored.`
        : sync.syncing || background.started
          ? "The rest of the history and of the details is being stored in the background; ask again later for more."
          : sync.error
            ? "The last sync stopped early; it resumes on the next call."
            : undefined,
    },
  };
}
