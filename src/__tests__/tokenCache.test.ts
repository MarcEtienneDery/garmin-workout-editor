import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenCache } from "../shared/tokenCache";
import { closeStore, getStore } from "../shared/store";

const EMAIL = "me@example.com";
const DAY = 86_400_000;
const tokens = { oauth1: { token: "t1", secret: "s1" }, oauth2: { access_token: "a2", refresh_token: "r2" } };

let dir: string;
let dataDir: string; // the profile's data directory, as a GarminClient is given it
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-cache-"));
  dataDir = path.join(dir, "data", "MED");
  saved = process.env.GARMIN_STORE_PATH;
  process.env.GARMIN_STORE_PATH = path.join(dir, "data", "garmin.db");
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  closeStore();
  if (saved === undefined) delete process.env.GARMIN_STORE_PATH; else process.env.GARMIN_STORE_PATH = saved;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const legacy = (over: Record<string, unknown> = {}) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, ".garmin-token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2, timestamp: Date.now() - DAY, email: EMAIL, ...over }, null, 2));
  return file;
};

describe("the Garmin token cache", () => {
  it("keeps the tokens in the database and writes no file, not even the directory", () => {
    const cache = new TokenCache(dataDir);
    cache.saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(getStore().tokens.get("MED")).toEqual({ email: EMAIL, data: { oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 }, savedAt: expect.any(Number) });
    expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 });
    expect(new TokenCache(dataDir).hasCachedToken(EMAIL)).toBe(true);
  });

  it("does not hand the tokens of one account to another, nor expired ones", () => {
    const cache = new TokenCache(dataDir);
    cache.saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    expect(cache.loadToken("someone@else.com")).toBeNull();
    expect(cache.hasCachedToken("someone@else.com")).toBe(false);
    expect(cache.loadToken(EMAIL)).not.toBeNull(); // the other account's look did not clear it

    getStore().tokens.put("MED", EMAIL, { oauth1Token: 1, oauth2Token: 2 }, Date.now() - 8 * DAY);
    expect(cache.hasCachedToken(EMAIL)).toBe(false);
    expect(cache.loadToken(EMAIL)).toBeNull(); // too old: a new login is due
    expect(getStore().tokens.get("MED")).toBeNull(); // and the stale row is gone
  });

  it("keeps each profile's tokens apart", () => {
    new TokenCache(path.join(dir, "data", "MED")).saveToken(EMAIL, "a", "b");
    new TokenCache(path.join(dir, "data", "SAM")).saveToken("sam@example.com", "c", "d");
    expect(new TokenCache(path.join(dir, "data", "MED")).loadToken(EMAIL)).toEqual({ oauth1Token: "a", oauth2Token: "b" });
    expect(new TokenCache(path.join(dir, "data", "SAM")).loadToken("sam@example.com")).toEqual({ oauth1Token: "c", oauth2Token: "d" });
    new TokenCache(path.join(dir, "data", "MED")).clearToken();
    expect(new TokenCache(path.join(dir, "data", "MED")).loadToken(EMAIL)).toBeNull();
    expect(new TokenCache(path.join(dir, "data", "SAM")).hasCachedToken("sam@example.com")).toBe(true);
  });

  it("clears the tokens, and is quiet about clearing what was never there", () => {
    const cache = new TokenCache(dataDir);
    expect(() => cache.clearToken()).not.toThrow(); // no database, no file
    expect(fs.existsSync(process.env.GARMIN_STORE_PATH!)).toBe(false); // and looking did not create one
    cache.saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    cache.clearToken();
    expect(cache.hasCachedToken(EMAIL)).toBe(false);
  });

  it("does not create a database just to look for tokens", () => {
    expect(new TokenCache(dataDir).loadToken(EMAIL)).toBeNull();
    expect(new TokenCache(dataDir).hasCachedToken(EMAIL)).toBe(false);
    expect(fs.existsSync(process.env.GARMIN_STORE_PATH!)).toBe(false);
  });

  describe("a cache file left by an earlier version", () => {
    it("is taken into the database the first time it is looked at, and then deleted, so nobody logs in again", () => {
      const file = legacy();
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 });
      expect(fs.existsSync(file)).toBe(false);
      expect(getStore().tokens.get("MED")!.email).toBe(EMAIL);
      expect(getStore().tokens.get("MED")!.savedAt).toBeLessThan(Date.now() - DAY / 2); // the age of the file's login is kept, not reset
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 }); // now from the database
    });

    it("is also taken in when only asked whether a token exists", () => {
      const file = legacy();
      expect(new TokenCache(dataDir).hasCachedToken(EMAIL)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    });

    it("keeps its age: an expired file is moved in and then found expired, not renewed", () => {
      legacy({ timestamp: Date.now() - 9 * DAY });
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toBeNull();
    });

    it("is left alone when it cannot be read, and an older file never replaces the database's login", () => {
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, ".garmin-token-cache.json");
      fs.writeFileSync(file, "{ not json");
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toBeNull();
      expect(fs.existsSync(file)).toBe(true);

      new TokenCache(dataDir).saveToken(EMAIL, "fresh1", "fresh2"); // a login replaces the old file for good
      expect(fs.existsSync(file)).toBe(false);
      const older = legacy({ oauth1Token: "old1", oauth2Token: "old2" }); // a day old
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: "fresh1", oauth2Token: "fresh2" }); // not overwritten by the older file
      expect(fs.existsSync(older)).toBe(false); // and the file does not linger
    });

    it("replaces the database's login when it is newer: a login made elsewhere and copied in by hand", () => {
      getStore().tokens.put("MED", EMAIL, { oauth1Token: "stale1", oauth2Token: "stale2" }, Date.now() - 3 * DAY);
      const copied = legacy({ oauth1Token: "new1", oauth2Token: "new2", timestamp: Date.now() - 1000 });
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: "new1", oauth2Token: "new2" });
      expect(fs.existsSync(copied)).toBe(false);
      expect(new TokenCache(dataDir).loadToken(EMAIL)).toEqual({ oauth1Token: "new1", oauth2Token: "new2" }); // and it stays in the database
    });

    it("is removed by clearToken too", () => {
      const file = legacy();
      new TokenCache(dataDir).clearToken();
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});
