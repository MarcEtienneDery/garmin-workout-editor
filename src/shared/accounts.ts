import { SETTING_FIELDS, getGoals } from "./nutritionGoals";
import { garminLogin } from "./profileLoader";
import { INTERVAL_HOURS, InviteError, type Invite, MAX_INVITE_USES, MAX_NOTE, MAX_PROFILE_NAME, type Measurement, type Prefs, type RenphoSettings, SealKeyError, type SqliteStore, WEIGHT_UNITS, isProfileName, normalizeCode, sealing } from "./store";
import { isRealDay, localToday } from "./wellnessSync";

export class SettingsError extends Error {}

const EMAIL = /^\S+@\S+\.\S+$/;
export const MIN_WEB_PASSWORD = 8;

function checkEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim() : "";
  if (!EMAIL.test(value)) throw new SettingsError("Enter the account's email address.");
  return value;
}


export interface GarminAccount {
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

function savedLogin(profile: string) {
  try {
    return garminLogin(profile);
  } catch {
    return null;
  }
}

export function saveGarminLogin(store: SqliteStore, profile: string, input: { email?: unknown; password?: unknown }): void {
  const email = checkEmail(input.email);
  const typed = typeof input.password === "string" ? input.password : "";
  const before = savedLogin(profile);
  const password = typed || (before && before.email === email ? before.password : "");
  if (!password) throw new SettingsError("Enter the password.");
  store.credentials.put(profile, "garmin", email, password);
  if (!before || before.email !== email || before.password !== password) { store.tokens.delete(profile); store.limits.clear(profile); }
}

export function removeGarminLogin(store: SqliteStore, profile: string, now = Date.now()): void {
  store.credentials.delete(profile, "garmin");
  store.tokens.delete(profile);
  store.limits.clear(profile);
  store.wellness.saveProgress(profile, { error: null, retryAfter: null }, now);
  store.activities.saveProgress(profile, { error: null, retryAfter: null }, now);
  if (store.renpho.settings(profile).pushEnabled) {
    store.renpho.saveSettings(profile, { pushEnabled: false });
    store.renpho.log(profile, "info", "Upload to Garmin switched off: the Garmin login was removed.", now);
  }
}

function hasGarminLogin(store: SqliteStore, profile: string): boolean {
  try {
    return store.credentials.get(profile, "garmin") !== null;
  } catch (error) {
    if (error instanceof SealKeyError) return true;
    throw error;
  }
}


export function checkWebPassword(password: unknown, confirm: unknown): string {
  const typed = typeof password === "string" ? password : "";
  if (!typed) throw new SettingsError("Enter a password.");
  if (typed.length < MIN_WEB_PASSWORD) throw new SettingsError(`The password is at least ${MIN_WEB_PASSWORD} characters.`);
  if (typed !== confirm) throw new SettingsError("The two passwords are not the same.");
  return typed;
}

export function saveWebPassword(store: SqliteStore, profile: string, input: { password?: unknown; confirm?: unknown }): void {
  store.profiles.setWebPassword(profile, checkWebPassword(input.password, input.confirm));
}

export function createProfile(store: SqliteStore, input: { name?: unknown; password?: unknown; confirm?: unknown }): string {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!isProfileName(name)) throw new SettingsError(`A profile name is letters, numbers, hyphens and underscores, at most ${MAX_PROFILE_NAME}.`);
  const password = checkWebPassword(input.password, input.confirm);
  store.profiles.create(name, password);
  return name;
}


export function publicMcpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const text = (env.MCP_PUBLIC_URL ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return (url.origin + url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export const createMcpToken = (store: SqliteStore, profile: string, now = Date.now()): string => store.mcpTokens.create(profile, now);

export const mcpView = (store: SqliteStore, profile: string) => ({ url: publicMcpUrl(), token: store.mcpTokens.info(profile) });


export const profileTaken = (store: SqliteStore, name: string): string | undefined => {
  const wanted = name.trim().toLowerCase();
  return wanted ? store.profiles.names().find((p) => p.toLowerCase() === wanted) : undefined;
};

export const MAX_INVITE_DAYS = 365;

export function createInvite(store: SqliteStore, input: { note?: unknown; maxUses?: unknown; days?: unknown }, now = Date.now()): string {
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_NOTE) throw new SettingsError(`The note is at most ${MAX_NOTE} characters.`);
  const maxUses = input.maxUses === undefined || input.maxUses === null || input.maxUses === "" ? 1 : Number(input.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_INVITE_USES) throw new SettingsError(`An invite can be used by 1 to ${MAX_INVITE_USES} people.`);
  const never = input.days === null || input.days === 0 || input.days === "0" || input.days === "never";
  const days = input.days === undefined || input.days === "" ? 7 : Number(input.days);
  if (!never && (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS)) throw new SettingsError(`An invite lasts 1 to ${MAX_INVITE_DAYS} days, or never expires.`);
  try {
    return store.invites.create({ note, maxUses, expiresAt: never ? null : now + days * 86_400_000 }, now);
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error));
  }
}

export const inviteList = (store: SqliteStore, now = Date.now()): Invite[] => store.invites.list(now);

export function signUp(store: SqliteStore, input: { code?: unknown; name?: unknown; password?: unknown; confirm?: unknown }, now = Date.now()): string {
  const status = store.invites.check(input.code, now);
  if (status !== "active") throw new InviteError(status);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!isProfileName(name)) throw new SettingsError(`A profile name is letters, numbers, hyphens and underscores, at most ${MAX_PROFILE_NAME}.`);
  const password = checkWebPassword(input.password, input.confirm);
  return store.transaction(() => {
    const taken = profileTaken(store, name);
    if (taken) throw new SettingsError(`The name ${taken} is taken. Choose another.`);
    store.profiles.create(name, password, now);
    store.profiles.setWelcomePending(name, true);
    store.invites.use(normalizeCode(input.code), name, now);
    return name;
  });
}


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
    if (change.pushEnabled && change.pushSince === undefined && !store.renpho.settings(profile).pushSince) change.pushSince = localToday(store, profile, now);
  }
  const wantsLogin = input.email !== undefined || (typeof input.password === "string" && input.password !== "");
  if (wantsLogin) {
    const email = checkEmail(input.email ?? saved?.email);
    const typed = typeof input.password === "string" ? input.password : "";
    const password = typed || (saved && saved.email === email ? saved.password : "");
    if (!password) throw new SettingsError("Enter the password.");
    store.credentials.put(profile, "renpho", email, password, now);
    store.renpho.saveState(profile, { error: null, errorKind: null, nextRunAt: null }, now);
    store.renpho.log(profile, "info", "Renpho login saved.", now);
  }
  if ((change.fetchEnabled || change.pushEnabled) && !store.credentials.get(profile, "renpho")) throw new SettingsError("Save the Renpho login first.");
  store.renpho.saveSettings(profile, change);
  if (change.fetchEnabled !== undefined) store.renpho.log(profile, "info", change.fetchEnabled ? "Fetching from Renpho switched on." : "Fetching from Renpho switched off.", now);
  if (change.pushEnabled !== undefined) store.renpho.log(profile, "info", change.pushEnabled ? `Upload to Garmin switched on${change.pushSince ? ` (weigh-ins from ${change.pushSince})` : ""}.` : "Upload to Garmin switched off.", now);
}

export function removeRenpho(store: SqliteStore, profile: string, now = Date.now()): void {
  store.credentials.delete(profile, "renpho");
  store.renpho.saveSettings(profile, { fetchEnabled: false, pushEnabled: false });
  store.renpho.saveState(profile, { error: null, errorKind: null, nextRunAt: null }, now);
  store.renpho.log(profile, "info", "Renpho login removed; the sync is off.", now);
}

const SHOWN = ["weight", "bodyfat", "water", "muscle", "bone", "bmi", "visfat", "bodyage", "bmr", "weightUnit"] as const;

const slim = (m: Measurement) => ({
  id: m.id,
  measuredAt: m.measuredAt,
  day: m.day,
  fields: Object.fromEntries(SHOWN.map((k) => [k, typeof m.data[k] === "number" || typeof m.data[k] === "string" ? m.data[k] : null])),
  pushedAt: m.pushedAt,
  pushError: m.pushError,
});

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


export function savePrefs(store: SqliteStore, profile: string, input: { weightUnit?: unknown }): Prefs {
  const prefs = store.prefs.get(profile);
  if (input.weightUnit !== undefined) {
    if (!WEIGHT_UNITS.includes(input.weightUnit as Prefs["weightUnit"])) throw new SettingsError('The unit of weight is "lb" or "kg".');
    prefs.weightUnit = input.weightUnit as Prefs["weightUnit"];
  }
  store.prefs.set(profile, prefs);
  return prefs;
}

export function settingsView(store: SqliteStore, profile: string, now = Date.now()) {
  return {
    profile,
    garmin: { ...garminAccount(profile), check: store.credentials.lastCheck(profile, "garmin") },
    web: { hasPassword: store.profiles.webPasswordHash(profile) !== null },
    goals: { values: getGoals(store, profile), fields: SETTING_FIELDS.map(({ max: _max, ...field }) => field) },
    renpho: renphoView(store, profile, now),
    mcp: mcpView(store, profile),
    encryption: { enabled: sealing(), plain: store.credentials.plainCount() },
  };
}
