import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Pins the Publish workflow's push trigger: documentation-only pushes to main
// must not publish a new :latest image, while image inputs and tag releases
// still publish. GitHub glob semantics: `*` does not cross `/`, `**` does.
const root = resolve(__dirname, "../..");

type PushTrigger = { branches?: string[]; tags?: string[]; "paths-ignore"?: string[]; paths?: string[] };

type PublishWorkflow = {
  on: { push: PushTrigger; workflow_dispatch?: unknown };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};

const workflow = (): PublishWorkflow =>
  load(readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")) as PublishWorkflow;

const trigger = (): PushTrigger => workflow().on.push;

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

// Pins how the Publish workflow keeps `:latest` on main's newest build: runs
// are serialized per ref, and only the default branch pushes `:latest`, so a
// v* tag build that finishes after a newer main build cannot roll it back,
// and no run of one ref can supersede a queued run of another.
type MetaStep = { id?: string; with?: { tags?: string; flavor?: string } };
const metaStep = (): MetaStep | undefined => {
  const wf = load(readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")) as {
    jobs: Record<string, { steps: MetaStep[] }>;
  };
  return Object.values(wf.jobs)
    .flatMap((job) => job.steps)
    .find((s) => s.id === "meta");
};
const metadataTags = (): string[] =>
  (metaStep()?.with?.tags ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

describe("publish workflow :latest ownership", () => {
  it("serializes runs per ref and never cancels a running publish", () => {
    expect(workflow().concurrency?.group).toBe("publish-${{ github.ref }}");
    expect(workflow().concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("pushes :latest only from the default branch", () => {
    const latest = metadataTags().filter((line) => /value=latest\b/.test(line));
    expect(latest).toEqual(["type=raw,value=latest,enable={{is_default_branch}}"]);
  });

  it("turns off metadata-action's automatic latest for semver tags", () => {
    const flavor = (metaStep()?.with?.flavor ?? "").split("\n").map((line) => line.trim());
    expect(flavor).toContain("latest=false");
  });

  it("still pushes the semver tags for a v* tag build", () => {
    const tags = metadataTags();
    expect(tags).toContain("type=semver,pattern={{version}}");
    expect(tags).toContain("type=semver,pattern={{major}}.{{minor}}");
  });
});
