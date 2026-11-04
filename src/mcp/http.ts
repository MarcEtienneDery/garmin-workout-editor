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
  /**
   * Shared secret (the admin's: every profile); accepted as /mcp/<token> or as "Authorization: Bearer <token>" on /mcp. A profile's own
   * token (Settings → Claude (MCP), kept in the database) is accepted the same two ways and limits the connection to that profile.
   */
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

/**
 * Streamable HTTP endpoint for remote MCP clients (claude.ai / Claude Desktop connectors).
 * Stateless: each POST gets its own server+transport; Garmin sessions live in context.ts.
 */
export function startHttpServer(options: HttpServerOptions): Promise<http.Server> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32).`
    );
  }
  const expected = sha256(options.token);
  const matches = (candidate: string): boolean => timingSafeEqual(sha256(candidate), expected);

  /** The token a request brings: in the path (/mcp/<token>) or as a Bearer header on /mcp; null when it brings none. */
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

  /** Who a request is: `{}` for the server's own token (every profile), `{ profile }` for a profile's token, null for anyone else. */
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

    // The icon is the one thing besides /healthz that needs no token: a client or a browser looks for it at the root of the host.
    const icon = pathname === "/favicon.ico" ? "apple-touch-icon.png" : pathname === "/icon.svg" ? "icon.svg" : undefined;
    if (icon && (req.method === "GET" || req.method === "HEAD")) {
      const bytes = readIcon(icon);
      if (bytes) {
        res.writeHead(200, { "Content-Type": icon.endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "no-cache" });
        return void res.end(req.method === "HEAD" ? undefined : bytes);
      }
    }

    // Unauthorized and unknown paths look identical, and the token is never logged.
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
      // a profile's token: every tool this request calls runs as that profile and no other (context.ts)
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
