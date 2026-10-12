import { AsyncLocalStorage } from "async_hooks";
import { format } from "util";

const MAX_LOG_CHARS = 20_000;

// Per-tool-call buffer. AsyncLocalStorage keeps concurrent calls from mixing logs.
const storage = new AsyncLocalStorage<string[]>();
let installed = false;

/**
 * Route console output to stderr (stdout is the protocol channel in stdio mode,
 * and stderr is what `docker logs` shows) and copy it into the active tool-call
 * buffer, if any. Idempotent.
 */
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

/**
 * Run `fn`, collecting everything it logs. The editor/exporter classes report
 * skipped or failed items only through console output, so the log is part of
 * the tool result.
 */
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
  // Keep the tail: failures are reported last.
  return "…(earlier log truncated)\n" + text.slice(text.length - MAX_LOG_CHARS);
}
