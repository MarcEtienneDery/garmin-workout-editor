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
const WIDTH = 900;
const FPS = 10;
const FORMAT = process.argv.includes("--gif") ? "gif" : "webp";


interface Frame {
  file: string;
  at: number;
}

class Stage {
  private x = DESKTOP.width / 2;
  private y = DESKTOP.height / 2;
  constructor(readonly page: Page, readonly touch: boolean) {}

  pause(ms: number) {
    return this.page.waitForTimeout(ms);
  }

  async moveTo(target: Locator | { x: number; y: number }, fx = 0.5, fy = 0.5, stepMs = 12) {
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
      await this.page.waitForTimeout(stepMs);
    }
    this.x = x;
    this.y = y;
    return { x, y };
  }

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

  async drag(from: Locator, to: Locator, { hold = 450, wait = 450 } = {}) {
    await this.moveTo(from);
    await this.pause(250);
    await this.page.mouse.down();
    await this.pause(150);
    await this.moveTo(to, 0.5, 0.5, 35);
    await this.pause(hold);
    await this.page.mouse.up();
    await this.pause(wait);
  }

  async type(target: Locator, text: string, delay = 55) {
    await this.click(target, { wait: 150 });
    await this.page.keyboard.type(text, { delay });
  }

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

  async reveal(target: Locator, ms = 1100) {
    await target.waitFor();
    const dy = await target.evaluate((el) => {
      let pane: Element | null = el.parentElement;
      while (pane && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
      return el.getBoundingClientRect().top - (pane ?? document.documentElement).getBoundingClientRect().top - 12;
    });
    await this.scroll(target, dy, ms);
  }

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
  phone?: boolean;
  start: string;
  ready?: (page: Page) => Promise<unknown>;
  before?: (page: Page) => Promise<unknown>;
  run: (s: Stage, page: Page) => Promise<void>;
}


const meal = (page: Page, name: string) => page.locator(`#fbody section.fmeal[data-meal="${name}"]`);

const atDinner = (page: Page) => page.clock.setFixedTime(new Date(`${new Date().toISOString().slice(0, 10)}T18:40:00Z`));

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

const MOVE_PICK = `(() => {
  const today = new Date().toISOString().slice(0, 10), weeks = [...document.querySelectorAll("#cgrid .cweek")];
  const at = weeks.findIndex((wk) => wk.querySelector(".cday.today"));
  const col = (el) => parseInt(el.style.gridColumn, 10) - 1;
  for (const wk of at < 0 ? weeks : [weeks[at + 1], weeks[at], ...weeks].filter(Boolean)) {
    const days = [...wk.querySelectorAll(".cday")].sort((a, b) => col(a) - col(b));
    const chips = [...wk.querySelectorAll(".cbar.wk")], busy = new Set(chips.map(col));
    chips.sort((a, b) => (b.textContent === "Easy run") - (a.textContent === "Easy run"));
    for (const chip of chips) {
      const c = col(chip);
      if (!days[c] || days[c].dataset.day < today) continue;
      for (const off of [1, -1, 2, -2, 3, -3]) {
        const d = days[c + off];
        if (!d || busy.has(c + off) || d.classList.contains("out") || d.dataset.day < today) continue;
        chip.dataset.demo = "drag";
        d.dataset.demo = "drop";
        return true;
      }
    }
  }
  return false;
})()`;

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
    ready: (page) => page.waitForFunction('typeof editor !== "undefined" && !!editor && document.getElementById("new").onclick !== null'),
    run: async (s, page) => {
      const form = page.locator("#pform");
      await s.pause(700);
      await s.click(page.locator("#filelist .file").filter({ hasText: "half-marathon-build" }), { wait: 1400 });
      await s.click(page.locator("#outline .row.wk .name").filter({ hasText: "Intervals 6 x 800 m" }), { wait: 1600 });
      await s.click(form.locator(".wf-rep").getByRole("button", { name: "Times: one more" }), { wait: 900 });
      const from = form.getByLabel("Pace from");
      await s.click(from, { wait: 200 });
      await page.keyboard.press("Control+A");
      await page.keyboard.type("4:00", { delay: 110 });
      await page.keyboard.press("Tab");
      await s.pause(1400);
      await s.click(page.locator("#emode button[data-mode=json]"), { wait: 400 });
      await page.evaluate(`(() => {
        const m = editor.getModel().findMatches('"Intervals 6 x 800 m"', false, false, true, null, false)[0];
        if (m) { editor.revealLineInCenter(m.range.startLineNumber + 12); editor.setPosition(m.range.getStartPosition()); }
      })()`);
      await s.pause(2200);
      await s.click(page.locator("#emode button[data-mode=form]"), { wait: 800 });
      await s.click(page.locator("#outline .row.wk .name").filter({ hasText: "Strength A" }), { wait: 1600 });
      await s.reveal(form.locator(".wf-ex").filter({ hasText: "Bent Over Row With Barbell" }), 1200);
      await s.click(form.getByRole("button", { name: "More for Bent Over Row With Barbell" }), { wait: 700 });
      await s.click(page.locator(".wf-menu").getByRole("menuitem", { name: "Superset with the next exercise" }), { wait: 1400 });
      await s.click(form.locator(".wf-ss").getByRole("button", { name: "Rounds: one more" }), { wait: 1600 });
      await s.reveal(form.locator(".wf-add"), 900);
      await s.click(form.locator(".wf-add").getByRole("button", { name: "+ Exercise" }), { wait: 600 });
      await s.type(page.getByLabel("Search Garmin's exercises"), "hip thrust", 90);
      await s.pause(900);
      await s.click(page.locator("dialog.wf-pick .wf-pk-row").first(), { wait: 1600 });
      await s.pause(1200);
    },
  },
  {
    name: "calendar",
    start: "/#calendar",
    before: (page) => page.addInitScript(() => { try { localStorage.setItem("calendarView", "month"); } catch { } }),
    ready: (page) => page.locator("#cgrid .cday").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1500);
      await s.click(page.locator("#cModes button[data-mode=plans]"), { wait: 1500 });
      await s.click(page.locator("#cModes button[data-mode=workouts]"), { wait: 1500 });
      await s.click(page.locator("#cModes button[data-mode=both]"), { wait: 1000 });
      if (!(await page.evaluate(MOVE_PICK))) throw new Error("calendar: no workout with a free day beside it to drag");
      await s.drag(page.locator('#cgrid [data-demo="drag"]'), page.locator('#cgrid [data-demo="drop"]'));
      await page.locator("#dlg").waitFor();
      await s.pause(1800);
      await s.click(page.locator("#dlgOk"), { wait: 300 });
      await page.locator("#toast").filter({ hasText: "Moved" }).waitFor();
      await s.pause(2600);
      const [there, back] = new Date().getUTCDate() > 15 ? ["#cNext", "#cPrev"] : ["#cPrev", "#cNext"];
      await s.click(page.locator(there), { wait: 1600 });
      await s.click(page.locator(back), { wait: 1200 });
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
      const section = (title: RegExp) => page.locator("#abody .achd h2").filter({ hasText: title }).first();
      await s.reveal(section(/graphs/i));
      const graph = page.locator("#abody svg.acsvg").first();
      await s.sweep(graph, 0.03, 0.97, 3500);
      await s.pause(500);
      await s.reveal(section(/route/i));
      await s.pause(1800);
      await s.reveal(section(/laps/i));
      await s.pause(2000);
      await s.reveal(section(/planned/i));
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
      await s.click(page.locator("#rTabs").getByRole("button", { name: "Trends", exact: true }), { wait: 1200 });
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
    ready: (page) => page.locator("#bbody .bchart").first().waitFor(),
    run: async (s, page) => {
      await s.pause(1500);
      await s.sweep(page.locator("#bbody svg.rcsvg").first(), 0.05, 0.95, 2500);
      await s.click(page.locator("#bTabs").getByRole("button", { name: "Body", exact: true }), { wait: 1500 });
      await s.click(page.locator("#bRange"), { wait: 300 });
      await page.locator("#bRange").selectOption("90");
      await s.pause(1500);
      await s.click(page.locator("#bUnits button[data-unit=kg]"), { wait: 1500 });
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
      await s.click(page.locator("#cwBoard .wday.today, #cwBoard .wday.sel").first(), { wait: 1600 });
      await s.click(page.locator("#views button, #views a").filter({ hasText: "Plans" }), { wait: 1200 });
      await s.click(page.locator('#tabbar [data-tab="files"]'), { wait: 900 });
      await s.click(page.locator("#filelist .file").filter({ hasText: "half-marathon-build" }), { wait: 1500 });
      await s.click(page.locator("#outline .row.wk .name").filter({ hasText: "Strength A" }), { wait: 1400 });
      await s.reveal(page.locator("#pform .wf-ex").first(), 1000);
      await s.pause(500);
      await s.click(page.locator("#pform .wf-line").first().getByRole("button", { name: "Sets: one more" }), { wait: 1600 });
      await s.click(page.locator("#views button, #views a").filter({ hasText: "Food" }), { wait: 1800 });
      await s.click(meal(page, "snack").getByRole("button", { name: "Add a food to Snacks" }), { wait: 1200 });
      await s.click(page.locator("#fsh .frec").filter({ hasText: "Protein shake" }).first(), { wait: 1500 });
      await s.click(page.locator("#fsh .fsh-foot").getByRole("button", { name: "Done" }), { wait: 900 });
      await s.scroll(page.locator("#fscroll"), 520, 1000);
      await s.pause(1500);
    },
  },
  {
    name: "food",
    start: "/#food",
    before: atDinner,
    ready: (page) => meal(page, "dinner").waitFor(),
    run: async (s, page) => {
      await s.pause(1600);
      await s.click(page.locator("#fbody .fchip").filter({ hasText: "Salmon with rice" }), { wait: 1600 });
      await s.click(page.locator("#fdSearch"), { wait: 700 });
      await page.keyboard.type("skyr", { delay: 110 });
      const result = page.locator("#fsh .fresults button.fr:not(.frec)").first();
      await result.waitFor({ timeout: 20_000 });
      await s.pause(1200);
      await s.click(result, { wait: 1000 });
      const picker = page.locator("#fsh .fpick");
      await page.waitForFunction('!document.querySelector("#fsh .fpick button.primary").disabled', null, { timeout: 15_000 });
      const quantity = picker.getByRole("spinbutton", { name: "Quantity" });
      await s.click(quantity, { wait: 150 });
      await page.keyboard.press("Control+a");
      await page.keyboard.type("175", { delay: 140 });
      await s.pause(1200);
      await s.click(picker.locator("button.primary"), { wait: 1500 });
      await s.click(page.locator("#fsh").getByRole("tab", { name: "By hand" }), { wait: 600 });
      const form = page.locator("#fsh form.fform");
      await s.type(form.locator(".fname"), "Rice cakes, 2", 60);
      await s.type(form.locator('input[aria-label="P g"]'), "2", 120);
      await s.type(form.locator('input[aria-label="C g"]'), "15", 120);
      await s.type(form.locator('input[aria-label="F g"]'), "1", 120);
      await s.pause(900);
      await s.click(form.locator('button[type="submit"]'), { wait: 1500 });
      await s.click(page.locator("#fsh .fsh-foot").getByRole("button", { name: "Done" }), { wait: 900 });
      await s.reveal(meal(page, "dinner"));
      await s.pause(1800);
      await s.scroll(page.locator("#fscroll"), -1500, 900);
      await s.pause(1500);
    },
  },
  {
    name: "food-ai",
    start: "/#food",
    before: async (page) => {
      await atDinner(page);
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
      await s.click(page.locator("#fdAi"), { wait: 600 });
      await page.keyboard.type("chicken breast with a roasted sweet potato and green beans, a bit of olive oil", { delay: 35 });
      await s.pause(500);
      await s.click(page.locator("#fsh .faibody").getByRole("button", { name: "Estimate", exact: true }), { wait: 300 });
      await page.locator("#fsh .faires .fair").first().waitFor();
      await s.pause(2400);
      await s.scroll(page.locator("#fsh .faires"), 400, 900);
      await s.pause(800);
      await s.click(page.locator("#fsh .faires .fpa button.primary"), { wait: 1200 });
      await s.reveal(meal(page, "dinner"));
      await s.pause(2200);
    },
  },
];


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
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  const stage = new Stage(page, !!scene.phone);
  await scene.run(stage, page);
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  await context.close();
  if (!frames.length) throw new Error(`${scene.name}: no frame was painted`);

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
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {});
  try {
    for (const scene of scenes) console.log(await record(browser, demo.url, scene, work));
  } finally {
    await browser.close();
    demo.stop();
    if (process.env.KEEP_FRAMES) console.log(`frames kept in ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
