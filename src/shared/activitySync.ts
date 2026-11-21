import { type ChartResponses, pruneChart } from "./activityChart";
import { normalizeActivityType } from "./activityType";
import type { NewActivity, SqliteStore } from "./store";

export interface ActivitySource {
  listPage(offset: number, limit: number): Promise<any[]>;
  fetchDetail(activity: { id: string; type: string }): Promise<Record<string, unknown>>;
  fetchChart?(activity: { id: string; type: string }): Promise<ChartResponses>;
}

export const PAGE_SIZE = 100;
const OVERLAP = 20;
export const SETTLE_MS = 3 * 86_400_000;
export const LEASE_MS = 3 * 60_000;
export const COOL_OFF_MS = 10 * 60_000;
const DETAIL_GAP_MS = 500;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const stopsSync = (error: unknown) => /\((429|401|403)\)|too many requests|authenticat/i.test(message(error));
export const isRateLimit = (error: unknown) => /\(429\)|too many requests/i.test(message(error));
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
  renew?: () => boolean;
}

export async function syncList(store: SqliteStore, profile: string, source: ActivitySource, options: Pace = {}): Promise<{ added: number; pages: number; complete: boolean }> {
  const before = store.activities.state(profile);
  const result = await listActivities(store, profile, source, options);
  if (before.error) store.activities.saveProgress(profile, { error: null });
  if (result.complete && !before.complete) retireActivityDocuments(store, profile);
  return result;
}

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
    return fresh < items.length;
  };

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
  limit?: number;
  ids?: string[];
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

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

export async function syncCharts(store: SqliteStore, profile: string, source: ActivitySource, options: DetailOptions = {}): Promise<{ fetched: number; failed: number; stopped: string | null }> {
  const table = store.activities, fetchChart = source.fetchChart?.bind(source);
  if (!fetchChart) return { fetched: 0, failed: 0, stopped: null };
  const wanted = table.needingChart(profile, { limit: options.limit, ids: options.ids });
  const sleep = options.sleep ?? sleepFor;
  let fetched = 0, failed = 0;
  for (let i = 0; i < wanted.length; i++) {
    if (options.renew && !options.renew()) throw new LeaseLost();
    const { id, type } = wanted[i];
    try {
      const responses = await fetchChart({ id, type });
      if (!responses || typeof responses !== "object") throw new Error("Garmin returned no chart data");
      table.setChart(profile, id, pruneChart(responses));
      fetched++;
    } catch (error) {
      if (stopsSync(error)) {
        table.saveProgress(profile, { error: message(error), retryAfter: Date.now() + COOL_OFF_MS });
        return { fetched, failed, stopped: message(error) };
      }
      table.noteChartFailure(profile, id);
      failed++;
    }
    if (i < wanted.length - 1) await sleep(options.gapMs ?? DETAIL_GAP_MS);
  }
  return { fetched, failed, stopped: null };
}

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

export const isBackfilling = (store: SqliteStore, profile: string): boolean => running.has(runKey(store, profile));

export interface BackfillOptions {
  holder: string;
  now?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => void;
  attempt?: number;
}

export const MAX_RATE_LIMIT_RETRIES = 12;
const unrefTimer = (fn: () => void, ms: number) => void setTimeout(fn, ms).unref();

export function startBackfill(store: SqliteStore, profile: string, source: ActivitySource, options: BackfillOptions): { started: boolean; reason?: string; done: Promise<void> } {
  const table = store.activities, key = runKey(store, profile), now = options.now ?? Date.now(), attempt = options.attempt ?? 0;
  const no = (reason: string) => ({ started: false, reason, done: running.get(key) ?? Promise.resolve() });
  if (running.has(key)) return no("A sync is already running.");
  const state = table.state(profile);
  const chartsLeft = () => (source.fetchChart ? table.needingChart(profile, { limit: 1 }).length : 0);
  if (state.complete && table.needingDetail(profile, { limit: 1, settleMs: SETTLE_MS }).length === 0 && chartsLeft() === 0) return no("Everything is stored.");
  if (state.retryAfter !== null && now < state.retryAfter) return no(`Waiting after: ${state.error ?? "an error"}`);
  if (!table.claim(profile, options.holder, LEASE_MS, now)) return no("Another process is syncing.");

  const renew = () => table.renew(profile, options.holder, LEASE_MS);
  let rateLimited = false;
  const done = (async () => {
    try {
      await syncList(store, profile, source, { renew });
      let result = await syncDetails(store, profile, source, { renew, gapMs: options.gapMs, sleep: options.sleep });
      if (!result.stopped) result = await syncCharts(store, profile, source, { renew, gapMs: options.gapMs, sleep: options.sleep });
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
  withCharts: number;
  pendingDetails: number;
  pendingCharts: number;
  historyComplete: boolean;
  syncing: boolean;
  error: string | null;
  newest: string | null;
  oldest: string | null;
}

export function syncStatus(store: SqliteStore, profile: string, now = Date.now()): SyncStatus {
  const table = store.activities, counts = table.counts(profile), state = table.state(profile);
  return {
    activities: counts.total,
    withDetails: counts.withDetail,
    withCharts: counts.withChart,
    pendingDetails: table.needingDetail(profile, { settleMs: SETTLE_MS }).length,
    pendingCharts: table.needingChart(profile).length,
    historyComplete: state.complete,
    syncing: !!state.holder && (state.leaseUntil ?? 0) > now,
    error: state.error,
    newest: counts.newest,
    oldest: counts.oldest,
  };
}
