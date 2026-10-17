import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

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

/**
 * Discover available profiles by scanning for .env.<name> files in the profiles directory.
 * Excludes .env.example.
 */
export function getAvailableProfiles(): string[] {
  const profilesDir = getProfilesDir();
  if (!fs.existsSync(profilesDir)) return [];
  const files = fs.readdirSync(profilesDir);
  const profiles: string[] = [];
  for (const file of files) {
    if (file.startsWith(".env.") && file !== ".env.example") {
      const name = file.slice(5); // remove ".env." prefix
      if (PROFILE_NAME_REGEX.test(name)) {
        profiles.push(name);
      }
    }
  }
  return profiles.sort();
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
  if (!fs.existsSync(envFile)) {
    const available = getAvailableProfiles();
    const list = available.length > 0
      ? `Available profiles: ${available.join(", ")}`
      : `No profiles found. Create a .env.<name> file (e.g., .env.MED) in the project root.`;
    throw new Error(
      `Profile "${name}" not found (expected ${envFile}).\n${list}`
    );
  }

  // Load the profile's env file (does NOT override existing process.env vars)
  const parsed = dotenv.parse(fs.readFileSync(envFile, "utf-8"));

  const email = parsed.GARMIN_EMAIL;
  const password = parsed.GARMIN_PASSWORD;

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

/**
 * Resolve the --profile flag from process.argv, or throw with guidance.
 * In mock mode, returns a dummy profile that doesn't require a .env file.
 */
export function requireProfile(mockMode: boolean = false): ProfileConfig {
  const profileArg = getProfileArg();

  if (mockMode && !profileArg) {
    // In mock mode, allow running without a profile for testing
    return getMockProfile();
  }

  if (!profileArg) {
    const available = getAvailableProfiles();
    const list = available.length > 0
      ? `\n  Available profiles: ${available.join(", ")}\n  Example: npm run mcp -- --profile ${available[0]}`
      : `\n  No profiles found. Create .env.<name> files (e.g., .env.MED, .env.Julie) in the project root.`;
    throw new Error(
      `❌ No profile specified. Use --profile <name>.${list}`
    );
  }

  return loadProfile(profileArg);
}

/**
 * Extract --profile value from process.argv
 */
export function getProfileArg(): string | undefined {
  const idx = process.argv.indexOf("--profile");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}
