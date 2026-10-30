import { test, expect, openView, today } from "../support/fixtures";

test("alice's Today page opens signed in", async ({ alice }) => {
  await openView(alice, "today");
  await expect(alice.locator("#tbody")).not.toContainText("Loading…");
  await expect(alice.locator("#tTitle")).not.toBeEmpty();
});

test("a fresh profile has only the views that need no data", async ({ me, profile }) => {
  await openView(me, "today");
  await expect(me.locator("#vPlans")).toBeVisible();
  await expect(me.locator("#vFood")).toBeVisible();
  await expect(me.locator("#vWorkouts")).toBeHidden();
  await expect(me.locator("#accountName")).toContainText(profile.name);
});

test("food logged through the API shows in the Food view", async ({ me, profile }) => {
  const day = today();
  const res = await profile.api.post("/api/nutrition", { data: { action: "add", profile: profile.name, day, meal: "lunch", items: [{ name: "Smoke soup", kcal: 123, proteinG: 5, carbsG: 10, fatG: 4 }] } });
  expect(res.ok()).toBeTruthy();
  await openView(me, "food");
  await expect(me.locator("#fbody")).toContainText("Smoke soup");
});
