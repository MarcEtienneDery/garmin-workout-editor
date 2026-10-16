/**
 * activitySync.ts — keep a profile's Garmin activities in the database (the `activities` table, see store/activities.ts).
 *
 * An activity is written once and rarely changes, so nothing stored is fetched again, except the details of an
 * activity that is still young, because RPE and feel are entered after the workout.
 *
 *   syncList     the list of activities, 100 a call. The first run pages back through the whole history and remembers
 *                where it got to, so an interrupted run resumes; once the history is complete, a run pages from the
 *                newest until it meets an activity it has (usually one call).
 *   syncDetails  the details (and strength sets) of the activities that lack them, newest first, one call each.
 *   startBackfill  runs both in the background until everything is stored.
 *
 * Garmin is reached through an ActivitySource, which serializes each call with the other Garmin work, so a long
 * backfill never holds the account for more than one call. The MCP server and the web editor are separate
 * processes: a lease in the database keeps them from syncing at once (each operation takes its own holder name, so
 * two in one process exclude each other too). A rate limit or a login failure stops the job and is recorded; the next
 * run picks up where this one stopped, and after a rate limit (never after a login failure, which could lock the
 * account) the job starts again by itself once the cool-off is over.
 */
import { normalizeActivityType } from "./activityType";
import type { NewActivity, SqliteStore } from "./store";

export interface ActivitySource {
  /** One page of Garmin's activity list, newest first; empty past the end of the history. */
  listPage(offset: number, limit: number): Promise<any[]>;
  /** The details of one activity, including its exercise sets when it is a strength workout. */
  fetchDetail(activity: { id: string; type: string }): Promise<Record<string, unknown>>;
}

export const PAGE_SIZE = 100;
/** A resumed listing starts this far back, so an activity added or removed since the last run cannot leave a gap. */
const OVERLAP = 20;
/** Details fetched less than this after an activity started are fetched again later: feel and RPE are entered afterwards. */
export const SETTLE_MS = 3 * 86_400_000;
export const LEASE_MS = 3 * 60_000;
/** After a rate limit or a login failure, a background sync waits this long before it tries again. */
export const COOL_OFF_MS = 10 * 60_000;
const DETAIL_GAP_MS = 500;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Errors that mean Garmin will refuse the next call too: rate limits and login problems. */
const stopsSync = (error: unknown) => /\((429|401|403)\)|too many requests|authenticat/i.test(message(error));
/** Only a rate limit goes away by waiting; a login failure is not retried on its own, as repeated logins can lock the account. */
export const isRateLimit = (error: unknown) => /\(429\)|too many requests/i.test(message(error));
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A row for the table from one item of Garmin's list; null when it lacks an id or a start time. */
export function toNewActivity(item: any): NewActivity | null {
  const startGmt = text(item?.startTimeGMT) ?? text(item?.startTimeLocal);
  if (item?.activityId === undefined || item?.activityId === null || !startGmt) return null;
  return {
    id: String(item.activityId),
    startGmt,
    startLocal: text(item.startTimeLocal) ?? startGmt,
    type: normalizeActivityType(item.activityType?.typeKey ?? (typeof item.activityType === "string" ? item.activityType : undefined)),
    name: text(item.activityName) ?? "Unknown Activity",
    duration: number(item.duration),
    distance: number(item.distance),
    avgHr: number(item.averageHR),
    workoutId: item.workoutId ? String(item.workoutId) : null,
    raw: item,
  };
}

export class LeaseLost extends Error {
  constructor() {
    super("Another process took over the activity sync.");
  }
}

interface Pace {
  /** Returns false when the lease was lost. */
  renew?: () => boolean;
}

/**
 * List the activities Garmin has and the table has not. It always starts at the newest end and pages back until a
 * page holds an activity it already has: everything older is stored too, if the history is complete. While it is
 * not (the first run, or one that was interrupted), it goes on from where the last run stopped, a little further
 * back, to the end of the history, and then records that the history is complete.
 */
export async function syncList(store: SqliteStore, profile: string, source: ActivitySource, options: Pace = {}): Promise<{ added: number; pages: number; complete: boolean }> {
  const before = store.activities.state(profile);
  const result = await listActivities(store, profile, source, options);
  if (before.error) store.activities.saveProgress(profile, { error: null }); // Garmin answered: whatever stopped the last sync is over
  if (result.complete && !before.complete) retireActivityDocuments(store, profile); // once: a document restored later is left alone
  return result;
}

/**
 * Activities used to be saved as documents (data/<profile>/activities.json and its variants), overwritten on each
 * fetch. Once the table holds the whole history those are stale copies, so they are deleted; like any deleted
 * document they stay restorable from the trash.
 */
export function retireActivityDocuments(store: SqliteStore, profile: string): string[] {
  const gone: string[] = [];
  for (const meta of store.list("data/")) {
    const m = /^data\/([^/]+)\/activities[^/]*\.json$/i.exec(meta.path);
    if (!m || m[1].toLowerCase() !== profile.toLowerCase()) continue;
    store.remove(meta.path, { source: "activity-sync" });
    gone.push(meta.path);
  }
  return gone;
}

async function listActivities(store: SqliteStore, profile: string, source: ActivitySource, options: Pace): Promise<{ added: number; pages: number; complete: boolean }> {
  const table = store.activities, state = table.state(profile);
  let added = 0, pages = 0;
  const page = async (offset: number) => {
    if (options.renew && !options.renew()) throw new LeaseLost();
    pages++;
    return source.listPage(offset, PAGE_SIZE);
  };
  const keep = (list: any[]) => {
    const items = list.map(toNewActivity).filter((a): a is NewActivity => a !== null);
    const fresh = table.insertNew(profile, items);
    added += fresh;
    return fresh < items.length; // true: it held an activity we had
  };

  // The newest end. New activities push the older ones back, so the place a resumed listing stopped moves with them.
  let offset = 0;
  for (;;) {
    const list = await page(offset);
    if (list.length === 0) {
      if (!state.complete) table.saveProgress(profile, { complete: true, nextOffset: offset });
      return { added, pages, complete: true };
    }
    const met = keep(list);
    offset += list.length;
    if (!state.complete) table.saveProgress(profile, { nextOffset: Math.max(offset, state.nextOffset + added) });
    if (met) break;
  }
  if (state.complete) return { added, pages, complete: true };

  // The rest of the history, from a little before where the last run stopped.
  offset = Math.max(0, Math.max(offset, state.nextOffset + added) - OVERLAP);
  for (;;) {
    const list = await page(offset);
    if (list.length === 0) break;
    keep(list);
    offset += list.length;
    table.saveProgress(profile, { nextOffset: offset });
  }
  table.saveProgress(profile, { complete: true, nextOffset: offset });
  return { added, pages, complete: true };
}

export interface DetailOptions extends Pace {
  /** Only this many, the newest first. */
  limit?: number;
  /** Only these activities. */
  ids?: string[];
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fetch the details that are missing (or may still change). Stops, and records why, on a rate limit or a login failure. */
export async function syncDetails(store: SqliteStore, profile: string, source: ActivitySource, options: DetailOptions = {}): Promise<{ fetched: number; failed: number; stopped: string | null }> {
  const table = store.activities;
  const wanted = table.needingDetail(profile, { limit: options.limit, settleMs: SETTLE_MS, ids: options.ids });
  const sleep = options.sleep ?? sleepFor;
  let fetched = 0, failed = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (options.renew && !options.renew()) throw new LeaseLost();
    const { id, type } = wanted[i];
    try {
      const detail = await source.fetchDetail({ id, type });
      if (!detail || typeof detail !== "object") throw new Error("Garmin returned no details");
      table.setDetail(profile, id, detail);
      fetched++;
    } catch (error) {
      if (stopsSync(error)) {
        table.saveProgress(profile, { error: message(error), retryAfter: Date.now() + COOL_OFF_MS });
        return { fetched, failed, stopped: message(error) };
      }
      table.noteDetailFailure(profile, id);
      failed++;
    }
    if (i < wanted.length - 1) await sleep(options.gapMs ?? DETAIL_GAP_MS);
  }
  return { fetched, failed, stopped: null };
}

/** Hold the profile's sync lease while fn runs. ok: false when another process holds it. */
export async function withLease<T>(store: SqliteStore, profile: string, holder: string, fn: (renew: () => boolean) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const table = store.activities;
  if (!table.claim(profile, holder, LEASE_MS)) return { ok: false };
  try {
    return { ok: true, value: await fn(() => table.renew(profile, holder, LEASE_MS)) };
  } finally {
    table.release(profile, holder);
  }
}

const running = new Map<string, Promise<void>>();
const runKey = (store: SqliteStore, profile: string) => `${store.location}|${profile}`;

/** Is a background sync of this profile running in this process? */
export const isBackfilling = (store: SqliteStore, profile: string): boolean => running.has(runKey(store, profile));

export interface BackfillOptions {
  holder: string;
  now?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Run fn after ms; the default is a timer that does not keep the process alive. */
  schedule?: (fn: () => void, ms: number) => void;
  /** How many times in a row the job has been started again after a rate limit. */
  attempt?: number;
}

/** After a rate limit, the job starts again by itself this many times at most. */
export const MAX_RATE_LIMIT_RETRIES = 12;
const unrefTimer = (fn: () => void, ms: number) => void setTimeout(fn, ms).unref();

/**
 * Store the whole history and every activity's details in the background. Returns at once; `done` settles when
 * the job ends. started is false when there is nothing to do, a sync is running (here or in another process), or
 * the last one stopped on an error less than COOL_OFF_MS ago. After a rate limit it starts again by itself.
 */
export function startBackfill(store: SqliteStore, profile: string, source: ActivitySource, options: BackfillOptions): { started: boolean; reason?: string; done: Promise<void> } {
  const table = store.activities, key = runKey(store, profile), now = options.now ?? Date.now(), attempt = options.attempt ?? 0;
  const no = (reason: string) => ({ started: false, reason, done: running.get(key) ?? Promise.resolve() });
  if (running.has(key)) return no("A sync is already running.");
  const state = table.state(profile);
  if (state.complete && table.needingDetail(profile, { limit: 1, settleMs: SETTLE_MS }).length === 0) return no("Everything is stored.");
  if (state.retryAfter !== null && now < state.retryAfter) return no(`Waiting after: ${state.error ?? "an error"}`);
  if (!table.claim(profile, options.holder, LEASE_MS, now)) return no("Another process is syncing.");

  const renew = () => table.renew(profile, options.holder, LEASE_MS);
  let rateLimited = false;
  const done = (async () => {
    try {
      await syncList(store, profile, source, { renew });
      const result = await syncDetails(store, profile, source, { renew, gapMs: options.gapMs, sleep: options.sleep });
      if (!result.stopped) table.saveProgress(profile, { error: null, retryAfter: null });
      else rateLimited = isRateLimit(result.stopped);
    } catch (error) {
      if (!(error instanceof LeaseLost)) {
        table.saveProgress(profile, { error: message(error), retryAfter: Date.now() + COOL_OFF_MS });
        rateLimited = isRateLimit(error);
      }
    } finally {
      table.release(profile, options.holder);
      running.delete(key);
    }
    if (rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
      (options.schedule ?? unrefTimer)(() => {
        try {
          startBackfill(store, profile, source, { ...options, now: undefined, attempt: attempt + 1 });
        } catch {
          // the database is closed (the process is shutting down)
        }
      }, COOL_OFF_MS + 1000);
    }
  })();
  running.set(key, done);
  return { started: true, done };
}

export interface SyncStatus {
  activities: number;
  withDetails: number;
  /** Activities whose details are missing or may still change. */
  pendingDetails: number;
  /** Is the whole history listed? */
  historyComplete: boolean;
  syncing: boolean;
  /** Why the last sync stopped early. */
  error: string | null;
  newest: string | null;
  oldest: string | null;
}

export function syncStatus(store: SqliteStore, profile: string, now = Date.now()): SyncStatus {
  const table = store.activities, counts = table.counts(profile), state = table.state(profile);
  return {
    activities: counts.total,
    withDetails: counts.withDetail,
    pendingDetails: table.needingDetail(profile, { settleMs: SETTLE_MS }).length,
    historyComplete: state.complete,
    syncing: !!state.holder && (state.leaseUntil ?? 0) > now,
    error: state.error,
    newest: counts.newest,
    oldest: counts.oldest,
  };
}
