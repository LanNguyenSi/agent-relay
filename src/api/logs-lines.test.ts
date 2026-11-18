/**
 * Route-level guard for GET /api/apps/:name/logs: the raw `lines` query is
 * Number() coerced by the route, so `?lines=abc` is NaN and `?lines=-1` is -1.
 * Both must collapse to the 50-line default before they reach `docker compose
 * logs --tail=<n>` (a negative/NaN --tail is a docker error). This keeps the
 * real fetchLogs path (only exec + config are stubbed) so the assertion is on
 * the `--tail` argument that actually reaches runExec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../deploy/exec.js", () => ({ runExec: vi.fn() }));
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return {
    ...actual,
    loadRelayConfig: vi.fn().mockResolvedValue({ compose_file: "docker-compose.yml" }),
  };
});

import { api } from "./routes.js";
import { runExec } from "../deploy/exec.js";
import { env } from "../config/env.js";

const mockRunExec = vi.mocked(runExec);
const AUTH = `Bearer ${env.AUTH_TOKEN}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockRunExec.mockResolvedValue({ stdout: "log line\n", stderr: "", exitCode: 0 });
});

async function getLogs(lines: string): Promise<void> {
  await api.fetch(
    new Request(`http://test/apps/demo/logs?lines=${lines}`, {
      headers: { Authorization: AUTH },
    }),
  );
}

describe("GET /api/apps/:name/logs: lines query clamped before --tail", () => {
  it("clamps ?lines=abc (NaN) to --tail=50 reaching the exec", async () => {
    await getLogs("abc");
    const [, args] = mockRunExec.mock.calls[0]!;
    expect(args).toContain("--tail=50");
  });

  it("clamps ?lines=-1 to --tail=50 reaching the exec", async () => {
    await getLogs("-1");
    const [, args] = mockRunExec.mock.calls[0]!;
    expect(args).toContain("--tail=50");
  });

  it("passes a valid ?lines through unchanged as --tail", async () => {
    await getLogs("250");
    const [, args] = mockRunExec.mock.calls[0]!;
    expect(args).toContain("--tail=250");
  });
});
