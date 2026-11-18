/**
 * Upper bound on a JSON/text request body for every `/api` route, enforced
 * after the auth middleware and before the route handlers read it (Hono
 * `bodyLimit`, registered in `./routes.js`). Sized off the largest
 * legitimate body, the env PUT (`PUT /api/apps/:name/env`): `ENV_MAX_ENTRIES`
 * (500) entries, each a key up to `ENV_MAX_KEY` (128) plus a value up to
 * `ENV_MAX_VALUE` (32768), JSON-framed with structural overhead:
 * ~500 × 32917 + framing ≈ 16,459,013 bytes. The smallest power of two above
 * that is 16 MiB, so a maximum-size env write of ASCII values without JSON
 * escapes passes while anything larger is rejected with 413 before a handler
 * parses it. A maximum-size write whose values carry non-ASCII characters or
 * `"` (each escaped to a multi-byte JSON sequence) can be roughly twice that
 * in bytes and would exceed this cap.
 */
export const API_MAX_BODY_BYTES = 16 * 1024 * 1024;
