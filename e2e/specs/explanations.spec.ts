/**
 * The explanations: what a view's numbers mean and how a setting works sit behind an ⓘ until asked for, and Show explanations in the
 * account menu shows them all, remembered in this browser. Reads only: alice's data is never changed (an ⓘ in a checkbox's row ticks nothing).
 */
import type { Page } from "@playwright/test";
import { test, expect, openView } from "../support/fixtures";

/** The views whose notes on their numbers are one "About these numbers" line at their foot, by their body. */
const FEET = [["today", "#tbody"], ["recovery", "#rbody"], ["weight", "#bbody"], ["food", "#fbody"]] as const;

const aboutButton = (page: Page, body: string) => page.locator(`${body} .rfoot`).getByRole("button", { name: "About these numbers" });
const aboutNote = (page: Page, body: string) => page.locator(`${body} .rfoot .help`);
const card = (page: Page, heading: string) => page.locator(".scard").filter({ has: page.locator("h2", { hasText: heading }) });

async function openSettings(page: Page): Promise<void> {
  await openView(page, "settings");
  await expect(page.locator("#sbody .scard")).toHaveCount(5, { timeout: 15_000 });
}

test.describe("each note behind its ⓘ", () => {
  for (const [view, body] of FEET) {
    test(`${view}: About these numbers is one line until pressed, and shuts again`, async ({ alice }) => {
      await openView(alice, view);
      const button = aboutButton(alice, body), note = aboutNote(alice, body);
      await expect(button).toBeVisible({ timeout: 15_000 });
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(note).toBeHidden();
      await expect(button).toHaveAttribute("aria-controls", (await note.getAttribute("id"))!);
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(note).toBeVisible();
      await expect(note).not.toBeEmpty();
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(note).toBeHidden();
    });
  }

  test("a note opened stays open when its view is drawn again for another day", async ({ alice }) => {
    await openView(alice, "food");
    await aboutButton(alice, "#fbody").click();
    await expect(aboutNote(alice, "#fbody")).toBeVisible();
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fToday")).toBeVisible(); // the day before is drawn
    await expect(aboutNote(alice, "#fbody")).toBeVisible();
    await expect(aboutButton(alice, "#fbody")).toHaveAttribute("aria-expanded", "true");
  });

  test("the Settings cards keep what they are for behind the ⓘ of their title", async ({ alice }) => {
    await openSettings(alice);
    for (const [heading, about, says] of [
      ["Nutrition goals", "About the nutrition goals", "What the Food view measures each day against"],
      ["Units", "About the units", "Plans keep pounds whatever it is"],
      ["Garmin account", "About the Garmin account", "Connect it to sync activities and health data"],
      ["Renpho scale", "About the Renpho scale", "It only reads from Renpho."],
      ["Web sign-in", "About the web sign-in", "The password is kept as a hash."],
    ] as const) {
      const c = card(alice, heading), note = c.locator("h2 + .help");
      await expect(note).toBeHidden();
      await c.locator("h2").getByRole("button", { name: about }).click();
      await expect(note).toBeVisible();
      await expect(note).toContainText(says);
    }
  });

  test("the ⓘ of a checkbox shows what it does and leaves the box as it was", async ({ alice }) => {
    await openSettings(alice);
    const box = alice.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" });
    const checked = await box.isChecked();
    const note = card(alice, "Nutrition goals").locator(".stoggle .help");
    await expect(note).toBeHidden();
    await card(alice, "Nutrition goals").getByRole("button", { name: "About adding the calories burned" }).click();
    await expect(note).toBeVisible();
    await expect(note).toContainText("Adds a share of the day's active calories");
    await expect(box).toBeChecked({ checked });
  });

  test("a workout's estimate says how it was timed behind its ⓘ", async ({ alice }) => {
    await alice.addInitScript(() => localStorage.setItem("planEditor.editMode", "json")); // the outline's picture: the form has its own (workout-form.spec.ts)
    await openView(alice, "plans");
    await alice.locator("#filelist .file", { hasText: "alice-run-block.json" }).click();
    const tempo = alice.locator("#outline .row.wk").nth(1);
    await tempo.locator(".name").click();
    const stat = tempo.locator(".wv-stat", { hasText: "Est. time" });
    await stat.getByRole("button", { name: "About the estimate" }).click();
    await expect(tempo.locator(".wv-sum > .help")).toBeVisible();
    await expect(tempo.locator(".wv-sum > .help")).toContainText("Steps with no pace target");
    await expect(tempo.locator(".name")).toHaveAttribute("aria-expanded", "true"); // the picture stays open
  });
});

test.describe("Show explanations", () => {
  test("shows every note without its ⓘ, is remembered after a reload, and hides them again", async ({ alice }) => {
    await openView(alice, "today");
    await expect(aboutButton(alice, "#tbody")).toBeVisible({ timeout: 15_000 });
    await alice.locator("#accountBtn").click();
    const toggle = alice.locator("#explainBtn");
    await expect(toggle).toHaveText("Show explanations");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(alice.locator("#accountMenu")).toBeHidden(); // a menu item shuts the menu
    await expect(aboutNote(alice, "#tbody")).toBeVisible();
    await expect(aboutButton(alice, "#tbody")).toBeHidden();

    await alice.reload();
    await expect(aboutNote(alice, "#tbody")).toBeVisible({ timeout: 15_000 });
    await openSettings(alice);
    await expect(card(alice, "Nutrition goals").locator("h2 + .help")).toBeVisible();
    await expect(alice.locator("#sbody button.infob:visible")).toHaveCount(0);

    await alice.locator("#accountBtn").click();
    await expect(alice.locator("#explainBtn")).toHaveAttribute("aria-pressed", "true");
    await alice.locator("#explainBtn").click();
    await expect(card(alice, "Nutrition goals").locator("h2 + .help")).toBeHidden();
    await expect(card(alice, "Nutrition goals").locator("h2").getByRole("button", { name: "About the nutrition goals" })).toBeVisible();
  });
});
