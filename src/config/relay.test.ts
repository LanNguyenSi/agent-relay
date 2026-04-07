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
});
