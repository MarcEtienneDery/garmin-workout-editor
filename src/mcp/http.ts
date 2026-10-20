import * as http from "http";
import { createHash, timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, readIcon } from "./createServer";

export const MIN_TOKEN_LENGTH = 32;

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Shared secret; accepted as /mcp/<token> or as "Authorization: Bearer <token>" on /mcp. */
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

  const isAuthorized = (pathname: string, authorization: string | undefined): boolean => {
    if (pathname === "/mcp") {
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
      return !!bearer && matches(bearer[1].trim());
    }
    if (pathname.startsWith("/mcp/")) {
      let supplied: string;
      try {
        supplied = decodeURIComponent(pathname.slice("/mcp/".length)).replace(/\/$/, "");
      } catch {
        return false;
      }
      return matches(supplied);
    }
    return false;
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
    if (!isAuthorized(pathname, req.headers.authorization)) return notFound(res);

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
      await server.connect(transport);
      await transport.handleRequest(req, res);
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
