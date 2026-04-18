import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { parseEnv, serializeEnv, readAppEnv, writeAppEnv } from "./env.js";

// APPS_DIR is read once at module load (vitest.setup.ts seeds it), so tests
// have to work within that directory instead of switching to a fresh tmpdir.

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

  beforeEach(async () => {
    await mkdir(base, { recursive: true });
    // Clean any leftovers from a previous run before mkdir-ing the app dir.
    await rm(resolve(base, "demo"), { recursive: true, force: true });
    await mkdir(resolve(base, "demo"));
  });

  afterEach(async () => {
    await rm(resolve(base, "demo"), { recursive: true, force: true });
  });

  it("returns [] when .env is missing", async () => {
    expect(await readAppEnv("demo")).toEqual([]);
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
});
