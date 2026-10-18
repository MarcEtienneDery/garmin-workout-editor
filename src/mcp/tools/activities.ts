/**
 * The activities tools' side of the activity store: Garmin as an ActivitySource, a refresh that lists what is new,
 * and the answer to get_activities, read from the database. The sync itself is shared/activitySync.ts.
 */
import { getLastNWeeksStart } from "../../activityExporter";
import { type ActivitySource, COOL_OFF_MS, LeaseLost, SETTLE_MS, isBackfilling, startBackfill, syncCharts, syncDetails, syncList, syncStatus, withLease, type SyncStatus } from "../../shared/activitySync";
import { getStore } from "../../shared/store";
import { type Session, getSession, requireAuth, runCaptured } from "../context";

/**
 * Names the one that syncs, in the lease the MCP server and the web editor share. Every operation takes a name of its
 * own: get_activities calls overlap, and two that shared a name would release each other's lease.
 */
const PROCESS = `${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
let operations = 0;
export const holder = () => `${PROCESS}:${++operations}`;
/** Activities whose details a get_activities call fetches itself; the rest fill in the background. */
const INLINE_DETAILS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Pause between two detail calls (GARMIN_DETAIL_GAP_MS; the default of the sync, 500 ms, is gentle on Garmin's rate limit). */
export const detailGapMs = (): number | undefined => (process.env.GARMIN_DETAIL_GAP_MS ? Number(process.env.GARMIN_DETAIL_GAP_MS) : undefined);

/** Run one Garmin call alone, queued with the rest of the Garmin work, and give back its value or throw its error. */
export async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const outcome = await runCaptured(fn);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Garmin, one call at a time, signed in on first use. */
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
            // the summarized sets in the details stay
          }
        }
        return { ...details, ...(fullExerciseSets !== undefined && { fullExerciseSets }) };
      });
    },
    async fetchChart({ id }) {
      await ready();
      // each call has the Garmin lock to itself, with a pause between them: the laps and the zones are optional
      const details = await locked(() => session.garminClient.getActivityDetails(id));
      // Only "there is no such thing for this activity" (a 404 or a 400) leaves a part out. Anything else (a 500, a timeout,
      // a dropped connection) throws, so the activity counts a failure and is tried again: a chart that is stored is never fetched again.
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

/** Add the activities Garmin has and the table lacks. Never throws: a failure comes back as `error`, and the table still answers. */
export async function refreshActivities(profile?: string): Promise<{ added: number; busy: boolean; error: string | null }> {
  const session = getSession(profile), store = getStore(), name = session.profile.name;
  if (isBackfilling(store, name)) return { added: 0, busy: true, error: null }; // the background job is listing already
  try {
    const leased = await withLease(store, name, holder(), (renew) => syncList(store, name, sourceFor(session), { renew }));
    return leased.ok ? { added: leased.value.added, busy: false, error: null } : { added: 0, busy: true, error: null };
  } catch (error) {
    if (error instanceof LeaseLost) return { added: 0, busy: true, error: null };
    store.activities.saveProgress(name, { error: errorText(error), retryAfter: Date.now() + COOL_OFF_MS });
    return { added: 0, busy: false, error: errorText(error) };
  }
}

/** Fetch the details of these activities now (at most `limit`), unless a background sync is already filling them in. */
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

/** Fetch the chart data of one activity now, unless a background sync is already filling the charts in. */
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

/** Keep filling the table in the background: the whole history, then every activity's details. A no-op when all is stored. */
export function startBackgroundSync(profile?: string): { started: boolean; reason?: string } {
  const session = getSession(profile);
  if (session.mock) return { started: false, reason: "Mock mode." };
  const { started, reason } = startBackfill(getStore(), session.profile.name, sourceFor(session), { holder: holder(), gapMs: detailGapMs() });
  return { started, reason };
}

export function activitySyncStatus(profile?: string): SyncStatus {
  return syncStatus(getStore(), getSession(profile).profile.name);
}

// ── get_activities ──

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

/** A generous range in the table's GMT strings for the period; the exporter's own filters then cut it exactly. */
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

/**
 * The profile's activities for a period in the slim planning format, read from the database. Garmin is asked only
 * for what is new (a page of the list) and for the details of the activities returned that lack them; the rest of the
 * history and of the details fills in the background.
 */
export async function getActivities(args: GetActivitiesArgs) {
  const session = getSession(args.profile);
  const options = {
    filterToLastWeek: !args.weekStart && !args.weekEnd && args.period === "last-week",
    filterToThisWeek: !args.weekStart && !args.weekEnd && args.period === "this-week",
    typeFilter: args.type,
    customWeekStart: args.weekStart ?? (args.weekEnd ? "1970-01-01" : args.period === "last-4-weeks" ? getLastNWeeksStart(4) : args.period === "all" ? "1970-01-01" : undefined),
    customWeekEnd: args.weekEnd,
  };

  if (session.mock) {
    // Mock mode answers with generated activities and keeps nothing: the database holds only what Garmin returned.
    const raw = await session.exporter.fetchActivities(args.limit, args.includeDetails);
    if (raw.length === 0) throw new Error("No mock activities.");
    return { ...session.exporter.buildExtractedActivities(raw, options), mock: true };
  }

  const store = getStore(), name = session.profile.name;
  const refreshed = await refreshActivities(args.profile);
  const range = rangeFor(args);
  const inRange = () => store.activities.between(name, { ...range, type: args.type });
  let rows = inRange();

  let detailsError: string | null = null;
  if (args.includeDetails) {
    const lacking = new Set(store.activities.needingDetail(name, { settleMs: SETTLE_MS }).map((r) => r.id));
    const ids = rows.filter((r) => lacking.has(r.id)).map((r) => r.id);
    const got = await fetchDetailsNow(args.profile, ids);
    detailsError = got.error;
    if (got.fetched > 0) rows = inRange();
  }

  const raw = rows.map((r) => ({ ...r.raw, ...(r.detail ?? {}) }));
  const data = session.exporter.buildExtractedActivities(raw, options);
  const total = data.activities.length;
  const activities = data.activities.slice(0, args.limit);
  const background = startBackgroundSync(args.profile);

  const sync = activitySyncStatus(args.profile);
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
      note: sync.syncing || background.started
        ? "The rest of the history and of the details is being stored in the background; ask again later for more."
        : sync.error
          ? "The last sync stopped early; it resumes on the next call."
          : undefined,
    },
  };
}
