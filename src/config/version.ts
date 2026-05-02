// Single source of truth for the runtime-reported relay version.
// Reads package.json once at import time so a release that bumps
// only package.json's "version" propagates to /health, /api/health,
// and the MCP server-info response without further source edits.
//
// Implementation note: uses fs.readFileSync rather than a static
// `import pkg from "../../package.json" with { type: "json" }`
// because the latter forces tsc to copy package.json into dist/,
// which conflicts with the project's --rootDir=src and -outDir=dist
// layout (the JSON file would land OUTSIDE rootDir or duplicate the
// real one). fs.readFileSync resolves the path via import.meta.url,
// so it works the same in tsx (dev) and node (dist).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dev:  src/config/version.ts → ../../package.json
// dist: dist/config/version.js → ../../package.json
// Both resolve to the same repo-root package.json.
const pkgPath = resolve(__dirname, "..", "..", "package.json");

interface PackageJson {
  version?: string;
}

function readVersion(): string {
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as PackageJson;
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the unknown sentinel; degrade visibly rather
    // than crashing the relay process at import time.
  }
  return "0.0.0-unknown";
}

export const RELAY_VERSION: string = readVersion();
