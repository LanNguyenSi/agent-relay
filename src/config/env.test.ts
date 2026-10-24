/**
 * Pins the env schema's default/coercion behaviour through the zod 4
 * migration. v4 defaults short-circuit (the default value is emitted as-is,
 * without running the inner coerce), so each interaction between
 * `.default(8222)` and `z.coerce.number()` is a separate case:
 *   - absent PORT          -> 8222 (number, from the default, no coercion)
 *   - PORT="9000" (string) -> 9000 (number, from coercion)
 *   - PORT=""              -> 0   (Number("") === 0; v3 parity, kept)
 *   - PORT="abc"           -> rejected (NaN)
 * Error message texts are pinned verbatim because env.ts prints them to
 * stderr before exiting; the AUTH_TOKEN custom message must survive, the
 * default texts are the v4 ones captured at migration time.
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

  it("coerces the string \"9000\" to the number 9000 (coerce wins over default)", () => {
    const result = parsePort({ PORT: "9000" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(9000);
  });

  it("coerces an empty string to 0 (Number(\"\") === 0, v3 parity)", () => {
    const result = parsePort({ PORT: "" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(0);
  });

  it("passes a numeric PORT value through unchanged", () => {
    const result = parsePort({ PORT: "80" });
    expect(result.success).toBe(true);
    expect(result.data?.PORT).toBe(80);
  });

  it("rejects a non-numeric PORT with the NaN issue text", () => {
    const result = parsePort({ PORT: "abc" });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["PORT"]);
    expect(issue?.message).toBe("Invalid input: expected number, received NaN");
  });

  it("rejects non-finite PORT (zod 4 numbers reject Infinity)", () => {
    for (const value of ["Infinity", "-Infinity"]) {
      const result = parsePort({ PORT: value });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["PORT"]);
    }
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
