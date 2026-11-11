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
import { open, readFile, rename, rm } from "node:fs/promises";
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

export async function readAppEnv(name: string): Promise<EnvEntry[]> {
  const dir = await safeAppDir(name);
  const path = resolve(dir, ".env");
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseEnv(contents);
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
// temp file it created (best effort, by its exact path) and rethrows.
export async function writeAppEnv(name: string, entries: EnvEntry[]): Promise<void> {
  const dir = await safeAppDir(name);
  const path = resolve(dir, ".env");
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
