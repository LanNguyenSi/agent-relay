import { z } from "zod";

// Exported for tests: pins the v4 default/coercion behaviour of PORT
// (default short-circuits to 8222, strings are coerced, "" -> 0).
export const envSchema = z.object({
  PORT: z.coerce.number().default(8222),
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
