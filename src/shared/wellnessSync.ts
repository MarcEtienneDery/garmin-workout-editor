/**
 * wellnessSync.ts — keep a profile's daily health data in the database (the `wellness` table, see store/wellness.ts).
 *
 * One Garmin call per day and kind, newest day first, the kinds a daily check reads (the day's summary, sleep, HRV)
 * before the series (heart rate, stress, Body Battery, respiration, SpO2), so a sync that stops half way, on a rate
 * limit, still leaves what the check needs. A day's data keeps changing until the watch has synced and the day is over, so
 * a response fetched less than FINAL_AFTER_MS after its day began is fetched again (at most every REFRESH_MS); older
 * responses are final, and so are the empty ones. Like the activity sync it stops, and records why, on a rate limit or a
 * login failure; a lease keeps the two processes from syncing at once; after a rate limit (never after a login failure)
 * the background job starts again by itself once the cool-off is over.
 */
import { COOL_OFF_MS, LEASE_MS, LeaseLost, MAX_RATE_LIMIT_RETRIES, isRateLimit, stopsSync } from "./activitySync";
import { type SqliteStore, WELLNESS_KINDS, type WellnessKind } from "./store";

export interface WellnessSource {
  /** Garmin's response for one kind and one day (YYYY-MM-DD, the user's local day). */
  fetch(kind: WellnessKind, day: string): Promise<unknown>;
}

export const BACKFILL_DAYS = 60;
/** A response fetched less than this after its day began may still change. */
export const FINAL_AFTER_MS = 2 * 86_400_000;
/** A response that may still change is fetched again no sooner than this after the last time. */
export const REFRESH_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_GAP_MS = 500;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Garmin has no such thing for the day (a 404 or a 400): that is an answer, stored as nothing. */
const hasNothing = (error: unknown) => /\((404|400)\)/.test(message(error));

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The user's calendar day now: in the zone of GARMIN_TZ (or TZ) when one is set, else by the offset the newest activity
 * shows (the container runs in UTC), else in UTC. A wrong guess around midnight is corrected by the refetching of the last days.
 */
export function localToday(store: SqliteStore, profile: string, now = Date.now()): string {
  const tz = process.env.GARMIN_TZ || process.env.TZ;
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    } catch {
      // not a zone name: fall through
    }
  }
  return new Date(now + (store.activities.localOffsetMinutes(profile) ?? 0) * 60_000).toISOString().slice(0, 10);
}

export interface Wanted {
  day: string;
  kind: WellnessKind;
}

/** The responses to fetch: the ones missing, and the ones that may still have changed. Kinds in order, then the newest day first. */
export function wanted(store: SqliteStore, profile: string, today: string, days = BACKFILL_DAYS, kinds: readonly WellnessKind[] = WELLNESS_KINDS, now = Date.now(), staleMs = REFRESH_MS): Wanted[] {
  const have = store.wellness.fetchedAt(profile, addDays(today, -(days - 1)), today);
  const out: Wanted[] = [];
  for (const kind of kinds) {
    for (let i = 0; i < days; i++) {
      const day = addDays(today, -i), at = have.get(`${day}|${kind}`);
      const stale = at !== undefined && at - Date.parse(`${day}T00:00:00Z`) < FINAL_AFTER_MS && now - at > staleMs;
      if (at === undefined || stale) out.push({ day, kind });
    }
  }
  return out;
}

export interface WellnessSyncOptions {
  today: string;
  days?: number;
  kinds?: readonly WellnessKind[];
  /** Only this many responses. */
  limit?: number;
  /** Returns false when the lease was lost. */
  renew?: () => boolean;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
  /** Fetch a response that may still change again after this long (REFRESH_MS by default). */
  staleMs?: number;
}

/** Fetch the responses that are missing or may have changed. Stops, and records why, on a rate limit or a login failure. */
export async function syncWellness(store: SqliteStore, profile: string, source: WellnessSource, options: WellnessSyncOptions): Promise<{ fetched: number; failed: number; stopped: string | null }> {
  const table = store.wellness, now = options.now ?? Date.now(), sleep = options.sleep ?? sleepFor;
  const todo = wanted(store, profile, options.today, options.days, options.kinds, now, options.staleMs).slice(0, options.limit ?? Infinity);
  let fetched = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    if (options.renew && !options.renew()) throw new LeaseLost();
    const { day, kind } = todo[i];
    try {
      table.put(profile, day, kind, await source.fetch(kind, day), options.now ?? Date.now());
      fetched++;
    } catch (error) {
      if (hasNothing(error)) {
        table.put(profile, day, kind, null, options.now ?? Date.now());
        fetched++;
      } else if (stopsSync(error)) {
        table.saveProgress(profile, { error: message(error), retryAfter: Date.now() + COOL_OFF_MS });
        return { fetched, failed, stopped: message(error) };
      } else {
        failed++; // not stored: the next sync asks again
      }
    }
    const gap = options.gapMs ?? DEFAULT_GAP_MS;
    if (i < todo.length - 1 && gap > 0) await sleep(gap);
  }
  if (fetched > 0) table.saveProgress(profile, { error: null, retryAfter: null });
  return { fetched, failed, stopped: null };
}

/** Hold the profile's wellness lease while fn runs. ok: false when another process holds it. */
export async function withWellnessLease<T>(store: SqliteStore, profile: string, holder: string, fn: (renew: () => boolean) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const table = store.wellness;
  if (!table.claim(profile, holder, LEASE_MS)) return { ok: false };
  try {
    return { ok: true, value: await fn(() => table.renew(profile, holder, LEASE_MS)) };
  } finally {
    table.release(profile, holder);
  }
}

const running = new Map<string, Promise<void>>();
const runKey = (store: SqliteStore, profile: string) => `${store.location}|${profile}`;

/** Is a background wellness sync of this profile running in this process? */
export const isWellnessBackfilling = (store: SqliteStore, profile: string): boolean => running.has(runKey(store, profile));

export interface WellnessBackfillOptions {
  holder: string;
  today: string;
  days?: number;
  now?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Run fn after ms; the default is a timer that does not keep the process alive. */
  schedule?: (fn: () => void, ms: number) => void;
  attempt?: number;
}

const unrefTimer = (fn: () => void, ms: number) => void setTimeout(fn, ms).unref();

/**
 * Store the last BACKFILL_DAYS days in the background. Returns at once; `done` settles when the job ends. started is false
 * when there is nothing to do, a sync is running (here or in another process), or Garmin said to wait (a rate limit of the
 * wellness sync or of the activity sync: the limit is the account's).
 */
export function startWellnessBackfill(store: SqliteStore, profile: string, source: WellnessSource, options: WellnessBackfillOptions): { started: boolean; reason?: string; done: Promise<void> } {
  const table = store.wellness, key = runKey(store, profile), now = options.now ?? Date.now(), attempt = options.attempt ?? 0;
  const no = (reason: string) => ({ started: false, reason, done: running.get(key) ?? Promise.resolve() });
  if (running.has(key)) return no("A sync is already running.");
  if (wanted(store, profile, options.today, options.days, undefined, now).length === 0) return no("Everything is stored.");
  const state = table.state(profile), waitUntil = Math.max(state.retryAfter ?? 0, store.activities.state(profile).retryAfter ?? 0);
  if (now < waitUntil) return no(`Waiting after: ${state.error ?? store.activities.state(profile).error ?? "an error"}`);
  if (!table.claim(profile, options.holder, LEASE_MS, now)) return no("Another process is syncing.");

  let rateLimited = false;
  const done = (async () => {
    try {
      const result = await syncWellness(store, profile, source, { today: options.today, days: options.days, renew: () => table.renew(profile, options.holder, LEASE_MS), gapMs: options.gapMs, sleep: options.sleep, now: options.now });
      if (result.stopped) rateLimited = isRateLimit(result.stopped);
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
          startWellnessBackfill(store, profile, source, { ...options, now: undefined, attempt: attempt + 1 });
        } catch {
          // the database is closed (the process is shutting down)
        }
      }, COOL_OFF_MS + 1000);
    }
  })();
  running.set(key, done);
  return { started: true, done };
}

export interface WellnessStatus {
  days: number;
  rows: number;
  oldest: string | null;
  newest: string | null;
  /** Responses still to fetch of the days kept (BACKFILL_DAYS unless asked otherwise). */
  pending: number;
  syncing: boolean;
  error: string | null;
}

export function wellnessStatus(store: SqliteStore, profile: string, today: string, now = Date.now(), days = BACKFILL_DAYS): WellnessStatus {
  const counts = store.wellness.counts(profile), state = store.wellness.state(profile);
  return {
    days: counts.days,
    rows: counts.rows,
    oldest: counts.oldest,
    newest: counts.newest,
    pending: wanted(store, profile, today, days, undefined, now).length,
    syncing: !!state.holder && (state.leaseUntil ?? 0) > now,
    error: state.error,
  };
}
