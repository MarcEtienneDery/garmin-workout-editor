import { test as base, expect, request as pwRequest, type APIRequestContext, type Page, type BrowserContext } from "@playwright/test";
import { ADMIN_TOKEN, PASSWORD } from "./seed";

export { expect, ADMIN_TOKEN, PASSWORD };
export type { APIRequestContext, BrowserContext, Locator, Page, Request, Response, Route } from "@playwright/test";
export * from "./dates";

export const CSRF = { "X-Requested-With": "plan-editor" };

const FRESH_SOCKET = { Connection: "close" };

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
  api: APIRequestContext;
}

export async function loginAs(target: Page | BrowserContext, user: string, secret: string): Promise<void> {
  const context = "context" in target ? (target as Page).context() : (target as BrowserContext);
  const res = await retrying(() => context.request.post("/api/login", { data: { user, password: secret }, headers: { ...CSRF, ...FRESH_SOCKET } }));
  if (!res.ok()) throw new Error(`Signing in as ${user} failed: ${res.status()} ${await res.text()}`);
}

export async function ready(page: Page): Promise<void> {
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#views")).toBeVisible();
}

export async function openView(page: Page, view: string): Promise<void> {
  await page.goto(view === "today" ? "/" : `/#${view}`);
  await ready(page);
  await expect(page.locator("body")).toHaveAttribute("data-view", view);
}

export const chooseTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate((t) => (window as any).setTheme(t, true), theme);

export const toggleTheme = (page: Page) =>
  page.evaluate(() => (window as any).setTheme(document.body.dataset.theme === "light" ? "dark" : "light", true));

let counter = 0;
const unique = () => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const monthView = (page: Page) => page.addInitScript(() => { try { localStorage.setItem("calendarView", "month"); } catch { } });

export const chooseEditMode = (page: Page, mode: "form" | "json") => page.addInitScript((m) => localStorage.setItem("planEditor.editMode", m), mode);

export const test = base.extend<{ admin: APIRequestContext; profile: Profile; me: Page; alice: Page; editMode: "form" | "json" | undefined }>({
  editMode: [undefined, { option: true }],
  page: async ({ page, editMode }, use) => {
    if (editMode) await chooseEditMode(page, editMode);
    await use(page);
  },
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
