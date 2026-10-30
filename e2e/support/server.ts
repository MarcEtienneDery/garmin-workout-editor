/**
 * Starts the plan editor for the suite on a database made for the occasion: `tsx e2e/support/server.ts [mock]`.
 *
 * Without `mock` it is the app as a person without a Garmin login meets it, with the data of seed.ts already stored. With
 * `mock` it is mock mode (MOCK_MODE=true): Garmin looks connected, answers with generated workouts and activities, and refuses
 * every write. Neither ever reaches Garmin, Renpho, Open Food Facts or Claude.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mock = process.argv.includes("mock");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), mock ? "e2e-mock-" : "e2e-"));
process.env.GARMIN_DATA_DIR = dir;
process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
process.env.TZ = "UTC";
process.env.GARMIN_TZ = "UTC";
delete process.env.GARMIN_PROFILE;
delete process.env.TRUST_PROXY;
delete process.env.ANTHROPIC_API_KEY;
if (mock) process.env.MOCK_MODE = "true";

async function main() {
  const { ADMIN_TOKEN, seed } = await import("./seed");
  const { startWebServer } = await import("../../src/web/server");
  const { closeStore } = await import("../../src/shared/store");
  if (!mock) seed();
  const port = Number(process.env.E2E_PORT ?? (mock ? 8793 : 8792));
  const server = await startWebServer({ host: "127.0.0.1", port, token: ADMIN_TOKEN });
  console.log(`e2e ${mock ? "mock " : ""}server on http://127.0.0.1:${port} (${dir})`);
  const stop = () => {
    server.close();
    closeStore();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
