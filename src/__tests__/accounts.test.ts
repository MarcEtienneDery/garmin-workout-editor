import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SettingsError, createProfile, garminAccount, removeGarminLogin, removeRenpho, renphoView, saveGarminLogin, saveRenpho, saveWebPassword, settingsView } from "../shared/accounts";
import { closeStore, getStore } from "../shared/store";
import { GarminNotConnectedError, getAvailableProfiles, loadProfile } from "../shared/profileLoader";
import { configureMcp, getSession, getSettings } from "../mcp/context";
import { renphoRow } from "./fixtures/renpho";
import { seedProfile } from "./fixtures/profiles";

let dir: string;
const saved = { data: process.env.GARMIN_DATA_DIR, store: process.env.GARMIN_STORE_PATH, key: process.env.CREDENTIALS_KEY, tz: process.env.GARMIN_TZ };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  delete process.env.GARMIN_STORE_PATH;
  delete process.env.CREDENTIALS_KEY;
  process.env.GARMIN_TZ = "UTC";
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  restore("GARMIN_DATA_DIR", saved.data); restore("GARMIN_STORE_PATH", saved.store); restore("CREDENTIALS_KEY", saved.key); restore("GARMIN_TZ", saved.tz);
});

describe("the Garmin login", () => {
  it("is optional: a profile has none until one is saved, and it is saved in the database", () => {
    seedProfile("MED");
    expect(garminAccount("MED")).toEqual({ connected: false, email: null, hasPassword: false });
    expect(loadProfile("MED").login).toBeNull();
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(garminAccount("MED")).toEqual({ connected: true, email: "set@x.y", hasPassword: true });
    expect(loadProfile("MED")).toEqual(expect.objectContaining({ login: { email: "set@x.y", password: "setpw" } }));
  });

  it("never gives the password to the view", () => {
    seedProfile("MED");
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(JSON.stringify(settingsView(getStore(), "MED"))).not.toMatch(/setpw/);
  });

  it("keeps the saved password when none is typed and the email is the same, and wants one when the email changes", () => {
    seedProfile("MED", { garmin: { email: "file@x.y", password: "filepw" } });
    saveGarminLogin(getStore(), "MED", { email: " file@x.y ", password: "" });
    expect(getStore().credentials.get("MED", "garmin")).toEqual(expect.objectContaining({ email: "file@x.y", password: "filepw" }));
    expect(() => saveGarminLogin(getStore(), "MED", { email: "new@x.y", password: "" })).toThrow("Enter the password.");
    expect(() => saveGarminLogin(getStore(), "MED", { email: "not an email", password: "x" })).toThrow(SettingsError);
    saveGarminLogin(getStore(), "MED", { email: "new@x.y", password: "newpw" });
    expect(loadProfile("MED").login).toEqual({ email: "new@x.y", password: "newpw" });
    expect(() => saveGarminLogin(getStore(), "SAM", { email: "sam@x.y", password: "" })).toThrow("Enter the password."); // the first save needs one
  });

  it("ends the open session when the login changes, so the next sign-in tries the new one, and keeps it when nothing changed", () => {
    const store = getStore();
    seedProfile("MED", { garmin: { email: "file@x.y", password: "filepw" } });
    store.tokens.put("MED", "file@x.y", { oauth1Token: {}, oauth2Token: {} });
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "filepw" }); // the same login
    expect(store.tokens.get("MED")).not.toBeNull();
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "newpw" }); // same email, another password
    expect(store.tokens.get("MED")).toBeNull();
    store.tokens.put("MED", "file@x.y", { oauth1Token: {}, oauth2Token: {} });
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "" }); // kept as it is
    expect(store.tokens.get("MED")).not.toBeNull();
  });

  it("can be removed, even when it is the only one: the profile stays and goes on without Garmin, and what was synced is kept", () => {
    const store = getStore();
    saveGarminLogin(store, "SAM", { email: "sam@x.y", password: "sampw" });
    seedProfile("SAM");
    store.tokens.put("SAM", "sam@x.y", { oauth1Token: {}, oauth2Token: {} });
    store.wellness.put("SAM", "2026-10-01", "sleep", { a: 1 });
    removeGarminLogin(store, "SAM");
    expect(garminAccount("SAM")).toEqual({ connected: false, email: null, hasPassword: false });
    expect(store.tokens.get("SAM")).toBeNull();
    expect(getAvailableProfiles()).toEqual(["SAM"]);
    expect(store.wellness.hasRows("SAM")).toBe(true);
    removeGarminLogin(store, "SAM"); // nothing to remove is not an error
  });

  it("switches the Renpho upload off when the login is removed, as there is nothing to upload to", () => {
    const store = getStore();
    seedProfile("MED", { garmin: true });
    saveRenpho(store, "MED", { email: "me@x.y", password: "rpw", fetchEnabled: true, pushEnabled: true });
    removeGarminLogin(store, "MED");
    expect(store.renpho.settings("MED")).toEqual(expect.objectContaining({ fetchEnabled: true, pushEnabled: false }));
    expect(store.renpho.logLines("MED").map((l) => l.message)).toContain("Upload to Garmin switched off: the Garmin login was removed.");
  });

  it("is not what makes a profile: a profile exists because it was added, and a login is saved for one that exists", () => {
    expect(getAvailableProfiles()).toEqual([]);
    saveGarminLogin(getStore(), "SAM", { email: "sam@x.y", password: "sampw" });
    expect(getAvailableProfiles()).toEqual([]); // the login of a name nobody added makes no profile
    seedProfile("SAM");
    seedProfile("MED");
    expect(getAvailableProfiles()).toEqual(["MED", "SAM"]);
    expect(loadProfile("SAM")).toEqual(expect.objectContaining({ name: "SAM", login: { email: "sam@x.y", password: "sampw" } }));
    expect(loadProfile("MED").login).toBeNull();
    expect(() => loadProfile("NOBODY")).toThrow(/not found/);
  });

  it("tells that a saved login cannot be read when it is encrypted and the key is gone", () => {
    process.env.CREDENTIALS_KEY = "k".repeat(32);
    seedProfile("MED");
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(loadProfile("MED").login!.password).toBe("setpw");
    delete process.env.CREDENTIALS_KEY;
    expect(() => loadProfile("MED")).toThrow(/CREDENTIALS_KEY is not set/);
    expect(garminAccount("MED")).toEqual(expect.objectContaining({ connected: true, email: null, error: expect.stringMatching(/CREDENTIALS_KEY/) }));
    expect(getAvailableProfiles()).toEqual(["MED"]);
  });
});

describe("the web sign-in password", () => {
  const typed = (password: string, confirm = password) => ({ password, confirm });

  it("is set from Settings, kept as a hash, and shown only as set or not", () => {
    const store = getStore();
    seedProfile("MED");
    expect(settingsView(store, "MED").web).toEqual({ hasPassword: false });
    saveWebPassword(store, "MED", typed("long enough"));
    expect(settingsView(store, "MED").web).toEqual({ hasPassword: true });
    expect(JSON.stringify(settingsView(store, "MED"))).not.toContain("long enough");
    expect(store.profiles.checkWebPassword("MED", "long enough")).toBe(true);
    saveWebPassword(store, "MED", typed("another one"));
    expect(store.profiles.checkWebPassword("MED", "long enough")).toBe(false);
    expect(store.profiles.checkWebPassword("MED", "another one")).toBe(true);
  });

  it("is typed twice: two fields that differ, an empty one and a short one are all refused, and nothing is saved", () => {
    const store = getStore();
    seedProfile("MED", { webPassword: "the first one" });
    expect(() => saveWebPassword(store, "MED", { password: "long enough", confirm: "long enougH" })).toThrow("The two passwords are not the same.");
    expect(() => saveWebPassword(store, "MED", { password: "long enough" })).toThrow("The two passwords are not the same."); // no second field at all
    expect(() => saveWebPassword(store, "MED", typed(""))).toThrow("Enter a password.");
    expect(() => saveWebPassword(store, "MED", {})).toThrow("Enter a password.");
    expect(() => saveWebPassword(store, "MED", typed("short"))).toThrow(/at least 8 characters/);
    expect(() => saveWebPassword(store, "MED", { password: "short", confirm: "other" })).toThrow(SettingsError);
    expect(store.profiles.checkWebPassword("MED", "the first one")).toBe(true);
  });

  it("cannot be removed: there is no way to take a profile's password away from Settings", () => {
    expect(Object.keys(require("../shared/accounts"))).not.toContain("removeWebPassword");
  });

  it("is given when a profile is made, which takes a name and the password twice, and makes nothing when one is wrong", () => {
    const store = getStore();
    expect(createProfile(store, { name: " SAM ", ...typed("long enough") })).toBe("SAM");
    expect(store.profiles.has("SAM")).toBe(true);
    expect(store.profiles.checkWebPassword("SAM", "long enough")).toBe(true);
    expect(() => createProfile(store, { name: "a b", ...typed("long enough") })).toThrow(/letters, numbers, hyphens and underscores/);
    expect(() => createProfile(store, { ...typed("long enough") })).toThrow(/letters, numbers/);
    expect(() => createProfile(store, { name: "NEW" })).toThrow("Enter a password.");
    expect(() => createProfile(store, { name: "NEW", password: "long enough", confirm: "different" })).toThrow("The two passwords are not the same.");
    expect(() => createProfile(store, { name: "NEW", ...typed("short") })).toThrow(/at least 8/);
    expect(store.profiles.has("NEW")).toBe(false);
    expect(() => createProfile(store, { name: "SAM", ...typed("long enough") })).toThrow(); // the name is taken: nothing is replaced
    expect(store.profiles.checkWebPassword("SAM", "long enough")).toBe(true);
  });
});

describe("the MCP server's Garmin session", () => {
  const before = { ...getSettings() };
  afterEach(() => configureMcp({ mock: before.mock, defaultProfile: before.defaultProfile }));

  it("is a new client when the login is changed in Settings, by this process or the other one, and the same one otherwise", () => {
    seedProfile("MED", { garmin: { email: "file@x.y", password: "filepw" } });
    configureMcp({ mock: false, defaultProfile: "MED" });
    const first = getSession("MED");
    expect(first.profile.login!.email).toBe("file@x.y");
    expect(getSession("MED")).toBe(first);
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    const second = getSession("MED");
    expect(second).not.toBe(first);
    expect(second.profile.login).toEqual({ email: "set@x.y", password: "setpw" });
    expect(getSession("MED")).toBe(second);
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "changed" });
    expect(getSession("MED")).not.toBe(second);
  });

  it("is refused for a profile that has no Garmin login, with the error that says so", () => {
    seedProfile("SAM");
    configureMcp({ mock: false, defaultProfile: "SAM" });
    expect(() => getSession("SAM")).toThrow(GarminNotConnectedError);
    expect(() => getSession()).toThrow(/Profile "SAM" has no Garmin login/);
  });
});

describe("the Renpho login and settings", () => {
  const T = Date.parse("2026-10-18T15:00:00Z");

  it("saves the login and the switches, and the password stays on the server", () => {
    const store = getStore();
    saveRenpho(store, "MED", { email: "me@x.y", password: "rpw", areaCode: "ca", fetchEnabled: true, intervalHours: 6 }, T);
    expect(store.credentials.get("MED", "renpho")).toEqual(expect.objectContaining({ email: "me@x.y", password: "rpw" }));
    expect(store.renpho.settings("MED")).toEqual(expect.objectContaining({ areaCode: "CA", fetchEnabled: true, intervalHours: 6, pushEnabled: false }));
    const view = renphoView(store, "MED", T);
    expect(view.account).toEqual({ email: "me@x.y", hasPassword: true });
    expect(JSON.stringify(settingsView(store, "MED", T))).not.toContain("rpw");
    expect(view.intervals).toEqual([1, 3, 6, 12, 24]);
    expect(store.renpho.logLines("MED").map((l) => l.message)).toEqual(["Fetching from Renpho switched on.", "Renpho login saved."]);
    saveRenpho(store, "MED", { email: "me@x.y", password: "" }, T);
    expect(store.credentials.get("MED", "renpho")!.password).toBe("rpw"); // empty keeps it
  });

  it("wants the login before the sync is switched on, a password with a changed email, and sensible values", () => {
    const store = getStore();
    seedProfile("MED", { garmin: true });
    expect(() => saveRenpho(store, "MED", { fetchEnabled: true })).toThrow("Save the Renpho login first.");
    expect(() => saveRenpho(store, "MED", { pushEnabled: true })).toThrow("Save the Renpho login first.");
    expect(() => saveRenpho(store, "MED", { email: "me@x.y" })).toThrow("Enter the password.");
    saveRenpho(store, "MED", { email: "me@x.y", password: "rpw" });
    expect(() => saveRenpho(store, "MED", { email: "other@x.y", password: "" })).toThrow("Enter the password.");
    expect(() => saveRenpho(store, "MED", { areaCode: "United States" })).toThrow(/two or three letters/);
    expect(() => saveRenpho(store, "MED", { intervalHours: 5 })).toThrow(/hours/);
    expect(() => saveRenpho(store, "MED", { pushSince: "yesterday" })).toThrow(/date/);
    expect(store.renpho.settings("MED")).toEqual(expect.objectContaining({ areaCode: "US", intervalHours: 3 })); // nothing half saved
  });

  it("works without Garmin, and the upload to Garmin needs a Garmin login", () => {
    const store = getStore();
    seedProfile("SAM");
    saveRenpho(store, "SAM", { email: "me@x.y", password: "rpw", fetchEnabled: true });
    expect(store.renpho.settings("SAM")).toEqual(expect.objectContaining({ fetchEnabled: true, pushEnabled: false }));
    expect(() => saveRenpho(store, "SAM", { pushEnabled: true })).toThrow("Connect Garmin first: the weigh-ins are uploaded to a Garmin account.");
    expect(store.renpho.settings("SAM").pushEnabled).toBe(false);
    saveGarminLogin(store, "SAM", { email: "sam@x.y", password: "sampw" });
    saveRenpho(store, "SAM", { pushEnabled: true });
    expect(store.renpho.settings("SAM").pushEnabled).toBe(true);
  });

  it("starts the upload from today when it is switched on without a day, so the whole history is not sent by surprise", () => {
    const store = getStore();
    seedProfile("MED", { garmin: true });
    saveRenpho(store, "MED", { email: "me@x.y", password: "rpw" });
    saveRenpho(store, "MED", { pushEnabled: true }, T);
    expect(store.renpho.settings("MED")).toEqual(expect.objectContaining({ pushEnabled: true, pushSince: "2026-10-18" }));
    saveRenpho(store, "MED", { pushEnabled: false, pushSince: "2026-01-01" }, T);
    saveRenpho(store, "MED", { pushEnabled: true }, T);
    expect(store.renpho.settings("MED").pushSince).toBe("2026-01-01"); // a chosen day is kept
    saveRenpho(store, "MED", { pushSince: "" }, T);
    expect(store.renpho.settings("MED").pushSince).toBeNull();
  });

  it("clears an earlier refusal when a new login is saved, and a removal switches everything off but keeps the weigh-ins", () => {
    const store = getStore();
    seedProfile("MED", { garmin: true });
    saveRenpho(store, "MED", { email: "me@x.y", password: "rpw", fetchEnabled: true, pushEnabled: true }, T);
    store.renpho.saveState("MED", { error: "refused", errorKind: "login" });
    saveRenpho(store, "MED", { email: "me@x.y", password: "new" }, T);
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ error: null, errorKind: null }));
    store.renpho.addMeasurement("MED", { id: "1", measuredAt: 1, day: "2026-01-01", data: renphoRow(1) });
    removeRenpho(store, "MED", T);
    expect(store.credentials.get("MED", "renpho")).toBeNull();
    expect(store.renpho.settings("MED")).toEqual(expect.objectContaining({ fetchEnabled: false, pushEnabled: false }));
    expect(store.renpho.counts("MED").total).toBe(1);
    expect(renphoView(store, "MED", T).account).toBeNull();
  });

  it("shows the weigh-ins as Renpho sent them, and whether the passwords are encrypted", () => {
    const store = getStore();
    store.renpho.addMeasurement("MED", { id: "1", measuredAt: 5, day: "2026-01-01", data: { ...renphoRow(1), secret: "x" } });
    const view = renphoView(store, "MED");
    expect(view.recent[0].fields).toEqual({ weight: 81.7, bodyfat: 17.8, water: 56.1, muscle: 44.5, bone: 3.8, bmi: 24.9, visfat: 7, bodyage: 34, bmr: 1850, weightUnit: 1 });
    expect(JSON.stringify(view)).not.toContain("secret");
    saveGarminLogin(store, "MED", { email: "a@b.c", password: "plain" });
    saveGarminLogin(store, "SAM", { email: "s@b.c", password: "plain" });
    expect(settingsView(store, "MED").encryption).toEqual({ enabled: false, plain: 2 });
    process.env.CREDENTIALS_KEY = "k".repeat(32);
    expect(settingsView(store, "MED").encryption).toEqual({ enabled: true, plain: 1 }); // MED's was encrypted as it was read; SAM's waits for its turn
  });
});
