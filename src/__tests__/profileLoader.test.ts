import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GarminNotConnectedError, findProfile, garminConnected, getAvailableProfiles, loadProfile } from "../shared/profileLoader";
import { closeStore, getStore } from "../shared/store";
import { importEnvProfiles } from "../shared/profileImport";
import { seedProfile } from "./fixtures/profiles";

let dir: string;
const saved = { data: process.env.GARMIN_DATA_DIR, store: process.env.GARMIN_STORE_PATH, key: process.env.CREDENTIALS_KEY };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
  process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  delete process.env.GARMIN_STORE_PATH;
  delete process.env.CREDENTIALS_KEY;
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  restore("GARMIN_DATA_DIR", saved.data); restore("GARMIN_STORE_PATH", saved.store); restore("CREDENTIALS_KEY", saved.key);
});

describe("profile names", () => {
  it("finds a profile whatever the case, and returns the spelling it was made with", () => {
    seedProfile("MED");
    seedProfile("Sam");
    expect(findProfile("med")).toBe("MED");
    expect(findProfile("MED")).toBe("MED");
    expect(findProfile("SAM")).toBe("Sam");
    expect(findProfile("nobody")).toBeUndefined();
  });

  it("prefers the exact spelling, and refuses to guess between names that differ only in case", () => {
    seedProfile("Sam");
    seedProfile("sam");
    expect(findProfile("Sam")).toBe("Sam");
    expect(findProfile("sam")).toBe("sam");
    expect(findProfile("SAM")).toBeUndefined();
  });

  it("loads a profile by any case and keeps its data under the real name", () => {
    seedProfile("MED", { garmin: true });
    const profile = loadProfile("med");
    expect(profile.name).toBe("MED");
    expect(profile.dataDir).toBe(path.join(dir, "data", "MED"));
    expect(fs.readdirSync(path.join(dir, "data")).filter((f) => !f.endsWith(".db"))).toEqual(["MED"]);
  });

  it("refuses a bad name and one that does not exist, and says how to make a profile", () => {
    expect(() => loadProfile("../x")).toThrow(/Invalid profile name/);
    expect(() => loadProfile("NOBODY")).toThrow(/No profiles yet: add one/);
    seedProfile("MED");
    expect(() => loadProfile("NOBODY")).toThrow(/Available profiles: MED/);
  });
});

describe("Garmin is optional", () => {
  it("lets a profile exist, and load, without a Garmin login", () => {
    seedProfile("SAM");
    expect(getAvailableProfiles()).toEqual(["SAM"]);
    expect(garminConnected("SAM")).toBe(false);
    expect(loadProfile("SAM")).toEqual(expect.objectContaining({ name: "SAM", login: null }));
  });

  it("gives the login of a profile that has one", () => {
    seedProfile("MED", { garmin: { email: "a@b.c", password: "pw" } });
    expect(garminConnected("MED")).toBe(true);
    expect(loadProfile("MED").login).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("has a profile without asking the database to exist first, and does not make one by looking", () => {
    expect(getAvailableProfiles()).toEqual([]);
    expect(garminConnected("MED")).toBe(false);
    expect(fs.existsSync(path.join(dir, "data", "garmin.db"))).toBe(false);
  });

  it("counts a login that cannot be decrypted as a login that is there", () => {
    process.env.CREDENTIALS_KEY = "k".repeat(32);
    seedProfile("MED", { garmin: true });
    delete process.env.CREDENTIALS_KEY;
    expect(garminConnected("MED")).toBe(true);
    expect(() => loadProfile("MED")).toThrow(/CREDENTIALS_KEY is not set/);
  });

  it("names the profile in the error a Garmin action gets", () => {
    const error = new GarminNotConnectedError("SAM");
    expect(error.message).toMatch(/Profile "SAM" has no Garmin login/);
    expect(error.profile).toBe("SAM");
  });
});

describe("the profile registry", () => {
  it("takes the profiles a database made before it already has data for, once", () => {
    process.env.GARMIN_STORE_PATH = path.join(dir, "old.db");
    getStore();
    closeStore();
    // an older database: the registry table is not there yet, but the data is
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.GARMIN_STORE_PATH);
    db.exec("DROP TABLE profiles");
    db.prepare("INSERT INTO nutrition (profile, day, meal, name, kcal, protein_g, carbs_g, fat_g, source, created_at, updated_at) VALUES ('Old_One', '2026-01-01', 'lunch', 'x', 1, 0, 0, 0, 'test', 1, 1)").run();
    db.prepare("INSERT INTO documents (path, owner, text, size, version, updated_at, source, summary) VALUES ('data/PlanOnly/x.json', NULL, '[]', 2, 1, 1, 'test', '{}')").run();
    db.prepare("INSERT INTO documents (path, owner, text, size, version, updated_at, source, summary) VALUES ('workout-plans/y.json', 'Owner', '[]', 2, 1, 1, 'test', '{}')").run();
    db.prepare("INSERT INTO wellness (profile, day, kind, fetched_at, data) VALUES ('bad name!', '2026-01-01', 'sleep', 1, '{}')").run();
    db.close();

    expect(getAvailableProfiles()).toEqual(["Old_One", "Owner", "PlanOnly"]); // a name that is no profile name is left out
    getStore().profiles.add("Later");
    closeStore();
    expect(getAvailableProfiles()).toEqual(["Later", "Old_One", "Owner", "PlanOnly"]); // not taken again once the table has a row
  });

  it("refuses a name that is not a profile name", () => {
    expect(() => getStore().profiles.add("a b")).toThrow(/Invalid profile name/);
    expect(() => getStore().profiles.create("a b", "long enough")).toThrow(/Invalid profile name/);
  });

  it("makes a profile with its password in one step, and never replaces one that exists", () => {
    getStore().profiles.create("MED", "long enough");
    expect(getStore().profiles.has("MED")).toBe(true);
    expect(getStore().profiles.checkWebPassword("MED", "long enough")).toBe(true);
    expect(() => getStore().profiles.create("MED", "another one")).toThrow();
    expect(getStore().profiles.checkWebPassword("MED", "long enough")).toBe(true);
  });

  it("keeps the hash of a web password, never the password, and checks against it", () => {
    seedProfile("MED", { webPassword: "correct horse" });
    const hash = getStore().profiles.webPasswordHash("MED")!;
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("correct horse");
    expect(getStore().profiles.checkWebPassword("MED", "correct horse")).toBe(true);
    expect(getStore().profiles.checkWebPassword("MED", "wrong")).toBe(false);
    expect(getStore().profiles.checkWebPassword("NOBODY", "correct horse")).toBe(false);
    expect(getStore().profiles.withWebPassword()).toEqual(["MED"]);
    getStore().profiles.setWebPassword("MED", "correct horse"); // the same password, another salt
    expect(getStore().profiles.webPasswordHash("MED")).not.toBe(hash);
    getStore().profiles.setWebPassword("MED", null);
    expect(getStore().profiles.withWebPassword()).toEqual([]);
    expect(getStore().profiles.has("MED")).toBe(true);
  });
});

describe("importing the old .env.<name> files", () => {
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, `.env.${name}`), body);

  it("takes the Garmin login and the web password of each file, and skips .env.example and other files", () => {
    write("MED", 'GARMIN_EMAIL=med@x.y\nGARMIN_PASSWORD="pw #1"\nWEB_PASSWORD=webpw\n');
    write("Sam", "WEB_PASSWORD=samweb\n");
    write("Julie", "GARMIN_EMAIL=j@x.y\nGARMIN_PASSWORD=jp\n");
    write("example", "GARMIN_EMAIL=nobody@x.y\nGARMIN_PASSWORD=x\n");
    write("bad name", "GARMIN_EMAIL=nobody@x.y\nGARMIN_PASSWORD=x\n");
    fs.writeFileSync(path.join(dir, ".env"), "MCP_AUTH_TOKEN=x\n");

    const out = importEnvProfiles(getStore(), dir);
    expect(out).toEqual([
      { name: "Julie", garmin: "imported", webPassword: "none" },
      { name: "MED", garmin: "imported", webPassword: "imported" },
      { name: "Sam", garmin: "none", webPassword: "imported" },
    ]);
    expect(getAvailableProfiles()).toEqual(["Julie", "MED", "Sam"]);
    expect(loadProfile("MED").login).toEqual({ email: "med@x.y", password: "pw #1" });
    expect(garminConnected("Sam")).toBe(false);
    expect(getStore().profiles.checkWebPassword("MED", "webpw")).toBe(true);
    expect(getStore().profiles.checkWebPassword("Sam", "samweb")).toBe(true);
  });

  it("never replaces what the database already has, and can be run twice", () => {
    seedProfile("MED", { garmin: { email: "kept@x.y", password: "kept" }, webPassword: "keptweb" });
    write("MED", "GARMIN_EMAIL=file@x.y\nGARMIN_PASSWORD=filepw\nWEB_PASSWORD=fileweb\n");
    expect(importEnvProfiles(getStore(), dir)).toEqual([{ name: "MED", garmin: "kept", webPassword: "kept" }]);
    expect(loadProfile("MED").login).toEqual({ email: "kept@x.y", password: "kept" });
    expect(getStore().profiles.checkWebPassword("MED", "keptweb")).toBe(true);
    expect(importEnvProfiles(getStore(), dir)).toHaveLength(1);
  });
});
