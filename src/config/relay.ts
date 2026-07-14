import { z } from "zod";
import * as yaml from "js-yaml";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// `compose_file` is passed as a literal runExec arg-array element in
// src/deploy/engine.ts and src/services/apps.ts — never shell-interpolated.
// Shell injection via `compose_file` is therefore not possible regardless
// of the charset. COMPOSE_FILE_PATTERN still serves as defence-in-depth
// and path-charset hygiene: it prevents control characters, whitespace, and
// other non-printable bytes from slipping in and potentially confusing
// docker or a downstream audit tool.
//
// Path-traversal containment (`..`-escapes-outside-APPS_DIR) is enforced
// separately in `loadRelayConfig`, where we have `appDir` and can
// resolve against the filesystem. That lets legitimate sibling-app
// patterns (`compose_file: ../other-app/docker-compose.yml`) validate
// when the resolved path stays under APPS_DIR, while deeper escapes
// (`../../etc/passwd`) still fail. Doing this at parse time would have
// forced a lexical ban on all `..` which is too strict.
//
// `command`, `pre_update`, and `post_update` remain deliberately
// permissive — they are documented as arbitrary shell, and the trust
// boundary for those fields is "push access to the deployed branch".
// Anyone who can edit `.relay.yml` on a deploy branch already has
// equivalent RCE via those hooks; tightening them would break legitimate
// use (pipes, redirects, `docker compose exec backend …`, etc.).
const COMPOSE_FILE_PATTERN = /^[A-Za-z0-9._/-]+$/;

export const relayConfigSchema = z.object({
  name: z.string().min(1, "name is required"),
  health: z.string().min(1, "health endpoint is required"),
  health_port: z.number().optional(),
  compose_file: z
    .string()
    .regex(
      COMPOSE_FILE_PATTERN,
      "compose_file must only contain letters, digits, '.', '_', '/', or '-'",
    )
    .refine(
      (v) => !v.startsWith("/"),
      "compose_file must be a path relative to the app directory, not absolute",
    )
    .default("docker-compose.yml"),
  command: z.string().optional(),
  pre_update: z.array(z.string()).default([]),
  post_update: z.array(z.string()).default([]),
  rollback: z.boolean().default(true),
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;

export function parseRelayConfig(content: string): RelayConfig {
  const raw = yaml.load(content);

  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new RelayConfigError("Invalid YAML: expected a mapping, got " + typeof raw);
  }

  const result = relayConfigSchema.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new RelayConfigError(
      "Invalid .relay.yml:\n" + messages.join("\n"),
    );
  }

  return result.data;
}

/**
 * Reject a compose_file whose resolved filesystem location escapes the
 * apps-root directory (the parent of `appDir`). This is the "what the
 * lexical `..`-ban used to try to prevent" check — except it accepts
 * the legitimate sibling-app case (`../other-app/docker-compose.yml`
 * resolves to `APPS_DIR/other-app/docker-compose.yml`, which stays
 * within APPS_DIR) while still rejecting deeper traversals like
 * `../../etc/passwd`.
 *
 * APPS_DIR is derived as `resolve(appDir, "..")` — agent-relay treats
 * every `appDir` as a direct child of the apps root, which is how
 * both the dev mount (`./apps/<name>`) and the production bind mount
 * (`/root/git/<name>` → `/apps/<name>` inside the container) are
 * structured. Deploys never address apps via other layouts.
 */
export async function assertComposeFileContained(
  appDir: string,
  composeFile: string,
): Promise<void> {
  const resolved = resolve(appDir, composeFile);
  const appsDir = resolve(appDir, "..");
  // Lexical containment first: catches `..` escapes and works before the
  // compose file exists on disk. `startsWith(appsDir + sep)` (not just
  // `appsDir`) prevents a sibling-name prefix false-positive — without the
  // trailing separator, `appsDir = /apps` would accept `/appsteak/...`.
  if (!resolved.startsWith(appsDir + sep) && resolved !== appsDir) {
    throw new RelayConfigError(
      `compose_file resolves outside the apps directory ` +
        `(${resolved} is not under ${appsDir})`,
    );
  }
  // Symlink containment: a symlink inside the app directory can stay lexically
  // contained while pointing outside APPS_DIR. Resolve symlinks and re-check
  // against the real apps root. ENOENT means the compose file is not on disk
  // yet (e.g. a fresh checkout) — presence is enforced separately by the
  // deploy preflight (checkComposeFileExists), so skip the symlink check here
  // rather than reject a not-yet-present file.
  let realResolved: string;
  try {
    realResolved = await realpath(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const realAppsDir = await realpath(appsDir);
  if (!realResolved.startsWith(realAppsDir + sep) && realResolved !== realAppsDir) {
    throw new RelayConfigError(
      `compose_file resolves through a symlink to outside the apps directory ` +
        `(${realResolved} is not under ${realAppsDir})`,
    );
  }
}

export async function loadRelayConfig(appDir: string): Promise<RelayConfig> {
  const configPath = join(appDir, ".relay.yml");

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RelayConfigError(
        `No .relay.yml found in ${appDir}`,
      );
    }
    throw new RelayConfigError(
      `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const config = parseRelayConfig(content);
  await assertComposeFileContained(appDir, config.compose_file);
  return config;
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}
