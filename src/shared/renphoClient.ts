/**
 * renphoClient.ts — a client for Renpho's cloud, the one the Renpho Health app talks to. Unofficial: there is no public
 * API, so this follows what the app does as others have written it down (no one has published a check against a live
 * account, so what the Settings view shows of a run is the real test). It may stop working when Renpho changes the app.
 *
 * Every request is a POST of `{ "encryptData": <base64> }`, the JSON body encrypted with AES-128-ECB under a constant key
 * that is part of the app (a protocol constant, not a secret of the account); answers are `{ code: 101, data: <base64> }`.
 * The client only reads. Rate limits and refused logins are reported, never retried here.
 */
import * as crypto from "crypto";

const BASE_URL = "https://cloud.renpho.com";
const KEY = Buffer.from("ed*wijdi$h6fe3ew", "utf8");
const APP_VERSION = "7.0.0";
const PAGE_SIZE = 200;
/** Pages read per table before giving up: 10 000 weigh-ins. */
const MAX_PAGES = 50;
const TIMEOUT_MS = 20_000;
const OK = 101;

export const encrypt = (plain: string): string => {
  const cipher = crypto.createCipheriv("aes-128-ecb", KEY, null);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
};
export const decrypt = (data: string): string => {
  const decipher = crypto.createDecipheriv("aes-128-ecb", KEY, null);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

/** Parse JSON without losing the long integers (ids, as an object's value or an array's item) that a number cannot hold: they are kept as text. Strings are skipped over, so their digits stay as they are. */
export const parseJson = (text: string): any => JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(?<![\w.+-])(-?\d{16,})(?=\s*[,}\]])/g, (match, long) => (long ? `"${long}"` : match)));

/** What went wrong: "login" (Renpho refused the login), "rate" (too many requests), "other" (the network, an error answer, an answer that makes no sense). */
export class RenphoError extends Error {
  constructor(
    message: string,
    readonly kind: "login" | "rate" | "other"
  ) {
    super(message);
  }
}

export interface ScaleTable {
  tableName: string;
  userIds: unknown[];
  count: number;
}

export type Measurement = Record<string, unknown>;

export class RenphoClient {
  private token: string | null = null;
  /** The account's id, which its own weigh-ins are filed under. */
  userId: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly areaCode = "US",
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async post(path: string, payload: unknown, authenticated: boolean): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json", appVersion: APP_VERSION, platform: "android" };
    if (authenticated && this.token && this.userId) Object.assign(headers, { token: this.token, userId: this.userId });
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE_URL}/${path}`, { method: "POST", headers, body: JSON.stringify({ encryptData: encrypt(payload === undefined ? "" : JSON.stringify(payload)) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new RenphoError(`Could not reach Renpho: ${error instanceof Error ? error.message : String(error)}`, "other");
    }
    if (res.status === 429) throw new RenphoError("Renpho says too many requests (HTTP 429).", "rate");
    if (res.status === 401 || res.status === 403) throw new RenphoError(`Renpho refused the session (HTTP ${res.status}).`, "login");
    if (!res.ok) throw new RenphoError(`Renpho answered HTTP ${res.status}.`, "other");
    let envelope: { code?: unknown; data?: unknown; msg?: unknown };
    try {
      envelope = (await res.json()) as typeof envelope;
    } catch {
      throw new RenphoError("Renpho's answer is not JSON.", "other");
    }
    if (envelope.code !== OK) throw new RenphoError(`Renpho answered code ${String(envelope.code)}${typeof envelope.msg === "string" && envelope.msg ? ` (${envelope.msg})` : ""}.`, "other");
    if (typeof envelope.data !== "string") throw new RenphoError("Renpho's answer holds no data.", "other");
    try {
      return parseJson(decrypt(envelope.data));
    } catch {
      throw new RenphoError("Renpho's answer could not be decoded (the app's protocol may have changed).", "other");
    }
  }

  /** Sign in. A refusal is a "login" error: the email, the password or the area code is wrong, or the account signs in with Google or Apple and has no password. */
  async login(): Promise<void> {
    this.token = null;
    let data: any;
    try {
      data = await this.post("renpho-aggregation/user/login", {
        questionnaire: {},
        login: { email: this.email, password: this.password, areaCode: this.areaCode, appRevision: APP_VERSION, cellphoneType: "garmin-workout-editor", systemType: "11", platform: "android" },
        bindingList: { deviceTypes: ["2"] },
      }, false);
    } catch (error) {
      if (error instanceof RenphoError && error.kind === "other" && /answered code/.test(error.message)) throw new RenphoError(`Renpho did not accept the login: ${error.message} Check the email, the password and the area code.`, "login");
      throw error;
    }
    const login = data?.login;
    if (!login || typeof login.token !== "string" || login.id === undefined) throw new RenphoError("Renpho did not accept the login: the answer holds no session.", "login");
    this.token = login.token;
    this.userId = String(login.id);
  }

  /** An authenticated call; when the session is refused once, sign in again and retry that one time. */
  private async call(path: string, payload?: unknown): Promise<any> {
    if (!this.token) await this.login();
    try {
      return await this.post(path, payload, true);
    } catch (error) {
      if (!(error instanceof RenphoError && error.kind === "login")) throw error;
      await this.login();
      return this.post(path, payload, true);
    }
  }

  /** The tables the account's scales write to. */
  async scaleTables(): Promise<ScaleTable[]> {
    const data = await this.call("renpho-aggregation/device/count");
    const scale: any[] = Array.isArray(data?.scale) ? data.scale : [];
    return scale.filter((t) => typeof t?.tableName === "string" && Array.isArray(t.userIds) && t.userIds.length).map((t) => ({ tableName: t.tableName, userIds: t.userIds, count: Number(t.count) || 0 }));
  }

  /** Every weigh-in of a table, as Renpho keeps them; `complete` is false when the page limit ended the read. */
  async measurements(table: ScaleTable): Promise<{ rows: Measurement[]; complete: boolean }> {
    const rows: Measurement[] = [];
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const page = await this.call("RenphoHealth/scale/queryAllMeasureDataList", { pageNum, pageSize: PAGE_SIZE, tableName: table.tableName, userIds: table.userIds });
      if (!Array.isArray(page)) throw new RenphoError("Renpho's list of weigh-ins is not a list (the app's protocol may have changed).", "other");
      rows.push(...page);
      if (page.length < PAGE_SIZE) return { rows, complete: true };
    }
    return { rows, complete: false };
  }
}
