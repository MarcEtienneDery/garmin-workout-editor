/** The header status on a phone: the words shorten to fit the strip of views, and a tap says the rest. Pixel 7 project; reads only. */
import { test, expect, openView } from "../support/fixtures";

test.setTimeout(60_000);

test("a 429 is a short pill in the phone's header, and the header does not scroll sideways", async ({ alice }) => {
  const now = Date.now();
  await alice.route("**/api/sync-activity", (route) => route.fulfill({ json: { now, profiles: { alice: { syncing: [], limit: { since: now - 60_000, lastAt: now - 30_000, count: 1 } } } } }));
  await openView(alice, "today");
  const pill = alice.locator("#syncActivity");
  await expect(pill).toBeVisible();
  await expect(pill.locator(".ssShort")).toBeVisible();
  await expect(pill.locator(".ssLong")).toBeHidden();
  await expect(pill).toHaveText("429", { useInnerText: true });
  const header = await alice.locator("header").boundingBox();
  const box = await pill.boundingBox();
  expect(box && header && box.x + box.width <= header.x + header.width + 1).toBe(true);
  await pill.tap();
  await expect(alice.locator("#toast")).toContainText("Too Many Requests");
});

test("a sync running is the word Syncing", async ({ alice }) => {
  await alice.route("**/api/sync-activity", (route) => route.fulfill({ json: { now: Date.now(), profiles: { alice: { syncing: ["activities"], limit: null } } } }));
  await openView(alice, "today");
  await expect(alice.locator("#syncActivity")).toHaveText("Syncing", { useInnerText: true });
});
