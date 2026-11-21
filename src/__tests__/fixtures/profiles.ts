import { getStore } from "../../shared/store";

export interface SeedOptions {
  garmin?: boolean | { email: string; password: string };
  webPassword?: string;
}

export function seedProfile(name: string, options: SeedOptions = {}): void {
  const store = getStore();
  store.profiles.add(name);
  if (options.garmin) {
    const login = options.garmin === true ? { email: "a@b.c", password: "x" } : options.garmin;
    store.credentials.put(name, "garmin", login.email, login.password);
  }
  if (options.webPassword) store.profiles.setWebPassword(name, options.webPassword);
}
