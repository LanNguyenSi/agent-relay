/**
 * Request body caps for the `/api` routes, enforced after the auth middleware
 * and before the route handlers read the body (Hono `bodyLimit`, selected in
 * `./routes.js`).
 *
 * Every route but one carries small JSON or text bodies (deploy and rollback
 * options, a self-update request), so they share a 1 MiB cap.
 *
 * `PUT /api/apps/:name/env` gets its own cap, computed from the per-field
 * limits the route validates (below). The cap is the size of the largest
 * compact JSON body (no insignificant whitespace, only `key` and `value`
 * members) those limits admit, so every entry set that passes validation in
 * that form is accepted and nothing larger is read. The worst case is every character of a key or
 * value spelled as a `\uXXXX` JSON escape, 6 bytes per UTF-16 unit.
 */

/** Cap for every `/api` route except the env PUT: 1 MiB. */
export const API_MAX_BODY_BYTES = 1024 * 1024;

// Per-field limits of the env PUT, validated on the parsed strings.
export const ENV_MAX_ENTRIES = 500;
export const ENV_MAX_KEY = 128;
export const ENV_MAX_VALUE = 32_768;

/** Longest JSON spelling of one UTF-16 unit: `\uXXXX`. */
const JSON_BYTES_PER_UNIT = 6;

// One entry is `{"key":"<k>","value":"<v>"}` plus a separating comma:
// `{"key":"` (8) + `","value":"` (11) + `"}` (2) + `,` (1) = 22 bytes of
// framing, plus 6 bytes per character of key and value. The envelope
// `{"entries":[]}` is 14 bytes, and n entries carry n - 1 commas, so one comma
// is taken back: 13.
// 500 * (22 + 6 * 128 + 6 * 32768) + 13 = 500 * 197398 + 13 = 98,699,013.
const ENV_ENTRY_FRAMING_BYTES = 22;
const ENV_ENVELOPE_BYTES = 13;

export const ENV_PUT_MAX_BODY_BYTES =
  ENV_MAX_ENTRIES *
    (ENV_ENTRY_FRAMING_BYTES + JSON_BYTES_PER_UNIT * (ENV_MAX_KEY + ENV_MAX_VALUE)) +
  ENV_ENVELOPE_BYTES;

// `PUT /api/apps/:name/env`: exactly one non-empty path segment for the app
// name, no trailing slash (routing is strict, a trailing slash is unrouted).
const ENV_PUT_PATH = /^\/api\/apps\/[^/]+\/env$/;

/** Body cap for a request: the env PUT's own cap, 1 MiB for everything else. */
export function bodyLimitFor(method: string, path: string): number {
  return method === "PUT" && ENV_PUT_PATH.test(path) ? ENV_PUT_MAX_BODY_BYTES : API_MAX_BODY_BYTES;
}
