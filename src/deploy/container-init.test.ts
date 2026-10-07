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

// Stages split on FROM in any letter case; the runtime stage is the last one.
const runtimeStage = () => read("Dockerfile").split(/^FROM /im).pop() ?? "";

// Every `<keyword> ...` line of a stage, in order, with the keyword upper-cased
// and the separating whitespace collapsed to one space.
const instructions = (stage: string, keyword: string) =>
  (stage.match(new RegExp(`^${keyword}\\s.*$`, "gim")) ?? []).map((line) =>
    line.trim().replace(/^(\S+)\s+/, (_m, k: string) => `${k.toUpperCase()} `),
  );

describe("container init (zombie reaping)", () => {
  it("installs tini in the runtime image", () => {
    expect(runtimeStage()).toMatch(/^RUN [^\n]*apk add[^\n]*\btini\b/im);
  });

  it("starts node under tini as a subreaper, in exec form, in the runtime stage", () => {
    const stage = runtimeStage();
    // Docker instruction keywords are case-insensitive: a lowercase
    // `entrypoint`/`cmd` line still takes effect, so collect every spelling
    // and compare the last one after normalising the keyword.
    const entrypoints = instructions(stage, "ENTRYPOINT");
    const cmds = instructions(stage, "CMD");
    expect(entrypoints.at(-1)).toBe('ENTRYPOINT ["/sbin/tini", "-s", "--"]');
    expect(cmds.at(-1)).toBe('CMD ["node", "dist/index.js"]');
  });

  it.each(["docker-compose.yml", "docker-compose.prod.example.yml"])(
    "%s sets init: true on the relay service",
    (file) => {
      expect(read(file)).toMatch(/^ {4}init: true$/m);
    },
  );
});
