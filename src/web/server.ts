/**
 * web/server.ts — small web UI to manage plan files (CRUD + Monaco JSON editor).
 *
 *   npm run web                      # http://127.0.0.1:8788
 *   WEB_PORT=8788 WEB_HOST=0.0.0.0 WEB_AUTH_TOKEN=... npm run web
 *
 * Reaches the same files as the MCP plan tools ("workout-plans/*.json" and
 * "data/<profile>/*.json") through the same path guard. Non-loopback binds
 * require WEB_AUTH_TOKEN (HTTP Basic auth: any user name, the token as password).
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, timingSafeEqual } from "crypto";
import * as dotenv from "dotenv";
import { PROJECT_ROOT, getDataRoot } from "../shared/profileLoader";
import { getPlansDir, resolveDataPath, toLogicalPath } from "../mcp/context";
import { validatePlanData } from "../mcp/tools/plans";
import {
  VALID_END_CONDITIONS,
  VALID_STEP_TYPES,
  VALID_TARGET_TYPES,
} from "../workoutEditor";

const PUBLIC_DIR = path.join(__dirname, "public");
// Monaco is served from node_modules so the editor works offline (e.g. on the NAS).
const MONACO_DIR = path.join(PROJECT_ROOT, "node_modules", "monaco-editor", "min", "vs");
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const PROFILE_DIR_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface WebServerOptions {
  host: string;
  port: number;
  /** Optional shared secret (HTTP Basic password). Required unless host is loopback. */
  token?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

const sha256 = (v: string) => createHash("sha256").update(v).digest();

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function resolveOr400(logicalPath: unknown): { logical: string; absolute: string } {
  if (typeof logicalPath !== "string" || !logicalPath) throw new HttpError(400, "Missing path");
  try {
    const absolute = resolveDataPath(logicalPath);
    return { logical: toLogicalPath(absolute), absolute };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

function writeTextAtomic(absolute: string, text: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, absolute);
}

function parseOr400(text: unknown): unknown {
  if (typeof text !== "string") throw new HttpError(400, "Missing text");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, `Not valid JSON: ${(error as Error).message}`);
  }
}

/** Validation for workout-shaped JSON; other documents (e.g. training-plan.json) just need to parse. */
function validateText(text: string): unknown {
  const data = parseOr400(text);
  const isWorkouts =
    Array.isArray(data) ||
    (!!data && typeof data === "object" && Array.isArray((data as any).workouts));
  return isWorkouts ? validatePlanData(data) : null;
}

interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  workoutCount?: number;
  weekStart?: string;
  weekEnd?: string;
}

function describe(absolute: string): FileInfo {
  const stat = fs.statSync(absolute);
  const info: FileInfo = { path: toLogicalPath(absolute), size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.size < 5 * 1024 * 1024) {
    try {
      const data: any = JSON.parse(fs.readFileSync(absolute, "utf8"));
      const workouts = Array.isArray(data) ? data : data?.workouts;
      if (Array.isArray(workouts)) info.workoutCount = workouts.length;
      if (typeof data?.weekStart === "string") info.weekStart = data.weekStart;
      if (typeof data?.weekEnd === "string") info.weekEnd = data.weekEnd;
    } catch {
      /* listed anyway; the editor will flag it */
    }
  }
  return info;
}

function jsonFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name));
}

function listFiles(): FileInfo[] {
  const dataRoot = getDataRoot();
  const profileDirs = fs.existsSync(dataRoot)
    ? fs
        .readdirSync(dataRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && PROFILE_DIR_REGEX.test(e.name))
        .map((e) => path.join(dataRoot, e.name))
    : [];
  return [getPlansDir(), ...profileDirs]
    .flatMap(jsonFilesIn)
    .map(describe)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** JSON Schema for the Monaco editor: autocompletion and hover docs for plan files. */
function workoutSchema() {
  const step = {
    type: "object",
    required: ["stepType", "targetType"],
    properties: {
      stepType: { enum: [...VALID_STEP_TYPES] },
      targetType: { enum: [...VALID_TARGET_TYPES] },
      endCondition: { enum: [...VALID_END_CONDITIONS] },
      endConditionValue: { type: "number" },
      exerciseName: { type: "string", description: "Garmin exercise key, e.g. BARBELL_BENCH_PRESS" },
      targetValueOne: { type: "number" },
      targetValueTwo: { type: "number" },
      reps: { type: "number" },
      durationSeconds: { type: "number" },
      distanceMeters: { type: "number" },
      weight: { type: "number", description: "Pounds" },
      weightPercentage: { type: "number", description: "Percent of 1RM; requires benchmarkKey" },
      benchmarkKey: { type: "string" },
      restTimeSeconds: { type: "number" },
      numberOfRepeats: { type: "number" },
      repeatGroupIndex: { type: "number" },
      stepOrder: { type: "number" },
    },
  };
  const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const workout = {
    type: "object",
    required: ["workoutName"],
    properties: {
      workoutName: { type: "string", minLength: 1 },
      workoutId: { type: ["number", "string"], description: "Assigned by Garmin on upload" },
      workoutType: { enum: ["running", "strength_training", "cycling", "cardio", "swimming", "other"] },
      description: { type: "string" },
      distanceMeters: { type: "number" },
      scheduledDate: { oneOf: [date, { type: "array", items: date }] },
      sendToDevice: { type: "boolean" },
      steps: { type: "array", items: step },
    },
  };
  return {
    oneOf: [
      {
        type: "object",
        properties: {
          generatedAt: { type: "string" },
          weekStart: date,
          weekEnd: date,
          source: { type: "string" },
          notes: { type: "string" },
          workouts: { type: "array", items: workout },
        },
      },
      { type: "array", items: workout },
    ],
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  let root = PUBLIC_DIR;
  let name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.startsWith("vendor/monaco/")) {
    root = MONACO_DIR;
    name = name.slice("vendor/monaco/".length);
  }
  let full: string;
  try {
    full = path.resolve(root, decodeURIComponent(name));
  } catch {
    full = root;
  }
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return void res.end("Not found");
  }
  const content = fs.readFileSync(full); // read first: a failure must still be able to send a 500
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const queryPath = url.searchParams.get("path");

  switch (route) {
    case "GET /api/files":
      return send(res, 200, { files: listFiles() });

    case "GET /api/schema":
      return send(res, 200, workoutSchema());

    case "GET /api/file": {
      const { logical, absolute } = resolveOr400(queryPath);
      if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, {
        path: logical,
        text: fs.readFileSync(absolute, "utf8"),
        mtimeMs: fs.statSync(absolute).mtimeMs,
      });
    }

    case "PUT /api/file": {
      // Body: { text, mtimeMs? } to update (409 if the file changed on disk since mtimeMs),
      //       { text, create: true } to create (409 if it already exists).
      const body = await readBody(req);
      const { logical, absolute } = resolveOr400(queryPath);
      parseOr400(body.text);
      const exists = fs.existsSync(absolute);
      if (body.create && exists) throw new HttpError(409, `${logical} already exists`);
      if (!body.create && !exists) throw new HttpError(404, `File not found: ${logical}`);
      if (!body.create && typeof body.mtimeMs === "number" && fs.statSync(absolute).mtimeMs !== body.mtimeMs) {
        throw new HttpError(409, `${logical} changed on disk since you opened it. Reload to see the new version.`);
      }
      writeTextAtomic(absolute, body.text);
      return send(res, exists ? 200 : 201, {
        path: logical,
        mtimeMs: fs.statSync(absolute).mtimeMs,
        validation: validateText(body.text),
      });
    }

    case "DELETE /api/file": {
      const { logical, absolute } = resolveOr400(queryPath);
      if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
      fs.unlinkSync(absolute);
      return send(res, 200, { path: logical, deleted: true });
    }

    case "POST /api/rename": {
      const body = await readBody(req);
      const from = resolveOr400(body.from);
      const to = resolveOr400(body.to);
      if (!fs.existsSync(from.absolute)) throw new HttpError(404, `File not found: ${from.logical}`);
      if (fs.existsSync(to.absolute)) throw new HttpError(409, `${to.logical} already exists`);
      fs.mkdirSync(path.dirname(to.absolute), { recursive: true });
      fs.renameSync(from.absolute, to.absolute);
      return send(res, 200, { from: from.logical, to: to.logical, mtimeMs: fs.statSync(to.absolute).mtimeMs });
    }

    case "POST /api/validate": {
      const body = await readBody(req);
      return send(res, 200, { validation: validateText(body.text) });
    }

    default:
      throw new HttpError(404, "Unknown API route");
  }
}

export function startWebServer(options: WebServerOptions): Promise<http.Server> {
  if (!isLoopback(options.host) && !options.token) {
    throw new Error("WEB_AUTH_TOKEN is required when binding to a non-loopback host.");
  }
  const expected = options.token ? sha256(options.token) : undefined;

  const authorized = (header: string | undefined): boolean => {
    if (!expected) return true;
    const m = /^Basic\s+(.+)$/i.exec(header ?? "");
    if (!m) return false;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    return timingSafeEqual(sha256(decoded.slice(decoded.indexOf(":") + 1)), expected);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return void res.end("ok");
      }
      // Without a token on loopback, reject foreign Host headers (DNS rebinding).
      if (!expected && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return void res.end("Forbidden host");
      }
      if (!authorized(req.headers.authorization)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Plan editor"' });
        return void res.end("Authentication required");
      }
      if (!url.pathname.startsWith("/api/")) {
        return req.method === "GET" ? serveStatic(url.pathname, res) : send(res, 405, { error: "Method not allowed" });
      }
      // Custom header forces a CORS preflight, so other sites can't drive the API from a browser.
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "plan-editor") {
        throw new HttpError(403, "Missing X-Requested-With header");
      }
      await handleApi(req, res, url);
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.error("[web] error:", error);
      send(res, 500, { error: "Internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

if (require.main === module) {
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.WEB_PORT ?? 8788);
  startWebServer({ host, port, token: process.env.WEB_AUTH_TOKEN || undefined })
    .then(() => console.log(`Plan editor on http://${host}:${port}  (plans: ${getPlansDir()})`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
