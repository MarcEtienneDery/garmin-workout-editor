/**
 * renphoSync.ts — the run that brings the Renpho scale's weigh-ins into the database and, when it is switched on, to Garmin.
 *
 * A run: take the lease (one run per profile, across both processes), sign in to Renpho, read every weigh-in of the
 * account's scales, keep the new ones in the ledger as Renpho sent them (`renpho_measurements`), then upload the ones
 * that are not on Garmin yet as one FIT file and mark them. A weigh-in is uploaded once. Garmin is reached through the
 * `push` the caller passes (this file does not know Garmin); a run without one only fetches.
 *
 * What goes wrong is told, never retried in a loop: a refused login stops the schedule until the login is saved or
 * tested again, a rate limit waits hours, and every step leaves a line in the log the Settings view shows.
 */
import { RenphoClient, RenphoError } from "./renphoClient";
import { type WeighIn, toWeighIn, weighInsToFit } from "./renphoFit";
import type { Measurement, RenphoSettings, SqliteStore } from "./store";
import { localToday } from "./wellnessSync";

const LEASE_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** Garmin has had this long to take an uploaded file in before the day's weigh-in is read from it again. */
export const SETTLE_MS = 10 * 60_000;
/** Weigh-ins per uploaded file. */
const FILE_SIZE = 100;
/** How long a rate limit holds the schedule back. */
const RATE_WAIT_MS = 6 * HOUR_MS;

/** Upload a FIT file to Garmin; resolves with a few words on how Garmin took it, rejects when it did not. */
export type RenphoPush = (fit: Uint8Array, weighIns: number) => Promise<string>;

export interface RenphoRunOptions {
  holder: string;
  /** A run asked for by a person: it goes ahead while the schedule is off and after a refused login. */
  manual?: boolean;
  push?: RenphoPush;
  fetch?: typeof fetch;
  now?: number;
}

export interface RenphoRun {
  ran: boolean;
  /** Why it did not run. */
  reason?: string;
  /** Weigh-ins Renpho holds for the account, how many of them are new, and how many are other people's on the same scale. */
  seen: number;
  added: number;
  others: number;
  uploaded: number;
  error: string | null;
}

const none = (reason: string): RenphoRun => ({ ran: false, reason, seen: 0, added: 0, others: 0, uploaded: 0, error: null });
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The weigh-ins of a ledger, as the FIT file takes them; those Renpho gave no weight for are left out. */
const weighInsOf = (ledger: Measurement[]): { m: Measurement; w: WeighIn }[] =>
  ledger.flatMap((m) => {
    const w = toWeighIn(m.data);
    return w ? [{ m, w }] : [];
  });

/** The FIT file of the newest `count` weigh-ins of the ledger, for trying an import by hand; null when there are none. */
export function recentFit(store: SqliteStore, profile: string, count: number): { bytes: Uint8Array; weighIns: number } | null {
  const usable = weighInsOf(store.renpho.measurements(profile, { limit: Math.max(1, count) }));
  return usable.length ? { bytes: weighInsToFit(usable.map((u) => u.w)), weighIns: usable.length } : null;
}

/** Sign in to Renpho and say how it went (it also clears an earlier refusal, so the schedule may run again when it works). */
export async function testRenphoLogin(store: SqliteStore, profile: string, fetchFn?: typeof fetch, now = Date.now()): Promise<{ ok: boolean; message: string }> {
  const credential = store.credentials.get(profile, "renpho");
  if (!credential) return { ok: false, message: "No Renpho login is saved." };
  const client = new RenphoClient(credential.email, credential.password, store.renpho.settings(profile).areaCode, fetchFn);
  try {
    await client.login();
    const tables = await client.scaleTables();
    store.renpho.saveState(profile, { error: null, errorKind: null }, now);
    store.renpho.log(profile, "info", `Login test: Renpho accepted the login, ${tables.length} scale table${tables.length === 1 ? "" : "s"}.`, now);
    return { ok: true, message: `Renpho accepted the login (${tables.length} scale table${tables.length === 1 ? "" : "s"} on the account).` };
  } catch (error) {
    const message = text(error);
    store.renpho.log(profile, "error", `Login test failed: ${message}`, now);
    if (error instanceof RenphoError && error.kind === "login") store.renpho.saveState(profile, { error: message, errorKind: "login", nextRunAt: null }, now);
    return { ok: false, message };
  }
}

/** The profiles whose scheduled run is due: switched on, not stopped by a refused login, and past their next run. */
export function dueProfiles(store: SqliteStore, now = Date.now()): string[] {
  return store.renpho.enabledProfiles().filter((p) => {
    const state = store.renpho.state(p);
    return state.errorKind !== "login" && (state.nextRunAt ?? 0) <= now && !(state.holder && (state.leaseUntil ?? 0) > now);
  });
}

/** One run for a profile. Never throws: what went wrong is in the result, the log and the state. */
export async function syncRenpho(store: SqliteStore, profile: string, options: RenphoRunOptions): Promise<RenphoRun> {
  const now = options.now ?? Date.now();
  const credential = store.credentials.get(profile, "renpho");
  if (!credential) return none("No Renpho login is saved.");
  const settings = store.renpho.settings(profile);
  if (!settings.fetchEnabled && !options.manual) return none("Fetching from Renpho is switched off.");
  if (!options.manual && store.renpho.state(profile).errorKind === "login") return none("Renpho refused the login; save the login again or test it.");
  if (!store.renpho.claim(profile, options.holder, LEASE_MS, now)) return none("A run is already going.");

  const log = store.renpho.log.bind(store.renpho, profile);
  const run: RenphoRun = { ran: true, seen: 0, added: 0, others: 0, uploaded: 0, error: null };
  const intervalMs = settings.intervalHours * HOUR_MS;
  try {
    store.renpho.saveState(profile, { lastRunAt: now }, now);
    log("info", options.manual ? "Run started by hand." : "Scheduled run started.", now);
    try {
      await fetchFromRenpho(store, profile, credential, settings, run, options, now);
      store.renpho.saveState(profile, { lastOkAt: now, nextRunAt: now + intervalMs, error: null, errorKind: null }, now);
    } catch (error) {
      run.error = text(error);
      const kind = error instanceof RenphoError && error.kind === "login" ? "login" : "other";
      const wait = error instanceof RenphoError && error.kind === "rate" ? RATE_WAIT_MS : intervalMs;
      store.renpho.saveState(profile, { error: run.error, errorKind: kind, nextRunAt: kind === "login" ? null : now + wait }, now);
      log("error", kind === "login" ? `${run.error} The scheduled runs stop until the login is saved or tested again.` : run.error, now);
      return run;
    }
    rereadSettledDays(store, profile, now);
    if (settings.pushEnabled) {
      if (!options.push) log("warn", "Upload to Garmin is on, but this run cannot reach Garmin.", now);
      else await upload(store, profile, settings, options.push, run, now);
    }
    return run;
  } finally {
    store.renpho.release(profile, options.holder);
  }
}

async function fetchFromRenpho(store: SqliteStore, profile: string, credential: { email: string; password: string }, settings: RenphoSettings, run: RenphoRun, options: RenphoRunOptions, now: number): Promise<void> {
  const client = new RenphoClient(credential.email, credential.password, settings.areaCode, options.fetch);
  const tables = await client.scaleTables();
  const log = store.renpho.log.bind(store.renpho, profile);
  for (const table of tables) {
    const { rows, complete } = await client.measurements(table);
    if (!complete) log("warn", `Stopped reading table ${table.tableName} at the page limit: older weigh-ins are not kept.`, now);
    if (!rows.length && table.count > 0) log("warn", `Renpho counts ${table.count} weigh-ins in table ${table.tableName} but returned none (the app's protocol may have changed).`, now);
    for (const row of rows) {
      const id = row.id === undefined || row.id === null ? "" : String(row.id), seconds = Number(row.timeStamp);
      if (!id || !Number.isFinite(seconds) || seconds <= 0) continue;
      if (String(row.bUserId) !== client.userId) { run.others++; continue; }
      run.seen++;
      const measuredAt = seconds * 1000;
      if (store.renpho.addMeasurement(profile, { id, measuredAt, day: localToday(store, profile, measuredAt), data: row })) run.added++;
    }
  }
  log("info", `Renpho holds ${run.seen} weigh-in${run.seen === 1 ? "" : "s"} of this account${run.others ? ` (and ${run.others} of other people on the scale, left out)` : ""}; ${run.added} new.`, now);
}

/** The days uploaded a while ago: forget Garmin's stored (empty) answer for their weigh-in, so the Weight view reads it again. */
function rereadSettledDays(store: SqliteStore, profile: string, now: number): void {
  const { days, ids } = store.renpho.daysToReread(profile, now - SETTLE_MS);
  if (!ids.length) return;
  for (const day of days) store.wellness.forget(profile, day, "weight");
  store.renpho.markReread(profile, ids, now);
}

async function upload(store: SqliteStore, profile: string, settings: RenphoSettings, push: RenphoPush, run: RenphoRun, now: number): Promise<void> {
  const log = store.renpho.log.bind(store.renpho, profile);
  const pending = store.renpho.measurements(profile, { pending: true, sinceDay: settings.pushSince ?? undefined });
  const usable = weighInsOf(pending);
  for (const m of pending) if (!usable.some((u) => u.m.id === m.id)) store.renpho.markFailed(profile, [m.id], "Renpho gave no weight for this weigh-in.");
  if (!usable.length) return log("info", "Nothing to upload to Garmin.", now);
  for (let i = 0; i < usable.length; i += FILE_SIZE) {
    const chunk = usable.slice(i, i + FILE_SIZE), ids = chunk.map((u) => u.m.id);
    try {
      const said = await push(weighInsToFit(chunk.map((u) => u.w)), chunk.length);
      store.renpho.markPushed(profile, ids, now);
      run.uploaded += chunk.length;
      log("info", `Uploaded ${chunk.length} weigh-in${chunk.length === 1 ? "" : "s"} to Garmin${said ? `: ${said}` : ""}.`, now);
    } catch (error) {
      const message = text(error);
      store.renpho.markFailed(profile, ids, message);
      run.error = `Upload to Garmin failed: ${message}`;
      store.renpho.saveState(profile, { error: run.error, errorKind: "other" }, now);
      log("error", run.error, now);
      return;
    }
  }
}
