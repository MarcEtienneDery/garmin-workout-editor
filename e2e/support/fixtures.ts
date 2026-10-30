/**
 * What every spec starts from. Import `test` and `expect` from here, not from @playwright/test.
 *
 *   alice     a page already signed in as the seeded profile alice (stored activities, health data, weigh-ins, plans, food).
 *             Read-only: never change her data, other specs read it at the same time.
 *   admin     an API client signed in as the admin (the access token); it can add profiles and reads every profile.
 *   profile   a profile made for this test alone, empty, with its own API client (`profile.api`) signed in as it. Use it, or
 *             `me` (a page signed in as it), for any spec that changes data: specs run in parallel on one database.
 *   me        a page signed in as `profile`.
 *
 * The server's time zone is UTC and so is the browser's, so the dates of dates.ts are the page's "today".
 */
import { test as base, expect, request as pwRequest, type APIRequestContext, type Page, type BrowserContext } from "@playwright/test";
import { ADMIN_TOKEN, PASSWORD } from "./seed";

export { expect, ADMIN_TOKEN, PASSWORD };
export type { APIRequestContext, BrowserContext, Locator, Page, Request, Response, Route } from "@playwright/test";
export * from "./dates";

/** The header the server wants on every request that is not a GET (it keeps other sites from driving the API). */
export const CSRF = { "X-Requested-With": "plan-editor" };

/** No socket is kept between calls: Node closes an idle one after 5 s, and a request sent on it just then fails with ECONNRESET. */
const FRESH_SOCKET = { Connection: "close" };

/** A call that failed because the connection dropped is made again (the server was not asked, or did not answer): never one that was answered. */
async function retrying<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up|ECONNREFUSED/.test(String(error))) throw error;
    }
  }
}

const basic = (user: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}` });

export interface Profile {
  name: string;
  password: string;
  /** Signed in as this profile (HTTP Basic), with the required header: `profile.api.get("/api/files")`. */
  api: APIRequestContext;
}

/** Sign a page's browser context in through the API, so the session cookie is set before the page loads. */
export async function loginAs(target: Page | BrowserContext, user: string, secret: string): Promise<void> {
  const context = "context" in target ? (target as Page).context() : (target as BrowserContext);
  const res = await retrying(() => context.request.post("/api/login", { data: { user, password: secret }, headers: { ...CSRF, ...FRESH_SOCKET } }));
  if (!res.ok()) throw new Error(`Signing in as ${user} failed: ${res.status()} ${await res.text()}`);
}

/** Wait for the page to have loaded its first view (the sign-in form is gone and the header is up). */
export async function ready(page: Page): Promise<void> {
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#views")).toBeVisible();
}

/** Open the page on a view (`today`, `plans`, `calendar`, `food`, ...), signed in already, and wait until it is drawn. */
export async function openView(page: Page, view: string): Promise<void> {
  await page.goto(view === "today" ? "/" : `/#${view}`);
  await ready(page);
  await expect(page.locator("body")).toHaveAttribute("data-view", view);
}

let counter = 0;
const unique = () => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const test = base.extend<{ admin: APIRequestContext; profile: Profile; me: Page; alice: Page }>({
  admin: async ({ baseURL }, use) => {
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { ...CSRF, ...FRESH_SOCKET, ...basic("admin", ADMIN_TOKEN) } });
    await use(api);
    await api.dispose();
  },
  profile: async ({ admin, baseURL }, use) => {
    const name = unique();
    const made = await retrying(() => admin.post("/api/profiles", { data: { name, password: PASSWORD, confirm: PASSWORD } }));
    if (!made.ok()) throw new Error(`Could not make profile ${name}: ${made.status()} ${await made.text()}`);
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { ...CSRF, ...FRESH_SOCKET, ...basic(name, PASSWORD) } });
    await use({ name, password: PASSWORD, api });
    await api.dispose();
  },
  me: async ({ page, profile }, use) => {
    await loginAs(page, profile.name, profile.password);
    await use(page);
  },
  alice: async ({ page }, use) => {
    await loginAs(page, "alice", PASSWORD);
    await use(page);
  },
});
