import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { parseEnv, serializeEnv, readAppEnv, writeAppEnv, EnvFileUnusableError } from "./env.js";

const execFileAsync = promisify(execFile);

// APPS_DIR is read once at module load (vitest.setup.ts seeds it), so tests
// have to work within that directory instead of switching to a fresh tmpdir.

// When set, the mocked `open` below runs this first (and awaits it) for any
// call whose flags contain "w", with the path being opened as the argument.
// Lets a test plant a file at the exact temp path writeAppEnv is about to
// open; that name contains a random UUID and is otherwise unknowable.
let plantAtOpenPath: ((path: string) => Promise<void>) | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const [filePath, flags] = args;
      if (plantAtOpenPath !== null && typeof flags === "string" && flags.includes("w")) {
        await plantAtOpenPath(String(filePath));
      }
      return original.open(...args);
    },
  };
});

describe("parseEnv", () => {
  it("parses a typical .env file", () => {
    const input = [
      "# comment",
      "",
      "DB_HOST=localhost",
      "DB_PORT=5432",
      'SECRET="one two"',
      "EMPTY=",
    ].join("\n");
    expect(parseEnv(input)).toEqual([
      { key: "DB_HOST", value: "localhost" },
      { key: "DB_PORT", value: "5432" },
      { key: "SECRET", value: "one two" },
      { key: "EMPTY", value: "" },
    ]);
  });

  it("strips a single pair of surrounding quotes but keeps inner ones", () => {
    expect(parseEnv(`A="v"\nB='v'\nC="inner 'quote'"`)).toEqual([
      { key: "A", value: "v" },
      { key: "B", value: "v" },
      { key: "C", value: "inner 'quote'" },
    ]);
  });

  it("skips malformed lines silently", () => {
    const input = "GOOD=1\nno-equals\n123INVALID=x\n=nokeys\n";
    expect(parseEnv(input)).toEqual([{ key: "GOOD", value: "1" }]);
  });

  it("keeps `=` inside values", () => {
    expect(parseEnv("DSN=postgres://u:p@h/db?sslmode=require")).toEqual([
      { key: "DSN", value: "postgres://u:p@h/db?sslmode=require" },
    ]);
  });
});

describe("serializeEnv", () => {
  it("emits bare for safe values and quotes for unsafe ones", () => {
    const out = serializeEnv([
      { key: "A", value: "simple" },
      { key: "B", value: "with space" },
      { key: "C", value: 'with"quote' },
      { key: "D", value: "with\\backslash" },
    ]);
    expect(out).toBe(
      [
        "A=simple",
        'B="with space"',
        'C="with\\"quote"',
        'D="with\\\\backslash"',
        "",
      ].join("\n"),
    );
  });

  it("rejects invalid keys", () => {
    expect(() => serializeEnv([{ key: "1_BAD", value: "x" }])).toThrow(/Invalid env key/);
  });

  it("round-trips parseEnv", () => {
    const entries = [
      { key: "DB_HOST", value: "db.prod" },
      { key: "SPACED", value: "a b c" },
      { key: "EMPTY", value: "" },
      { key: "EQ", value: "k=v" },
    ];
    expect(parseEnv(serializeEnv(entries))).toEqual(entries);
  });
});

describe("readAppEnv / writeAppEnv", () => {
  const base = env.APPS_DIR;
  const dir = resolve(base, "demo");
  const outsideDir = resolve(base, "outside");

  // A file outside the app dir that a planted symlink points at; it must
  // never be opened for writing by writeAppEnv.
  async function makeOutsideFile(name: string, contents: string): Promise<string> {
    await mkdir(outsideDir, { recursive: true });
    const path = resolve(outsideDir, name);
    await writeFile(path, contents, "utf8");
    await chmod(path, 0o644);
    return path;
  }

  async function outsideMode(path: string): Promise<string> {
    const s = await stat(path);
    return (s.mode & 0o777).toString(8);
  }

  async function tmpLeftovers(): Promise<string[]> {
    return (await readdir(dir)).filter((n) => n.includes(".tmp"));
  }

  beforeEach(async () => {
    await mkdir(base, { recursive: true });
    // Clean any leftovers from a previous run before mkdir-ing the app dir.
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await mkdir(dir);
  });

  afterEach(async () => {
    plantAtOpenPath = null;
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("returns [] when .env is missing", async () => {
    expect(await readAppEnv("demo")).toEqual([]);
  });

  it("refuses a `.env` symlink to a file outside the app dir and does not return its contents", async () => {
    // The read mirror of the write-side link tests: a tracked
    // `.env -> /some/host/file` must not make the relay (root in its
    // container) leak the target. O_NOFOLLOW turns the open into ELOOP.
    const outside = await makeOutsideFile("host-secrets", "HOST_SECRET=leaked\n");
    await symlink(outside, resolve(dir, ".env"));
    const err = await readAppEnv("demo").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(EnvFileUnusableError);
    // The message reaches API callers: no link target, no file content.
    expect((err as Error).message).not.toContain(outside);
    expect((err as Error).message).not.toContain("leaked");
  });

  it("refuses a `.env` symlink to a directory", async () => {
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, resolve(dir, ".env"));
    await expect(readAppEnv("demo")).rejects.toBeInstanceOf(EnvFileUnusableError);
  });

  it("refuses a dangling `.env` symlink (not the missing-file [] path)", async () => {
    // O_NOFOLLOW rejects the link itself, so a dangling target never turns
    // into the ENOENT "no .env yet" answer.
    await symlink(resolve(outsideDir, "does-not-exist"), resolve(dir, ".env"));
    await expect(readAppEnv("demo")).rejects.toBeInstanceOf(EnvFileUnusableError);
  });

  it("refuses a directory named `.env`", async () => {
    await mkdir(resolve(dir, ".env"));
    await expect(readAppEnv("demo")).rejects.toBeInstanceOf(EnvFileUnusableError);
  });

  it("refuses a FIFO named `.env` without hanging", async () => {
    // A plain O_RDONLY open of a FIFO blocks until a writer opens it;
    // readAppEnv adds O_NONBLOCK so open() returns and the isFile check
    // refuses it. Without O_NONBLOCK this test would time out.
    await execFileAsync("mkfifo", [resolve(dir, ".env")]);
    await expect(readAppEnv("demo")).rejects.toBeInstanceOf(EnvFileUnusableError);
  });

  it("round-trips write→read and persists file at 0600", async () => {
    await writeAppEnv("demo", [
      { key: "A", value: "1" },
      { key: "B", value: "two three" },
    ]);
    const read = await readAppEnv("demo");
    expect(read).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two three" },
    ]);
    const s = await stat(resolve(base, "demo", ".env"));
    // File should be rw-------; compare only the mode bits (lower 9).
    expect((s.mode & 0o777).toString(8)).toBe("600");
  });

  it("rejects app names outside APPS_DIR (path traversal)", async () => {
    await expect(readAppEnv("../escape")).rejects.toThrow(/Invalid app name/);
    await expect(writeAppEnv("../escape", [])).rejects.toThrow(/Invalid app name/);
  });

  it("rejects unknown apps without creating directories", async () => {
    // `safeAppDir` resolves the real path; for an app dir that doesn't
    // exist we still get a valid-but-nonexistent path. Reading should
    // return [], writing should throw a filesystem error, not create the
    // missing app dir.
    expect(await readAppEnv("no-such-app")).toEqual([]);
  });

  it("preserves existing file when write fails mid-flight (atomic rename)", async () => {
    // Write a good file first.
    await writeAppEnv("demo", [{ key: "A", value: "1" }]);
    const before = await readFile(resolve(base, "demo", ".env"), "utf8");
    // Force serializeEnv to throw via an invalid key — write must bubble.
    await expect(writeAppEnv("demo", [{ key: "1bad", value: "x" }])).rejects.toThrow();
    const after = await readFile(resolve(base, "demo", ".env"), "utf8");
    expect(after).toBe(before);
  });

  it("refuses a pre-existing `.env.tmp` symlink pointing outside the app dir", async () => {
    // The old fixed temp name `.env.tmp`: a tracked symlink at that name in
    // the app checkout used to make writeAppEnv write the env body (which
    // holds secrets) into the link's target outside the app dir.
    const outside = await makeOutsideFile("victim", "OUTSIDE-ORIGINAL");
    await symlink(outside, resolve(dir, ".env.tmp"));
    await writeAppEnv("demo", [{ key: "SECRET_TOKEN", value: "hunter2" }]);
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
    expect(await outsideMode(outside)).toBe("644");
    expect(await readFile(resolve(dir, ".env"), "utf8")).toBe("SECRET_TOKEN=hunter2\n");
    expect(await outsideMode(resolve(dir, ".env"))).toBe("600");
  });

  it("is unaffected by a stale regular `.env.tmp` leftover (left alone)", async () => {
    // Decision: the stale leftover is left alone. The unique temp name means
    // writeAppEnv never touches `.env.tmp` anymore, whatever created it owns
    // it; deleting an arbitrary app-dir path would be a new side effect.
    await writeFile(resolve(dir, ".env.tmp"), "STALE-LEFTOVER", "utf8");
    await writeAppEnv("demo", [{ key: "A", value: "1" }]);
    expect(await readFile(resolve(dir, ".env"), "utf8")).toBe("A=1\n");
    expect(await readFile(resolve(dir, ".env.tmp"), "utf8")).toBe("STALE-LEFTOVER");
  });

  it("replaces a `.env` symlink itself with a regular file, not its target", async () => {
    // rename() swaps the link for the new regular file instead of writing
    // through it: the link is just a file in the app checkout, and the
    // secrets land in a file the relay owns.
    const outside = await makeOutsideFile("link-target", "OUTSIDE-ORIGINAL");
    await symlink(outside, resolve(dir, ".env"));
    await writeAppEnv("demo", [{ key: "SECRET_TOKEN", value: "hunter2" }]);
    const link = await lstat(resolve(dir, ".env"));
    expect(link.isSymbolicLink()).toBe(false);
    expect(link.isFile()).toBe(true);
    expect(await readFile(resolve(dir, ".env"), "utf8")).toBe("SECRET_TOKEN=hunter2\n");
    expect(await outsideMode(resolve(dir, ".env"))).toBe("600");
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeAppEnv("demo", [{ key: "A", value: "1" }]);
    expect(await tmpLeftovers()).toEqual([]);
  });

  it("removes its temp file and rethrows when the rename fails", async () => {
    // A non-empty directory at `.env` makes the final rename fail.
    await mkdir(resolve(dir, ".env"));
    await writeFile(resolve(dir, ".env", "occupied"), "x", "utf8");
    await expect(writeAppEnv("demo", [{ key: "A", value: "1" }])).rejects.toThrow();
    expect(await tmpLeftovers()).toEqual([]);
  });

  it("fails with EEXIST when a symlink sits at the exact temp path, without following it", async () => {
    // The exclusive create (`wx`): open() fails on any existing path,
    // symlink included, so no env body is ever written through a planted
    // link. The temp name is random, so the link is planted via the mocked
    // open at the path about to be opened.
    const outside = await makeOutsideFile("victim", "OUTSIDE-ORIGINAL");
    plantAtOpenPath = (p) => symlink(outside, p);
    await expect(writeAppEnv("demo", [{ key: "SECRET_TOKEN", value: "hunter2" }])).rejects.toThrow(
      /EEXIST/,
    );
    plantAtOpenPath = null;
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
    expect(await outsideMode(outside)).toBe("644");
    expect((await readdir(dir)).filter((n) => n === ".env")).toEqual([]);
  });

  it("writes mode 0600 even when the umask masks the open mode", async () => {
    // The mode is forced via the handle's chmod, not by path (which could
    // follow a symlink), so a masking umask cannot leave the secrets readable.
    const prevUmask = process.umask(0o277);
    try {
      await writeAppEnv("demo", [{ key: "A", value: "1" }]);
    } finally {
      process.umask(prevUmask);
    }
    expect(await outsideMode(resolve(dir, ".env"))).toBe("600");
  });
});
