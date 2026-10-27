import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const connect = {
  login: jest.fn(),
  getUserProfile: jest.fn(),
  loadToken: jest.fn(),
  exportToken: jest.fn(),
};
jest.mock("@flow-js/garmin-connect", () => ({ GarminConnect: jest.fn().mockImplementation(() => connect) }));

import { GarminClient, LOGIN_COOLDOWN_MS } from "../shared/garminClient";
import { TokenCache } from "../shared/tokenCache";
import { closeStore } from "../shared/store";

const EMAIL = "me@example.com";
const tokens = { oauth1: { token: "t1" }, oauth2: { access_token: "a2" } };
const tooMany = () => new Error('ERROR: (429), Too Many Requests, {"error":{"status-code":"429"}}');

let dir: string;
let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-auth-"));
  dataDir = path.join(dir, "data", "MED");
  saved = process.env.GARMIN_STORE_PATH;
  process.env.GARMIN_STORE_PATH = path.join(dir, "data", "garmin.db");
  for (const fn of Object.values(connect)) fn.mockReset();
  connect.getUserProfile.mockResolvedValue({ userName: "tester" });
  connect.exportToken.mockReturnValue({ oauth1: tokens.oauth1, oauth2: tokens.oauth2 });
  for (const level of ["log", "warn", "error"] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  closeStore();
  if (saved === undefined) delete process.env.GARMIN_STORE_PATH; else process.env.GARMIN_STORE_PATH = saved;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const client = () => new GarminClient(EMAIL, "pw", false, dataDir);
const cache = () => new TokenCache(dataDir);
const cached = () => cache().hasCachedToken(EMAIL);

describe("Garmin authentication when Garmin throttles or refuses", () => {
  it("keeps the cached token, and does not log in again, when checking it gets a 429", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    connect.getUserProfile.mockRejectedValueOnce(tooMany());
    const garmin = client();

    expect(await garmin.ensureAuthenticated()).toBe(false);
    expect(connect.login).not.toHaveBeenCalled();
    expect(cached()).toBe(true);
    expect(garmin.authError().message).toMatch(/rate limiting logins \(HTTP 429, Too Many Requests\)/);
  });

  it("keeps the cached token when Garmin is down or unreachable", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    connect.getUserProfile.mockRejectedValueOnce(new Error("ERROR: (503), Service Unavailable, {}"));
    expect(await client().authenticate()).toBe(false);
    connect.getUserProfile.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    expect(await client().authenticate()).toBe(false);

    expect(connect.login).not.toHaveBeenCalled();
    expect(cached()).toBe(true);
  });

  it("logs in afresh, and replaces the cache, when the cached token is refused", async () => {
    cache().saveToken(EMAIL, { token: "old" }, { access_token: "old" });
    connect.getUserProfile.mockRejectedValueOnce(new Error("ERROR: (401), Unauthorized, {}"));
    connect.login.mockResolvedValue(undefined);

    expect(await client().authenticate()).toBe(true);
    expect(connect.login).toHaveBeenCalledTimes(1);
    expect(cache().loadToken(EMAIL)).toEqual({ oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 });
  });

  it("clears the cache when a fresh login fails for a reason that is not throttling", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    connect.getUserProfile.mockRejectedValueOnce(new Error("ERROR: (401), Unauthorized, {}"));
    connect.login.mockRejectedValue(new Error("login failed (INVALID_USERNAME_PASSWORD), please check username and password"));
    const garmin = client();

    expect(await garmin.authenticate()).toBe(false);
    expect(cached()).toBe(false);
    expect(garmin.authError().message).toMatch(/check the profile credentials/);
  });

  it("leaves nothing to clear and says 'rate limiting' when a fresh login gets a 429", async () => {
    connect.login.mockRejectedValue(tooMany());
    const garmin = client();

    expect(await garmin.authenticate()).toBe(false);
    expect(garmin.authError().message).toMatch(/rate limiting logins/);
    expect(garmin.authError().message).not.toMatch(/credentials/);
  });

  it("does not try a fresh login again for a minute after a 429, then does", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-26T23:18:00Z") });
    connect.login.mockRejectedValueOnce(tooMany()).mockResolvedValue(undefined);
    const garmin = client();

    expect(await garmin.authenticate()).toBe(false);
    expect(connect.login).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(20_000);
    expect(await garmin.authenticate()).toBe(false);
    expect(connect.login).toHaveBeenCalledTimes(1); // Garmin was not asked
    expect(garmin.authError().message).toMatch(/try again in 40 seconds/);

    jest.advanceTimersByTime(LOGIN_COOLDOWN_MS - 20_000);
    expect(await garmin.authenticate()).toBe(true);
    expect(connect.login).toHaveBeenCalledTimes(2);
    expect(cached()).toBe(true);
  });

  it("still uses a good cached token during the cooldown", async () => {
    connect.login.mockRejectedValueOnce(tooMany());
    const garmin = client();
    expect(await garmin.authenticate()).toBe(false);

    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2); // a login made elsewhere (the other process)
    expect(await garmin.authenticate()).toBe(true);
    expect(connect.login).toHaveBeenCalledTimes(1);
  });

  it("forgets the last failure once authentication works", async () => {
    connect.login.mockRejectedValueOnce(tooMany());
    const garmin = client();
    await garmin.authenticate();
    garmin["loginBlockedUntil"] = 0;
    connect.login.mockResolvedValue(undefined);

    expect(await garmin.authenticate()).toBe(true);
    expect(garmin.authError().message).toMatch(/check the profile credentials/);
  });
});
