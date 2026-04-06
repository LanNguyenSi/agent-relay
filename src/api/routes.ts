import { Hono } from "hono";
import { env } from "../config/env.js";

export const api = new Hono();

// Auth middleware
api.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.AUTH_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

api.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    uptime: process.uptime(),
  });
});

api.get("/apps", (c) => {
  // Placeholder — will be implemented in R6
  return c.json({ apps: [] });
});
