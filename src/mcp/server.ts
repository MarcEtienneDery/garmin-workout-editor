/**
 * server.ts — MCP server entry point
 *
 *   node dist/mcp/server.js --http [--port 8787] [--host 0.0.0.0] [--profile MED] [--mock]
 *   npm run mcp            (stdio, for local development / MCP Inspector)
 *
 * HTTP mode requires MCP_AUTH_TOKEN (>= 32 chars). Configuration also comes from
 * MCP_PORT, MCP_HOST, GARMIN_PROFILE, MOCK_MODE and the directory overrides
 * GARMIN_DATA_DIR / GARMIN_STORE_PATH.
 */
import "./consoleRedirect"; // must stay first: keeps stdout clean

import * as dotenv from "dotenv";
import * as path from "path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PROJECT_ROOT } from "../shared/profileLoader";
import { configureMcp } from "./context";
import { createServer } from "./createServer";
import { startHttpServer } from "./http";

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  configureMcp({
    mock: process.argv.includes("--mock") || process.env.MOCK_MODE === "true",
    defaultProfile: argValue("--profile") ?? (process.env.GARMIN_PROFILE || undefined),
  });

  // A stray rejection from the Garmin client shouldn't take the service down.
  process.on("unhandledRejection", (reason) => {
    console.error("[mcp] unhandled rejection:", reason);
  });

  if (!process.argv.includes("--http")) {
    await createServer().connect(new StdioServerTransport());
    console.error("[mcp] garmin-workout-editor ready on stdio");
    return;
  }

  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    throw new Error("MCP_AUTH_TOKEN is required in HTTP mode (generate one with: openssl rand -hex 32).");
  }
  const port = Number(argValue("--port") ?? process.env.MCP_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${argValue("--port") ?? process.env.MCP_PORT}`);
  }
  const host = argValue("--host") ?? process.env.MCP_HOST ?? "127.0.0.1";

  const httpServer = await startHttpServer({ host, port, token });
  console.error(`[mcp] garmin-workout-editor listening on http://${host}:${port}/mcp/<token> (health: /healthz)`);

  const shutdown = (signal: string) => {
    console.error(`[mcp] ${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    httpServer.closeAllConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[mcp] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
