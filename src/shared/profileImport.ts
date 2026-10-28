/**
 * profileImport.ts — take the profiles of the old `.env.<name>` files into the database, once. Profiles used to be those files
 * (GARMIN_EMAIL, GARMIN_PASSWORD and WEB_PASSWORD in each); they are rows now, and nothing reads the files any more.
 * What the database already holds is never replaced: a login or a web password saved there wins, as it did when the files
 * were still read.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { SealKeyError, type SqliteStore, isProfileName } from "./store";

export interface ImportedProfile {
  name: string;
  /** "imported": the file's login was saved; "kept": the database had one already; "none": the file has no Garmin login. */
  garmin: "imported" | "kept" | "none";
  /** "imported", "kept" (the database had one already) or "none". */
  webPassword: "imported" | "kept" | "none";
}

const hasLogin = (store: SqliteStore, name: string): boolean => {
  try {
    return store.credentials.get(name, "garmin") !== null;
  } catch (error) {
    if (error instanceof SealKeyError) return true;
    throw error;
  }
};

/** Import every `.env.<name>` of a directory (`.env.example` and names that are not profile names are skipped). */
export function importEnvProfiles(store: SqliteStore, dir: string): ImportedProfile[] {
  const imported: ImportedProfile[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const name = file.startsWith(".env.") ? file.slice(5) : "";
    if (!name || name === "example" || !isProfileName(name)) continue;
    const env = dotenv.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    store.profiles.add(name);

    let garmin: ImportedProfile["garmin"] = "none";
    if (hasLogin(store, name)) garmin = "kept";
    else if (env.GARMIN_EMAIL && env.GARMIN_PASSWORD) {
      store.credentials.put(name, "garmin", env.GARMIN_EMAIL, env.GARMIN_PASSWORD);
      garmin = "imported";
    }

    let webPassword: ImportedProfile["webPassword"] = "none";
    if (store.profiles.webPasswordHash(name)) webPassword = "kept";
    else if (env.WEB_PASSWORD) {
      store.profiles.setWebPassword(name, env.WEB_PASSWORD);
      webPassword = "imported";
    }
    imported.push({ name, garmin, webPassword });
  }
  return imported;
}
