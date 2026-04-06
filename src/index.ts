import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { env } from "./config/env.js";
import { api } from "./api/routes.js";

const app = new Hono();

app.use("*", logger());

// Public health (no auth)
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0" }),
);

// Authenticated API
app.route("/api", api);

// MCP endpoint placeholder
app.get("/mcp", (c) =>
  c.json({ message: "MCP endpoint — will be implemented in R5" }),
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`agent-relay listening on port ${info.port}`);
  console.log(`  API: http://localhost:${info.port}/api`);
  console.log(`  MCP: http://localhost:${info.port}/mcp`);
});
