import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

// Self-update refuses a compose file whose relay service has no `image:` (or
// has `build:`). The installer's compose files gained a `logging:` block and
// must still parse to an image-based relay service in every mode.
const installSh = resolve(__dirname, "../../install.sh");
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeCompose(mode: string): Record<string, unknown> {
  dir = mkdtempSync(join(tmpdir(), "relay-compose-"));
  execFileSync(
    "bash",
    [
      "-c",
      `INSTALL_SH_SOURCE_ONLY=1 . "$1"
       RELAY_MODE="$2"; RELAY_DOMAIN=relay.example.com; TRAEFIK_EMAIL=a@example.com
       TRAEFIK_CA=letsencrypt; APPS_DIR=/home/deploy/apps; RELAY_PORT=8222
       TRAEFIK_NETWORK=traefik-public; TRAEFIK_CERTRESOLVER=letsencrypt
       agent_relay_write_relay_compose "$3"`,
      "bash",
      installSh,
      mode,
      dir,
    ],
    { stdio: "pipe" },
  );
  const doc = yaml.load(readFileSync(join(dir, "docker-compose.yml"), "utf8")) as {
    services: { relay: Record<string, unknown> };
  };
  return doc.services.relay;
}

describe("installer-written compose and self-update", () => {
  it.each(["greenfield", "existing-traefik", "port-only"])(
    "%s: relay service is image-based with log rotation",
    (mode) => {
      const relay = writeCompose(mode);
      expect(relay.image).toBe("ghcr.io/lannguyensi/agent-relay:latest");
      expect(relay.build).toBeUndefined();
      expect(relay.logging).toEqual({
        driver: "json-file",
        options: { "max-size": "10m", "max-file": "3" },
      });
    },
  );
});
