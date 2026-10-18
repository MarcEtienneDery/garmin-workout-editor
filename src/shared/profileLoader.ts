import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { getStore, getStorePath } from "./store";
import { SealKeyError } from "./store/seal";

export interface ProfileConfig {
  name: string;
  email: string;
  password: string;
  dataDir: string;
}

export const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PROFILE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Directory holding the .env.<profile> files. Defaults to the project root;
 * override with GARMIN_PROFILES_DIR (e.g. a read-only /config volume in Docker).
 */
export function getProfilesDir(): string {
  return process.env.GARMIN_PROFILES_DIR
    ? path.resolve(process.env.GARMIN_PROFILES_DIR)
    : PROJECT_ROOT;
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

export interface Login {
  email: string;
  password: string;
}

/** The Garmin login saved in the database (the Settings view), when there is a database and one is saved; it comes before the .env file's. */
export function storedLogin(name: string): Login | null {
  try {
    return fs.existsSync(getStorePath()) ? getStore().credentials.get(name, "garmin") : null;
  } catch (error) {
    if (error instanceof SealKeyError) throw error; // the login is there but cannot be read: say so, do not fall back as if it were not
    return null;
  }
}

/** The Garmin login in the profile's .env.<name> file, when there is one. */
export function fileLogin(name: string): Login | null {
  const file = path.join(getProfilesDir(), `.env.${name}`);
  if (!fs.existsSync(file)) return null;
  const parsed = dotenv.parse(fs.readFileSync(file, "utf-8"));
  return parsed.GARMIN_EMAIL && parsed.GARMIN_PASSWORD ? { email: parsed.GARMIN_EMAIL, password: parsed.GARMIN_PASSWORD } : null;
}

/**
 * Discover available profiles: the .env.<name> files in the profiles directory (not .env.example) and the profiles that
 * have a Garmin login saved in the database.
 */
export function getAvailableProfiles(): string[] {
  const profilesDir = getProfilesDir();
  const profiles = new Set<string>();
  if (fs.existsSync(profilesDir)) {
    for (const file of fs.readdirSync(profilesDir)) {
      if (file.startsWith(".env.") && file !== ".env.example") {
        const name = file.slice(5); // remove ".env." prefix
        if (PROFILE_NAME_REGEX.test(name)) profiles.add(name);
      }
    }
  }
  try {
    if (fs.existsSync(getStorePath())) for (const name of getStore().credentials.profiles("garmin")) if (PROFILE_NAME_REGEX.test(name)) profiles.add(name);
  } catch {
    // an unreadable database leaves the files' profiles
  }
  return [...profiles].sort();
}

/**
 * The profile a name stands for, ignoring case ("med" -> "MED"): the exact spelling wins,
 * otherwise a single profile that differs only in case. Profiles keep the spelling of their
 * .env.<name> file, which names their data/<name>/ folder, so only lookups are case-insensitive.
 */
export function findProfile(name: string): string | undefined {
  const available = getAvailableProfiles();
  if (available.includes(name)) return name;
  const matches = available.filter((p) => p.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Load a profile's credentials and resolve its data directory.
 * Throws if the profile doesn't exist or is missing required vars.
 */
export function loadProfile(requested: string): ProfileConfig {
  if (!PROFILE_NAME_REGEX.test(requested)) {
    throw new Error(
      `Invalid profile name "${requested}". Use only letters, numbers, hyphens, and underscores.`
    );
  }
  const name = findProfile(requested) ?? requested;

  const envFile = path.join(getProfilesDir(), `.env.${name}`);
  const saved = storedLogin(name);
  if (!fs.existsSync(envFile) && !saved) {
    const available = getAvailableProfiles();
    const list = available.length > 0
      ? `Available profiles: ${available.join(", ")}`
      : `No profiles found. Create a .env.<name> file (e.g., .env.MED) in the project root.`;
    throw new Error(
      `Profile "${name}" not found (expected ${envFile}).\n${list}`
    );
  }

  // Load the profile's env file (does NOT override existing process.env vars)
  const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile, "utf-8")) : {};

  // the login saved in Settings wins over the file's
  const email = saved?.email ?? parsed.GARMIN_EMAIL;
  const password = saved?.password ?? parsed.GARMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      `Profile "${name}" is missing GARMIN_EMAIL or GARMIN_PASSWORD in ${envFile}.`
    );
  }

  const dataDir = path.join(getDataRoot(), name);

  // Ensure the profile data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Also set any other env vars from the profile file (e.g., GITHUB_TOKEN)
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "WEB_PASSWORD") continue; // the web editor reads it per profile; never share it process-wide
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return { name, email, password, dataDir };
}

/**
 * Dummy profile for mock mode; does not require a .env file.
 */
export function getMockProfile(): ProfileConfig {
  const dataDir = path.join(getDataRoot(), "mock");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return {
    name: "mock",
    email: "mock@example.com",
    password: "mock",
    dataDir,
  };
}
