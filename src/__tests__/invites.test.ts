import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SettingsError, createInvite, signUp } from "../shared/accounts";
import { InviteError, SqliteStore, closeStore, displayCode, getStore, normalizeCode } from "../shared/store";
import { newCode } from "../shared/store/invites";

let dir: string;
const saved = { data: process.env.GARMIN_DATA_DIR, store: process.env.GARMIN_STORE_PATH };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invites-test-"));
  process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  delete process.env.GARMIN_STORE_PATH;
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  restore("GARMIN_DATA_DIR", saved.data); restore("GARMIN_STORE_PATH", saved.store);
});

const join = (code: string, name = "sam", password = "long enough", now = NOW) => signUp(getStore(), { code, name, password, confirm: password }, now);

describe("an invite code", () => {
  it("is twelve letters and digits without the ones that look alike, shown in groups of four", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    expect(displayCode("ABCDEFGH2345")).toBe("ABCD-EFGH-2345");
  });

  it("is read as typed: any case, with dashes, spaces or none", () => {
    expect(normalizeCode(" abcd-efgh 2345 ")).toBe("ABCDEFGH2345");
    expect(normalizeCode(undefined)).toBe("");
    expect(normalizeCode(42)).toBe("");
  });

  it("works until it is used up, has expired or is revoked, and says which", () => {
    const store = getStore();
    const used = createInvite(store, { maxUses: 1 }, NOW);
    expect(store.invites.check(used, NOW)).toBe("active");
    join(displayCode(used).toLowerCase(), "first");
    expect(store.invites.check(used, NOW)).toBe("used");

    const short = createInvite(store, { days: 2 }, NOW);
    expect(store.invites.check(short, NOW + 2 * DAY - 1)).toBe("active");
    expect(store.invites.check(short, NOW + 2 * DAY)).toBe("expired");

    const forever = createInvite(store, { days: null }, NOW);
    expect(store.invites.check(forever, NOW + 1000 * DAY)).toBe("active");

    const cancelled = createInvite(store, {}, NOW);
    expect(store.invites.revoke(cancelled, NOW)).toBe(true);
    expect(store.invites.check(cancelled, NOW)).toBe("revoked");

    expect(store.invites.check("NOSUCHCODE22", NOW)).toBe("unknown");
    expect(store.invites.check("", NOW)).toBe("unknown");
    expect(store.invites.revoke("NOSUCHCODE22")).toBe(false);
  });

  it("lasts a week and one use unless the admin says otherwise", () => {
    const code = createInvite(getStore(), {}, NOW);
    const [invite] = getStore().invites.list(NOW);
    expect(invite).toMatchObject({ code, maxUses: 1, uses: 0, expiresAt: NOW + 7 * DAY, status: "active", note: "", joined: [] });
  });

  it("refuses what an invite cannot be", () => {
    const store = getStore();
    for (const bad of [{ maxUses: 0 }, { maxUses: 101 }, { maxUses: 1.5 }, { maxUses: "x" }, { days: 0.5 }, { days: 366 }, { days: "soon" }, { note: "x".repeat(61) }]) {
      expect(() => createInvite(store, bad)).toThrow(SettingsError);
    }
    expect(store.invites.list()).toEqual([]);
    expect(createInvite(store, { maxUses: "5", days: "30", note: "  for Sam " }, NOW)).toBeTruthy();
    expect(store.invites.list(NOW)[0]).toMatchObject({ maxUses: 5, expiresAt: NOW + 30 * DAY, note: "for Sam" });
  });

  it("is forgotten with its list entry, and what it made stays", () => {
    const store = getStore();
    const code = createInvite(store, { maxUses: 2 }, NOW);
    join(code, "sam");
    expect(store.invites.list(NOW)[0]).toMatchObject({ uses: 1, joined: ["sam"], status: "active" });
    expect(store.invites.remove(code)).toBe(true);
    expect(store.invites.list(NOW)).toEqual([]);
    expect(store.invites.check(code, NOW)).toBe("unknown");
    expect(store.profiles.has("sam")).toBe(true);
    expect(store.invites.remove(code)).toBe(false);
  });
});

describe("signing up", () => {
  it("makes the profile with the password, marks the welcome flow pending and counts the use", () => {
    const store = getStore();
    const code = createInvite(store, { maxUses: 3 }, NOW);
    expect(join(code, "  sam ")).toBe("sam");
    expect(store.profiles.has("sam")).toBe(true);
    expect(store.profiles.checkWebPassword("sam", "long enough")).toBe(true);
    expect(store.profiles.welcomePending("sam")).toBe(true);
    expect(store.invites.list(NOW)[0]).toMatchObject({ uses: 1, joined: ["sam"] });
    // not the same rule as a profile the admin adds: that one has nothing pending
    store.profiles.create("added", "long enough");
    expect(store.profiles.welcomePending("added")).toBe(false);
  });

  it("gives one profile per use and then refuses", () => {
    const code = createInvite(getStore(), { maxUses: 2 }, NOW);
    join(code, "one");
    join(code, "two");
    expect(() => join(code, "three")).toThrow(InviteError);
    expect(getStore().profiles.has("three")).toBe(false);
    expect(getStore().invites.list(NOW)[0]).toMatchObject({ uses: 2, joined: ["one", "two"], status: "used" });
  });

  it("checks the code before anything else, and says what is wrong with it", () => {
    const store = getStore();
    const expired = createInvite(store, { days: 1 }, NOW);
    const cancelled = createInvite(store, {}, NOW);
    store.invites.revoke(cancelled, NOW);
    const problem = (code: string, now = NOW) => { try { join(code, "", "", now); } catch (e) { return (e as InviteError).problem; } };
    expect(problem("")).toBe("unknown");
    expect(problem("WRONGCODE234")).toBe("unknown");
    expect(problem(expired, NOW + 2 * DAY)).toBe("expired");
    expect(problem(cancelled)).toBe("revoked");
    expect(() => join("WRONGCODE234")).toThrow(/not valid/);
  });

  it("keeps a code that was not used when the name or the password is refused", () => {
    const store = getStore();
    const code = createInvite(store, {}, NOW);
    expect(() => join(code, "no spaces")).toThrow(SettingsError);
    expect(() => join(code, "")).toThrow(SettingsError);
    expect(() => join(code, "sam", "short")).toThrow(/at least 8/);
    expect(() => signUp(store, { code, name: "sam", password: "long enough", confirm: "different" }, NOW)).toThrow(/not the same/);
    expect(store.invites.check(code, NOW)).toBe("active");
    expect(store.invites.list(NOW)[0].uses).toBe(0);
    expect(store.profiles.names()).toEqual([]);
  });

  it("refuses a name that is taken, in any case, without using the code", () => {
    const store = getStore();
    store.profiles.create("MED", "long enough");
    const code = createInvite(store, {}, NOW);
    expect(() => join(code, "med")).toThrow(/taken/);
    expect(store.invites.check(code, NOW)).toBe("active");
    expect(join(code, "other")).toBe("other");
  });

  it("makes no profile when the use of the code fails after it was checked", () => {
    const store = getStore();
    const code = createInvite(store, {}, NOW);
    join(code, "first");
    // a second sign-up that passed the check before the first one finished: the use is refused and the profile goes with it
    jest.spyOn(store.invites, "check").mockReturnValueOnce("active");
    expect(() => join(code, "second")).toThrow(InviteError);
    expect(store.profiles.has("second")).toBe(false);
  });
});

describe("the welcome flow", () => {
  it("is pending until it is cleared, and a database from before it existed has none pending", () => {
    const store = getStore();
    store.profiles.create("sam", "long enough");
    expect(store.profiles.welcomePending("sam")).toBe(false);
    store.profiles.setWelcomePending("sam", true);
    expect(store.profiles.welcomePending("sam")).toBe(true);
    store.profiles.setWelcomePending("sam", false);
    expect(store.profiles.welcomePending("sam")).toBe(false);
    expect(store.profiles.welcomePending("nobody")).toBe(false);
  });

  it("adds the column to a database made without it", () => {
    closeStore();
    const file = path.join(dir, "old.db");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE profiles (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, web_password_hash TEXT) WITHOUT ROWID; INSERT INTO profiles VALUES ('old', 1, NULL);");
    old.close();
    const store = SqliteStore.open(file);
    expect(store.profiles.has("old")).toBe(true);
    expect(store.profiles.welcomePending("old")).toBe(false);
    store.close();
  });
});
