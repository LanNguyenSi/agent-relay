import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { isAuthorized } from "./config/auth.js";
import { getRelayRevision, RELAY_VERSION } from "./config/version.js";
import { api } from "./api/routes.js";
import { reconcileSelfUpdateState } from "./deploy/self-update.js";
import { createMcpServer } from "./mcp/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Upper bound on a JSON/text request body for every `/api` route, enforced
 * before the route handlers read it (Hono `bodyLimit`). Sized off the largest
 * legitimate body, the env PUT (`PUT /api/apps/:name/env`): `ENV_MAX_ENTRIES`
 * (500) entries, each a key up to `ENV_MAX_KEY` (128) plus a value up to
 * `ENV_MAX_VALUE` (32768), JSON-framed with structural overhead:
 * ~500 × 32917 + framing ≈ 16,459,013 bytes. The smallest power of two above
 * that is 16 MiB, so a maximum-size env write passes while anything larger is
 * rejected with 413 before a handler parses it.
 */
export const API_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The Hono app for every non-MCP route: public /health plus the authenticated /api. */
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", logger());

  // Public health (no auth)
  app.get("/health", (c) =>
    c.json({ status: "ok", version: RELAY_VERSION, revision: getRelayRevision() }),
  );

  // Authenticated API. The body cap runs before the /api handlers, so an
  // oversized body is answered with 413 JSON and never parsed by a route.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );
  app.route("/api", api);
  // Marks a pending self-update record succeeded once this process runs the target revision.
  void reconcileSelfUpdateState().catch(() => {});
  return app;
}


/**
 * The Node.js HTTP server: /mcp goes to the MCP transport, everything else to
 * the Hono app through the @hono/node-server request listener. Not listening
 * yet; the caller binds the port.
 */
export function createRelayServer(): Server {
  // Hono request listener for non-MCP routes
  const honoListener = getRequestListener(createApp().fetch);

  return createServer(async (req, res) => {
    if (req.url?.startsWith("/mcp")) {
      // Auth check for MCP
      const auth = req.headers.authorization;
      if (!isAuthorized(auth)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      // Create per-session transport
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // All other routes handled by Hono
    honoListener(req, res);
  });
}
