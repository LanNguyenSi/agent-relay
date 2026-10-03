import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runPreflightChecks } from "./preflight.js";
import { safeAppDir } from "../services/apps.js";
import { env } from "../config/env.js";
import type { RelayConfig } from "../config/relay.js";

// Real-filesystem integration test: no fs/path/crypto/os mocks. Chains
// safeAppDir() into runPreflightChecks() through an explicit symlink
// APPS_DIR, so a mismatch between the appDir that production hands to the
// check and the realpath-ed APPS_DIR the check derives itself fails here.
// The symlink is created explicitly (not via the host's /var ->
// /private/var) so the test also bites on CI runners with a real tmpdir.

const APP = "demo";

const config: RelayConfig = {
  name: APP,
  health: "/health",
  compose_file: "docker-compose.yml",
  pre_update: [],
  post_update: [],
  rollback: true,
};

describe("compose_bind_mount_sources_exist through a symlinked APPS_DIR (real fs)", () => {
  let tmpRoot: string;
  let realApps: string;
  let linkApps: string;
  let originalAppsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-preflight-symlink-"));
    realApps = resolve(tmpRoot, "real-apps");
    linkApps = resolve(tmpRoot, "apps-link");
    await mkdir(resolve(realApps, APP), { recursive: true });
    await symlink(realApps, linkApps);
    originalAppsDir = env.APPS_DIR;
    env.APPS_DIR = linkApps;
  });

  afterEach(async () => {
    env.APPS_DIR = originalAppsDir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeCompose(source: string): Promise<void> {
    const text =
      "services:\n" +
      "  app:\n" +
      "    image: example/app:latest\n" +
      "    volumes:\n" +
      `      - ${source}:/data\n`;
    await writeFile(resolve(realApps, APP, "docker-compose.yml"), text, "utf-8");
  }

  async function runCheck(appDir: string) {
    const report = await runPreflightChecks({
      appDir,
      config,
      only: ["compose_bind_mount_sources_exist"],
    });
    const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
    expect(check).toBeDefined();
    return { report, check: check! };
  }

  it("passes when the bind-mount source exists", async () => {
    await mkdir(resolve(realApps, APP, "data"));
    await writeCompose("./data");

    const appDir = await safeAppDir(APP);
    expect(appDir).toBe(await realpath(resolve(linkApps, APP)));
    expect(appDir.startsWith(linkApps)).toBe(false);

    const { report, check } = await runCheck(appDir);
    expect(check.passed).toBe(true);
    expect(check.critical).toBe(true);
    expect(check.message).toContain("All 1 compose bind-mount source(s) exist");
    expect(report.passed).toBe(true);
  });

  it("fails critically when the bind-mount source is missing", async () => {
    await writeCompose("./missing-dir");

    const appDir = await safeAppDir(APP);
    const { report, check } = await runCheck(appDir);

    expect(check.passed).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.message).toContain("Missing compose bind-mount source");
    expect(check.message).toContain(resolve(await realpath(realApps), APP, "missing-dir"));
    expect(report.passed).toBe(false);
  });

  it("skips a relative source that escapes APPS_DIR instead of checking it", async () => {
    await writeCompose("../../../outside");

    const appDir = await safeAppDir(APP);
    const { check } = await runCheck(appDir);

    expect(check.passed).toBe(true);
    expect(check.message).toContain("escapes APPS_DIR");
  });

  it("skips an absolute source outside APPS_DIR", async () => {
    const outside = resolve(tmpRoot, "elsewhere");
    await mkdir(outside);
    await writeCompose(outside);

    const appDir = await safeAppDir(APP);
    const { check } = await runCheck(appDir);

    expect(check.passed).toBe(true);
    expect(check.message).toContain("absolute, outside APPS_DIR");
  });
});
