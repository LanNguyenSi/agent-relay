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

// Option-injection guard at the route boundary: a leading-dash `service` query
// would be a docker compose logs option (`-f`, `--follow`) at the end of the
// exec argv. The route must answer 400 from validateServiceName's throw without
// ever calling runExec.
describe("GET /api/apps/:name/logs: leading-dash service rejected with 400 before exec", () => {
  async function getLogsWithService(service: string): Promise<Response> {
    return api.fetch(
      new Request(`http://test/apps/demo/logs?service=${encodeURIComponent(service)}`, {
        headers: { Authorization: AUTH },
      }),
    );
  }

  it("answers 400 for ?service=-f without calling exec", async () => {
    const res = await getLogsWithService("-f");
    expect(res.status).toBe(400);
    expect(mockRunExec).not.toHaveBeenCalled();
  });

  it("answers 400 for ?service=--follow without calling exec", async () => {
    const res = await getLogsWithService("--follow");
    expect(res.status).toBe(400);
    expect(mockRunExec).not.toHaveBeenCalled();
  });

  it("passes a valid service through to the exec argv", async () => {
    const res = await getLogsWithService("web");
    expect(res.status).toBe(200);
    const [, args] = mockRunExec.mock.calls[0]!;
    expect(args.at(-1)).toBe("web");
  });
});
