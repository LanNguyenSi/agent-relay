import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { safeAppDir, validateBranch } from "./apps.js";
import { env } from "../config/env.js";

describe("validateBranch", () => {
  it("accepts well-formed branch names", () => {
    expect(validateBranch("main")).toBe("main");
    expect(validateBranch("feat/x")).toBe("feat/x");
    expect(validateBranch("release/v1.0.0")).toBe("release/v1.0.0");
    expect(validateBranch("fix/a-b_c.d")).toBe("fix/a-b_c.d");
  });

  it("rejects branch names carrying shell metacharacters", () => {
    expect(() => validateBranch("main';rm -rf /")).toThrow("Invalid branch name");
    expect(() => validateBranch("feature branch")).toThrow("Invalid branch name");
    expect(() => validateBranch("main|cat /etc/passwd")).toThrow("Invalid branch name");
    expect(() => validateBranch("main$(whoami)")).toThrow("Invalid branch name");
    expect(() => validateBranch("main`id`")).toThrow("Invalid branch name");
    expect(() => validateBranch("main\nrm -rf /")).toThrow("Invalid branch name");
  });
});

describe("safeAppDir", () => {
  let tmpRoot: string;
  let appsDir: string;
  let originalAppsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-safeappdir-"));
    appsDir = resolve(tmpRoot, "apps");
    await mkdir(appsDir, { recursive: true });
    originalAppsDir = env.APPS_DIR;
    env.APPS_DIR = appsDir;
  });

  afterEach(async () => {
    env.APPS_DIR = originalAppsDir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects an invalid app name", async () => {
    await expect(safeAppDir("../evil")).rejects.toThrow("Invalid app name");
  });

  it("resolves a legitimate app directory to its real path", async () => {
    const appDir = resolve(appsDir, "demo");
    await mkdir(appDir);
    const expected = await realpath(appDir);
    await expect(safeAppDir("demo")).resolves.toBe(expected);
  });

  it("rejects a symlink escaping to a sibling-prefixed dir (apps vs apps-evil)", async () => {
    // The trailing-separator false-positive: a symlink APPS_DIR/escape ->
    // <tmpRoot>/apps-evil. Its realpath string-starts with appsReal
    // (<tmpRoot>/apps) yet is NOT contained. Without the `+ sep` guard the
    // old check accepted it.
    const sibling = resolve(tmpRoot, "apps-evil");
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, resolve(appsDir, "escape"));
    await expect(safeAppDir("escape")).rejects.toThrow("App path escapes APPS_DIR");
  });
});
