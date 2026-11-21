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
  login: Login | null;
  dataDir: string;
}

export const PROJECT_ROOT = path.resolve(__dirname, "../..");

export class GarminNotConnectedError extends Error {
  constructor(readonly profile: string) {
    super(`Profile "${profile}" has no Garmin login: add one in the web editor's Settings (Garmin account).`);
    this.name = "GarminNotConnectedError";
  }
}

export function getDataRoot(): string {
  return process.env.GARMIN_DATA_DIR
    ? path.resolve(process.env.GARMIN_DATA_DIR)
    : path.join(PROJECT_ROOT, "data");
}

export function garminLogin(name: string): Login | null {
  const saved = fs.existsSync(getStorePath()) ? getStore().credentials.get(name, "garmin") : null;
  return saved && { email: saved.email, password: saved.password };
}

export function garminConnected(name: string): boolean {
  try {
    return garminLogin(name) !== null;
  } catch (error) {
    if (error instanceof SealKeyError) return true;
    throw error;
  }
}

export function getAvailableProfiles(): string[] {
  return fs.existsSync(getStorePath()) ? getStore().profiles.names() : [];
}

export function findProfile(name: string): string | undefined {
  const available = getAvailableProfiles();
  if (available.includes(name)) return name;
  const matches = available.filter((p) => p.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export function unknownProfileMessage(name: string): string {
  const available = getAvailableProfiles();
  const similar = available.filter((p) => p.toLowerCase() === name.toLowerCase());
  if (similar.length > 1) return `Profile "${name}" matches several profiles (${similar.join(", ")}): use the exact spelling.`;
  return `Profile "${name}" not found.\n${available.length > 0 ? `Available profiles: ${available.join(", ")}` : "No profiles yet: add one in the web editor's Settings."}`;
}

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
