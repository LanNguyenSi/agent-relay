import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The relay shells out to git/docker/sh. When such a step is killed (timeout)
// or leaves a grandchild behind, the orphan is reparented to the container's
// PID 1. Node as PID 1 never reaps those, so defunct entries pile up. These
// checks pin the image-level fix (an init as PID 1) so it cannot be dropped
// silently; the behavioural proof is the container soak documented in
// docs/operations.md.
const root = resolve(__dirname, "../..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8");

describe("container init (zombie reaping)", () => {
  it("installs tini in the runtime image", () => {
    const runtimeStage = read("Dockerfile").split(/^FROM /m).pop() ?? "";
    expect(runtimeStage).toMatch(/apk add[^\n]*\btini\b/);
  });

  it("starts node under tini as a subreaper, in exec form, in the runtime stage", () => {
    const runtimeStage = read("Dockerfile").split("FROM ").pop() ?? "";
    expect(runtimeStage).toMatch(/^ENTRYPOINT \["\/sbin\/tini", "-s", "--"\]$/m);
    expect(runtimeStage).toMatch(/^CMD \["node", "dist\/index\.js"\]$/m);
    const entrypoints = runtimeStage.match(/^ENTRYPOINT .*$/gm) ?? [];
    expect(entrypoints.at(-1)).toBe('ENTRYPOINT ["/sbin/tini", "-s", "--"]');
  });

  it.each(["docker-compose.yml", "docker-compose.prod.example.yml"])(
    "%s sets init: true on the relay service",
    (file) => {
      expect(read(file)).toMatch(/^ {4}init: true$/m);
    },
  );
});
