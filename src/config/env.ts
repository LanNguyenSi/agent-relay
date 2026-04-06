import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8222),
  AUTH_TOKEN: z.string().min(1, "AUTH_TOKEN is required"),
  APPS_DIR: z.string().default("/home/deploy/apps"),
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
