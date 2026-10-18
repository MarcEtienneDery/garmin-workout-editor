/**
 * The Renpho sync's side that touches Garmin and the clock: the upload of a FIT file to a profile's Garmin account, a run
 * for a profile, and the timer that starts the runs that are due (the web editor starts it; one process runs the timer,
 * and the lease keeps two runs of one profile apart whichever process starts them). The run itself is shared/renphoSync.ts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type RenphoPush, type RenphoRun, dueProfiles, syncRenpho } from "../../shared/renphoSync";
import { getStore } from "../../shared/store";
import { getSession, requireAuth } from "../context";
import { locked, holder } from "./activities";
import { startBackgroundWellness } from "./wellness";

/** How often the timer looks for a run that is due. */
const TICK_MS = 5 * 60_000;

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What Garmin's upload answer says, as a few words; throws when it refused the file. A file Garmin already has is not a failure. */
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

/**
 * What an upload that Garmin answered with an HTTP error says. The library throws `ERROR: (<status>), <text>, <JSON of the
 * answer>` for those, and a file Garmin already has comes back that way (409): its answer is read as an upload answer, so a
 * duplicate counts as taken in. An error that has no answer in it is thrown again as it was.
 */
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

/** An upload to the profile's Garmin account of a FIT file, through the same endpoint Garmin Connect's import page uses. */
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

/** One run for a profile: fetch from Renpho and, when switched on, upload. Afterwards the Garmin weigh-ins of the days uploaded earlier are read again. */
export async function runRenpho(profile: string, manual: boolean): Promise<RenphoRun> {
  const store = getStore();
  const run = await syncRenpho(store, profile, { holder: holder(), manual, push: pushToGarmin(profile) });
  if (run.ran) {
    try {
      startBackgroundWellness(profile); // fills in the weigh-in rows that were forgotten for a second read
    } catch (error) {
      store.renpho.log(profile, "warn", `Could not start reading the weigh-ins back from Garmin: ${text(error)}`);
    }
  }
  return run;
}

let timer: NodeJS.Timeout | undefined;

/** Start the timer that runs the profiles that are due (every few minutes it looks; each profile has its own interval). Safe to call twice. */
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
  setTimeout(tick, 15_000).unref(); // a first look soon after the server starts
}

export function stopRenphoTimer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
