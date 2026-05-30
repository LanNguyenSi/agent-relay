import { describe, it, expect } from "vitest";
import { validateBranch } from "./apps.js";

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
