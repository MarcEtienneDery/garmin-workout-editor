/**
 * The HTTP API's contract: who may call what, what each call answers, the headers it sends, and what it refuses.
 *
 * Calls sign in with HTTP Basic (or a session cookie in a context of its own). This file sends no wrong password, so the server's
 * per-address throttle is never touched. Changes only happen in profiles made for the test; alice's data is only read, and the
 * refused calls against it change nothing.
 */
import { request as pwRequest } from "@playwright/test";
import { test, expect, CSRF, PASSWORD, ADMIN_TOKEN, daysAgo } from "../support/fixtures";

// Every call here goes to a server shared with the other runs, which can take several seconds to answer on a busy machine: a
// test that makes many calls gets up to ninety seconds.
test.describe.configure({ timeout: 90_000 });

const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
/** Headers that sign a call in as a login, with the header every non-GET needs. */
const as = (user: string, secret: string): Record<string, string> => ({ ...CSRF, Authorization: basic(user, secret) });
const ALICE = () => as("alice", PASSWORD);
const BOB = () => as("bob", PASSWORD);
const ADMIN = () => as("admin", ADMIN_TOKEN);
const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const enc = (path: string) => encodeURIComponent(path);

/** A plan that validates. */
const goodPlan = (name = "Easy run") =>
  JSON.stringify({
    weekStart: "2026-11-02",
    weekEnd: "2026-11-08",
    workouts: [{ workoutName: name, workoutType: "running", scheduledDate: "2026-11-03", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 600 }] }],
  });
/** A plan that does not: a workout with no name and a step type that does not exist. */
const badPlan = () => JSON.stringify({ workouts: [{ workoutName: "", steps: [{ stepType: "bogus", targetType: "x" }] }] });

const cookieHeaders = (res: { headersArray(): { name: string; value: string }[] }) =>
  res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

test.describe("a login is needed", () => {
  test("every API route answers 401 without a login, before the route is looked up", async ({ request }) => {
    const probe = `workout-plans/never-${unique()}.json`;
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/files"],
      ["GET", `/api/file?path=${enc("workout-plans/shared-base.json")}`],
      ["GET", `/api/history?path=${enc("workout-plans/shared-base.json")}`],
      ["GET", "/api/schema"],
      ["GET", "/api/garmin"],
      ["GET", "/api/settings"],
      ["GET", "/api/today"],
      ["GET", "/api/activities"],
      ["GET", "/api/nutrition"],
      ["GET", "/api/weight"],
      ["GET", "/api/nope"],
      ["POST", "/api/profiles", { name: unique(), password: PASSWORD, confirm: PASSWORD }],
      ["PUT", `/api/file?path=${enc(probe)}`, { text: goodPlan(), create: true }],
      ["DELETE", `/api/file?path=${enc(probe)}`],
      ["POST", "/api/rename", { from: probe, to: probe + "x" }],
      ["POST", "/api/validate", { text: "{}" }],
      ["POST", "/api/nutrition", { action: "add" }],
      ["POST", "/api/settings/goals", { action: "clear" }],
    ];
    for (const [method, url, data] of calls) {
      const res = await request.fetch(url, { method, headers: CSRF, data });
      expect(res.status(), `${method} ${url}`).toBe(401);
      expect(await res.json(), `${method} ${url}`).toEqual({ error: "Authentication required" });
    }
    const admin = await request.get(`/api/file?path=${enc(probe)}`, { headers: ADMIN() });
    expect(admin.status()).toBe(404); // the PUT without a login created nothing
  });

  test("the session, sign-out and health routes answer without a login", async ({ request }) => {
    const session = await request.get("/api/session");
    expect(session.status()).toBe(200);
    expect(await session.json()).toEqual({ authRequired: true, user: null });
    const logout = await request.post("/api/logout", { headers: CSRF });
    expect(logout.status()).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    const health = await request.get("/healthz");
    expect(health.status()).toBe(200);
    expect(await health.text()).toBe("ok");
  });

  test("only HTTP Basic and the session cookie are accepted: a Bearer token or a token in the URL is refused", async ({ request }) => {
    const bearer = await request.get("/api/files", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(bearer.status()).toBe(401);
    const query = await request.get(`/api/files?token=${ADMIN_TOKEN}`);
    expect(query.status()).toBe(401);
    const queryPassword = await request.get(`/api/files?password=${enc(PASSWORD)}&user=alice`);
    expect(queryPassword.status()).toBe(401);
  });

  test("a non-GET call without the X-Requested-With header is refused with 403, before the login is checked", async ({ request }) => {
    const probe = `workout-plans/never-${unique()}.json`;
    const writes: [string, string, unknown?][] = [
      ["POST", "/api/validate", { text: "{}" }],
      ["PUT", `/api/file?path=${enc(probe)}`, { text: goodPlan(), create: true }],
      ["DELETE", `/api/file?path=${enc(probe)}`],
      ["POST", "/api/rename", { from: probe, to: probe + "x" }],
      ["POST", "/api/profiles", { name: unique(), password: PASSWORD, confirm: PASSWORD }],
    ];
    for (const [method, url, data] of writes) {
      const none = await request.fetch(url, { method, data });
      expect(none.status(), `${method} ${url} with no login`).toBe(403);
      expect(await none.json()).toEqual({ error: "Missing X-Requested-With header" });
      const wrong = await request.fetch(url, { method, headers: { "X-Requested-With": "fetch" }, data });
      expect(wrong.status(), `${method} ${url} with the wrong header`).toBe(403);
    }
  });

  test("with a login but no header, writes are refused and the file is unchanged; reads still work", async ({ request, profile }) => {
    const path = `workout-plans/${unique()}.json`;
    const made = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Original"), create: true } });
    expect(made.status()).toBe(201);
    const auth = { Authorization: basic(profile.name, PASSWORD) };
    const put = await request.put(`/api/file?path=${enc(path)}`, { headers: auth, data: { text: goodPlan("Changed"), version: 1 } });
    expect(put.status()).toBe(403);
    expect((await request.delete(`/api/file?path=${enc(path)}`, { headers: auth })).status()).toBe(403);
    expect((await request.post("/api/rename", { headers: auth, data: { from: path, to: path + "x" } })).status()).toBe(403);
    expect((await request.post("/api/validate", { headers: auth, data: { text: "{}" } })).status()).toBe(403);
    const read = await request.get(`/api/file?path=${enc(path)}`, { headers: auth });
    expect(read.status()).toBe(200);
    expect((await read.json()).text).toBe(goodPlan("Original"));
  });
});

test.describe("the page and its scripts", () => {
  test("the page and every script it names load without a login", async ({ request }) => {
    const page = await request.get("/");
    expect(page.status()).toBe(200);
    expect(page.headers()["content-type"]).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain('<div id="login" hidden>');
    const scripts = [...html.matchAll(/<script\s+src="(\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(5);
    for (const src of scripts) {
      // the page's own scripts carry the version stamp; the vendored libraries keep their own names
      if (!src.startsWith("/vendor/")) expect(src, "scripts are stamped with the page's version").toMatch(/\?v=[0-9a-f]{10}$/);
      const js = await request.get(src);
      expect(js.status(), src).toBe(200);
      expect(js.headers()["content-type"], src).toBe("text/javascript; charset=utf-8");
    }
    const icon = await request.get("/icon.svg");
    expect(icon.headers()["content-type"]).toBe("image/svg+xml");
    const touch = await request.get("/apple-touch-icon.png");
    expect(touch.headers()["content-type"]).toBe("image/png");
  });

  test("the page holds no data and no secret, whoever asks for it", async ({ request }) => {
    const html = await (await request.get("/")).text();
    for (const secret of [ADMIN_TOKEN, PASSWORD, "scrypt$"]) expect(html).not.toContain(secret);
    for (const seeded of ["Tempo intervals", "Oatmeal", "alice-run-block"]) expect(html).not.toContain(seeded);
  });

  test("a file outside the page's folder is never served, and a page path takes only GET", async ({ request }) => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fserver.ts", "/vendor/../../package.json", "/no-such-page.html", "/src/web/server.ts"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(res.headers()["content-type"], path).toBe("text/plain");
      expect(await res.text()).toBe("Not found");
    }
    const post = await request.post("/", { headers: CSRF });
    expect(post.status()).toBe(405);
    expect(await post.json()).toEqual({ error: "Method not allowed" });
  });

  test("an unknown API route answers 404 once a login is given", async ({ request, profile }) => {
    const res = await request.get("/api/no-such-thing", { headers: { Authorization: basic(profile.name, PASSWORD) } });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown API route" });
  });
});

test.describe("response headers", () => {
  test("the page is HTML that is not cached, and API answers are JSON that is never cached", async ({ request }) => {
    const page = await request.get("/");
    expect(page.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers()["cache-control"]).toBe("no-cache");
    const session = await request.get("/api/session");
    expect(session.headers()["content-type"]).toBe("application/json");
    expect(session.headers()["cache-control"]).toBe("no-store");
    const data = await request.get("/api/garmin", { headers: BOB() });
    expect(data.headers()["content-type"]).toBe("application/json");
    expect(data.headers()["cache-control"]).toBe("no-store");
  });

  test("a 401 does not ask the browser for its own login dialog", async ({ request }) => {
    const res = await request.get("/api/files");
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toBeUndefined();
  });

  test("the sign-in cookie is HttpOnly, SameSite=Strict and for the whole site, and not Secure over plain http", async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL });
    try {
      const res = await ctx.post("/api/login", { headers: CSRF, data: { user: "alice", password: PASSWORD } });
      expect(res.status()).toBe(200);
      const session = (cookieHeaders(res)).find((c) => c.startsWith("plan_editor_session="));
      expect(session).toBeDefined();
      expect(session).toMatch(/^plan_editor_session=[0-9a-f]{64}; /);
      expect(session).toContain("; Path=/");
      expect(session).toContain("; HttpOnly");
      expect(session).toContain("; SameSite=Strict");
      expect(session).toMatch(/; Max-Age=\d+/);
      expect(session).not.toContain("; Secure");
    } finally {
      await ctx.dispose();
    }
  });

  test("behind an HTTPS proxy (X-Forwarded-Proto) the sign-in cookie is also Secure", async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL });
    try {
      const res = await ctx.post("/api/login", { headers: { ...CSRF, "X-Forwarded-Proto": "https" }, data: { user: "alice", password: PASSWORD } });
      expect(res.status()).toBe(200);
      const session = (cookieHeaders(res)).find((c) => c.startsWith("plan_editor_session="));
      expect(session).toContain("; Secure");
    } finally {
      await ctx.dispose();
    }
  });

  test("signing out ends the session on the server: the old cookie is refused afterwards", async ({ baseURL, profile }) => {
    const ctx = await pwRequest.newContext({ baseURL });
    const again = await pwRequest.newContext({ baseURL });
    try {
      const login = await ctx.post("/api/login", { headers: CSRF, data: { user: profile.name, password: PASSWORD } });
      expect(login.status()).toBe(200);
      const value = (cookieHeaders(login)).find((c) => c.startsWith("plan_editor_session="))!.split(";")[0].slice("plan_editor_session=".length);
      const cookie = { Cookie: `plan_editor_session=${value}` };
      expect((await ctx.get("/api/files", { headers: cookie })).status()).toBe(200);
      const out = await ctx.post("/api/logout", { headers: { ...CSRF, ...cookie } });
      expect(out.status()).toBe(200);
      expect((cookieHeaders(out)).some((c) => c.startsWith("plan_editor_session=;") && c.includes("Max-Age=0"))).toBeTruthy();
      expect((await again.get("/api/files", { headers: cookie })).status()).toBe(401);
    } finally {
      await ctx.dispose();
      await again.dispose();
    }
  });

  test("a browser that signed out is refused even with a login header, while a script with the same login is not", async ({ request }) => {
    const signedOut = { ...BOB(), Cookie: "plan_editor_signed_out=1" };
    expect((await request.get("/api/files", { headers: signedOut })).status()).toBe(401);
    expect((await request.get("/api/files", { headers: BOB() })).status()).toBe(200);
  });
});

test.describe("who sees which files", () => {
  test("a login sees its own plans and the shared one, and nobody else's", async ({ request, profile }) => {
    const mine = `workout-plans/${unique()}.json`;
    expect((await profile.api.put(`/api/file?path=${enc(mine)}`, { data: { text: goodPlan(), create: true } })).status()).toBe(201);

    const listOf = async (headers: Record<string, string>) => (await (await request.get("/api/files", { headers })).json()).files as { path: string; owner: string | null }[];

    const alice = await listOf(ALICE());
    expect(alice.map((f) => f.path)).toEqual(expect.arrayContaining(["workout-plans/alice-run-block.json", "workout-plans/alice-someday.json", "workout-plans/shared-base.json"]));
    for (const f of alice) expect([null, "alice"], f.path).toContain(f.owner);

    const bob = await listOf(BOB());
    expect(bob.map((f) => f.path)).toContain("workout-plans/shared-base.json");
    expect(bob.map((f) => f.path)).not.toContain("workout-plans/alice-run-block.json");
    for (const f of bob) expect([null, "bob"], f.path).toContain(f.owner);

    const own = await listOf({ ...CSRF, Authorization: basic(profile.name, PASSWORD) });
    expect(own.map((f) => f.path)).toEqual(expect.arrayContaining([mine, "workout-plans/shared-base.json"]));
    expect(own.map((f) => f.path)).not.toContain("workout-plans/alice-run-block.json");
    for (const f of own) expect([null, profile.name], f.path).toContain(f.owner);
  });

  test("the admin sees every profile's plans", async ({ admin, profile }) => {
    const mine = `workout-plans/${unique()}.json`;
    expect((await profile.api.put(`/api/file?path=${enc(mine)}`, { data: { text: goodPlan(), create: true } })).status()).toBe(201);
    const paths = (await (await admin.get("/api/files")).json()).files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["workout-plans/alice-run-block.json", "workout-plans/shared-base.json", mine]));
  });

  test("reading another profile's file is refused with 403, and no text is returned", async ({ request }) => {
    const refused = await request.get(`/api/file?path=${enc("workout-plans/alice-run-block.json")}`, { headers: BOB() });
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body.error).toBe("workout-plans/alice-run-block.json belongs to another profile.");
    expect(JSON.stringify(body)).not.toContain("Tempo intervals");

    expect((await request.get(`/api/file?path=${enc("data/alice/none.json")}`, { headers: BOB() })).status()).toBe(403);
    expect((await request.get(`/api/history?path=${enc("workout-plans/alice-run-block.json")}`, { headers: BOB() })).status()).toBe(403);
    expect((await request.get(`/api/file?path=${enc(`workout-plans/never-${unique()}.json`)}`, { headers: BOB() })).status()).toBe(404);

    const allowed = await request.get(`/api/file?path=${enc("workout-plans/alice-run-block.json")}`, { headers: ALICE() });
    expect(allowed.status()).toBe(200);
    expect((await allowed.json()).text).toContain("Tempo intervals");
  });

  test("another profile's files cannot be saved, renamed or deleted, and alice's file is unchanged afterwards", async ({ request, admin }) => {
    const before = await (await admin.get(`/api/file?path=${enc("workout-plans/alice-someday.json")}`)).json();
    const put = await request.put(`/api/file?path=${enc("workout-plans/alice-someday.json")}`, { headers: BOB(), data: { text: goodPlan("Hijacked"), version: before.version } });
    expect(put.status()).toBe(403);
    const del = await request.delete(`/api/file?path=${enc("workout-plans/alice-someday.json")}`, { headers: BOB() });
    expect(del.status()).toBe(403);
    const ren = await request.post("/api/rename", { headers: BOB(), data: { from: "workout-plans/alice-someday.json", to: `workout-plans/hijack-${unique()}.json` } });
    expect(ren.status()).toBe(403);
    const intoAlice = await request.put(`/api/file?path=${enc(`data/alice/${unique()}.json`)}`, { headers: BOB(), data: { text: "{}", create: true } });
    expect(intoAlice.status()).toBe(403);

    const after = await (await admin.get(`/api/file?path=${enc("workout-plans/alice-someday.json")}`)).json();
    expect(after).toEqual(before);
  });

  test("the profile parameter cannot reach another profile's data: a login always reads its own", async ({ request, admin }) => {
    const yesterday = daysAgo(1);
    const bob = BOB();
    const activities = await (await request.get("/api/activities?profile=alice", { headers: bob })).json();
    expect(activities.profile).toBe("bob");
    expect(activities.activities).toEqual([]);
    const nutrition = await (await request.get(`/api/nutrition?profile=alice&date=${yesterday}`, { headers: bob })).json();
    expect(nutrition.profile).toBe("bob");
    expect(nutrition.day.entries).toBe(0);
    expect((await (await request.get("/api/today?profile=alice", { headers: bob })).json()).profile).toBe("bob");
    expect((await (await request.get("/api/weight?profile=alice", { headers: bob })).json()).profile).toBe("bob");
    expect((await (await request.get("/api/settings?profile=alice", { headers: bob })).json()).profile).toBe("bob");

    // the same question as the admin, who may ask about any profile, has alice's five meals
    const asAdmin = await (await admin.get(`/api/nutrition?profile=alice&date=${yesterday}`)).json();
    expect(asAdmin.profile).toBe("alice");
    expect(asAdmin.day.entries).toBe(5);
  });

  test("a profile may write into its own data folder only", async ({ profile }) => {
    const own = `data/${profile.name}/${unique()}.json`;
    expect((await profile.api.put(`/api/file?path=${enc(own)}`, { data: { text: "{}", create: true } })).status()).toBe(201);
    const alice = await profile.api.put(`/api/file?path=${enc(`data/alice/${unique()}.json`)}`, { data: { text: "{}", create: true } });
    expect(alice.status()).toBe(403);
    const bob = await profile.api.put(`/api/file?path=${enc(`data/bob/${unique()}.json`)}`, { data: { text: "{}", create: true } });
    expect(bob.status()).toBe(403);
  });
});

test.describe("saving a file", () => {
  test("creating a plan answers version 1 and what the validator makes of it", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    const res = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), create: true } });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ path, version: 1, validation: { valid: true, errors: [], workoutCount: 1 } });
    const read = await (await profile.api.get(`/api/file?path=${enc(path)}`)).json();
    expect(read).toMatchObject({ path, text: goodPlan(), version: 1 });
  });

  test("a save with the version it was read at succeeds; a stale version is refused with 409 and changes nothing", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("One"), create: true } });
    const first = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Two"), version: 1 } });
    expect(first.status()).toBe(200);
    expect((await first.json()).version).toBe(2);
    const stale = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Three"), version: 1 } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toEqual({ error: `${path} changed since you opened it.` });
    expect((await (await profile.api.get(`/api/file?path=${enc(path)}`)).json()).text).toBe(goodPlan("Two"));
  });

  test("a save without a version overwrites the file", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("One"), create: true } });
    const res = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Overwritten") } });
    expect(res.status()).toBe(200);
    expect((await res.json()).version).toBe(2);
    expect((await (await profile.api.get(`/api/file?path=${enc(path)}`)).json()).text).toBe(goodPlan("Overwritten"));
  });

  test("creating a file that exists is refused with 409, and its text is kept", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Kept"), create: true } });
    const again = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("Lost"), create: true } });
    expect(again.status()).toBe(409);
    expect(await again.json()).toEqual({ error: `${path} already exists` });
    expect((await (await profile.api.get(`/api/file?path=${enc(path)}`)).json()).text).toBe(goodPlan("Kept"));
  });

  test("updating a file that does not exist is 404, and nothing is created", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    const res = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), version: 1 } });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: `File not found: ${path}` });
    expect((await profile.api.get(`/api/file?path=${enc(path)}`)).status()).toBe(404);
  });

  test("a save with no text, or text that is not JSON, is 400 and nothing is created", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    const none = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { create: true } });
    expect(none.status()).toBe(400);
    expect(await none.json()).toEqual({ error: "Missing text" });
    const notJson = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: "{nope", create: true } });
    expect(notJson.status()).toBe(400);
    expect((await notJson.json()).error).toMatch(/^Not valid JSON: /);
    expect((await profile.api.get(`/api/file?path=${enc(path)}`)).status()).toBe(404);
  });

  test("a plan that does not validate is kept, and the reply says what is wrong with it", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    const res = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: badPlan(), create: true } });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.validation.valid).toBe(false);
    expect(body.validation.errors.length).toBeGreaterThan(0);
    expect((await (await profile.api.get(`/api/file?path=${enc(path)}`)).json()).text).toBe(badPlan());
  });

  test("saving the text that is already there keeps its version", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), create: true } });
    const same = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), version: 1 } });
    expect(same.status()).toBe(200);
    expect((await same.json()).version).toBe(1);
  });

  test("DELETE removes the file, a second DELETE is 404, and no path is 400", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), create: true } });
    const del = await profile.api.delete(`/api/file?path=${enc(path)}`);
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ path, deleted: true });
    expect((await profile.api.get(`/api/file?path=${enc(path)}`)).status()).toBe(404);
    const again = await profile.api.delete(`/api/file?path=${enc(path)}`);
    expect(again.status()).toBe(404);
    expect(await again.json()).toEqual({ error: `File not found: ${path}` });
    const none = await profile.api.delete("/api/file");
    expect(none.status()).toBe(400);
    expect(await none.json()).toEqual({ error: "Missing path" });
  });

  test("a deleted file made again does not reuse an old version, so a stale editor is still refused", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("A"), create: true } });
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("B"), version: 1 } });
    await profile.api.delete(`/api/file?path=${enc(path)}`);
    const made = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("C"), create: true } });
    expect(made.status()).toBe(201);
    const version = (await made.json()).version;
    expect(version).toBeGreaterThan(2);
    const stale = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan("D"), version: 2 } });
    expect(stale.status()).toBe(409);
  });
});

test.describe("rename", () => {
  test("rename moves the file and keeps its text", async ({ profile }) => {
    const from = `workout-plans/${unique()}.json`;
    const to = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(from)}`, { data: { text: goodPlan("Moved"), create: true } });
    const res = await profile.api.post("/api/rename", { data: { from, to } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ from, to, version: 1 });
    expect((await profile.api.get(`/api/file?path=${enc(from)}`)).status()).toBe(404);
    expect((await (await profile.api.get(`/api/file?path=${enc(to)}`)).json()).text).toBe(goodPlan("Moved"));
  });

  test("rename onto an existing file is refused with 409, and both files stay", async ({ profile }) => {
    const from = `workout-plans/${unique()}.json`;
    const to = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(from)}`, { data: { text: goodPlan("From"), create: true } });
    await profile.api.put(`/api/file?path=${enc(to)}`, { data: { text: goodPlan("To"), create: true } });
    const res = await profile.api.post("/api/rename", { data: { from, to } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: `${to} already exists` });
    expect((await (await profile.api.get(`/api/file?path=${enc(from)}`)).json()).text).toBe(goodPlan("From"));
    expect((await (await profile.api.get(`/api/file?path=${enc(to)}`)).json()).text).toBe(goodPlan("To"));
  });

  test("renaming a file that does not exist is 404, and a rename with no source is 400", async ({ profile }) => {
    const missing = await profile.api.post("/api/rename", { data: { from: `workout-plans/${unique()}.json`, to: `workout-plans/${unique()}.json` } });
    expect(missing.status()).toBe(404);
    const none = await profile.api.post("/api/rename", { data: { to: `workout-plans/${unique()}.json` } });
    expect(none.status()).toBe(400);
    expect(await none.json()).toEqual({ error: "Missing path" });
  });

  test("a rename into another profile's folder is refused with 403, and the file stays where it was", async ({ profile }) => {
    const from = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(from)}`, { data: { text: goodPlan(), create: true } });
    const res = await profile.api.post("/api/rename", { data: { from, to: `data/alice/${unique()}.json` } });
    expect(res.status()).toBe(403);
    expect((await profile.api.get(`/api/file?path=${enc(from)}`)).status()).toBe(200);
  });
});

test.describe("validate and schema", () => {
  test("a valid plan validates and lists its workouts", async ({ request }) => {
    const res = await request.post("/api/validate", { headers: ALICE(), data: { text: goodPlan("Tuesday tempo") } });
    expect(res.status()).toBe(200);
    const { validation } = await res.json();
    expect(validation).toMatchObject({ valid: true, format: "plan", errors: [], workoutCount: 1 });
    expect(validation.workouts[0]).toMatchObject({ name: "Tuesday tempo", type: "running", scheduledDate: "2026-11-03" });
  });

  test("a plan with errors is answered with them, not refused", async ({ request }) => {
    const res = await request.post("/api/validate", { headers: ALICE(), data: { text: badPlan() } });
    expect(res.status()).toBe(200);
    const { validation } = await res.json();
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  test("text that is not JSON is 400, a body that is not JSON is 400, and no text is 400", async ({ request }) => {
    const notJson = await request.post("/api/validate", { headers: ALICE(), data: { text: "{nope" } });
    expect(notJson.status()).toBe(400);
    expect((await notJson.json()).error).toMatch(/^Not valid JSON: /);
    const body = await request.post("/api/validate", { headers: { ...ALICE(), "Content-Type": "application/json" }, data: Buffer.from("{nope") });
    expect(body.status()).toBe(400);
    expect(await body.json()).toEqual({ error: "Request body is not valid JSON" });
    const none = await request.post("/api/validate", { headers: ALICE(), data: {} });
    expect(none.status()).toBe(400);
    expect(await none.json()).toEqual({ error: "Missing text" });
  });

  test("JSON that is not a plan is accepted with no validation, and a body that is not an object is 400", async ({ request }) => {
    const other = await request.post("/api/validate", { headers: ALICE(), data: { text: '{"a":1}' } });
    expect(other.status()).toBe(200);
    expect(await other.json()).toEqual({ validation: null });
    for (const raw of ["[1]", "null"]) {
      const res = await request.post("/api/validate", { headers: { ...ALICE(), "Content-Type": "application/json" }, data: Buffer.from(raw) });
      expect(res.status(), raw).toBe(400);
      expect(await res.json(), raw).toEqual({ error: "Request body must be a JSON object" });
    }
  });

  test("GET /api/schema describes a plan file for the editor", async ({ request }) => {
    const res = await request.get("/api/schema", { headers: ALICE() });
    expect(res.status()).toBe(200);
    const schema = await res.json();
    expect(schema.oneOf).toHaveLength(2);
    const plan = schema.oneOf[0];
    expect(plan.type).toBe("object");
    expect(plan.properties.workouts.type).toBe("array");
    const stepTypes = plan.properties.workouts.items.properties.steps.items.properties.stepType.enum;
    expect(stepTypes).toEqual(expect.arrayContaining(["warmup", "interval", "repeat", "cooldown"]));
  });
});

test.describe("paths", () => {
  const BAD = [
    "",
    "../workout-plans/x.json",
    "workout-plans/../x.json",
    "workout-plans/../../etc/passwd.json",
    "/workout-plans/x.json",
    "/etc/passwd.json",
    "workout-plans/x.txt",
    "workout-plans/x",
    "workout-plans/.x.json",
    "workout-plans//x.json",
    "workout-plans/",
    "workout-plans/\u0000.json",
    "workout-plans\\..\\x.json",
    "C:\\x.json",
    "./../x.json",
    "%2e%2e/x.json",
    "data/x.json",
    "data/../workout-plans/x.json",
  ];

  // one test per path, so a slow run shows which path failed and no single test makes many calls
  for (const path of BAD) {
    test(`a path of ${JSON.stringify(path)} is refused with 400 on every file route`, async ({ profile }) => {
      const get = await profile.api.get(`/api/file?path=${enc(path)}`);
      expect(get.status(), "GET").toBe(400);
      const put = await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), create: true } });
      expect(put.status(), "PUT").toBe(400);
      const del = await profile.api.delete(`/api/file?path=${enc(path)}`);
      expect(del.status(), "DELETE").toBe(400);
      const ren = await profile.api.post("/api/rename", { data: { from: path, to: `workout-plans/${unique()}.json` } });
      expect(ren.status(), "rename from").toBe(400);
    });
  }

  test("a path that climbs out of its own profile folder is refused", async ({ profile }) => {
    const climb = `data/${profile.name}/../alice/x.json`;
    expect((await profile.api.get(`/api/file?path=${enc(climb)}`)).status()).toBe(400);
    expect((await profile.api.put(`/api/file?path=${enc(climb)}`, { data: { text: "{}", create: true } })).status()).toBe(400);
  });

  test("a path that is a plan with a leading ./ is the same plan", async ({ profile }) => {
    const path = `workout-plans/${unique()}.json`;
    await profile.api.put(`/api/file?path=${enc(path)}`, { data: { text: goodPlan(), create: true } });
    const res = await profile.api.get(`/api/file?path=${enc(`./${path}`)}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).path).toBe(path);
  });
});

test.describe("profiles", () => {
  test("only the admin login can add a profile: a profile is refused with 403 and nothing is made", async ({ request, admin, profile }) => {
    const name = unique();
    const body = { name, password: PASSWORD, confirm: PASSWORD };
    const asBob = await request.post("/api/profiles", { headers: BOB(), data: body });
    expect(asBob.status()).toBe(403);
    expect(await asBob.json()).toEqual({ error: "Only the admin login can add a profile." });
    const asProfile = await profile.api.post("/api/profiles", { data: body });
    expect(asProfile.status()).toBe(403);
    const names = (await (await admin.get("/api/garmin")).json()).profiles;
    expect(names).not.toContain(name);
  });

  test("the admin adds a profile, which then signs in with its password", async ({ request, admin }) => {
    const name = unique();
    const made = await admin.post("/api/profiles", { data: { name, password: PASSWORD, confirm: PASSWORD } });
    expect(made.status()).toBe(201);
    const body = await made.json();
    expect(body.name).toBe(name);
    expect(body.profiles).toContain(name);
    expect(body.profileInfo[name]).toEqual({ garmin: false, renpho: false, webPassword: true, hasActivities: false, hasWellness: false, hasWeight: false });
    const signedIn = await request.get("/api/garmin", { headers: as(name, PASSWORD) });
    expect(signedIn.status()).toBe(200);
    expect((await signedIn.json()).user).toEqual({ admin: false, name });
  });

  test("a name already taken is refused with 409, whatever its case or surrounding spaces", async ({ admin, profile }) => {
    const upper = await admin.post("/api/profiles", { data: { name: profile.name.toUpperCase(), password: PASSWORD, confirm: PASSWORD } });
    expect(upper.status()).toBe(409);
    expect(await upper.json()).toEqual({ error: `Profile "${profile.name}" exists already.` });

    const padded = await admin.post("/api/profiles", { data: { name: "  ALICE  ", password: PASSWORD, confirm: PASSWORD } });
    expect(padded.status()).toBe(409);
    expect(await padded.json()).toEqual({ error: 'Profile "alice" exists already.' });

    const exact = await admin.post("/api/profiles", { data: { name: "bob", password: PASSWORD, confirm: PASSWORD } });
    expect(exact.status()).toBe(409);
    expect(await exact.json()).toEqual({ error: 'Profile "bob" exists already.' });
  });

  test("the password is at least 8 characters, is typed twice, and an 8-character one is accepted", async ({ admin }) => {
    const short = await admin.post("/api/profiles", { data: { name: unique(), password: "1234567", confirm: "1234567" } });
    expect(short.status()).toBe(400);
    expect(await short.json()).toEqual({ error: "The password is at least 8 characters." });

    const empty = await admin.post("/api/profiles", { data: { name: unique(), password: "", confirm: "" } });
    expect(empty.status()).toBe(400);
    expect(await empty.json()).toEqual({ error: "Enter a password." });

    const mismatch = await admin.post("/api/profiles", { data: { name: unique(), password: PASSWORD, confirm: PASSWORD + "x" } });
    expect(mismatch.status()).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "The two passwords are not the same." });

    const unconfirmed = await admin.post("/api/profiles", { data: { name: unique(), password: PASSWORD } });
    expect(unconfirmed.status()).toBe(400);
    expect(await unconfirmed.json()).toEqual({ error: "The two passwords are not the same." });

    const eight = await admin.post("/api/profiles", { data: { name: unique(), password: "abcdefgh", confirm: "abcdefgh" } });
    expect(eight.status()).toBe(201);
  });

  test("a profile name is letters, digits, hyphens and underscores, up to 64 characters", async ({ admin }) => {
    const message = "A profile name is letters, numbers, hyphens and underscores, at most 64.";
    for (const name of ["bad name", "a/b", "../x", "naïve", "x.y", "semi;colon", "", "a".repeat(65)]) {
      const res = await admin.post("/api/profiles", { data: { name, password: PASSWORD, confirm: PASSWORD } });
      expect(res.status(), JSON.stringify(name)).toBe(400);
      expect(await res.json(), JSON.stringify(name)).toEqual({ error: message });
    }
    const longest = `v${unique()}`.padEnd(64, "x").slice(0, 64);
    const ok = await admin.post("/api/profiles", { data: { name: longest, password: PASSWORD, confirm: PASSWORD } });
    expect(ok.status()).toBe(201);
    expect((await ok.json()).name).toBe(longest);
  });

  test("a request body that is not JSON is refused with 400 before anything is made", async ({ admin }) => {
    const res = await admin.fetch("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, data: Buffer.from("{nope") });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body is not valid JSON" });
  });
});

test.describe("what the Garmin and Settings reads say", () => {
  test("GET /api/garmin for a profile with no Garmin login", async ({ profile }) => {
    const res = await profile.api.get("/api/garmin");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      mock: false,
      profiles: [profile.name],
      connected: [],
      profileInfo: { [profile.name]: { garmin: false, renpho: false, webPassword: true, hasActivities: false, hasWellness: false, hasWeight: false } },
      user: { admin: false, name: profile.name },
      defaultProfile: profile.name,
      reason: "Garmin is not connected: add a Garmin login in Settings to sync and send workouts.",
    });
  });

  test("GET /api/garmin for alice reports what is stored for her, with no Garmin login", async ({ request }) => {
    const body = await (await request.get("/api/garmin", { headers: ALICE() })).json();
    expect(body).toMatchObject({ enabled: false, profiles: ["alice"], connected: [], user: { admin: false, name: "alice" } });
    expect(body.profileInfo.alice).toMatchObject({ garmin: false, webPassword: true, hasActivities: true, hasWellness: true, hasWeight: true });
  });

  test("GET /api/garmin for the admin lists every profile, with what each has", async ({ request, admin }) => {
    const body = await (await admin.get("/api/garmin")).json();
    expect(body.user).toEqual({ admin: true });
    expect(body.profiles).toEqual(expect.arrayContaining(["alice", "bob"]));
    expect(Object.keys(body.profileInfo).sort()).toEqual([...body.profiles].sort());
    expect(body.profileInfo.alice.hasActivities).toBe(true);
    expect(body.profileInfo.bob.hasActivities).toBe(false);
    const asBob = await (await request.get("/api/garmin", { headers: BOB() })).json();
    expect(asBob.profiles).toEqual(["bob"]);
  });

  test("a saved Garmin login shows its e-mail address, and never its password", async ({ profile, admin }) => {
    const secret = `garmin-secret-${unique()}`;
    const email = `runner-${unique()}@example.com`;
    const saved = await profile.api.post("/api/settings/garmin", { data: { action: "save", profile: profile.name, email, password: secret } });
    expect(saved.status()).toBe(200);
    expect(await saved.text()).not.toContain(secret);
    const settings = await profile.api.get("/api/settings");
    const settingsText = await settings.text();
    expect(settingsText).not.toContain(secret);
    expect(JSON.parse(settingsText).garmin).toEqual({ connected: true, email, hasPassword: true });
    const garmin = await profile.api.get("/api/garmin");
    const garminText = await garmin.text();
    expect(garminText).not.toContain(secret);
    expect(JSON.parse(garminText)).toMatchObject({ enabled: true, connected: [profile.name] });
    const asAdmin = await admin.get(`/api/settings?profile=${enc(profile.name)}`);
    expect(await asAdmin.text()).not.toContain(secret);
  });

  test("no read answer carries the admin token, a profile's password or a password hash", async ({ request, admin }) => {
    const reads = ["/api/session", "/api/files", "/api/garmin", "/api/settings", "/api/schema", "/api/today", "/api/activities", "/"];
    const logins = [ADMIN(), ALICE(), BOB()];
    for (const headers of logins) {
      for (const url of reads) {
        const text = await (await request.get(url, { headers })).text();
        for (const secret of [ADMIN_TOKEN, PASSWORD, "scrypt$"]) expect(text, `${url} as ${headers.Authorization.slice(0, 12)}`).not.toContain(secret);
      }
    }
    const adminText = await (await admin.get("/api/settings?profile=alice")).text();
    expect(adminText).not.toContain(PASSWORD);
    const login = await pwRequest.newContext({ baseURL: "http://127.0.0.1:8792" }).then(async (ctx) => {
      try {
        return await (await ctx.post("/api/login", { headers: CSRF, data: { user: "alice", password: PASSWORD } })).text();
      } finally {
        await ctx.dispose();
      }
    });
    expect(login).not.toContain(PASSWORD);
    expect(login).not.toContain(ADMIN_TOKEN);
  });
});
