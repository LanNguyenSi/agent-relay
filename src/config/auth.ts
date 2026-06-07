import { timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

/**
 * Constant-time string comparison. Avoids leaking the secret one byte at a
 * time via early-exit timing. Lengths are compared first (this only leaks the
 * token length, which is not secret) because timingSafeEqual throws on a
 * length mismatch.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Validates an `Authorization: Bearer <token>` header against AUTH_TOKEN using
 * a constant-time comparison. Shared by the HTTP API (src/api/routes.ts) and
 * the MCP endpoint (src/index.ts) so the "constant-time compared" guarantee in
 * docs/security.md holds at every call site.
 */
export function isAuthorized(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  return safeEqual(authHeader.slice(7), env.AUTH_TOKEN);
}
