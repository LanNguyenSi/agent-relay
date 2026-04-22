import { z } from "zod";
import * as yaml from "js-yaml";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// `compose_file` is interpolated into shell via single quotes in
// src/deploy/engine.ts (`docker compose -f '${config.compose_file}' …`).
// A literal `'` would terminate the quoted context and let the rest of
// the value execute as shell. Restrict to a conservative filename charset
// (letters, digits, dot, underscore, slash, hyphen) and forbid `..` so a
// value can never break out of the quoting OR traverse out of the app
// directory.
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
    .refine(
      (v) => !v.split("/").includes(".."),
      "compose_file must not contain '..' path segments",
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

export async function loadRelayConfig(appDir: string): Promise<RelayConfig> {
  const configPath = join(appDir, ".relay.yml");

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new RelayConfigError(
        `No .relay.yml found in ${appDir}`,
      );
    }
    throw new RelayConfigError(
      `Failed to read ${configPath}: ${err.message}`,
    );
  }

  return parseRelayConfig(content);
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}
