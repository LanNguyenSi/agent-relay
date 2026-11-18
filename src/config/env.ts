import { z } from "zod";

// Exported for tests: pins PORT handling. An empty or whitespace-only PORT
// is preprocessed to undefined BEFORE the zod 4 default short-circuits, so it
// counts as unset and yields 8222 (previously "" coerced to 0 = random port).
// Anything else is coerced and must be an integer in 1..65535; `0`, negative,
// fractional, `65536` and non-numeric values are rejected at start-up with a
// PORT issue. Precedence: a non-empty PORT wins over the default; empty,
// whitespace-only and absent all take the default.
export const envSchema = z.object({
  PORT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65535).default(8222),
  ),
  AUTH_TOKEN: z.string().min(1, "AUTH_TOKEN is required"),
  APPS_DIR: z.string().default("/apps"),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
