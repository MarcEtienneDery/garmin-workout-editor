import * as fs from "fs";
import axios from "axios";
import { GarminConnect } from "@flow-js/garmin-connect";
import { getStore, getStorePath } from "./store";
import TokenCache from "./tokenCache";

export interface GarminExerciseEntry {
  category: string;
  name: string | null;
  probability?: number;
}

export interface GarminRawSet {
  setType: string;
  exercises: GarminExerciseEntry[];
  duration: number;
  repetitionCount: number | null;
  weight: number | null;
  startTime: string;
  wktStepIndex: number;
  messageIndex: number;
}

export const LOGIN_COOLDOWN_MS = 60_000;

export const httpStatus = (error: any): number | null => {
  const status = error?.response?.status ?? /\((\d{3})\)/.exec(String(error?.message ?? ""))?.[1];
  return status ? Number(status) : null;
};

const LIMIT_RECHECK_MS = 30_000;

const NOTED = Symbol("garmin429Noted");

function recordLimit(profile: string, limited: boolean): void {
  try {
    if (!fs.existsSync(getStorePath())) return;
    const limits = getStore().limits;
    if (limited) limits.record(profile);
    else if (limits.get(profile)) limits.clear(profile);
  } catch {
  }
}

const callTarget = (config: any): string => {
  try {
    const url = new URL(String(config?.url ?? ""), config?.baseURL);
    return `${url.host}${url.pathname}`;
  } catch {
    return String(config?.url ?? "?").split("?")[0];
  }
};

const RATE_LIMITED = "Failed to authenticate with Garmin: it is rate limiting logins (HTTP 429, Too Many Requests)";

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

const isTransient = (error: any): boolean => {
  const status = httpStatus(error);
  return status === 429 || (status !== null && status >= 500) || NETWORK_CODES.has(error?.code);
};

export class GarminClient {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean;
  private tokenCache: TokenCache;
  private lastAuthFailure: string | null = null;
  private loginBlockedUntil = 0;
  private limited = false;
  private limitChecked = 0;

  constructor(email: string, password: string, mockMode: boolean = false, dataDir?: string) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;
    this.tokenCache = new TokenCache(dataDir || "data");
    this.client = new GarminConnect({
      username: email,
      password: password,
    });
    (this.client as any).client?.client?.interceptors?.response?.use(
      (response: any) => {
        if (/\/\/connectapi\./.test(String(response?.config?.url ?? ""))) this.clearLimit();
        return response;
      },
      (error: any) => {
        this.noteRateLimit(error);
        return Promise.reject(error);
      }
    );
    this.logCalls();
  }

  private logCalls(): void {
    if (process.env.GARMIN_CALL_LOG === "0") return;
    try {
      const http = (this.client as any).client?.client;
      if (!http?.defaults) return;
      const send = axios.getAdapter(http.defaults.adapter);
      const profile = this.tokenCache.profileName;
      http.defaults.adapter = async (config: any) => {
        const started = Date.now();
        const note = (outcome: string) =>
          console.log(`📡 Garmin ${profile} ${String(config?.method ?? "get").toUpperCase()} ${callTarget(config)} → ${outcome} ${Date.now() - started}ms`);
        try {
          const response = await send(config);
          note(String(response.status));
          return response;
        } catch (error: any) {
          const status = error?.response?.status;
          const wait = status === 429 ? error.response.headers?.["retry-after"] : undefined;
          note(status ? `${status} ${error.response.statusText ?? ""}${wait ? ` (retry-after ${wait}s)` : ""}`.trim() : String(error?.code ?? error?.name ?? "failed"));
          throw error;
        }
      };
    } catch {
    }
  }

  private keepRefreshedToken(before: any): void {
    try {
      const { oauth1, oauth2 } = (this.client as any).exportToken();
      if (oauth2?.access_token && oauth2.access_token !== before?.access_token) this.tokenCache.saveToken(this.email, oauth1, oauth2);
    } catch {
    }
  }

  private noteRateLimit(error: any): void {
    if (httpStatus(error) !== 429 || (error && typeof error === "object" && error[NOTED])) return;
    if (error && typeof error === "object") error[NOTED] = true;
    this.limited = true;
    recordLimit(this.tokenCache.profileName, true);
  }

  private clearLimit(): void {
    const now = Date.now();
    if (!this.limited && now - this.limitChecked < LIMIT_RECHECK_MS) return;
    this.limitChecked = now;
    this.limited = false;
    recordLimit(this.tokenCache.profileName, false);
  }

  getClient(): GarminConnect {
    return this.client;
  }

  getClientAny(): any {
    return this.client as any;
  }

  isMockMode(): boolean {
    return this.mockMode;
  }

  async authenticate(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    this.lastAuthFailure = null;
    try {
      const cached = this.tokenCache.loadToken(this.email);
      if (cached) {
        try {
          (this.client as any).loadToken(cached.oauth1Token, cached.oauth2Token);

          const userProfile = await this.client.getUserProfile();
          console.log(
            `✅ Authenticated with cached token as: ${userProfile.userName}`
          );
          this.clearLimit();
          this.keepRefreshedToken(cached.oauth2Token);
          return true;
        } catch (error: any) {
          this.noteRateLimit(error);
          if (isTransient(error)) {
            console.log(`ℹ️ Could not check the cached token, keeping it: ${error.message}`);
            return this.failAuth(error);
          }
          console.log(
            `ℹ️ Cached token invalid or expired: ${error.message}`
          );
        }
      }

      const wait = this.loginBlockedUntil - Date.now();
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        console.log(`⏳ Garmin is rate limiting logins: not trying again for ${seconds}s`);
        this.lastAuthFailure = `${RATE_LIMITED}; try again in ${seconds} seconds.`;
        return false;
      }
      console.log("🔐 Authenticating with Garmin Connect (fresh login)...");
      await this.client.login();

      const userProfile = await this.client.getUserProfile();
      console.log(`✅ Successfully authenticated as: ${userProfile.userName}`);
      this.clearLimit();

      try {
        const { oauth1, oauth2 } = (this.client as any).exportToken();
        this.tokenCache.saveToken(this.email, oauth1, oauth2);
      } catch {
        console.warn("⚠️ Warning: OAuth tokens not available for caching");
      }

      return true;
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);
      this.noteRateLimit(error);
      if (httpStatus(error) === 429) this.loginBlockedUntil = Date.now() + LOGIN_COOLDOWN_MS;
      if (!isTransient(error)) this.tokenCache.clearToken();
      return this.failAuth(error);
    }
  }

  private failAuth(error: any): false {
    this.lastAuthFailure = httpStatus(error) === 429 ? `${RATE_LIMITED}; wait a few minutes and try again.` : null;
    return false;
  }

  authError(): Error {
    return new Error(this.lastAuthFailure ?? "Failed to authenticate with Garmin (check the profile credentials; 2FA accounts need a cached token).");
  }

  async ensureAuthenticated(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    return this.authenticate();
  }

  async getActivityExerciseSets(activityId: number | string): Promise<GarminRawSet[]> {
    const raw = await (this.client as any).client.get(
      `https://connectapi.garmin.com/activity-service/activity/${activityId}/exerciseSets`
    ) as { exerciseSets?: GarminRawSet[] } | undefined;
    return raw?.exerciseSets ?? [];
  }

  async getActivityDetails(activityId: number | string, size = 300): Promise<any> {
    return (this.client as any).client.get(
      `https://connectapi.garmin.com/activity-service/activity/${activityId}/details?maxChartSize=${size}&maxPolylineSize=${size}`
    );
  }

  async getActivitySplits(activityId: number | string): Promise<any> {
    return (this.client as any).client.get(`https://connectapi.garmin.com/activity-service/activity/${activityId}/splits`);
  }

  async getActivityHrZones(activityId: number | string): Promise<any> {
    return (this.client as any).client.get(`https://connectapi.garmin.com/activity-service/activity/${activityId}/hrTimeInZones`);
  }

  async sendToDevice(
    deviceId: number,
    workouts: { workoutId: number; workoutName: string }[]
  ): Promise<void> {
    const messages = workouts.map((w) => ({
      deviceId,
      messageUrl: `workout-service/workout/FIT/${w.workoutId}`,
      messageType: "workouts",
      messageName: w.workoutName,
      groupName: null,
      priority: 1,
      fileType: "FIT",
      metaDataId: w.workoutId,
    }));

    await (this.client as any).client.post(
      "https://connectapi.garmin.com/device-service/devicemessage/messages",
      messages
    );
  }

  async getDevices(): Promise<any[]> {
    return (this.client as any).client.get(
      "https://connectapi.garmin.com/device-service/deviceregistration/devices"
    );
  }

  clearCache(): void {
    this.tokenCache.clearToken();
  }
}

export default GarminClient;
