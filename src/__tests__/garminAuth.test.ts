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
import { closeStore, getStore } from "../shared/store";
import { removeGarminLogin } from "../shared/accounts";

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

describe("the cached token", () => {
  it("is used however old it is", async () => {
    getStore().tokens.put("MED", EMAIL, { oauth1Token: tokens.oauth1, oauth2Token: tokens.oauth2 }, Date.now() - 30 * 86_400_000);

    expect(await client().authenticate()).toBe(true);
    expect(connect.login).not.toHaveBeenCalled();
    expect(connect.loadToken).toHaveBeenCalledWith(tokens.oauth1, tokens.oauth2);
  });

  it("is replaced by the access token the library got when it refreshed the old one", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    connect.exportToken.mockReturnValue({ oauth1: tokens.oauth1, oauth2: { access_token: "refreshed" } });

    expect(await client().authenticate()).toBe(true);
    expect(cache().loadToken(EMAIL)).toEqual({ oauth1Token: tokens.oauth1, oauth2Token: { access_token: "refreshed" } });
  });

  it("is left as it is when the library did not refresh it", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    const put = jest.spyOn(getStore().tokens, "put");

    expect(await client().authenticate()).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the log of calls to Garmin", () => {
  const withHttp = (adapter: jest.Mock) => {
    const http: any = { defaults: { adapter }, interceptors: { response: { use: () => undefined } } };
    (connect as any).client = { client: http };
    const garmin = client();
    delete (connect as any).client;
    return { http, garmin };
  };
  const lines = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("📡"));

  it("has a line for each call: profile, method, host and path, status and time, and never the query string", async () => {
    const { http } = withHttp(jest.fn().mockResolvedValue({ status: 200, data: {} }));
    const config = { method: "post", url: "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0?oauth_signature=SECRET&oauth_token=T" };

    expect(await http.defaults.adapter(config)).toEqual({ status: 200, data: {} });
    expect(lines()).toEqual([expect.stringMatching(/^📡 Garmin MED POST connectapi\.garmin\.com\/oauth-service\/oauth\/exchange\/user\/2\.0 → 200 \d+ms$/)]);
  });

  it("says what a refusal was, with when Garmin asks to come back, and still throws it", async () => {
    const refused = Object.assign(new Error("ERROR: (429)"), { response: { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "120" } } });
    const { http } = withHttp(jest.fn().mockRejectedValue(refused));

    await expect(http.defaults.adapter({ method: "post", url: "https://sso.garmin.com/mobile/api/login?clientId=GCM" })).rejects.toBe(refused);
    expect(lines()).toEqual([expect.stringMatching(/^📡 Garmin MED POST sso\.garmin\.com\/mobile\/api\/login → 429 Too Many Requests \(retry-after 120s\) \d+ms$/)]);
  });

  it("names the network error when Garmin did not answer", async () => {
    const { http } = withHttp(jest.fn().mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })));

    await expect(http.defaults.adapter({ method: "get", url: "https://connectapi.garmin.com/x" })).rejects.toThrow("socket hang up");
    expect(lines()).toEqual([expect.stringMatching(/GET connectapi\.garmin\.com\/x → ECONNRESET \d+ms$/)]);
  });

  it("can be turned off with GARMIN_CALL_LOG=0", async () => {
    process.env.GARMIN_CALL_LOG = "0";
    try {
      const adapter = jest.fn().mockResolvedValue({ status: 200 });
      const { http } = withHttp(adapter);
      expect(http.defaults.adapter).toBe(adapter);
    } finally {
      delete process.env.GARMIN_CALL_LOG;
    }
  });
});

describe("Garmin 429s are recorded for the page", () => {
  const limit = () => getStore().limits.get("MED");
  beforeEach(() => { getStore(); }); // the database exists, as it does wherever a profile has a login

  it("records a login Garmin answers with 429, and counts each refusal once", async () => {
    connect.login.mockRejectedValue(tooMany());
    const garmin = client();

    expect(await garmin.ensureAuthenticated()).toBe(false);
    expect(limit()).toEqual({ since: expect.any(Number), lastAt: expect.any(Number), count: 1 });
  });

  it("records a 429 met while checking the cached token", async () => {
    cache().saveToken(EMAIL, tokens.oauth1, tokens.oauth2);
    connect.getUserProfile.mockRejectedValueOnce(tooMany());

    await client().ensureAuthenticated();
    expect(limit()?.count).toBe(1);
  });

  it("clears the record when a login works again", async () => {
    getStore().limits.record("MED");
    connect.login.mockResolvedValue(undefined);

    expect(await client().ensureAuthenticated()).toBe(true);
    expect(limit()).toBeNull();
  });

  it("does not record other failures", async () => {
    connect.login.mockRejectedValue(new Error("ERROR: (400), Bad Request, {}"));
    await client().ensureAuthenticated();
    expect(limit()).toBeNull();
  });

  it("records a 429 on any request of the library, and clears it when an API call works", async () => {
    let onOk: (r: any) => any = (r) => r, onFail: (e: any) => any = (e) => Promise.reject(e);
    (connect as any).client = { client: { interceptors: { response: { use: (ok: any, fail: any) => { onOk = ok; onFail = fail; } } } } };
    const garmin = client();
    delete (connect as any).client;

    await expect(onFail(tooMany())).rejects.toThrow(/429/);
    expect(limit()?.count).toBe(1);
    onOk({ config: { url: "https://sso.garmin.com/mobile/sso/en/sign-in" } }); // the sign-in page loading says nothing
    expect(limit()?.count).toBe(1);
    onOk({ config: { url: "https://connectapi.garmin.com/userprofile-service/socialProfile" } });
    expect(limit()).toBeNull();
    expect(garmin).toBeDefined();
  });

  it("forgets the record when the login is removed or changed", () => {
    const store = getStore();
    store.limits.record("MED");
    removeGarminLogin(store, "MED");
    expect(store.limits.get("MED")).toBeNull();
  });
});
