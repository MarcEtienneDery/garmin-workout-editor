import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SettingsError, garminAccount, moveGarminLoginFromFile, removeGarminLogin, removeRenpho, renphoView, saveGarminLogin, saveRenpho, settingsView } from "../shared/accounts";
import { closeStore, getStore } from "../shared/store";
import { getAvailableProfiles, loadProfile } from "../shared/profileLoader";
import { configureMcp, getSession, getSettings } from "../mcp/context";
import { renphoRow } from "./fixtures/renpho";

let dir: string;
const saved = { data: process.env.GARMIN_DATA_DIR, profiles: process.env.GARMIN_PROFILES_DIR, store: process.env.GARMIN_STORE_PATH, key: process.env.CREDENTIALS_KEY, tz: process.env.GARMIN_TZ };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
const writeEnv = (name: string, body: string) => fs.writeFileSync(path.join(dir, `.env.${name}`), body);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  process.env.GARMIN_PROFILES_DIR = dir;
  process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  delete process.env.GARMIN_STORE_PATH;
  delete process.env.CREDENTIALS_KEY;
  process.env.GARMIN_TZ = "UTC";
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  restore("GARMIN_DATA_DIR", saved.data); restore("GARMIN_PROFILES_DIR", saved.profiles); restore("GARMIN_STORE_PATH", saved.store); restore("CREDENTIALS_KEY", saved.key); restore("GARMIN_TZ", saved.tz);
});

describe("the Garmin login", () => {
  it("comes from the .env file until one is saved in Settings, which then comes first", () => {
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\n");
    expect(garminAccount("MED")).toEqual({ source: "file", email: "file@x.y", hasPassword: true, fileHasLogin: true });
    expect(loadProfile("MED")).toEqual(expect.objectContaining({ email: "file@x.y", password: "filepw" }));
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(garminAccount("MED")).toEqual({ source: "settings", email: "set@x.y", hasPassword: true, fileHasLogin: true });
    expect(loadProfile("MED")).toEqual(expect.objectContaining({ email: "set@x.y", password: "setpw" }));
    removeGarminLogin(getStore(), "MED");
    expect(loadProfile("MED").email).toBe("file@x.y");
  });

  it("never gives the password to the view", () => {
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\n");
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(JSON.stringify(settingsView(getStore(), "MED"))).not.toMatch(/setpw|filepw/);
  });

  it("keeps the saved password when none is typed and the email is the same, and wants one when the email changes", () => {
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\n");
    saveGarminLogin(getStore(), "MED", { email: "file@x.y", password: "" }); // the file's password, taken in with its email
    expect(loadProfile("MED").password).toBe("filepw");
    saveGarminLogin(getStore(), "MED", { email: " file@x.y ", password: "" });
    expect(getStore().credentials.get("MED", "garmin")).toEqual(expect.objectContaining({ email: "file@x.y", password: "filepw" }));
    expect(() => saveGarminLogin(getStore(), "MED", { email: "new@x.y", password: "" })).toThrow("Enter the password.");
    expect(() => saveGarminLogin(getStore(), "MED", { email: "not an email", password: "x" })).toThrow(SettingsError);
    saveGarminLogin(getStore(), "MED", { email: "new@x.y", password: "newpw" });
    expect(loadProfile("MED")).toEqual(expect.objectContaining({ email: "new@x.y", password: "newpw" }));
  });

  it("ends the open session when the login changes, so the next sign-in tries the new one, and keeps it when nothing changed", () => {
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\n");
    const store = getStore();
    store.tokens.put("MED", "file@x.y", { oauth1Token: {}, oauth2Token: {} });
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "filepw" }); // the file's own login, saved as it is
    moveGarminLoginFromFile(store, "MED");
    expect(store.tokens.get("MED")).not.toBeNull();
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "newpw" }); // same email, another password
    expect(store.tokens.get("MED")).toBeNull();
    store.tokens.put("MED", "file@x.y", { oauth1Token: {}, oauth2Token: {} });
    saveGarminLogin(store, "MED", { email: "file@x.y", password: "" }); // kept as it is
    expect(store.tokens.get("MED")).not.toBeNull();
    removeGarminLogin(store, "MED"); // back to the file's password, which is another one
    expect(store.tokens.get("MED")).toBeNull();
  });

  it("can be moved in from the .env file, and the last login cannot be removed", () => {
    expect(() => moveGarminLoginFromFile(getStore(), "NOPE")).toThrow(/holds no Garmin login/);
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\nWEB_PASSWORD=web\n");
    moveGarminLoginFromFile(getStore(), "MED");
    expect(garminAccount("MED").source).toBe("settings");
    expect(getStore().credentials.get("MED", "garmin")).toEqual(expect.objectContaining({ email: "file@x.y", password: "filepw" }));
    saveGarminLogin(getStore(), "SAM", { email: "sam@x.y", password: "sampw" });
    expect(() => removeGarminLogin(getStore(), "SAM")).toThrow(/only Garmin login/);
  });

  it("makes a profile of a name that has only a saved login, and a profile that exists by its file stays one", () => {
    expect(getAvailableProfiles()).toEqual([]);
    saveGarminLogin(getStore(), "SAM", { email: "sam@x.y", password: "sampw" });
    writeEnv("MED", "GARMIN_EMAIL=a@b.c\nGARMIN_PASSWORD=x\n");
    expect(getAvailableProfiles()).toEqual(["MED", "SAM"]);
    expect(loadProfile("SAM")).toEqual(expect.objectContaining({ name: "SAM", email: "sam@x.y", password: "sampw" }));
    expect(() => loadProfile("NOBODY")).toThrow(/not found/);
  });

  it("tells that a saved login cannot be read when it is encrypted and the key is gone", () => {
    process.env.CREDENTIALS_KEY = "k".repeat(32);
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    expect(loadProfile("MED").password).toBe("setpw");
    delete process.env.CREDENTIALS_KEY;
    expect(() => loadProfile("MED")).toThrow(/CREDENTIALS_KEY is not set/);
    expect(garminAccount("MED")).toEqual(expect.objectContaining({ source: "settings", email: null, error: expect.stringMatching(/CREDENTIALS_KEY/) }));
    expect(getAvailableProfiles()).toEqual(["MED"]);
  });
});

describe("the MCP server's Garmin session", () => {
  const before = { ...getSettings() };
  afterEach(() => configureMcp({ mock: before.mock, defaultProfile: before.defaultProfile }));

  it("is a new client when the login is changed in Settings, by this process or the other one, and the same one otherwise", () => {
    writeEnv("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\n");
    configureMcp({ mock: false, defaultProfile: "MED" });
    const first = getSession("MED");
    expect(first.profile.email).toBe("file@x.y");
    expect(getSession("MED")).toBe(first);
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "setpw" });
    const second = getSession("MED");
    expect(second).not.toBe(first);
    expect(second.profile).toEqual(expect.objectContaining({ email: "set@x.y", password: "setpw" }));
    expect(getSession("MED")).toBe(second);
    saveGarminLogin(getStore(), "MED", { email: "set@x.y", password: "changed" });
    expect(getSession("MED")).not.toBe(second);
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

  it("starts the upload from today when it is switched on without a day, so the whole history is not sent by surprise", () => {
    const store = getStore();
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
