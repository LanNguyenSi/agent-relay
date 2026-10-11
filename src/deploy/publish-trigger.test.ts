import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Pins the Publish workflow's push trigger: documentation-only pushes to main
// must not publish a new :latest image, while image inputs and tag releases
// still publish. GitHub glob semantics: `*` does not cross `/`, `**` does.
const root = resolve(__dirname, "../..");

type PushTrigger = { branches?: string[]; tags?: string[]; "paths-ignore"?: string[]; paths?: string[] };

const trigger = (): PushTrigger => {
  const wf = load(readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")) as {
    on: { push: PushTrigger; workflow_dispatch?: unknown };
  };
  return wf.on.push;
};

describe("publish workflow trigger", () => {
  it("ignores exactly the documentation-only paths", () => {
    expect(trigger()["paths-ignore"]).toEqual(["docs/**", "*.md", "LICENSE"]);
  });

  it("does not use a positive paths filter next to paths-ignore", () => {
    expect(trigger().paths).toBeUndefined();
  });

  it("keeps main and v* tag pushes as triggers", () => {
    expect(trigger().branches).toEqual(["main"]);
    expect(trigger().tags).toEqual(["v*"]);
  });

  it("never ignores an image input", () => {
    const ignore = trigger()["paths-ignore"] ?? [];
    for (const pattern of ignore) {
      expect(pattern.startsWith("src/")).toBe(false);
      expect(["Dockerfile", "package.json", "package-lock.json", "tsconfig.json"]).not.toContain(pattern);
      expect(pattern).not.toMatch(/^\*\*/);
    }
  });
});
