import * as fs from "fs";
import * as path from "path";
import { getStore, getStorePath, isProfileName } from "./store";
import { SealKeyError } from "./store/seal";

export interface Login {
  email: string;
  password: string;
}

export interface ProfileConfig {
  name: string;
  /** The Garmin login, or null for a profile that has none (Garmin is optional). */
  login: Login | null;
  dataDir: string;
}

export const PROJECT_ROOT = path.resolve(__dirname, "../..");

/** A profile that has no Garmin login was asked to do something that needs one. */
export class GarminNotConnectedError extends Error {
  constructor(readonly profile: string) {
    super(`Profile "${profile}" has no Garmin login: add one in the web editor's Settings (Garmin account).`);
    this.name = "GarminNotConnectedError";
  }
}

/**
 * Root directory for per-profile data (data/<profile>/). Defaults to
 * <project>/data; override with GARMIN_DATA_DIR (e.g. a /data volume in Docker).
 */
export function getDataRoot(): string {
  return process.env.GARMIN_DATA_DIR
    ? path.resolve(process.env.GARMIN_DATA_DIR)
    : path.join(PROJECT_ROOT, "data");
}

/**
 * The Garmin login saved in the database (the Settings view), when there is a database and one is saved. A login that is there but
 * cannot be read (SealKeyError, or a database that cannot be opened) throws: it is not the same as no login.
 */
export function garminLogin(name: string): Login | null {
  const saved = fs.existsSync(getStorePath()) ? getStore().credentials.get(name, "garmin") : null;
  return saved && { email: saved.email, password: saved.password };
}

/** Whether the profile has a Garmin login (one that cannot be decrypted counts: it is there). */
export function garminConnected(name: string): boolean {
  try {
    return garminLogin(name) !== null;
  } catch (error) {
    if (error instanceof SealKeyError) return true;
    throw error;
  }
}

/** The profiles that exist (the Settings view makes them), by name. No database yet means none. */
export function getAvailableProfiles(): string[] {
  return fs.existsSync(getStorePath()) ? getStore().profiles.names() : [];
}

/**
 * The profile a name stands for, ignoring case ("med" -> "MED"): the exact spelling wins,
 * otherwise a single profile that differs only in case. Profiles keep the spelling they were
 * made with, which names their data/<name>/ folder, so only lookups are case-insensitive.
 */
export function findProfile(name: string): string | undefined {
  const available = getAvailableProfiles();
  if (available.includes(name)) return name;
  const matches = available.filter((p) => p.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/** Why a name is no profile: it is several that differ only in case, or it does not exist. */
export function unknownProfileMessage(name: string): string {
  const available = getAvailableProfiles();
  const similar = available.filter((p) => p.toLowerCase() === name.toLowerCase());
  if (similar.length > 1) return `Profile "${name}" matches several profiles (${similar.join(", ")}): use the exact spelling.`;
  return `Profile "${name}" not found.\n${available.length > 0 ? `Available profiles: ${available.join(", ")}` : "No profiles yet: add one in the web editor's Settings."}`;
}

/**
 * Load a profile: its Garmin login (null when it has none) and its data directory.
 * Throws if the profile doesn't exist.
 */
export function loadProfile(requested: string): ProfileConfig {
  if (!isProfileName(requested)) {
    throw new Error(
      `Invalid profile name "${requested}". Use only letters, numbers, hyphens, and underscores.`
    );
  }
  const name = findProfile(requested);
  if (!name) throw new Error(unknownProfileMessage(requested));

  const dataDir = path.join(getDataRoot(), name);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return { name, login: garminLogin(name), dataDir };
}

/**
 * Dummy profile for mock mode; does not require a database.
 */
export function getMockProfile(): ProfileConfig {
  const dataDir = path.join(getDataRoot(), "mock");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return {
    name: "mock",
    login: { email: "mock@example.com", password: "mock" },
    dataDir,
  };
}
