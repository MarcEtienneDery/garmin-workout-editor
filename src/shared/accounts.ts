/**
 * accounts.ts — what the Settings view does with a profile's logins: the Garmin login (kept in the database, which comes
 * before the profile's .env file) and the Renpho login with its sync settings. What it tells a browser never includes a
 * password, only that one is set.
 */
import { fileLogin, storedLogin } from "./profileLoader";
import { INTERVAL_HOURS, type Measurement, type RenphoSettings, SealKeyError, type SqliteStore, sealing } from "./store";
import { localToday } from "./wellnessSync";

/** A request the person can fix: the message is for them. */
export class SettingsError extends Error {}

const EMAIL = /^\S+@\S+\.\S+$/;

function checkEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim() : "";
  if (!EMAIL.test(value)) throw new SettingsError("Enter the account's email address.");
  return value;
}

// ── Garmin ──

export interface GarminAccount {
  /** Where the login in use comes from: the database (this view), the profile's .env file, or nowhere. */
  source: "settings" | "file" | null;
  email: string | null;
  hasPassword: boolean;
  /** The .env file holds a login too, to move into the database. */
  fileHasLogin: boolean;
}

export function garminAccount(profile: string): GarminAccount & { error?: string } {
  const file = fileLogin(profile);
  try {
    const saved = storedLogin(profile), use = saved ?? file;
    return { source: saved ? "settings" : file ? "file" : null, email: use?.email ?? null, hasPassword: !!use?.password, fileHasLogin: !!file };
  } catch (error) {
    if (!(error instanceof SealKeyError)) throw error;
    return { source: "settings", email: null, hasPassword: true, fileHasLogin: !!file, error: error.message };
  }
}

/** Save the Garmin login. A blank password keeps the one saved; the first save (from the .env file's login) needs one. */
export function saveGarminLogin(store: SqliteStore, profile: string, input: { email?: unknown; password?: unknown }): void {
  const email = checkEmail(input.email);
  const typed = typeof input.password === "string" ? input.password : "";
  const current = typed ? null : (storedLogin(profile) ?? fileLogin(profile)); // only looked at when the password is kept
  const password = typed || (current && current.email === email ? current.password : "");
  if (!password) throw new SettingsError("Enter the password.");
  const before = effectiveLogin(profile);
  store.credentials.put(profile, "garmin", email, password);
  if (!before || before.email !== email || before.password !== password) store.tokens.delete(profile); // the session that was open belongs to the old login: the next sign-in, and the test, must try this one
}

/** The Garmin login in use now, or null (also when it is encrypted and cannot be read). */
function effectiveLogin(profile: string) {
  try {
    return storedLogin(profile) ?? fileLogin(profile);
  } catch {
    return null;
  }
}

/** Take the .env file's Garmin login into the database (the file is left as it is; the login in the database wins from now on). */
export function moveGarminLoginFromFile(store: SqliteStore, profile: string): void {
  const file = fileLogin(profile);
  if (!file) throw new SettingsError("The profile's .env file holds no Garmin login.");
  store.credentials.put(profile, "garmin", file.email, file.password);
}

/** Forget the login saved in the database, so the .env file's is used again. Refused when there is none to fall back on. */
export function removeGarminLogin(store: SqliteStore, profile: string): void {
  const file = fileLogin(profile);
  if (!file) throw new SettingsError("This is the profile's only Garmin login: replace it instead of removing it.");
  const before = effectiveLogin(profile);
  store.credentials.delete(profile, "garmin");
  if (!before || before.email !== file.email || before.password !== file.password) store.tokens.delete(profile);
}

// ── Renpho ──

export interface RenphoSettingsInput {
  email?: unknown;
  password?: unknown;
  areaCode?: unknown;
  fetchEnabled?: unknown;
  pushEnabled?: unknown;
  pushSince?: unknown;
  intervalHours?: unknown;
}

const AREA = /^[A-Za-z]{2,3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Save the Renpho login and settings (each given field; a blank password keeps the one saved). */
export function saveRenpho(store: SqliteStore, profile: string, input: RenphoSettingsInput, now = Date.now()): void {
  const saved = store.credentials.get(profile, "renpho");
  const change: Partial<RenphoSettings> = {};
  if (input.areaCode !== undefined) {
    const area = typeof input.areaCode === "string" ? input.areaCode.trim().toUpperCase() : "";
    if (!AREA.test(area)) throw new SettingsError("The area code is two or three letters, such as US or CA.");
    change.areaCode = area;
  }
  if (input.intervalHours !== undefined) {
    const hours = Number(input.intervalHours);
    if (!(INTERVAL_HOURS as readonly number[]).includes(hours)) throw new SettingsError(`Check every ${INTERVAL_HOURS.join(", ")} hours.`);
    change.intervalHours = hours;
  }
  if (input.fetchEnabled !== undefined) change.fetchEnabled = input.fetchEnabled === true;
  if (input.pushSince !== undefined) {
    if (input.pushSince !== null && input.pushSince !== "" && !(typeof input.pushSince === "string" && DAY.test(input.pushSince))) throw new SettingsError("The upload start day is a date.");
    change.pushSince = input.pushSince ? (input.pushSince as string) : null;
  }
  if (input.pushEnabled !== undefined) {
    change.pushEnabled = input.pushEnabled === true;
    // switching the upload on starts from today, unless a day was chosen: the scale's whole history is not sent by surprise
    if (change.pushEnabled && change.pushSince === undefined && !store.renpho.settings(profile).pushSince) change.pushSince = localToday(store, profile, now);
  }
  const wantsLogin = input.email !== undefined || (typeof input.password === "string" && input.password !== "");
  if (wantsLogin) {
    const email = checkEmail(input.email ?? saved?.email);
    const typed = typeof input.password === "string" ? input.password : "";
    const password = typed || (saved && saved.email === email ? saved.password : "");
    if (!password) throw new SettingsError("Enter the password.");
    store.credentials.put(profile, "renpho", email, password, now);
    store.renpho.saveState(profile, { error: null, errorKind: null, nextRunAt: null }, now); // a new login is worth another try
    store.renpho.log(profile, "info", "Renpho login saved.", now);
  }
  if ((change.fetchEnabled || change.pushEnabled) && !store.credentials.get(profile, "renpho")) throw new SettingsError("Save the Renpho login first.");
  store.renpho.saveSettings(profile, change);
  if (change.fetchEnabled !== undefined) store.renpho.log(profile, "info", change.fetchEnabled ? "Fetching from Renpho switched on." : "Fetching from Renpho switched off.", now);
  if (change.pushEnabled !== undefined) store.renpho.log(profile, "info", change.pushEnabled ? `Upload to Garmin switched on${change.pushSince ? ` (weigh-ins from ${change.pushSince})` : ""}.` : "Upload to Garmin switched off.", now);
}

/** Forget the Renpho login and switch the sync off; the weigh-ins already kept stay. */
export function removeRenpho(store: SqliteStore, profile: string, now = Date.now()): void {
  store.credentials.delete(profile, "renpho");
  store.renpho.saveSettings(profile, { fetchEnabled: false, pushEnabled: false });
  store.renpho.saveState(profile, { error: null, errorKind: null, nextRunAt: null }, now);
  store.renpho.log(profile, "info", "Renpho login removed; the sync is off.", now);
}

/** The numbers of a weigh-in the Settings view lists, as Renpho sent them (to check against the app). */
const SHOWN = ["weight", "bodyfat", "water", "muscle", "bone", "bmi", "visfat", "bodyage", "bmr", "weightUnit"] as const;

const slim = (m: Measurement) => ({
  id: m.id,
  measuredAt: m.measuredAt,
  day: m.day,
  fields: Object.fromEntries(SHOWN.map((k) => [k, typeof m.data[k] === "number" || typeof m.data[k] === "string" ? m.data[k] : null])),
  pushedAt: m.pushedAt,
  pushError: m.pushError,
});

/** The Renpho half of the Settings view: the login (never its password), the settings, how the runs go, the weigh-ins kept and the log. */
export function renphoView(store: SqliteStore, profile: string, now = Date.now()) {
  let account: { email: string; hasPassword: true } | null = null, error: string | undefined;
  try {
    const credential = store.credentials.get(profile, "renpho");
    account = credential ? { email: credential.email, hasPassword: true } : null;
  } catch (e) {
    if (!(e instanceof SealKeyError)) throw e;
    error = e.message;
    account = { email: "", hasPassword: true };
  }
  const { holder, leaseUntil, ...state } = store.renpho.state(profile);
  return {
    account,
    ...(error ? { accountError: error } : {}),
    settings: store.renpho.settings(profile),
    state: { ...state, running: !!(holder && (leaseUntil ?? 0) > now) },
    counts: store.renpho.counts(profile),
    recent: store.renpho.measurements(profile, { limit: 12 }).map(slim),
    log: store.renpho.logLines(profile, 60),
    intervals: INTERVAL_HOURS,
  };
}

/** Everything the Settings view shows for a profile. */
export function settingsView(store: SqliteStore, profile: string, now = Date.now()) {
  return {
    profile,
    garmin: garminAccount(profile),
    renpho: renphoView(store, profile, now),
    // whether the saved passwords are encrypted (CREDENTIALS_KEY), and how many are not
    encryption: { enabled: sealing(), plain: store.credentials.plainCount() },
  };
}
