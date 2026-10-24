import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getRelayRevision, RELAY_VERSION } from "./version.js";
import { createApp } from "../server.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

describe("getRelayRevision", () => {
  it("returns the full commit SHA when RELAY_REVISION is set", () => {
    const sha = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
    expect(getRelayRevision({ RELAY_REVISION: sha })).toBe(sha);
  });

  it("trims surrounding whitespace when RELAY_REVISION is set", () => {
    const sha = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
    expect(getRelayRevision({ RELAY_REVISION: `  ${sha}\n` })).toBe(sha);
  });

  it("returns \"unknown\" when RELAY_REVISION is absent", () => {
    expect(getRelayRevision({})).toBe("unknown");
  });

  it("returns \"unknown\" when RELAY_REVISION is empty", () => {
    expect(getRelayRevision({ RELAY_REVISION: "" })).toBe("unknown");
  });

  it("returns \"unknown\" when RELAY_REVISION is whitespace-only", () => {
    expect(getRelayRevision({ RELAY_REVISION: "   \t\n  " })).toBe("unknown");
  });

  it("keeps RELAY_VERSION non-empty alongside revision helpers", () => {
    expect(RELAY_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("createApp() GET /health revision reporting", () => {
  it("reports the commit SHA on GET /health when RELAY_REVISION is set", async () => {
    const prev = process.env.RELAY_REVISION;
    process.env.RELAY_REVISION = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
    try {
      const app = createApp();
      const res = await app.fetch(new Request("http://test/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        version: RELAY_VERSION,
        revision: "89b3f8b920be3ae58617395fddb4d73fe5138f72",
      });
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });

  it("reports \"unknown\" on GET /health when RELAY_REVISION is absent", async () => {
    const prev = process.env.RELAY_REVISION;
    delete process.env.RELAY_REVISION;
    try {
      const app = createApp();
      const res = await app.fetch(new Request("http://test/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        version: RELAY_VERSION,
        revision: "unknown",
      });
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });

  it("reports \"unknown\" on GET /health when RELAY_REVISION is empty or whitespace", async () => {
    const prev = process.env.RELAY_REVISION;
    process.env.RELAY_REVISION = "  \t  ";
    try {
      const app = createApp();
      const res = await app.fetch(new Request("http://test/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        version: RELAY_VERSION,
        revision: "unknown",
      });
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });
});

describe("image build revision wiring (Dockerfile + publish.yml)", () => {
  it("declares ARG RELAY_REVISION and ENV RELAY_REVISION in the final runtime stage of Dockerfile", () => {
    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
    const stages = dockerfile.split(/^FROM\s+/im).slice(1);
    const runtimeStage = stages.at(-1) ?? "";
    expect(runtimeStage).toMatch(/^ARG\s+RELAY_REVISION=""/m);
    expect(runtimeStage).toMatch(/^ENV\s+RELAY_REVISION=\$RELAY_REVISION/m);
  });

  it("passes RELAY_REVISION=${{ github.sha }} via build-args in .github/workflows/publish.yml", () => {
    const workflow = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/publish.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/build-args:\s*RELAY_REVISION=\$\{\{\s*github\.sha\s*\}\}/);
  });
});
