import { getStore } from "../../shared/store";

export interface SeedOptions {
  /** A Garmin login: `true` for a made-up one. Left out, the profile has none (Garmin is optional). */
  garmin?: boolean | { email: string; password: string };
  /** The password the profile signs in to the web editor with. */
  webPassword?: string;
}

/** A profile as the Settings view makes one: a row in the database, with a Garmin login and a web password when asked for. */
export function seedProfile(name: string, options: SeedOptions = {}): void {
  const store = getStore();
  store.profiles.add(name);
  if (options.garmin) {
    const login = options.garmin === true ? { email: "a@b.c", password: "x" } : options.garmin;
    store.credentials.put(name, "garmin", login.email, login.password);
  }
  if (options.webPassword) store.profiles.setWebPassword(name, options.webPassword);
}
