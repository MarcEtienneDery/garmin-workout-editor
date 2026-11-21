import * as http from "http";
import { createHash, timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getStore } from "../shared/store";
import { runScoped } from "./context";
import { createServer, readIcon } from "./createServer";

export const MIN_TOKEN_LENGTH = 32;

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

export function startHttpServer(options: HttpServerOptions): Promise<http.Server> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32).`
    );
  }
  const expected = sha256(options.token);
  const matches = (candidate: string): boolean => timingSafeEqual(sha256(candidate), expected);

  const suppliedToken = (pathname: string, authorization: string | undefined): string | null => {
    if (pathname === "/mcp") {
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
      return bearer ? bearer[1].trim() : null;
    }
    if (pathname.startsWith("/mcp/")) {
      try {
        return decodeURIComponent(pathname.slice("/mcp/".length)).replace(/\/$/, "");
      } catch {
        return null;
      }
    }
    return null;
  };

  const authorize = (pathname: string, authorization: string | undefined): { profile?: string } | null => {
    const supplied = suppliedToken(pathname, authorization);
    if (supplied === null) return null;
    if (matches(supplied)) return {};
    try {
      const profile = getStore().mcpTokens.profileOf(supplied);
      return profile ? { profile } : null;
    } catch (error) {
      console.error("[mcp] could not check a profile token (the request is refused):", error instanceof Error ? error.message : error);
      return null;
    }
  };

  const httpServer = http.createServer(async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return notFound(res);
    }

    if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return void res.end("ok");
    }

    const icon = pathname === "/favicon.ico" ? "apple-touch-icon.png" : pathname === "/icon.svg" ? "icon.svg" : undefined;
    if (icon && (req.method === "GET" || req.method === "HEAD")) {
      const bytes = readIcon(icon);
      if (bytes) {
        res.writeHead(200, { "Content-Type": icon.endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "no-cache" });
        return void res.end(req.method === "HEAD" ? undefined : bytes);
      }
    }

    const caller = authorize(pathname, req.headers.authorization);
    if (!caller) return notFound(res);

    if (req.method !== "POST") {
      return jsonRpcError(res, 405, "Method not allowed.", { Allow: "POST" });
    }

    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      const serve = async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      };
      await (caller.profile ? runScoped(caller.profile, serve) : serve());
    } catch (error) {
      console.error("[mcp] request failed:", error instanceof Error ? error.message : error);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error.");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve(httpServer);
    });
  });
}
