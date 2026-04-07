import { z } from "zod";
import * as yaml from "js-yaml";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const relayConfigSchema = z.object({
  name: z.string().min(1, "name is required"),
  health: z.string().min(1, "health endpoint is required"),
  compose_file: z.string().default("docker-compose.yml"),
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
