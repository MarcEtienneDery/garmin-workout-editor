import { AsyncLocalStorage } from "async_hooks";
import { format } from "util";

const MAX_LOG_CHARS = 20_000;

const storage = new AsyncLocalStorage<string[]>();
let installed = false;

export function installConsoleRedirect(): void {
  if (installed) return;
  installed = true;

  const forward = (...args: unknown[]): void => {
    const line = format(...args);
    process.stderr.write(line + "\n");
    storage.getStore()?.push(line);
  };

  console.log = forward;
  console.info = forward;
  console.debug = forward;
  console.warn = forward;
  console.error = forward;
}

export type CaptureOutcome<T> =
  | { ok: true; value: T; log: string }
  | { ok: false; error: unknown; log: string };

export async function captureLogs<T>(fn: () => Promise<T>): Promise<CaptureOutcome<T>> {
  const lines: string[] = [];
  try {
    const value = await storage.run(lines, fn);
    return { ok: true, value, log: joinLog(lines) };
  } catch (error) {
    return { ok: false, error, log: joinLog(lines) };
  }
}

function joinLog(lines: string[]): string {
  const text = lines.join("\n");
  if (text.length <= MAX_LOG_CHARS) return text;
  return "…(earlier log truncated)\n" + text.slice(text.length - MAX_LOG_CHARS);
}
