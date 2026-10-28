/**
 * accounts.ts — what the Settings view does with a profile's logins: the Garmin login and the Renpho login with its sync
 * settings (both optional, kept in the database), and the password of the profile's own sign-in to the web editor (which is
 * not optional). What it tells a browser never includes a password, only that one is set.
 */
import { GOALS, getGoals } from "./nutritionGoals";
import { garminLogin } from "./profileLoader";
import { INTERVAL_HOURS, MAX_PROFILE_NAME, type Measurement, type RenphoSettings, SealKeyError, type SqliteStore, isProfileName, sealing } from "./store";
import { isRealDay, localToday } from "./wellnessSync";

/** A request the person can fix: the message is for them. */
export class SettingsError extends Error {}

const EMAIL = /^\S+@\S+\.\S+$/;
export const MIN_WEB_PASSWORD = 8;

function checkEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim() : "";
  if (!EMAIL.test(value)) throw new SettingsError("Enter the account's email address.");
  return value;
}

// ── Garmin ──

export interface GarminAccount {
  /** A Garmin login is saved: the profile can sync and send workouts. Without one the app works without Garmin. */
  connected: boolean;
  email: string | null;
  hasPassword: boolean;
}

export function garminAccount(profile: string): GarminAccount & { error?: string } {
  try {
    const saved = garminLogin(profile);
    return { connected: !!saved, email: saved?.email ?? null, hasPassword: !!saved };
  } catch (error) {
    if (!(error instanceof SealKeyError)) throw error;
    return { connected: true, email: null, hasPassword: true, error: error.message };
  }
}

/** The Garmin login saved now, or null (also when it is encrypted and cannot be read). */
function savedLogin(profile: string) {
  try {
    return garminLogin(profile);
  } catch {
    return null;
  }
}

/** Save the Garmin login. A blank password keeps the one saved; the first save needs one. */
export function saveGarminLogin(store: SqliteStore, profile: string, input: { email?: unknown; password?: unknown }): void {
  const email = checkEmail(input.email);
  const typed = typeof input.password === "string" ? input.password : "";
  const before = savedLogin(profile);
  const password = typed || (before && before.email === email ? before.password : "");
  if (!password) throw new SettingsError("Enter the password.");
  store.credentials.put(profile, "garmin", email, password);
  if (!before || before.email !== email || before.password !== password) store.tokens.delete(profile); // the session that was open belongs to the old login: the next sign-in, and the test, must try this one
}

/**
 * Forget the Garmin login and its session. What was synced stays, and the profile goes on without Garmin: uploading weigh-ins to
 * it is switched off, as there is nothing to upload to, and the error or wait the last sync left is forgotten, as none will run.
 */
export function removeGarminLogin(store: SqliteStore, profile: string, now = Date.now()): void {
  store.credentials.delete(profile, "garmin");
  store.tokens.delete(profile);
  store.wellness.saveProgress(profile, { error: null, retryAfter: null }, now);
  store.activities.saveProgress(profile, { error: null, retryAfter: null }, now);
  if (store.renpho.settings(profile).pushEnabled) {
    store.renpho.saveSettings(profile, { pushEnabled: false });
    store.renpho.log(profile, "info", "Upload to Garmin switched off: the Garmin login was removed.", now);
  }
}

/** Whether a Garmin login is saved (one that cannot be decrypted is there). */
function hasGarminLogin(store: SqliteStore, profile: string): boolean {
  try {
    return store.credentials.get(profile, "garmin") !== null;
  } catch (error) {
    if (error instanceof SealKeyError) return true;
    throw error;
  }
}

// ── Web sign-in ──

/**
 * The password of a profile's own sign-in to the web editor, typed twice. It is mandatory (a profile has one from the day it is made,
 * and Settings cannot remove it), so a short one, an empty one and two fields that differ are all refused. The words are the ones the
 * page uses before it asks (settingsModel.js passwordProblem), so the person reads the same thing either way.
 */
export function checkWebPassword(password: unknown, confirm: unknown): string {
  const typed = typeof password === "string" ? password : "";
  if (!typed) throw new SettingsError("Enter a password.");
  if (typed.length < MIN_WEB_PASSWORD) throw new SettingsError(`The password is at least ${MIN_WEB_PASSWORD} characters.`);
  if (typed !== confirm) throw new SettingsError("The two passwords are not the same.");
  return typed;
}

/** Set or change the password the profile signs in to the web editor with (the admin token needs none of this). */
export function saveWebPassword(store: SqliteStore, profile: string, input: { password?: unknown; confirm?: unknown }): void {
  store.profiles.setWebPassword(profile, checkWebPassword(input.password, input.confirm));
}

/** Add a profile: a name and its web sign-in password, typed twice. Garmin and Renpho are optional and connected afterwards. */
export function createProfile(store: SqliteStore, input: { name?: unknown; password?: unknown; confirm?: unknown }): string {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!isProfileName(name)) throw new SettingsError(`A profile name is letters, numbers, hyphens and underscores, at most ${MAX_PROFILE_NAME}.`);
  const password = checkWebPassword(input.password, input.confirm);
  store.profiles.create(name, password);
  return name;
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
    if (input.pushSince !== null && input.pushSince !== "" && !isRealDay(input.pushSince)) throw new SettingsError("The upload start day is a date.");
    change.pushSince = input.pushSince ? (input.pushSince as string) : null;
  }
  if (input.pushEnabled !== undefined) {
    change.pushEnabled = input.pushEnabled === true;
    if (change.pushEnabled && !hasGarminLogin(store, profile)) throw new SettingsError("Connect Garmin first: the weigh-ins are uploaded to a Garmin account.");
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
    web: { hasPassword: store.profiles.webPasswordHash(profile) !== null },
    // the daily food goals by key, and what each can be set for (label, unit, whether it is a floor, a ceiling or an aim)
    goals: { values: getGoals(store, profile), fields: GOALS.map(({ max: _max, ...field }) => field) },
    renpho: renphoView(store, profile, now),
    // whether the saved passwords are encrypted (CREDENTIALS_KEY), and how many are not
    encryption: { enabled: sealing(), plain: store.credentials.plainCount() },
  };
}
