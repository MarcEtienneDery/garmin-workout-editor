import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

export interface ProfileConfig {
  name: string;
  email: string;
  password: string;
  dataDir: string;
}

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PROFILE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Discover available profiles by scanning for .env.<name> files in the project root.
 * Excludes .env.example.
 */
export function getAvailableProfiles(): string[] {
  const files = fs.readdirSync(PROJECT_ROOT);
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
 * Load a profile's credentials and resolve its data directory.
 * Throws if the profile doesn't exist or is missing required vars.
 */
export function loadProfile(name: string): ProfileConfig {
  if (!PROFILE_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use only letters, numbers, hyphens, and underscores.`
    );
  }

  const envFile = path.join(PROJECT_ROOT, `.env.${name}`);
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

  const dataDir = path.join(PROJECT_ROOT, "data", name);

  // Ensure the profile data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Also set any other env vars from the profile file (e.g., GITHUB_TOKEN)
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return { name, email, password, dataDir };
}

/**
 * Resolve the --profile flag from process.argv, or throw with guidance.
 * In mock mode, returns a dummy profile that doesn't require a .env file.
 */
export function requireProfile(mockMode: boolean = false): ProfileConfig {
  const profileArg = getProfileArg();

  if (mockMode && !profileArg) {
    // In mock mode, allow running without a profile for testing
    const dataDir = path.join(PROJECT_ROOT, "data", "mock");
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

  if (!profileArg) {
    const available = getAvailableProfiles();
    const list = available.length > 0
      ? `\n  Available profiles: ${available.join(", ")}\n  Example: npm run manage-workouts -- --profile ${available[0]} --export`
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
