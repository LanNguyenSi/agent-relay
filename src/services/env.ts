/**
 * Read and write .env files for managed apps.
 *
 * Deliberately minimal: a flat list of key=value entries, one per line. No
 * support for multi-line values, export prefixes, or quoted interpolation —
 * the panel surfaces a plain key/value editor and the .env format we emit is
 * the canonical Compose-compatible subset (https://docs.docker.com/compose/environment-variables/env-file/).
 *
 * Known limitation: only well-formed `KEY=VALUE` lines survive a read→write
 * round-trip. Comments, blank lines, `export KEY=VALUE` lines, lines whose
 * key is not a valid identifier and lines without `=` are all dropped. Teams that rely on commented .env files should keep
 * the comments elsewhere (e.g. `.env.example`). Documented in docs.
 */
import { constants, lstat, open, readdir, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { safeAppDir } from "./apps.js";

export interface EnvEntry {
  key: string;
  value: string;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Parse a .env file. Silently skips blank and comment lines. Lines that do
// not match `KEY=VALUE` are skipped as well — a noisy parser would make the
// panel refuse to open existing real-world .env files.
export function parseEnv(contents: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) continue;
    let value = line.slice(eq + 1);
    // Strip a single pair of surrounding quotes if present — matches docker
    // compose's own parser.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value });
  }
  return entries;
}

// Serialize entries back to canonical .env. Values containing whitespace or
// shell metacharacters are double-quoted with `"` and `\` escaped; everything
// else is emitted bare.
export function serializeEnv(entries: EnvEntry[]): string {
  const out: string[] = [];
  for (const { key, value } of entries) {
    if (!ENV_KEY.test(key)) {
      throw new Error(`Invalid env key: ${JSON.stringify(key)}`);
    }
    out.push(`${key}=${quoteIfNeeded(value)}`);
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

function quoteIfNeeded(value: string): string {
  // Bare-emit only if the value is printable ASCII without whitespace,
  // quotes, backslashes, or shell metacharacters. Otherwise double-quote and
  // escape.
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// A `.env` that readAppEnv refuses to read: a symlink (O_NOFOLLOW turns the
// open into ELOOP, dangling targets included) or a non-regular file that
// still opens (directory, FIFO, device). The message is deliberately generic
// (no path, no link target, no content) because the route returns it to
// API callers. Decision: an error mapped to 409, not an empty list: an empty
// list would make a compromised app look like it has no env vars and let the
// next PUT rename-replace the link (writeAppEnv writes to a fresh file),
// silently hiding the plant from the operator.
export class EnvFileUnusableError extends Error {
  constructor(name: string) {
    super(`Refusing to read ${name}'s .env: it is a symlink or not a regular file`);
    this.name = "EnvFileUnusableError";
  }
}

// Read <appDir>/.env without following symlinks: an app checkout that
// tracks `.env -> /some/host/file` must not let the relay (root in its
// container) leak any file it can read. O_NOFOLLOW makes the open fail with
// ELOOP on a symlink instead of resolving it; O_NONBLOCK keeps the open of a
// FIFO from blocking until a writer appears (a plain O_RDONLY open of a FIFO
// waits); the fstat on the handle then rejects everything that opened but is
// not a regular file. A missing .env keeps its long-standing meaning: an
// empty list. The handle is closed in a `finally`, including on refusal.
export async function readAppEnv(name: string): Promise<EnvEntry[]> {
  const dir = await safeAppDir(name);
  const path = resolve(dir, ".env");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ELOOP") throw new EnvFileUnusableError(name);
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new EnvFileUnusableError(name);
    return parseEnv(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

// Leftovers of a writeAppEnv that died between creating its temp file and
// renaming it keep the secrets at mode 0600. They are swept before the next
// write, but only when older than this, so a concurrent writer's live temp
// file is never removed.
export const STALE_ENV_TMP_AGE_MS = 10 * 60 * 1000;

// Exactly the names writeAppEnv generates: `.env.<pid>.<uuid>.tmp`.
const ENV_TMP_NAME =
  /^\.env\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

// Best effort: removes stale temp leftovers directly inside `dir` (no
// recursion). An entry goes only if lstat (never following a link) shows a
// regular file owned by this process's uid and older than the threshold;
// removal is unlink by that exact path. Every error is swallowed, and at most
// a count is logged (never names or contents).
async function sweepStaleEnvTmp(dir: string): Promise<void> {
  let removed = 0;
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (!ENV_TMP_NAME.test(name)) continue;
      try {
        const path = resolve(dir, name);
        const st = await lstat(path);
        if (!st.isFile()) continue;
        if (uid === undefined || st.uid !== uid) continue;
        if (!(now - st.mtimeMs > STALE_ENV_TMP_AGE_MS)) continue;
        await unlink(path);
        removed += 1;
      } catch {
        // gone mid-sweep or not removable: skip it
      }
    }
  } catch {
    // unreadable dir: the write below reports its own errors
  }
  if (removed > 0) console.warn(`removed ${removed} stale .env temp file(s) left by an interrupted write`);
}

// Write the full set of entries atomically: create a uniquely named temp
// file in the app dir exclusively (`wx` = O_CREAT|O_EXCL, which fails on any
// existing path, symlink included, so a link planted in the app checkout
// cannot redirect the write), write and fsync through the handle, force the
// mode to 0600 on the handle (immune to umask, and never chmod by path,
// which would follow a symlink), then rename. Prevents a half-written file
// if the process dies mid-write and keeps secrets at rw------- so non-root
// users on the box can't read them via a volume mount that mishandles
// permissions. If `.env` itself is a symlink, rename replaces the link, not
// its target: the link is just a file in the app checkout and the secrets
// land in a fresh regular file the relay owns. A failed write removes the
// temp file it created (best effort, by its exact path) and rethrows; stale
// temp files of earlier crashed writes are swept first.
export async function writeAppEnv(name: string, entries: EnvEntry[]): Promise<void> {
  const dir = await safeAppDir(name);
  const path = resolve(dir, ".env");
  await sweepStaleEnvTmp(dir);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = serializeEnv(entries);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
