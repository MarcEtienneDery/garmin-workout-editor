import type { Page } from "@playwright/test";
import { test, expect, openView, daysAgo } from "../support/fixtures";

interface Detail {
  activity: { id: string; name: string; km: number | null; seconds: number | null; paceSec: number | null; avgHr: number | null; maxHr: number | null; elevation: number | null; calories: number | null; effect: string | null; workoutId: string | null; detailed: boolean };
  stats: { minHr: number | null; hrZones: number[] | null };
  chart: { zones: { zone: number }[] | null; laps: unknown[]; splits: unknown[]; route: unknown } | null;
  planned: { workout: { workoutName: string } } | null;
  detailed: boolean;
}

async function detailOf(page: Page, id: string): Promise<Detail> {
  const res = await page.context().request.get(`/api/activity?profile=alice&id=${id}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const longDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
const rowNamed = (page: Page, name: string) => page.locator("#alist .arow").filter({ has: page.locator(".nm", { hasText: exact(name) }) });
const figure = (page: Page, label: string) =>
  page.locator("#abody .afig", { has: page.locator("small", { hasText: exact(label) }) }).locator("b").or(page.locator("#abody .amini", { hasText: new RegExp(`^${label}\\b`) }).locator("b"));
const figureLabels = (page: Page) => page.locator("#abody .afig small").allInnerTexts();

async function openActivity(page: Page, name: string) {
  await openView(page, "activities");
  await rowNamed(page, name).click();
  await expect(page.locator("#aDetailTitle")).toHaveText(name);
  await expect(page.locator("#abody .ahead b")).toHaveText(name);
}

async function blockTiles(page: Page) {
  const asked: string[] = [], finished: string[] = [];
  await page.route("**/tile.openstreetmap.org/**", (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  page.on("requestfinished", (r) => {
    if (/openstreetmap/.test(r.url())) finished.push(r.url());
  });
  return { asked, finished };
}

async function addRow(page: Page, row: Record<string, unknown>) {
  await page.route(/\/api\/activities\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, activities: [...body.activities, row] } });
  });
}

test.describe("opening an activity", () => {
  test("the page opens beside the list with the activity's name, its day and its start time", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .ahead")).toContainText(`Running · ${longDate(daysAgo(2))}, 07:00`);
    await expect(alice.locator("#alist .arow.active .nm")).toHaveText("Easy run");
  });

  test("the summary gives the distance, time, pace, heart rate, elevation and calories", async ({ alice }) => {
    const d = await detailOf(alice, "9018");
    await openActivity(alice, "Easy run");
    await expect(figure(alice, "Distance")).toHaveText(`${d.activity.km} km`);
    await expect(figure(alice, "Time")).toHaveText("40 min");
    await expect(figure(alice, "Average pace")).toHaveText("5:03 /km");
    await expect(figure(alice, "Average heart rate")).toHaveText(`${d.activity.avgHr} bpm`);
    await expect(figure(alice, "Max HR")).toHaveText(`${d.activity.maxHr} bpm`);
    await expect(figure(alice, "Elevation gain")).toHaveText(`${d.activity.elevation} m`);
    await expect(figure(alice, "Calories")).toHaveText(`${d.activity.calories} kcal`);
  });

  test("the training effect, the RPE and the lowest heart rate are in the summary too", async ({ alice }) => {
    const d = await detailOf(alice, "9018");
    await openActivity(alice, "Easy run");
    await expect(figure(alice, "Training effect")).toHaveText("Aerobic Base");
    await expect(alice.locator("#abody .aeffect .aeff", { hasText: "Perceived effort (RPE)" }).locator("b")).toHaveText("50 / 100");
    await expect(figure(alice, "Lowest HR")).toHaveText(`${d.stats.minHr} bpm`);
    await expect(alice.locator("#abody .aeffect")).not.toContainText("Aerobic effect");
    await expect(alice.locator("#abody .aeffect")).not.toContainText("Feel");
  });

  test("the page starts on a prompt to select an activity", async ({ alice }) => {
    await openView(alice, "activities");
    await expect(alice.locator("#aDetailTitle")).toHaveText("Activity");
    await expect(alice.locator("#abody")).toHaveText("Select an activity.");
  });

  test("selecting another row replaces the page, and only the new row is marked", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await expect(alice.locator(".acg")).toHaveCount(1);
    await rowNamed(alice, "Morning run 9000").click();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9000");
    await expect(alice.locator("#abody .ahead b")).toHaveText("Morning run 9000");
    await expect(alice.locator(".acg")).toHaveCount(0);
    await expect(alice.locator(".amap")).toHaveCount(0);
    await expect(alice.locator("#alist .arow.active")).toHaveCount(1);
    await expect(alice.locator("#alist .arow.active .nm")).toHaveText("Morning run 9000");
  });

  test("a row opens from the keyboard: Enter opens it and Space opens the next one", async ({ alice }) => {
    await openView(alice, "activities");
    await rowNamed(alice, "Easy run").focus();
    await alice.keyboard.press("Enter");
    await expect(alice.locator("#aDetailTitle")).toHaveText("Easy run");
    await rowNamed(alice, "Morning run 9000").focus();
    await alice.keyboard.press(" ");
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9000");
  });

  test("a failing details request shows its message in the page", async ({ alice }) => {
    await alice.route(/\/api\/activity\?/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The server is busy." }) }));
    await openView(alice, "activities");
    await rowNamed(alice, "Easy run").click();
    await expect(alice.locator("#abody .msg.err")).toHaveText("The server is busy.");
  });

  test("an activity the server does not hold says so in its page", async ({ alice }) => {
    await addRow(alice, { id: "9999", date: daysAgo(1), time: "08:00", type: "running", name: "Ghost run", km: 5, seconds: 1500, paceSec: 300, avgHr: 140, maxHr: 160, effect: null, aerobic: null, elevation: null, calories: null, sets: null, reps: null, workoutId: null, detailed: false });
    await openView(alice, "activities");
    await rowNamed(alice, "Ghost run").click();
    await expect(alice.locator("#abody .msg.err")).toHaveText("Activity 9999 is not stored.");
  });

  test("a slower earlier answer does not replace the page of the row clicked last", async ({ alice }) => {
    await alice.route(/\/api\/activity\?.*id=9018/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await openView(alice, "activities");
    const slow = alice.waitForResponse(/\/api\/activity\?.*id=9018/);
    await rowNamed(alice, "Easy run").click();
    await rowNamed(alice, "Morning run 9000").click();
    await slow;
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9000");
    await expect(alice.locator("#abody .ahead b")).toHaveText("Morning run 9000");
    await expect(alice.locator(".acg")).toHaveCount(0);
  });

  test("reloading the page keeps the Activities view, and an activity opens again after it", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await alice.reload();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "activities");
    await rowNamed(alice, "Morning run 9000").click();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9000");
  });
});

test.describe("what the page of a run with details shows", () => {
  test("the graphs of heart rate, pace and elevation are drawn, each with its scale", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    const panels = alice.locator("#abody .acp");
    await expect(panels).toHaveCount(3);
    await expect(panels.locator(".act span")).toHaveText(["Heart rate (bpm)", "Pace (/km)", "Elevation (m)"]);
    for (let i = 0; i < 3; i++) {
      const svg = panels.nth(i).locator("svg.acsvg");
      await expect(svg.locator("path[stroke]").first()).toBeAttached();
      expect(await svg.locator("text.aclab").count()).toBeGreaterThan(1);
    }
  });

  test("the graphs read on distance first, and Time switches the axis to the clock", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    const axis = alice.locator("#abody .acaxis text");
    await expect(alice.locator("#abody .acbar .seg button", { hasText: "Distance" })).toHaveAttribute("aria-pressed", "true");
    await expect(axis.first()).toHaveText(/km$/);
    await alice.locator("#abody .acbar .seg button", { hasText: "Time" }).click();
    await expect(alice.locator("#abody .acbar .seg button", { hasText: "Time" })).toHaveAttribute("aria-pressed", "true");
    await expect(axis.first()).not.toHaveText(/km$/);
    await expect(axis.first()).toHaveText(/^\d+:\d{2}(:\d{2})?$/);
  });

  test("the heart-rate zone bar shows the time in each of the five zones", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .acard.azones .aeyebrow")).toHaveText("Heart-rate zones");
    await expect(alice.locator("#abody .azstack .azseg")).toHaveCount(5);
    await expect(alice.locator("#abody .azlegend .azitem")).toHaveCount(5);
    await expect(alice.locator("#abody .azlegend .azitem").first()).toContainText("Z1 105–120 bpm: 5 min · 13%");
    await expect(alice.locator("#abody .azlegend .azitem").last()).toContainText("Z5 165+ bpm: 2 min · 4%");
  });

  test("the heart-rate zone bar shows the summary's time in each zone, with the bpm range of the zone when stored", async ({ alice }) => {
    await alice.route(/\/api\/activity\?/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.stats.hrZones = [1500, 1200, 900, 600, 300];
      await route.fulfill({ response, json: body });
    });
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .acard.azones .aeyebrow")).toHaveText("Heart-rate zones");
    await expect(alice.locator("#abody .azstack .azseg")).toHaveCount(5);
    await expect(alice.locator("#abody .azlegend .azitem")).toHaveCount(5);
    await expect(alice.locator("#abody .azlegend .azitem").first()).toContainText("Z1 105–120 bpm: 25 min · 33%");
    await expect(alice.locator("#abody .azlegend .azitem").last()).toContainText("Z5 165+ bpm: 5 min · 7%");
  });

  test("the heart-rate graph shows the zone bands behind its line", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .acp").first().locator("svg.acsvg rect")).not.toHaveCount(0);
  });

  test("hovering a graph reads the value and the place at that point, and leaving clears it", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    const svg = alice.locator("#abody .acp").first().locator("svg.acsvg");
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    await alice.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(alice.locator("#abody .acread")).toHaveText(/^\d+(\.\d+)? km · \d+:\d{2}$/);
    await expect(alice.locator("#abody .acp").first().locator(".acv")).toHaveText(/^\d+ bpm$/);
    await alice.mouse.move(0, 0);
    await expect(alice.locator("#abody .acread")).toHaveText("");
    await expect(alice.locator("#abody .acp").first().locator(".acv")).toHaveText("");
  });

  test("the laps list each lap's distance, time, pace and heart rate, and the tab says how many", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .asegtabs button", { hasText: "Laps (4)" })).toHaveAttribute("aria-pressed", "true");
    const bars = alice.locator("#abody .abars .abarrow");
    await expect(bars).toHaveCount(4);
    await expect(bars.first().locator(".abl")).toHaveText("1");
    await expect(bars.first().locator(".abv")).toHaveText("5:03");
    await expect(bars.first().locator(".abx")).toHaveText("2 km · 10 min · 141 bpm");
  });

  test("the km splits list each kilometre, and the last part on its own", async ({ alice }) => {
    await openActivity(alice, "Easy run");
    await alice.locator("#abody .asegtabs button", { hasText: "Km splits" }).click();
    await expect(alice.locator("#abody .asegtabs button", { hasText: "Km splits (8)" })).toHaveAttribute("aria-pressed", "true");
    const bars = alice.locator("#abody .abars .abarrow");
    await expect(bars).toHaveCount(8);
    await expect(bars.first().locator(".abv")).toHaveText("5:00");
    await expect(bars.last().locator(".abx")).toContainText("800 m");
  });

  test("the route is drawn on a map from the stored track, and no tile is fetched from OpenStreetMap", async ({ alice }) => {
    const tiles = await blockTiles(alice);
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .amap.leaflet-container")).toBeVisible();
    await expect(alice.locator("#abody .leaflet-overlay-pane path").first()).toBeAttached();
    await expect.poll(() => tiles.asked.length).toBeGreaterThan(0);
    expect(tiles.finished).toEqual([]);
  });

  test("the route colours by pace, by heart rate or not at all, and the chosen one is pressed", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    const paths = alice.locator("#abody .leaflet-overlay-pane path");
    await expect(alice.locator("#abody .amapmodes button", { hasText: "Pace" })).toHaveAttribute("aria-pressed", "true");
    await expect(paths).not.toHaveCount(3);
    await alice.locator("#abody .amapmodes button", { hasText: "Plain" }).click();
    await expect(alice.locator("#abody .amapmodes button", { hasText: "Plain" })).toHaveAttribute("aria-pressed", "true");
    await expect(paths).toHaveCount(3);
    await alice.locator("#abody .amapmodes button", { hasText: "Heart rate" }).click();
    await expect(alice.locator("#abody .amapmodes button", { hasText: "Heart rate" })).toHaveAttribute("aria-pressed", "true");
    await expect(paths).not.toHaveCount(3);
    await expect(alice.locator("#abody .amapbar")).toContainText("Slower or harder");
    await expect(alice.locator("#abody .amapbar")).toContainText("faster or easier");
    await alice.locator("#abody .amapmodes button", { hasText: "Plain" }).click();
    await expect(alice.locator("#abody .amapbar")).toBeHidden();
  });

  test("the start and the finish of the route are marked on the map", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    await expect(alice.locator('#abody .leaflet-overlay-pane path[fill="#22a24a"]')).toHaveCount(1);
    await expect(alice.locator('#abody .leaflet-overlay-pane path[fill="#e0393c"]')).toHaveCount(1);
  });

  test("the cursor of the graphs marks the place on the map", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    const cursor = alice.locator('#abody .leaflet-overlay-pane path[fill="#0e7ad1"]');
    await expect(alice.locator("#abody .leaflet-overlay-pane path").first()).toBeAttached();
    await expect(cursor).toHaveCount(0);
    const svg = alice.locator("#abody .acp").first().locator("svg.acsvg");
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    await alice.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(cursor).toHaveCount(1);
  });

  test("the planned workout the run came from is linked, with what was planned against what was done", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    await expect(alice.locator("#abody .aplanned .aeyebrow")).toHaveText("Planned against done");
    await expect(alice.locator("#abody a", { hasText: "Easy run · alice-run-block" })).toBeVisible();
    const bars = alice.locator("#abody .aplanned .abul");
    await expect(bars).toHaveCount(2);
    const distance = bars.nth(0), time = bars.nth(1);
    await expect(distance.locator(".abl span")).toHaveText("Distance");
    await expect(distance.locator(".abl b")).toHaveText("8 km");
    await expect(distance.locator(".abn span").first()).toHaveText("planned ~8 km");
    await expect(distance.locator(".abn span").last()).toHaveText("0%");
    await expect(time.locator(".abl span")).toHaveText("Time");
    await expect(time.locator(".abl b")).toHaveText("40 min");
    await expect(time.locator(".abn span").first()).toHaveText(/^planned ~\d+ min$/);
    await expect(time.locator(".abn span").last()).toHaveText(/^-\d+%$/);
  });

  test("the planned workout's name opens it in the Plans view, with that workout in the outline", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    await alice.locator("#abody a", { hasText: "Easy run · alice-run-block" }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator('#outline [data-name="Easy run"]')).toBeVisible();
  });

  test("a run that came from no plan has no planned section", async ({ alice }) => {
    await openActivity(alice, "Morning run 9000");
    await expect(alice.locator("#abody .aplanned")).toHaveCount(0);
  });

  test("the page of the Easy run has no button to fetch from Garmin", async ({ alice }) => {
    await blockTiles(alice);
    await openActivity(alice, "Easy run");
    await expect(alice.getByRole("button", { name: /Fetch/ })).toHaveCount(0);
  });
});

test.describe("what the page of a run without stored details shows", () => {
  test("the run opens with its summary, and says that the details and the graphs are not stored", async ({ alice }) => {
    await openActivity(alice, "Morning run 9000");
    await expect(figure(alice, "Distance")).toHaveText("7 km");
    await expect(figure(alice, "Average pace")).toHaveText("5:03 /km");
    await expect(figure(alice, "Average heart rate")).toHaveText("148 bpm");
    await expect(alice.locator("#abody .anote").first()).toHaveText("The details (feel, RPE, sets, intervals) are not stored yet.");
    await expect(alice.locator("#abody .agraphs .aeyebrow")).toHaveText("Graphs");
    await expect(alice.locator("#abody .anote", { hasText: "The graphs are not stored yet." })).toBeVisible();
    await expect(alice.locator("#abody .acg")).toHaveCount(0);
    await expect(alice.locator("#abody .amap")).toHaveCount(0);
  });

  test("opening it asks Garmin for nothing and raises no page error", async ({ alice }) => {
    const errors: string[] = [];
    const asked: string[] = [];
    alice.on("pageerror", (e) => errors.push(e.message));
    alice.on("request", (r) => {
      if (r.method() !== "GET" && /\/api\/activities\/(detail|chart)/.test(r.url())) asked.push(r.url());
    });
    await openActivity(alice, "Morning run 9000");
    await openActivity(alice, "Today's shakeout");
    await expect(alice.locator("#abody .ahead b")).toHaveText("Today's shakeout");
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("without a Garmin login there is no button to fetch the details or the graphs", async ({ alice }) => {
    await openActivity(alice, "Morning run 9000");
    await expect(alice.getByRole("button", { name: "Fetch them now" })).toHaveCount(0);
  });
});

test.describe("what the page of a strength session with its sets stored shows", () => {
  test("the exercises list each exercise with its sets, reps and weight", async ({ alice }) => {
    await openActivity(alice, "Gym session 9019");
    const exercises = alice.locator("#abody .aexercises .aex");
    await expect(exercises).toHaveCount(2);
    await expect(exercises.nth(0).locator(".aexn")).toHaveText("Barbell Back Squat");
    await expect(exercises.nth(0).locator(".aext")).toHaveText("3 sets · est. 1RM 257 lb");
    await expect(exercises.nth(0).locator(".aexchip")).toHaveText("3 × 5 @ 220 lb 86 %");
    await expect(exercises.nth(1).locator(".aexn")).toHaveText("Barbell Bench Press");
    await expect(exercises.nth(1).locator(".aexchip")).toHaveText("3 × 8 @ 154 lb 79 %");
  });

  test("each exercise gives its estimated one-rep max, the share each run of sets is of it, and the set it was worked out from", async ({ alice }) => {
    await openActivity(alice, "Gym session 9019");
    const lifts = alice.locator("#abody .aexercises .aex");
    await expect(lifts.nth(0).locator(".aext")).toContainText("est. 1RM 257 lb");
    await expect(lifts.nth(0).locator(".aexchip.b2")).toHaveText("3 × 5 @ 220 lb 86 %");
    await expect(lifts.nth(0).locator(".aexnote")).toHaveText(/^from 5 @ 220 lb on \d{4}-\d{2}-\d{2}$/);
    await expect(lifts.nth(1).locator(".aext")).toContainText("est. 1RM 195 lb");
    await expect(lifts.nth(1).locator(".aexchip.b1")).toHaveText("3 × 8 @ 154 lb 79 %");
  });

  test("in kg, the weights are the kilos lifted: 100 kg, not the 99.8 that its whole pounds (220) would make", async ({ alice }) => {
    await alice.route("**/api/garmin", async (route) => {
      const info = await (await route.fetch()).json();
      await route.fulfill({ json: { ...info, prefs: { ...info.prefs, alice: { ...info.prefs?.alice, weightUnit: "kg" } } } });
    });
    await openActivity(alice, "Gym session 9019");
    const exercises = alice.locator("#abody .aexercises .aex");
    await expect(exercises.nth(0).locator(".aexchip")).toHaveText("3 × 5 @ 100 kg 86 %");
    await expect(exercises.nth(1).locator(".aexchip")).toHaveText("3 × 8 @ 70 kg 79 %");
    await expect(exercises.nth(0).locator(".aexnote")).toHaveText(/^from 5 @ 100 kg on \d{4}-\d{2}-\d{2}$/);
  });

  test("the muscles worked count the sets each muscle gets, with a scale from fewer to more", async ({ alice }) => {
    await openActivity(alice, "Gym session 9019");
    await expect(alice.locator("#abody .ammc .aeyebrow").first()).toHaveText("Muscles worked · sets");
    await alice.locator("#abody .ammt").click();
    await expect(alice.locator("#abody .ammc")).toHaveClass(/open/);
    await expect(alice.locator("#abody .ammrow", { hasText: "Chest" })).toBeVisible();
    await expect(alice.locator("#abody .ammrow", { hasText: "Quads" })).toBeVisible();
    await expect(alice.locator("#abody .ammread")).toContainText("Darker means more sets");
  });

  test("the session's own rating of effort shows, and its graphs say they are not stored", async ({ alice }) => {
    await openActivity(alice, "Gym session 9019");
    await expect(alice.locator("#abody .aeffect .aeff", { hasText: "Perceived effort (RPE)" }).locator("b")).toHaveText("60 / 100");
    await expect(alice.locator("#abody")).toContainText("The graphs are not stored yet.");
  });
});

test.describe("what the page of a strength session shows", () => {
  test("the gym session opens with its time and heart rate, and no distance or pace", async ({ alice }) => {
    await openActivity(alice, "Gym session 9019");
    await expect(alice.locator("#abody .ahead")).toContainText(`Strength Training · ${longDate(daysAgo(3))}, 18:00`);
    await expect(figure(alice, "Time")).toHaveText("50 min");
    await expect(figure(alice, "Average heart rate")).toHaveText("148 bpm");
    await expect(figureLabels(alice)).not.toContain("Distance");
    await expect(figureLabels(alice)).not.toContain("Average pace");
  });

  test("a strength session without stored details has no exercise sections and no graphs", async ({ alice }) => {
    await openActivity(alice, "Gym session 9020");
    await expect(alice.locator("#abody .anote").first()).toHaveText("The details (feel, RPE, sets, intervals) are not stored yet.");
    await expect(alice.locator("#abody .aexercises")).toHaveCount(0);
    await expect(alice.locator("#abody .ammc")).toHaveCount(0);
    await expect(alice.locator("#abody .acg")).toHaveCount(0);
  });
});
