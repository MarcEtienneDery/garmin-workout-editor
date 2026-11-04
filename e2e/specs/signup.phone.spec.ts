/** Signing up from an invite link on a phone: the form, and the welcome flow filling the screen. */
import { test, expect, ready, PASSWORD } from "../support/fixtures";

test("signs up from a link and ends the welcome on a view of its own choice", async ({ page, admin }) => {
  const made = await admin.post("/api/invites", { data: { action: "create" } });
  const code: string = (await made.json()).created;
  const name = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  await page.goto(`/?invite=${code}`);
  await expect(page.locator("#signupForm")).toBeVisible();
  await page.locator("#signupName").fill(name);
  await page.locator("#signupPass").fill(PASSWORD);
  await page.locator("#signupPass2").fill(PASSWORD);
  await page.locator("#signupSubmit").click();
  await ready(page);

  const dialog = page.locator("#ftue");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1); // the whole screen, not a card
  await page.locator("#ftueNext").click();
  await page.locator("#ftueNext").click(); // goals skipped
  await page.locator("#ftueNext").click(); // Garmin skipped
  await expect(page.locator("#ftueTitle")).toHaveText("You're all set");
  await page.getByRole("button", { name: /Make a plan/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-view", "plans");
});
