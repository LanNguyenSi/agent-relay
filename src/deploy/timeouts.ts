/**
 * Timeout for read-only queries: a `docker compose` ps/logs read or a
 * `git rev-parse`. Neither has a side effect, so what matters is that neither
 * can hold the deploy lock (deploy engine) or the operation lock (services)
 * while it waits on a wedged daemon. Unbounded they inherit
 * `DEFAULT_STEP_TIMEOUT_MS` from deploy/exec.ts (300 s), which is a step budget
 * for builds and pulls, not for a status read. 30 s is generous for these
 * commands.
 *
 * Its own module (rather than exec.ts) because every exec.ts test mock is a
 * strict factory, and apps.ts needs this at module scope to keep exporting
 * `FETCH_LOGS_TIMEOUT_MS` as an alias of it.
 */
export const COMPOSE_QUERY_TIMEOUT_MS = 30_000;
