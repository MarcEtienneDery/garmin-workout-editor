import type { Page, Route } from "@playwright/test";

export interface GarminCalls {
  actions: Record<string, unknown>[];
}

export interface GarminOptions {
  states?: string[];
  differences?: string[];
  devices?: { deviceId: number; displayName: string }[];
  action?: { status?: number; body?: Record<string, unknown> };
}

export async function withGarmin(page: Page, profile: string, options: GarminOptions = {}): Promise<GarminCalls> {
  const calls: GarminCalls = { actions: [] };
  await page.route(/\/api\/garmin$/, async (route: Route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.enabled = true; body.mock = false; body.reason = null;
    body.connected = [profile];
    body.profileInfo = { ...body.profileInfo, [profile]: { ...(body.profileInfo || {})[profile], garmin: true } };
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/garmin\/status$/, async (route) => {
    const request = route.request().postDataJSON() as { text?: string };
    let list: unknown[] = [];
    try { const data = JSON.parse(request.text ?? "{}"); list = Array.isArray(data) ? data : data.workouts ?? []; } catch { }
    const statuses = list.map((_, index) => {
      const state = options.states?.[index] ?? "not-uploaded";
      return { index, state, differences: state === "modified" ? options.differences ?? ["Step 2: pace 3:55–4:05 in the plan, 4:00–4:10 on Garmin"] : [] };
    });
    await route.fulfill({ json: { profile, statuses } });
  });
  await page.route(/\/api\/garmin\/devices\?/, (route) => route.fulfill({ json: { devices: options.devices ?? [] } }));
  await page.route(/\/api\/garmin\/action$/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.actions.push(body);
    const version = await page.evaluate(() => (window as unknown as { current: { version: number } }).current.version);
    const status = options.action?.status ?? 200;
    await route.fulfill({
      status,
      json: options.action?.body ?? (status === 200
        ? { action: body.action, profile, version, log: "done", result: { successful: 1, failed: 0, attempted: [], workouts: [], requested: [] } }
        : { error: "Garmin said no", log: "", version }),
    });
  });
  return calls;
}
