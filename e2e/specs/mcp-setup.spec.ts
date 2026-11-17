/**
 * Setting an assistant up to use the MCP server as one profile: the token card in Settings. The page makes a token, shows it once with the
 * lines to paste into Claude, and keeps only a placeholder after a reload. (The MCP server itself is not started by this suite: what a token
 * reaches is tested against the server in src/__tests__/mcpScope.test.ts.) The suite's server has no MCP_PUBLIC_URL, so the lines carry a host placeholder.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";

const slow = expect.configure({ timeout: 30_000 });

/** The MCP card of Settings, once Settings is drawn. */
async function openCard(page: Page) {
  await page.goto("/#settings");
  const card = page.locator(".scard").filter({ has: page.locator("h2", { hasText: "Claude (MCP)" }) });
  await slow(card).toBeVisible();
  return card;
}

test.describe("the Claude (MCP) card", () => {
  test("starts with no token and no setup lines", async ({ me }) => {
    const card = await openCard(me);
    await slow(card.locator("h2 .chip")).toHaveText("no token");
    await expect(card.getByRole("button", { name: "Make a token" })).toBeEnabled();
    await expect(card.locator(".mcpcode")).toHaveCount(0);
    await expect(card).toContainText("No assistant can use this profile");
  });

  test("makes a token, shows it once with the lines to paste, and a reload keeps only placeholders", async ({ me, profile }) => {
    const card = await openCard(me);
    await card.getByRole("button", { name: "Make a token" }).click();
    await slow(card.locator("h2 .chip")).toHaveText("token set");
    const token = (await card.locator(".mcptoken").textContent()) ?? "";
    expect(token).toMatch(/^gwm_[0-9a-f]{64}$/);
    await expect(card).toContainText("Copy it now: it is not shown again.");

    const lines = card.locator(".mcpcode");
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toHaveText(`https://<your-mcp-host>/mcp/${token}`);
    await expect(lines.nth(1)).toContainText(`claude mcp add --transport http garmin-${profile.name.toLowerCase()} https://<your-mcp-host>/mcp --header "Authorization: Bearer ${token}"`);
    expect(JSON.parse((await lines.nth(2).textContent()) ?? "")).toEqual({
      mcpServers: { [`garmin-${profile.name.toLowerCase()}`]: { type: "http", url: "https://<your-mcp-host>/mcp", headers: { Authorization: `Bearer ${token}` } } },
    });
    await expect(card).toContainText("MCP_PUBLIC_URL"); // the placeholder host is explained

    // the server never says the token again
    const settings = await (await profile.api.get("/api/settings")).text();
    expect(settings).not.toContain(token);

    await me.reload();
    const again = await openCard(me);
    await slow(again.locator("h2 .chip")).toHaveText("token set");
    await expect(again.locator(".mcptoken")).toHaveCount(0);
    await expect(again.locator(".mcpcode").nth(0)).toHaveText("https://<your-mcp-host>/mcp/<your-token>");
    await expect(again).toContainText("Made just now; not used yet.");
    await expect(again).toContainText("<your-token>");
  });

  test("a new token replaces the old one after a question; removing it takes the lines away", async ({ me }) => {
    const card = await openCard(me);
    await card.getByRole("button", { name: "Make a token" }).click();
    const first = (await card.locator(".mcptoken").textContent()) ?? "";

    await card.getByRole("button", { name: "Make a new token" }).click();
    await expect(me.locator("#dlg")).toBeVisible();
    await expect(me.locator("#dlgText")).toContainText("The old token stops working at once");
    await me.locator("#dlgCancel").click();
    await expect(card.locator(".mcptoken")).toHaveText(first); // cancelled: nothing changed

    await card.getByRole("button", { name: "Make a new token" }).click();
    await me.locator("#dlgOk").click();
    await expect(card.locator(".mcptoken")).not.toHaveText(first);
    await expect(card.locator(".mcptoken")).toHaveText(/^gwm_[0-9a-f]{64}$/);

    await card.getByRole("button", { name: "Remove the token" }).click();
    await me.locator("#dlgOk").click();
    await slow(card.locator("h2 .chip")).toHaveText("no token");
    await expect(card.locator(".mcpcode")).toHaveCount(0);
    await expect(card.locator(".mcptoken")).toHaveCount(0);
  });

  test("the ⓘ says what the token reaches", async ({ me }) => {
    const card = await openCard(me);
    await card.locator("h2").getByRole("button", { name: "About the MCP token" }).click();
    await expect(card.locator("h2 + .help")).toContainText("A token reaches this profile only, never another one");
  });
});
