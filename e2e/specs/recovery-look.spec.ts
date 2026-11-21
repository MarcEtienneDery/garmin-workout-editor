import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, openView, loginAs, ADMIN_TOKEN, chooseTheme, toggleTheme } from "../support/fixtures";

test.describe.configure({ timeout: 60_000 });

interface Signal { name: string; value: string; baseline: string | null; score: number; weight: number; reason: string }
interface Wellness {
  today: string;
  date: string;
  week: { day: string; band: string; score: number | null }[];
  readinessDays: { day: string; band: string; score: number | null }[];
  readiness: { band: string; score: number | null; confidence: string; signals: Signal[]; missing: string[]; load: { sessions: number; acute: number; usual: number | null; ratio: number | null; hoursSinceHard: number | null; intensity: { acute: number; usual: number | null; ratio: number | null } | null } | null };
  days: { day: string; sleepSeconds: number | null; sleepScore: number | null; sleepNeedMinutes: number | null; deepSeconds: number | null; remSeconds: number | null; lightSeconds: number | null; awakeSeconds: number | null; awakeCount: number | null; sleepStress: number | null }[];
}
async function wellness(admin: APIRequestContext, query = "days=30"): Promise<Wellness> {
  const res = await admin.get(`/api/wellness?profile=alice&${query}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Wellness;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (day: string) => { const d = new Date(`${day}T00:00:00Z`); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const ZONE: Record<string, string> = { "go-harder": "go", "as-planned": "plan", "back-off": "back", unknown: "none" };
const NAME: Record<string, string> = { "go-harder": "go harder", "as-planned": "as planned", "back-off": "back off" };

const strip = (page: Page) => page.locator("#rstrip");
const chip = (page: Page, day: string) => strip(page).locator(`button.fwd[data-day="${day}"]`);
const part = (page: Page, name: "Verdict" | "Trends" | "Data") => page.locator("#rTabs").getByRole("button", { name, exact: true });
const hero = (page: Page) => page.locator("#rbody .rhero");

async function openRecovery(page: Page) {
  await openView(page, "recovery");
  await expect(hero(page)).toBeVisible();
}

async function altered(page: Page, change: (w: Wellness) => void) {
  await page.route(/\/api\/wellness\?/, async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Wellness;
    change(json);
    await route.fulfill({ response: res, json });
  });
}
const withBand = (band: string, score: number, scores: number[], extra: (w: Wellness) => void = () => undefined) => (w: Wellness) => {
  w.readiness.band = band;
  w.readiness.score = score;
  w.readiness.signals.forEach((s, i) => { s.score = scores[i] ?? 0; });
  extra(w);
};

const color = (page: Page, selector: string, prop = "color") => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);


test.describe("the week of verdicts", () => {
  test("has the seven days of the week the day is in, Monday first, each with its weekday, number, score and band", async ({ alice, admin }) => {
    const data = await wellness(admin);
    await openRecovery(alice);
    await expect(strip(alice).locator("button.fwd")).toHaveCount(7);
    const days = await strip(alice).locator("button.fwd").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day));
    expect(days).toEqual(data.week.map((w) => w.day));
    expect(new Date(`${days[0]}T00:00:00Z`).getUTCDay()).toBe(1);
    await expect(strip(alice).locator("button.fwd small:first-child")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    for (const w of data.week.filter((x) => x.day <= data.today)) {
      await expect(chip(alice, w.day).locator(".fwk")).toHaveText(w.score === null ? "–" : String(w.score));
      await expect(chip(alice, w.day)).toHaveClass(new RegExp(`rd-${ZONE[w.band]}\\b`));
      if (w.score !== null) await expect(chip(alice, w.day).locator(".rwn")).toHaveText(NAME[w.band]);
    }
  });

  test("marks the day shown and today, rings each verdict in the colour of its zone, and says each day in words", async ({ alice, admin }) => {
    const data = await wellness(admin);
    await openRecovery(alice);
    await expect(chip(alice, data.today)).toHaveAttribute("aria-current", "date");
    await expect(strip(alice).locator("[aria-current]")).toHaveCount(1);
    await expect(chip(alice, data.today)).toHaveClass(/\btoday\b/);
    const known = data.week.filter((w) => w.day <= data.today && w.score !== null);
    for (const w of known) {
      await expect(chip(alice, w.day)).toHaveAttribute("aria-label", `${label(w.day)}, ${NAME[w.band]}, ${w.score} of 100`);
      await expect(chip(alice, w.day).locator(".fwring .arc")).toHaveClass(new RegExp(`z-${ZONE[w.band]}`));
    }
    const arc = await chip(alice, known[0].day).locator(".fwring .arc").getAttribute("stroke-dasharray");
    const [on, all] = arc!.split(" ").map(Number);
    expect(on / all).toBeCloseTo(known[0].score! / 100, 2);
  });

  test("a day to come cannot be opened", async ({ alice, admin }) => {
    const data = await wellness(admin);
    test.skip(data.week[6].day <= data.today, "today is a Sunday: the week has no day to come");
    await openRecovery(alice);
    const future = data.week.find((w) => w.day > data.today)!;
    await expect(chip(alice, future.day)).toBeDisabled();
    await expect(chip(alice, future.day)).toHaveAttribute("aria-label", `${label(future.day)}, not yet`);
    await expect(chip(alice, future.day).locator(".fwk")).toHaveText("–");
  });

  test("a tap on a day opens it in the part the view is in, the week staying", async ({ alice, admin }) => {
    const data = await wellness(admin);
    const day = addDays(data.today, -1);
    test.skip(day < data.week[0].day, "today is a Monday: the day before is in another week");
    await openRecovery(alice);
    await part(alice, "Trends").click();
    await expect(alice.locator("#rbody .rcharts")).toBeVisible();
    await chip(alice, day).click();
    await expect(alice.locator("#rDate")).toHaveValue(day);
    await expect(chip(alice, day)).toHaveAttribute("aria-current", "date");
    await expect(part(alice, "Trends")).toHaveAttribute("aria-pressed", "true");
    await expect(strip(alice).locator("button.fwd").first()).toHaveAttribute("data-day", data.week[0].day);
    await part(alice, "Verdict").click();
    await expect(hero(alice).locator(".rverdict .eyebrow")).toHaveText(`Readiness · ${label(day)}`);
  });

  test("the arrows step a day and the week follows them into the week before", async ({ alice, admin }) => {
    const data = await wellness(admin);
    await openRecovery(alice);
    const monday = data.week[0].day;
    for (let day = data.today; day > monday; day = addDays(day, -1)) await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(monday);
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(monday, -1));
    await expect(strip(alice).locator("button.fwd").first()).toHaveAttribute("data-day", addDays(monday, -7));
    await expect(chip(alice, addDays(monday, -1))).toHaveAttribute("aria-current", "date");
    await expect(strip(alice).locator("button.fwd:disabled")).toHaveCount(0);
  });
});


test.describe("the Verdict, the Trends and the Data", () => {
  test("open on the Verdict; each part draws its own and the others' are gone", async ({ alice }) => {
    await openRecovery(alice);
    await expect(part(alice, "Verdict")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#rbody .rcharts")).toHaveCount(0);
    await expect(alice.locator("#rbody table.rmetrics")).toHaveCount(0);
    await part(alice, "Trends").click();
    await expect(alice.locator("#rbody .rcharts")).toBeVisible();
    await expect(hero(alice)).toHaveCount(0);
    await expect(alice.locator("#rbody table.rmetrics")).toHaveCount(0);
    await part(alice, "Data").click();
    await expect(alice.locator("#rbody table.rmetrics")).toBeVisible();
    await expect(alice.locator("#rbody .rcharts")).toHaveCount(0);
    await part(alice, "Verdict").click();
    await expect(hero(alice)).toBeVisible();
  });

  test("the part chosen stays while the page is open, on another view and back", async ({ alice }) => {
    await openRecovery(alice);
    await part(alice, "Trends").click();
    await alice.locator("#vToday").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
    await alice.locator("#vRecovery").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
    await expect(part(alice, "Trends")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#rbody .rcharts")).toBeVisible();
  });

  test("the Data keeps its table open and Garmin's responses shut until they are asked for, and remembers how they were left", async ({ alice }) => {
    await openRecovery(alice);
    await part(alice, "Data").click();
    const [every, raw] = [alice.locator("#rbody details.racc").nth(0), alice.locator("#rbody details.racc").nth(1)];
    await expect(every).toHaveAttribute("open", "");
    await expect(raw).not.toHaveAttribute("open", "");
    await expect(raw.locator("summary").first()).toContainText("Garmin's responses for");
    await expect(raw.locator("summary").first()).toContainText("3 of 8 stored");
    await every.locator("summary").first().click();
    await expect(alice.locator("#rbody table.rmetrics")).toBeHidden();
    await part(alice, "Trends").click();
    await part(alice, "Data").click();
    await expect(alice.locator("#rbody details.racc").nth(0)).not.toHaveAttribute("open", "");
  });
});

test.describe("a profile with nothing stored", () => {
  test("has its week with no verdict, no tabs, and the range select in the bar", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#recovery");
    await expect(page.locator("#rProfile")).toBeVisible();
    await page.locator("#rProfile").selectOption(profile.name);
    await expect(page.locator("#rbody")).toContainText("No health data is stored yet");
    await expect(page.locator("#rTabs")).toBeHidden();
    await expect(strip(page).locator("button.fwd")).toHaveCount(7);
    const today = await page.locator("#rDate").inputValue();
    for (const day of await strip(page).locator("button.fwd").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day!))) {
      if (day > today) continue;
      await expect(chip(page, day)).toHaveClass(/rd-none/);
      await expect(chip(page, day)).toHaveAttribute("aria-label", `${label(day)}, no verdict`);
      await expect(chip(page, day).locator(".fwring .arc")).toHaveCount(0);
    }
    await expect(page.locator("#rbar #rRange")).toBeVisible();
  });
});


test.describe("the verdict", () => {
  test("draws the gauge: the three zones, the one the score is in at full strength, and the marker where the score is", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin);
    await openRecovery(alice);
    const zone = r.score! < 37.5 ? "back" : r.score! >= 70 ? "go" : "plan";
    const gauge = hero(alice).locator(".rgauge svg");
    await expect(gauge).toHaveAttribute("aria-label", new RegExp(`^Score ${r.score} of 100, in the .+ zone$`));
    await expect(gauge.locator("path.gz")).toHaveCount(3);
    await expect(gauge.locator("path.gz.on")).toHaveCount(1);
    await expect(gauge.locator(`path.gz.on.z-${zone}`)).toHaveCount(1);
    const mark = gauge.locator("circle.gmark");
    const [cx, cy] = [Number(await mark.getAttribute("cx")), Number(await mark.getAttribute("cy"))];
    const angle = Math.PI * (1 - r.score! / 100);
    expect(cx).toBeCloseTo(125 + 100 * Math.cos(angle), 0);
    expect(cy).toBeCloseTo(125 - 100 * Math.sin(angle), 0);
    await expect(hero(alice).locator(".rmid span")).toHaveText("of 100 · a normal day is 50");
  });

  test("Go harder: the green zone, the band and what holds it", async ({ alice }) => {
    await altered(alice, withBand("go-harder", 76, [1, 1, 1, 2, 1, 1]));
    await openRecovery(alice);
    await expect(hero(alice)).toHaveClass(/b-go/);
    await expect(hero(alice).locator(".rband")).toHaveText("Go harder");
    await expect(hero(alice).locator(".rmid b")).toHaveText("76");
    await expect(hero(alice).locator("path.gz.on")).toHaveClass(/z-go/);
    await expect(hero(alice).locator(".rchange")).toHaveText("Holding Go harder takes a score of 70 or more and HRV, resting heart rate and sleep all at normal or better. One hard session, then it reads the load again.");
    await expect(hero(alice).locator(".rchange b")).toHaveText(["Holding Go harder"]);
  });

  test("Back off by an HRV well below its range: the rose zone, and why, whatever the score", async ({ alice }) => {
    await altered(alice, withBand("back-off", 52, [-2, 1, 1, 1, 0, -1]));
    await openRecovery(alice);
    await expect(hero(alice)).toHaveClass(/b-back/);
    await expect(hero(alice).locator(".rband")).toHaveText("Back off");
    await expect(hero(alice).locator("path.gz.on")).toHaveClass(/z-plan/);
    await expect(hero(alice).locator(".rchange")).toHaveText("HRV well below your range sets Back off whatever the rest says. As planned comes back when HRV is back in your range.");
  });

  test("Back off by a low score says how far As planned is", async ({ alice }) => {
    await altered(alice, withBand("back-off", 31, [-1, -1, -2, -1, -1, -1]));
    await openRecovery(alice);
    await expect(hero(alice).locator("path.gz.on")).toHaveClass(/z-back/);
    await expect(hero(alice).locator(".rchange")).toHaveText("As planned comes back at a score of 38 (7 more).");
  });

  test("As planned says how far Go harder is and what it needs, and where Back off starts", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin);
    expect(r.band).toBe("as-planned");
    await openRecovery(alice);
    const text = await hero(alice).locator(".rchange").innerText();
    expect(text).toContain(`Go harder needs a score of 70 (${70 - r.score!} more)`);
    expect(text).toContain(`Back off starts under 38 (${r.score! - 37} less), or if HRV falls well below your range.`);
  });

  test("each signal has a meter of five steps with the one of its score lit, and the colours of good and bad", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin);
    await openRecovery(alice);
    const rows = alice.locator("#rbody .rsigcard .rsig");
    for (const [i, s] of r.signals.entries()) {
      const steps = rows.nth(i).locator(".meter i");
      await expect(steps).toHaveCount(5);
      expect(await steps.evaluateAll((els) => els.map((e) => e.classList.contains("on")))).toEqual([-2, -1, 0, 1, 2].map((x) => x === s.score));
      await expect(rows.nth(i).locator(".meter")).toHaveAttribute("aria-label", new RegExp(` your normal$`));
    }
    await altered(alice, withBand("as-planned", 40, [-2, -1, 0, 1, 2, 0]));
    await alice.reload();
    await expect(hero(alice)).toBeVisible();
    const lit = alice.locator("#rbody .rsigcard .rsig");
    const fills = await lit.evaluateAll((els) => els.map((e) => getComputedStyle(e.querySelector(".meter i.on")!).backgroundColor));
    expect(new Set(fills).size).toBeGreaterThanOrEqual(4);
    expect(fills[3]).toBe(fills[4]);
  });

  test("last night: the time, the score, the stages, and how much of the need it was", async ({ alice, admin }) => {
    const data = await wellness(admin);
    const day = data.days[data.days.length - 1];
    await openRecovery(alice);
    const hm = (s: number) => `${Math.floor(Math.round(s / 60) / 60)} h ${String(Math.round(s / 60) % 60).padStart(2, "0")}`;
    const card = alice.locator("#rbody .rnight");
    await expect(card.locator(".rbig b")).toHaveText(hm(day.sleepSeconds!));
    await expect(card.locator(".rbig span")).toHaveText(`score ${day.sleepScore}`);
    await expect(card.locator(".rlegend span")).toHaveText([`Deep ${hm(day.deepSeconds!)}`, `REM ${hm(day.remSeconds!)}`, `Light ${hm(day.lightSeconds!)}`, `Awake ${hm(day.awakeSeconds!)}`]);
    const pct = Math.round((day.sleepSeconds! / (day.sleepNeedMinutes! * 60)) * 100);
    await expect(card.locator(".rneed .nl")).toContainText(`${pct} % of the sleep you need`);
    await expect(card.locator(".rneed .nl")).toContainText("need 8 h");
    expect(parseFloat(await card.locator(".rneed .t i").evaluate((el) => (el as HTMLElement).style.width))).toBe(Math.min(100, pct));
    await expect(card.locator(".rkv b")).toHaveText([String(day.awakeCount), String(day.sleepStress)]);
    const widths = await card.locator(".rstages i").evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.width)));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
  });

  test("the load before: each bar against its usual, with a tick at the usual, in a colour for how heavy it was", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin);
    const load = r.load!;
    await openRecovery(alice);
    const bar = alice.locator("#rbody .rload .rbullet").first();
    const expected = load.ratio! >= 1.6 ? "veryheavy" : load.ratio! >= 1.3 ? "heavy" : load.ratio! <= 0.7 ? "light" : "usual";
    await expect(bar).toHaveClass(new RegExp(`l-${expected}`));
    expect(parseFloat(await bar.locator(".t i").evaluate((el) => (el as HTMLElement).style.width))).toBeCloseTo(Math.min(100, (load.ratio! / 2) * 100), 1);
    await expect(bar.locator(".t u")).toHaveCount(1);
    await expect(bar.locator(".n")).toContainText(`${Math.round(load.ratio! * 100)} % of your usual`);
    await expect(bar.locator(".t")).toHaveAttribute("aria-label", /% of your usual$/);
    await altered(alice, (w) => { w.readiness.load = { ...w.readiness.load!, ratio: 0.6, acute: 390, intensity: null }; });
    await alice.reload();
    await expect(hero(alice)).toBeVisible();
    await expect(alice.locator("#rbody .rload .rbullet")).toHaveClass(/l-light/);
  });

  test("has no load card without a load, and no night card without sleep", async ({ alice }) => {
    await altered(alice, (w) => { w.readiness.load = null; w.days[w.days.length - 1].sleepSeconds = null; });
    await openRecovery(alice);
    await expect(alice.locator("#rbody .rload")).toHaveCount(0);
    await expect(alice.locator("#rbody .rnight")).toHaveCount(0);
    await expect(alice.locator("#rbody .rsigcard")).toBeVisible();
  });
});


test.describe("the look", () => {
  test("the controls of the bar, the week and the tabs are at least 44 px, in both themes", async ({ alice }) => {
    await openRecovery(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      const small = await alice.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#rbar button, #rbar .rdaypick, #rweek button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className, Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44),
      );
      expect(small, `${theme}: controls under 44 px`).toEqual([]);
    }
  });

  test("the theme button switches between dark and light, says what it will do, and the choice is the one of the other views", async ({ alice }) => {
    await openRecovery(alice);
    const body = alice.locator("body");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await expect(body).toHaveAttribute("data-theme", "dark");
    const dark = await color(alice, "#rscroll", "background-color");
    await toggleTheme(alice);
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(body).toHaveAttribute("data-theme", "light");
    expect(await color(alice, "#rscroll", "background-color")).not.toBe(dark);
    await alice.locator("#vToday").click();
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    await toggleTheme(alice);
    await alice.locator("#vRecovery").click();
    await expect(body).toHaveAttribute("data-theme", "dark");
  });

  test("the band, the signals, the cards and the week read: the text of each against its background, in both themes", async ({ alice }) => {
    await altered(alice, withBand("go-harder", 76, [1, 1, 1, 2, 1, 1]));
    await openRecovery(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
      const low = await alice.evaluate(() => {
        const lum = (css: string) => {
          const unit = css.startsWith("color(srgb") ? 1 : 255;
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / unit; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element): string => {
          for (let p: Element | null = el; p; p = p.parentElement) {
            const c = getComputedStyle(p).backgroundColor;
            if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c;
          }
          return "rgb(0,0,0)";
        };
        const out: string[] = [];
        const check = (sel: string, min: number) => {
          for (const el of document.querySelectorAll(sel)) {
            const fg = getComputedStyle(el).color, bg = bgOf(el), [a, b] = [lum(fg), lum(bg)];
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < min) out.push(`${sel} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
          }
        };
        for (const sel of ["#rbody .rsug", "#rbody .rsig .nm", "#rbody .rsig .val", "#rbody .rsig .why", "#rbody .rbig b", "#rbody .rbullet .l", "#rbody .rkv b", "#rstrip .fwd b", "#rstrip .fwd .fwk"]) check(sel, 7);
        for (const sel of ["#rbody .rband", "#rbody .rsig .base", "#rbody .chipx", "#rbody .rchange", "#rbody .rmid span", "#rbody .rlegend span", "#rbody .rkv small", "#rbody .rbullet .n", "#rstrip .fwd small", "#rbody .eyebrow", "#rTabs button"]) check(sel, 4.5);
        return out;
      });
      expect(low, `${theme}: text under its contrast`).toEqual([]);
    }
  });

  test("the three bands are told apart in both themes: the gauge's zones, the band's text and the rings", async ({ alice }) => {
    const seen: Record<string, string[]> = {};
    await openRecovery(alice);
    for (const [band, score, scores] of [["go-harder", 76, [1, 1, 1, 2, 1, 1]], ["as-planned", 52, [0, 1, 1, 1, 0, -1]], ["back-off", 31, [-1, -1, -2, -1, -1, -1]]] as const) {
      await alice.unroute(/\/api\/wellness\?/).catch(() => undefined);
      await altered(alice, withBand(band, score, [...scores]));
      await alice.reload();
      await expect(hero(alice)).toHaveClass(new RegExp(`b-${ZONE[band]}`));
      for (const theme of ["dark", "light"]) {
        if ((await alice.locator("body").getAttribute("data-theme")) !== theme) await toggleTheme(alice);
        await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
        (seen[theme] ??= []).push(await color(alice, "#rbody .rband"));
      }
    }
    for (const theme of ["dark", "light"]) expect(new Set(seen[theme]).size, `${theme}: three different band colours`).toBe(3);
  });

  test("does not scroll the page sideways at laptop and tablet widths, in any part", async ({ alice }) => {
    await openRecovery(alice);
    for (const width of [1100, 1000, 800]) {
      await alice.setViewportSize({ width, height: 900 });
      for (const name of ["Verdict", "Trends", "Data"] as const) {
        await part(alice, name).click();
        await expect(part(alice, name)).toHaveAttribute("aria-pressed", "true");
        const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(w.scroll, `${width}px, ${name}`).toBeLessThanOrEqual(w.client);
      }
    }
  });

  test("lays the Verdict out in two columns on a wide screen and in one under 1100 px, the gauge over the signals", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 900 });
    await openRecovery(alice);
    const at = (sel: string) => alice.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const [main, side] = [await at("#rbody .rmain"), await at("#rbody .rside")];
    expect(main.right).toBeLessThanOrEqual(side.left);
    expect(Math.abs(main.top - side.top)).toBeLessThan(2);
    expect((await at("#rbody .rsigcard")).top).toBeGreaterThan((await at("#rbody .rhero")).bottom - 1);
    await alice.setViewportSize({ width: 1000, height: 900 });
    const [m2, s2] = [await at("#rbody .rmain"), await at("#rbody .rside")];
    expect(s2.top).toBeGreaterThan(m2.bottom - 1);
    expect(Math.round(s2.left)).toBe(Math.round(m2.left));
  });

  test("the trends draw their charts for the room they get: text readable as shown and none of it cut off", async ({ alice }) => {
    await openRecovery(alice);
    for (const width of [1360, 1000]) {
      await alice.setViewportSize({ width, height: 900 });
      await part(alice, "Trends").click();
      await expect(alice.locator("#rbody .rcharts")).toBeVisible();
      const charts = await alice.evaluate(() =>
        [...document.querySelectorAll<SVGSVGElement>("#rbody .rcsvg")].map((svg) => {
          const box = svg.getBoundingClientRect(), scale = box.width / svg.viewBox.baseVal.width;
          const labels = [...svg.querySelectorAll<SVGTextElement>(".rc-tick, .rc-x")];
          return { minFontPx: Math.min(...labels.map((l) => parseFloat(getComputedStyle(l).fontSize) * scale)), cutOff: labels.filter((l) => { const r = l.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; }).length };
        }),
      );
      expect(charts.length).toBe(9);
      for (const c of charts) {
        expect(c.minFontPx, `${width}px: text size`).toBeGreaterThanOrEqual(9.5);
        expect(c.cutOff, `${width}px: labels cut off`).toBe(0);
      }
    }
  });

  test("the zones of the readiness chart are in the colours of the gauge's, in both themes", async ({ alice }) => {
    await altered(alice, (w) => {
      w.readinessDays.forEach((d, i) => { d.score = [30, 55, 80][i % 3]; d.band = ["back-off", "as-planned", "go-harder"][i % 3]; });
    });
    await openRecovery(alice);
    await part(alice, "Trends").click();
    const c = alice.locator("#rbody .rc", { has: alice.locator("b", { hasText: "Readiness" }) });
    await expect(c.locator("rect.rc-bar.go")).not.toHaveCount(0);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      const fills = await Promise.all(["go", "plan", "back"].map((z) => c.locator(`rect.rc-bar.${z}`).first().evaluate((el) => getComputedStyle(el).fill)));
      expect(new Set(fills).size, theme).toBe(3);
      const key = await Promise.all(["go", "plan", "back"].map((z) => c.locator(`.rcl i.sw-${z}`).evaluate((el) => getComputedStyle(el).backgroundColor)));
      expect(new Set(key).size, theme).toBe(3);
    }
    await expect(c.locator(".rcl")).toContainText("Back off");
    await expect(c.locator(".rcl")).toContainText("Go harder");
  });
});

