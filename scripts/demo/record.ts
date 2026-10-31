/**
 * Records the README's animations (docs/media/*.webp) from the editor running on the demo database (seed.ts):
 *
 *   npm run demo:record                  every scene
 *   npm run demo:record -- food plans    some of them
 *   npm run demo:record -- --gif         GIFs instead of WebP
 *
 * Each scene drives a fresh page with Playwright while Chrome's screencast keeps every frame it paints, with its time; ffmpeg
 * then turns the frames into an animation at the pace they were painted. pointer.js draws the pointer (headless Chrome draws none).
 * Needs ffmpeg with libwebp on the PATH. Emoji need a color emoji font: without one installed, point FONTCONFIG_FILE at a
 * fonts.conf that adds one.
 *
 * Nothing is reached but OpenStreetMap (the map tiles) and Open Food Facts (the food search). The AI box's answer is the
 * recorder's own (ESTIMATE below), so no Claude login is needed: what the recording shows of it is the page, not a real estimate.
 */
import { chromium, devices, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startDemo } from "./server";
import { DEMO_PASSWORD, DEMO_USER } from "./seed";

const OUT = path.resolve(__dirname, "../../docs/media");
const PORT = Number(process.env.DEMO_PORT ?? 8781);
const DESKTOP = { width: 1024, height: 700 };
/** The width recorded: GitHub shows a README image at most about 900 px wide. */
const WIDTH = 900;
const FPS = 10;
/** Animated WebP: full color at about half a GIF's size, and GitHub shows it like a GIF. --gif makes GIFs (128 colors) instead. */
const FORMAT = process.argv.includes("--gif") ? "gif" : "webp";

// ─── a scene ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Frame {
  file: string;
  at: number;
}

/** A page being recorded, with the moves a person makes: the pointer glides, the keys are typed one at a time. */
class Stage {
  private x = DESKTOP.width / 2;
  private y = DESKTOP.height / 2;
  constructor(readonly page: Page, readonly touch: boolean) {}

  pause(ms: number) {
    return this.page.waitForTimeout(ms);
  }

  /** Glide the pointer to a point (to a fraction of a box: 0.5, 0.5 is its middle). */
  async moveTo(target: Locator | { x: number; y: number }, fx = 0.5, fy = 0.5) {
    let x: number, y: number;
    if ("x" in target) ({ x, y } = target);
    else {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box) throw new Error(`Not on screen: ${target}`);
      x = box.x + box.width * fx;
      y = box.y + box.height * fy;
    }
    if (this.touch) return { x, y };
    const steps = Math.max(8, Math.min(30, Math.round(Math.hypot(x - this.x, y - this.y) / 25)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await this.page.mouse.move(this.x + (x - this.x) * ease, this.y + (y - this.y) * ease);
      await this.page.waitForTimeout(12);
    }
    this.x = x;
    this.y = y;
    return { x, y };
  }

  /** Point at it, then click (or tap, on a phone). */
  async click(target: Locator, { fx = 0.5, fy = 0.5, wait = 450 } = {}) {
    const { x, y } = await this.moveTo(target, fx, fy);
    if (this.touch) await this.page.touchscreen.tap(x, y);
    else {
      await this.pause(120);
      await this.page.mouse.down();
      await this.page.mouse.up();
    }
    await this.pause(wait);
  }

  async type(target: Locator, text: string, delay = 55) {
    await this.click(target, { wait: 150 });
    await this.page.keyboard.type(text, { delay });
  }

  /** Sweep the pointer across a box, left to right, as when reading a chart. */
  async sweep(target: Locator, from = 0.1, to = 0.9, ms = 2200, fy = 0.5) {
    await this.moveTo(target, from, fy);
    const box = (await target.boundingBox())!;
    const steps = Math.round(ms / 40);
    for (let i = 1; i <= steps; i++) {
      this.x = box.x + box.width * (from + ((to - from) * i) / steps);
      await this.page.mouse.move(this.x, this.y);
      await this.page.waitForTimeout(40);
    }
  }

  /** Scroll the pane that holds an element until the element is near the top of it. */
  async reveal(target: Locator, ms = 1100) {
    await target.waitFor();
    const dy = await target.evaluate((el) => {
      let pane: Element | null = el.parentElement;
      while (pane && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
      return el.getBoundingClientRect().top - (pane ?? document.documentElement).getBoundingClientRect().top - 12;
    });
    await this.scroll(target, dy, ms);
  }

  /** Scroll the pane that holds an element by dy pixels, easing in and out. */
  async scroll(within: Locator, dy: number, ms = 900) {
    const steps = Math.max(1, Math.round(ms / 30));
    let done = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, to = Math.round(dy * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
      await within.evaluate((el, d) => {
        let pane: Element | null = el;
        while (pane && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
        (pane ?? document.scrollingElement!).scrollBy(0, d);
      }, to - done);
      done = to;
      await this.page.waitForTimeout(30);
    }
  }
}

interface Scene {
  name: string;
  /** Recorded on a phone (a Pixel 7) instead of a desktop browser. */
  phone?: boolean;
  /** The address the scene starts on, already drawn when the recording starts. */
  start: string;
  /** What must be on screen before the recording starts. */
  ready?: (page: Page) => Promise<unknown>;
  /** Set up the page before it loads (routes). */
  before?: (page: Page) => Promise<unknown>;
  run: (s: Stage, page: Page) => Promise<void>;
}

// ─── the scenes, in the order they run (the food ones change the log, so they come last) ────────────────────────────────

const meal = (page: Page, name: string) => page.locator(`#fbody section.fmeal[data-meal="${name}"]`);

/** What the AI box is answered with (see the header). */
const ESTIMATE = {
  items: [
    { name: "Grilled chicken breast", portion: "150 g", meal: "dinner", amount: 150, unit: "g", kcal: 248, proteinG: 46, carbsG: 0, fatG: 5, nutrients: { sodiumMg: 110, potassiumMg: 390 } },
    { name: "Roasted sweet potato", portion: "1 medium", meal: "dinner", amount: 150, unit: "g", kcal: 135, proteinG: 2, carbsG: 31, fatG: 0, nutrients: { fiberG: 5, potassiumMg: 670 } },
    { name: "Steamed green beans", portion: "1 cup", meal: "dinner", amount: 125, unit: "g", kcal: 44, proteinG: 2, carbsG: 10, fatG: 0, nutrients: { fiberG: 4 } },
    { name: "Olive oil", portion: "1 tbsp", meal: "dinner", amount: 14, unit: "ml", kcal: 119, proteinG: 0, carbsG: 0, fatG: 14, nutrients: { satFatG: 2 } },
  ],
  note: "Assumed the sweet potato was roasted with the olive oil.",
  remaining: 28,
};

const SCENES: Scene[] = [
  {
    name: "today",
    start: "/",
    ready: (page) => page.locator("#tbody .twk").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1200);
      await s.moveTo(page.locator("#tbody .twk .wv-chart").first(), 0.05);
      await s.sweep(page.locator("#tbody .twk .wv-chart").first(), 0.05, 0.95, 2000);
      await s.pause(500);
      await s.scroll(page.locator("#tbody"), 420, 1300);
      await s.pause(1400);
      await s.scroll(page.locator("#tbody"), 600, 1300);
      await s.pause(1800);
      await s.scroll(page.locator("#tbody"), -1100, 1100);
      await s.pause(800);
    },
  },
  {
    name: "plans",
    start: "/#plans",
    // the page's Monaco editor is the global `editor` (a script-level binding, not a property of window)
    ready: (page) => page.waitForFunction('typeof editor !== "undefined" && !!editor && document.getElementById("new").onclick !== null'),
    run: async (s, page) => {
      await s.pause(700);
      await s.click(page.locator("#filelist .file").filter({ hasText: "half-marathon-build" }), { wait: 1200 });
      const intervals = page.locator("#outline .row.wk").filter({ hasText: "Intervals 6 x 800 m" });
      await s.click(intervals.locator(".name"), { wait: 1600 });
      await s.sweep(intervals.locator(".wv-chart").first(), 0.05, 0.95, 2200);
      await s.pause(600);
      await s.click(intervals.getByRole("button", { name: "Edit in JSON" }), { wait: 1200 });
      // a typo the validation catches as it is typed, then put right
      const placed = await page.evaluate(`(() => {
        const model = editor.getModel();
        for (let n = editor.getPosition().lineNumber; n <= model.getLineCount(); n++) {
          const at = model.getLineContent(n).indexOf('"warmup"');
          if (at < 0) continue;
          editor.revealLineInCenter(n);
          editor.setPosition({ lineNumber: n, column: at + 8 });
          editor.focus();
          return true;
        }
        return false;
      })()`);
      if (placed) {
        await s.pause(500);
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace", { delay: 70 });
        await page.keyboard.type("warmpu", { delay: 90 });
        await page.locator("#problems .msg.err").first().waitFor();
        await s.moveTo(page.locator("#problems .msg.err").first());
        await s.pause(1800);
        await s.moveTo(page.locator(".monaco-editor .view-lines"), 0.4, 0.5);
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace", { delay: 70 });
        await page.keyboard.type("warmup", { delay: 90 });
        await s.pause(1200);
      }
      const strength = page.locator("#outline .row.wk").filter({ hasText: "Strength A" });
      await s.click(intervals.locator(".name"), { wait: 500 });
      await s.click(strength.locator(".name"), { wait: 1400 });
      await s.scroll(page.locator("#outline"), 640, 1400);
      await s.pause(2200);
    },
  },
  {
    name: "calendar",
    start: "/#calendar",
    ready: (page) => page.locator(".cband").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1500);
      await s.click(page.locator("#cModes button[data-mode=plans]"), { wait: 1500 });
      await s.click(page.locator("#cModes button[data-mode=workouts]"), { wait: 1500 });
      await s.click(page.locator("#cModes button[data-mode=both]"), { wait: 1000 });
      await s.click(page.locator("#cNext"), { wait: 1800 });
      await s.click(page.locator("#cgrid .cday").filter({ hasText: /^\s*1?\d\b/ }).nth(5), { fx: 0.5, fy: 0.15, wait: 1500 });
      await s.click(page.locator("#cPrev"), { wait: 1200 });
      await s.click(page.locator("#cgrid .inband").filter({ hasText: "Intervals" }).last(), { wait: 2000 });
      await s.pause(1500);
    },
  },
  {
    name: "activity",
    start: "/#activities",
    ready: (page) => page.locator("#alist .arow").first().waitFor(),
    run: async (s, page) => {
      await s.pause(800);
      await s.click(page.locator("#alist .arow").filter({ hasText: "Intervals 6 x 800 m" }).first(), { wait: 2200 });
      const section = (title: RegExp) => page.locator("#abody h3").filter({ hasText: title }).first();
      await s.reveal(section(/graphs/i));
      const graph = page.locator("#abody svg.acsvg").first();
      await s.sweep(graph, 0.03, 0.97, 3500);
      await s.pause(500);
      await s.reveal(section(/route/i));
      await s.pause(1800);
      await s.reveal(section(/laps/i));
      await s.pause(2000);
      await s.reveal(section(/planned workout/i));
      await s.pause(2400);
    },
  },
  {
    name: "activities",
    start: "/#activities",
    ready: (page) => page.locator("#alist .arow").first().waitFor(),
    run: async (s, page) => {
      await s.pause(800);
      await s.click(page.locator("#alist .arow").filter({ hasText: "Strength A" }).first(), { wait: 1800 });
      await s.scroll(page.locator("#abody"), 480, 1200);
      await s.pause(2200);
      await s.click(page.locator("#aModes button[data-mode=calendar]"), { wait: 1200 });
      if ((await page.locator("#aPlanned").getAttribute("aria-pressed")) !== "true") await s.click(page.locator("#aPlanned"), { wait: 1500 });
      await s.pause(1200);
      await s.click(page.locator("#aModes button[data-mode=stats]"), { wait: 1800 });
      await s.scroll(page.locator("#astats"), 600, 1500);
      await s.pause(2200);
    },
  },
  {
    name: "recovery",
    start: "/#recovery",
    ready: (page) => page.locator(".rband").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1800);
      await s.scroll(page.locator("#rbody"), 520, 1200);
      await s.pause(600);
      const chart = page.locator("#rbody svg.rcsvg").first();
      await s.sweep(chart, 0.05, 0.95, 3000);
      await s.pause(400);
      await s.click(chart, { fx: 0.4, wait: 1600 });
      await s.scroll(page.locator("#rbody"), -900, 900);
      await s.pause(1600);
    },
  },
  {
    name: "weight",
    start: "/#weight",
    ready: (page) => page.locator("#bbody .rfig").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1500);
      await s.sweep(page.locator("#bbody svg.rcsvg").first(), 0.05, 0.95, 2500);
      await s.click(page.locator("#bRange"), { wait: 300 });
      await page.locator("#bRange").selectOption("90");
      await s.pause(1500);
      await s.click(page.getByRole("button", { name: "kg", exact: true }), { wait: 1500 });
    },
  },
  {
    name: "phone",
    phone: true,
    start: "/",
    ready: (page) => page.locator("#tbody .twk").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1500);
      await s.scroll(page.locator("#tbody"), 700, 1200);
      await s.pause(1000);
      await s.click(page.locator("#views button, #views a").filter({ hasText: "Calendar" }), { wait: 1500 });
      await s.click(page.locator("#cgrid .cday.today, #cgrid .cday.sel").first(), { wait: 1600 });
      await s.click(page.locator("#views button, #views a").filter({ hasText: "Food" }), { wait: 1500 });
      await s.scroll(page.locator("#fbody"), 500, 1000);
      await s.pause(1500);
    },
  },
  {
    name: "food",
    start: "/#food",
    ready: (page) => meal(page, "dinner").waitFor(),
    run: async (s, page) => {
      await s.pause(1000);
      // one tap on a recent food
      await s.scroll(page.locator("#fbody"), 330, 700);
      await s.click(meal(page, "snack").getByRole("button", { name: "Recent", exact: true }), { wait: 1200 });
      await s.click(meal(page, "snack").locator(".frec").filter({ hasText: "Protein shake" }).first(), { wait: 1500 });
      // a food from Open Food Facts, by its quantity
      const search = meal(page, "dinner").getByRole("searchbox", { name: "Search a food" });
      await s.type(search, "skyr", 110);
      const result = meal(page, "dinner").locator(".fresults button.fr").first();
      await result.waitFor({ timeout: 20_000 });
      await s.pause(1200);
      await s.click(result, { wait: 1000 });
      const picker = meal(page, "dinner").locator(".fpick");
      const quantity = picker.getByRole("spinbutton", { name: "Quantity" });
      await s.click(quantity, { wait: 150 });
      await page.keyboard.press("Control+a");
      await page.keyboard.type("175", { delay: 140 });
      await s.pause(1200);
      await s.click(picker.getByRole("button", { name: "Add", exact: true }), { wait: 1500 });
      // by hand: the calories follow the macros
      const hand = meal(page, "dinner").locator("details.fhand");
      await s.click(hand.locator("summary").first(), { wait: 500 });
      const form = hand.locator("form.fform");
      await s.type(form.locator(".fname"), "Rice cakes, 2", 60);
      await s.type(form.locator('input[aria-label="P g"]'), "2", 120);
      await s.type(form.locator('input[aria-label="C g"]'), "15", 120);
      await s.type(form.locator('input[aria-label="F g"]'), "1", 120);
      await s.pause(900);
      await s.click(form.locator('button[type="submit"]'), { wait: 1200 });
      await s.scroll(page.locator("#fbody"), -1200, 900);
      await s.pause(2000);
    },
  },
  {
    name: "food-ai",
    start: "/#food",
    before: async (page) => {
      await page.route("**/api/foods/ai", (route) => setTimeout(() => route.fulfill({ json: ESTIMATE }), 1600));
      await page.route("**/api/nutrition*", async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        if (json.ai) json.ai = { ...json.ai, enabled: true, remaining: 29 };
        await route.fulfill({ response, json });
      });
    },
    ready: (page) => meal(page, "dinner").waitFor(),
    run: async (s, page) => {
      await s.pause(900);
      await s.click(page.locator("#fbody .fai .faihead"), { wait: 600 });
      await s.type(page.locator("#fbody .faitext"), "chicken breast with a roasted sweet potato and green beans, a bit of olive oil", 35);
      await s.pause(500);
      await s.click(page.locator("#fbody .fai").getByRole("button", { name: "Estimate", exact: true }), { wait: 300 });
      await page.locator("#fbody .faires .fair").first().waitFor();
      await s.pause(2400);
      await s.click(page.locator("#fbody .faires .fpa button.primary"), { wait: 1500 });
      await s.scroll(page.locator("#fbody"), 700, 1200);
      await s.pause(2200);
    },
  },
];

// ─── recording ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function record(browser: Browser, base: string, scene: Scene, work: string): Promise<string> {
  const options = scene.phone
    ? { ...devices["Pixel 7"], deviceScaleFactor: 1 }
    : { viewport: DESKTOP, deviceScaleFactor: 1 };
  const context: BrowserContext = await browser.newContext({ ...options, baseURL: base, timezoneId: "UTC", locale: "en-CA", colorScheme: "dark" });
  const login = await context.request.post("/api/login", { data: { user: DEMO_USER, password: DEMO_PASSWORD }, headers: { "X-Requested-With": "plan-editor" } });
  if (!login.ok()) throw new Error(`Sign-in failed: ${login.status()}`);
  await context.addInitScript({ path: path.join(__dirname, "pointer.js") });
  const page = await context.newPage();
  await scene.before?.(page);
  await page.goto(scene.start);
  await page.locator("#views").waitFor();
  await scene.ready?.(page);
  await page.waitForTimeout(600);

  const dir = path.join(work, scene.name);
  fs.mkdirSync(dir, { recursive: true });
  const frames: Frame[] = [];
  const cdp = await context.newCDPSession(page);
  const viewport = page.viewportSize()!;
  cdp.on("Page.screencastFrame", (f: any) => {
    const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, at: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  // a first frame even when nothing moves
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  const stage = new Stage(page, !!scene.phone);
  await scene.run(stage, page);
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  await context.close();
  if (!frames.length) throw new Error(`${scene.name}: no frame was painted`);

  // ffmpeg's concat list: each frame for as long as it stayed on screen, the last one held for a moment
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (i + 1 < frames.length ? frames[i + 1].at : Math.max(end, f.at + 1)) - f.at).toFixed(3)}`);
  list.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n"));
  const width = scene.phone ? viewport.width : WIDTH;
  const out = path.join(OUT, `${scene.name}.${FORMAT}`);
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt")];
  const scale = `fps=${FPS},scale=${width}:-1:flags=lanczos`;
  if (FORMAT === "webp") execFileSync("ffmpeg", [...input, "-vf", scale, "-c:v", "libwebp_anim", "-quality", "80", "-compression_level", "6", "-loop", "0", out]);
  else execFileSync("ffmpeg", [...input, "-vf", `${scale},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", out]);
  return `${path.basename(out)}: ${frames.length} frames, ${(frames[frames.length - 1].at - frames[0].at).toFixed(1)} s, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`;
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const scenes = wanted.length ? SCENES.filter((s) => wanted.includes(s.name)) : SCENES;
  if (!scenes.length) throw new Error(`No such scene. Scenes: ${SCENES.map((s) => s.name).join(", ")}`);
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "demo-frames-"));
  const demo = await startDemo(PORT);
  const browser = await chromium.launch();
  try {
    for (const scene of scenes) console.log(await record(browser, demo.url, scene, work));
  } finally {
    await browser.close();
    demo.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
