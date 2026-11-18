/**
 * Pins the env schema's PORT handling after the empty-PORT hardening.
 * An empty or whitespace-only PORT is preprocessed to undefined before the
 * zod 4 default short-circuits, so it counts as unset (8222); a non-empty
 * value is coerced and must be an integer in 1..65535. The cases:
 *   - absent PORT / "" / "   "  -> 8222 (from the default, no coercion)
 *   - PORT="9000" or "80"       -> coerced number (a non-empty value wins
 *                                  over the default)
 *   - PORT="0", "-1", "1.5", "65536", "abc", "Infinity", "-Infinity"
 *                               -> rejected with the issue path ["PORT"]
 * (The old "v3 parity" case, PORT="" -> 0, was the bug: Number("") === 0
 * means "any free port" while the container healthcheck probes 8222.)
 * Error message texts are pinned verbatim because env.ts prints them to
 * stderr before exiting; the AUTH_TOKEN custom message must survive, the
 * default texts are the v4 ones captured at migration time. For PORT
 * rejections the texts are pinned only where the preprocess construct
 * leaves them unchanged ("abc" -> the coercion NaN issue); the bound and
 * int rejections assert the issue path.
 */
import { describe, it, expect } from "vitest";
import { envSchema } from "./env.js";

function parsePort(env: Record<string, string>) {
  return envSchema.safeParse({ AUTH_TOKEN: "test-token", ...env });
}

describe("envSchema PORT default/coercion", () => {
  it("applies the number default 8222 when PORT is absent", () => {
    const result = parsePort({});
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(8222);
  });

  it("treats an empty PORT as unset and applies the default 8222 (not 0)", () => {
    const result = parsePort({ PORT: "" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(8222);
  });

  it("treats a whitespace-only PORT as unset and applies the default 8222", () => {
    const result = parsePort({ PORT: "   " });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(8222);
  });

  it("coerces the string \"9000\" to the number 9000 (coerce wins over default)", () => {
    const result = parsePort({ PORT: "9000" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(9000);
  });

  it("passes a numeric PORT value through unchanged", () => {
    const result = parsePort({ PORT: "80" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(80);
  });

  it("rejects PORT \"0\" (0 means a random port; valid ports start at 1)", () => {
    const result = parsePort({ PORT: "0" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });

  it("rejects a negative PORT \"-1\"", () => {
    const result = parsePort({ PORT: "-1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });

  it("rejects a fractional PORT \"1.5\"", () => {
    const result = parsePort({ PORT: "1.5" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });

  it("rejects PORT \"65536\" (above the max valid port)", () => {
    const result = parsePort({ PORT: "65536" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });

  it("rejects a non-numeric PORT with the NaN issue text", () => {
    const result = parsePort({ PORT: "abc" });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["PORT"]);
    expect(issue?.message).toBe("Invalid input: expected number, received NaN");
  });

  it("rejects non-finite PORT \"Infinity\" (zod 4 numbers reject Infinity)", () => {
    const result = parsePort({ PORT: "Infinity" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });

  it("rejects non-finite PORT \"-Infinity\"", () => {
    const result = parsePort({ PORT: "-Infinity" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
  });
});

describe("envSchema required/default fields", () => {
  it("rejects a missing AUTH_TOKEN (v4 required text pinned)", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["AUTH_TOKEN"]);
    expect(issue?.message).toBe("Invalid input: expected string, received undefined");
  });

  it("rejects an empty AUTH_TOKEN with the identical custom message", () => {
    const result = envSchema.safeParse({ AUTH_TOKEN: "" });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["AUTH_TOKEN"]);
    expect(issue?.message).toBe("AUTH_TOKEN is required");
  });

  it("applies the APPS_DIR default /apps", () => {
    const result = envSchema.safeParse({ AUTH_TOKEN: "t" });
    expect(result.success).toBe(true);
    expect(result.data?.APPS_DIR).toBe("/apps");
  });
});
