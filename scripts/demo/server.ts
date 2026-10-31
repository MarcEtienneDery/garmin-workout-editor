/**
 * The plan editor on a throwaway demo database: `npm run demo`, then sign in as Sam / demo-password.
 *
 * The database is made in a temporary directory and deleted when the server stops; nothing reaches Garmin, Renpho or an AI.
 * Searching a food asks Open Food Facts and an activity's map asks OpenStreetMap for its tiles, as the real editor does.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Demo {
  url: string;
  stop: () => void;
}

/** Start the editor on a fresh demo database. Sets the environment first: the store reads it when it is first imported. */
export async function startDemo(port: number): Promise<Demo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-demo-"));
  process.env.GARMIN_DATA_DIR = dir;
  process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
  process.env.TZ = "UTC";
  process.env.GARMIN_TZ = "UTC";
  for (const name of ["GARMIN_PROFILE", "TRUST_PROXY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FOOD_AI_BACKEND", "GEMINI_API_KEY", "MOCK_MODE"]) delete process.env[name];

  const { DEMO_ADMIN_TOKEN, seedDemo } = await import("./seed");
  const { startWebServer } = await import("../../src/web/server");
  const { closeStore } = await import("../../src/shared/store");
  seedDemo();
  const server = await startWebServer({ host: "127.0.0.1", port, token: DEMO_ADMIN_TOKEN });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      server.close();
      closeStore();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (require.main === module) {
  startDemo(Number(process.env.DEMO_PORT ?? 8790))
    .then(async (demo) => {
      const { DEMO_USER, DEMO_PASSWORD } = await import("./seed");
      console.log(`Demo editor on ${demo.url}  (sign in as ${DEMO_USER} / ${DEMO_PASSWORD}; Ctrl+C stops it and deletes its data)`);
      const stop = () => {
        demo.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
