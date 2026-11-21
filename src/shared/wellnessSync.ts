import { COOL_OFF_MS, LEASE_MS, LeaseLost, MAX_RATE_LIMIT_RETRIES, isRateLimit, stopsSync } from "./activitySync";
import { type SqliteStore, WELLNESS_KINDS, type WellnessKind } from "./store";

export interface WellnessSource {
  fetch(kind: WellnessKind, day: string): Promise<unknown>;
}

export const BACKFILL_DAYS = 60;
export const RECENT_DAYS = 3;
export const FINAL_AFTER_MS = 2 * 86_400_000;
export const TODAY_MANUAL_MS = 60_000;
export const TODAY_AUTO_MS = 5 * 60_000;
export const EARLIER_MS = 30 * 60_000;
export type Ask = "manual" | "auto" | "missing";
export const refreshMs = (day: string, today: string, ask: Exclude<Ask, "missing"> = "auto"): number =>
  day !== today ? EARLIER_MS : ask === "manual" ? TODAY_MANUAL_MS : TODAY_AUTO_MS;
const DAY_MS = 86_400_000;
const DEFAULT_GAP_MS = 500;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hasNothing = (error: unknown) => /\((404|400)\)/.test(message(error));

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function isRealDay(text: unknown): text is string {
  const ms = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === text;
}

export function localToday(store: SqliteStore, profile: string, now = Date.now()): string {
  const tz = process.env.GARMIN_TZ || process.env.TZ;
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    } catch {
    }
  }
  return new Date(now + (store.activities.localOffsetMinutes(profile) ?? 0) * 60_000).toISOString().slice(0, 10);
}

export interface Wanted {
  day: string;
  kind: WellnessKind;
}

export function wanted(store: SqliteStore, profile: string, today: string, days = BACKFILL_DAYS, kinds: readonly WellnessKind[] = WELLNESS_KINDS, now = Date.now(), ask: Ask = "auto"): Wanted[] {
  const have = store.wellness.fetchedAt(profile, addDays(today, -(days - 1)), today);
  const out: Wanted[] = [];
  for (const kind of kinds) {
    for (let i = 0; i < days; i++) {
      const day = addDays(today, -i), at = have.get(`${day}|${kind}`);
      const stale = at !== undefined && at - Date.parse(`${day}T00:00:00Z`) < FINAL_AFTER_MS && now - at > refreshMs(day, today, ask === "manual" ? "manual" : "auto");
      if (at === undefined || (stale && ask !== "missing")) out.push({ day, kind });
    }
  }
  return out;
}

export interface WellnessSyncOptions {
  today: string;
  days?: number;
  kinds?: readonly WellnessKind[];
  limit?: number;
  renew?: () => boolean;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
  manual?: boolean;
}

export async function syncWellness(store: SqliteStore, profile: string, source: WellnessSource, options: WellnessSyncOptions): Promise<{ fetched: number; failed: number; stopped: string | null }> {
  const table = store.wellness, now = options.now ?? Date.now(), sleep = options.sleep ?? sleepFor;
  const todo = wanted(store, profile, options.today, options.days, options.kinds, now, options.manual ? "manual" : "auto").slice(0, options.limit ?? Infinity);
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
        failed++;
      }
    }
    const gap = options.gapMs ?? DEFAULT_GAP_MS;
    if (i < todo.length - 1 && gap > 0) await sleep(gap);
  }
  if (fetched > 0) table.saveProgress(profile, { error: null, retryAfter: null });
  return { fetched, failed, stopped: null };
}

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

export const isWellnessBackfilling = (store: SqliteStore, profile: string): boolean => running.has(runKey(store, profile));

export interface WellnessBackfillOptions {
  holder: string;
  today: string;
  days?: number;
  now?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => void;
  attempt?: number;
}

const unrefTimer = (fn: () => void, ms: number) => void setTimeout(fn, ms).unref();

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
  cooldownMs: number;
  pending: number;
  syncing: boolean;
  error: string | null;
}

export function wellnessStatus(store: SqliteStore, profile: string, today: string, now = Date.now(), days = BACKFILL_DAYS): WellnessStatus {
  const counts = store.wellness.counts(profile), state = store.wellness.state(profile);
  const lastAsked = Math.max(0, ...store.wellness.fetchedAt(profile, today, today).values());
  return {
    days: counts.days,
    rows: counts.rows,
    oldest: counts.oldest,
    newest: counts.newest,
    cooldownMs: lastAsked ? Math.min(TODAY_MANUAL_MS, Math.max(0, lastAsked + TODAY_MANUAL_MS - now)) : 0,
    pending: wanted(store, profile, today, days, undefined, now, "missing").length,
    syncing: !!state.holder && (state.leaseUntil ?? 0) > now,
    error: state.error,
  };
}
