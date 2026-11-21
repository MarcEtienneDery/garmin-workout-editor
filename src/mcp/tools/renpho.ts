import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type RenphoPush, type RenphoRun, dueProfiles, syncRenpho } from "../../shared/renphoSync";
import { getStore } from "../../shared/store";
import { garminAvailable, getSession, requireAuth } from "../context";
import { locked, holder } from "./activities";
import { startBackgroundWellness } from "./wellness";

const TICK_MS = 5 * 60_000;

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function readUploadAnswer(answer: any): string {
  const result = answer?.detailedImportResult ?? answer?.data?.detailedImportResult;
  if (!result) return "";
  const successes: any[] = Array.isArray(result.successes) ? result.successes : [];
  const failures: any[] = Array.isArray(result.failures) ? result.failures : [];
  const messages = failures.flatMap((f) => (Array.isArray(f.messages) ? f.messages : []));
  const duplicates = failures.filter((f) => Array.isArray(f.messages) && f.messages.length && f.messages.every((m: any) => Number(m.code) === 202)).length;
  if (failures.length && duplicates < failures.length) {
    const reasons = messages.filter((m) => Number(m.code) !== 202).map((m) => m.content ?? m.code).filter(Boolean);
    throw new Error(`Garmin refused the file: ${reasons.join("; ") || "no reason given"}`);
  }
  return duplicates ? "Garmin already had it" : successes.length ? "taken in" : "accepted";
}

export function readUploadError(error: unknown): string {
  const match = /^ERROR: \((\d{3})\), [^,]*, ([\s\S]*)$/.exec(error instanceof Error ? error.message : "");
  if (!match) throw error;
  let answer: unknown;
  try {
    answer = JSON.parse(match[2]);
  } catch {
    throw error;
  }
  return readUploadAnswer(answer) || (() => { throw error; })();
}

export function pushToGarmin(profile: string): RenphoPush {
  return async (fit) => {
    const session = getSession(profile);
    if (session.mock) throw new Error("Mock mode: nothing is uploaded.");
    const file = path.join(os.tmpdir(), `renpho-${process.pid}-${Date.now()}.fit`);
    fs.writeFileSync(file, fit);
    try {
      try {
        const answer = await locked(async () => {
          await requireAuth(session);
          return session.garminClient.getClient().uploadActivity(file, "fit");
        });
        return readUploadAnswer(answer);
      } catch (error) {
        return readUploadError(error);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
}

export async function runRenpho(profile: string, manual: boolean): Promise<RenphoRun> {
  const store = getStore();
  const garmin = garminAvailable(profile);
  const run = await syncRenpho(store, profile, { holder: holder(), manual, push: garmin ? pushToGarmin(profile) : undefined });
  if (run.ran && garmin) {
    try {
      startBackgroundWellness(profile);
    } catch (error) {
      store.renpho.log(profile, "warn", `Could not start reading the weigh-ins back from Garmin: ${text(error)}`);
    }
  }
  return run;
}

let timer: NodeJS.Timeout | undefined;

export function startRenphoTimer(): void {
  if (timer) return;
  const tick = async () => {
    try {
      for (const profile of dueProfiles(getStore())) await runRenpho(profile, false);
    } catch (error) {
      console.error("[renpho] timer:", text(error));
    }
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(tick, 15_000).unref();
}

export function stopRenphoTimer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
