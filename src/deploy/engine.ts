import type { RelayConfig } from "../config/relay.js";
import { shell } from "./exec.js";

export interface DeployStep {
  name: string;
  status: "success" | "failure" | "skipped";
  output: string;
  durationMs: number;
}

export interface DeployResult {
  success: boolean;
  durationMs: number;
  commitBefore: string;
  commitAfter: string;
  steps: DeployStep[];
}

export interface DeployOptions {
  appDir: string;
  config: RelayConfig;
  branch?: string;
  healthBaseUrl?: string;
}

export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const { appDir, config } = options;
  // Detect current branch if not specified
  let branch = options.branch;
  if (!branch) {
    const branchResult = await shell("git rev-parse --abbrev-ref HEAD", appDir);
    branch = branchResult.stdout.trim() || "main";
  }
  const steps: DeployStep[] = [];
  const start = Date.now();

  const commitBefore = await getCurrentCommit(appDir);

  if (config.command) {
    return customCommandDeploy(options, commitBefore, steps, start);
  }

  return defaultFlowDeploy(options, branch, commitBefore, steps, start);
}

async function defaultFlowDeploy(
  options: DeployOptions,
  branch: string,
  commitBefore: string,
  steps: DeployStep[],
  start: number,
): Promise<DeployResult> {
  const { appDir, config } = options;

  // Pre-update commands
  for (const cmd of config.pre_update) {
    const step = await runStep(`pre_update: ${cmd}`, () => shell(cmd, appDir));
    steps.push(step);
    if (step.status === "failure") {
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Git pull
  const pullStep = await runStep("git pull", () =>
    shell(`git pull origin '${branch}'`, appDir),
  );
  steps.push(pullStep);
  if (pullStep.status === "failure") {
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Docker compose build
  const buildStep = await runStep("compose build", () =>
    shell(`docker compose -f '${config.compose_file}' build`, appDir),
  );
  steps.push(buildStep);
  if (buildStep.status === "failure") {
    await rollbackIfEnabled(config, appDir, commitBefore, steps);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Docker compose up
  const upStep = await runStep("compose up", () =>
    shell(`docker compose -f '${config.compose_file}' up -d`, appDir),
  );
  steps.push(upStep);
  if (upStep.status === "failure") {
    await rollbackIfEnabled(config, appDir, commitBefore, steps);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Post-update commands
  for (const cmd of config.post_update) {
    const step = await runStep(`post_update: ${cmd}`, () => shell(cmd, appDir));
    steps.push(step);
    if (step.status === "failure") {
      await rollbackIfEnabled(config, appDir, commitBefore, steps);
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Health check
  const healthOk = await runHealthCheck(options, steps);
  if (!healthOk) {
    await rollbackIfEnabled(config, appDir, commitBefore, steps);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }

  const commitAfter = await getCurrentCommit(appDir);
  return result(true, commitBefore, commitAfter, steps, start);
}

async function customCommandDeploy(
  options: DeployOptions,
  commitBefore: string,
  steps: DeployStep[],
  start: number,
): Promise<DeployResult> {
  const { appDir, config } = options;

  const cmdStep = await runStep(`command: ${config.command}`, () =>
    shell(config.command!, appDir),
  );
  steps.push(cmdStep);
  if (cmdStep.status === "failure") {
    return result(false, commitBefore, commitBefore, steps, start);
  }

  const healthOk = await runHealthCheck(options, steps);
  if (!healthOk) {
    await rollbackIfEnabled(config, appDir, commitBefore, steps);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }

  const commitAfter = await getCurrentCommit(appDir);
  return result(true, commitBefore, commitAfter, steps, start);
}

async function runHealthCheck(
  options: DeployOptions,
  steps: DeployStep[],
): Promise<boolean> {
  const { appDir, config } = options;
  const healthPath = config.health;

  // Try each running service with node fetch, with retries for startup time
  const healthStep = await runStep("health check", async () => {
    const maxRetries = 5;
    const delayMs = process.env.NODE_ENV === "test" ? 0 : 5000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));

      const services = await shell(`docker compose -f '${config.compose_file}' ps --services --status running`, appDir);
      const serviceList = services.stdout.trim().split("\n").filter(Boolean);

      for (const service of serviceList) {
        for (const port of [3000, 4000, 8080]) {
          const check = await shell(
            `docker compose -f '${config.compose_file}' exec -T ${service} ` +
            `node -e "fetch('http://localhost:${port}${healthPath}').then(r=>{if(r.ok)process.exit(0);else process.exit(1)}).catch(()=>process.exit(1))"`,
            appDir,
          );
          if (check.exitCode === 0) {
            return { stdout: `Health check passed: ${service}:${port}${healthPath} (attempt ${attempt + 1})`, stderr: "", exitCode: 0 };
          }
        }
      }
    }

    return { stdout: `Health check failed: no service responded on ${healthPath} after ${maxRetries} attempts`, stderr: "", exitCode: 1 };
  });
  steps.push(healthStep);

  return healthStep.status === "success";
}

async function rollbackIfEnabled(
  config: RelayConfig,
  appDir: string,
  commitSha: string,
  steps: DeployStep[],
): Promise<void> {
  if (!config.rollback) {
    steps.push({ name: "rollback", status: "skipped", output: "Rollback disabled in config", durationMs: 0 });
    return;
  }

  const checkoutStep = await runStep("rollback: git reset", () =>
    shell(`git reset --hard '${commitSha}'`, appDir),
  );
  steps.push(checkoutStep);
  if (checkoutStep.status === "failure") return;

  const rebuildStep = await runStep("rollback: compose build", () =>
    shell(`docker compose -f '${config.compose_file}' build`, appDir),
  );
  steps.push(rebuildStep);
  if (rebuildStep.status === "failure") return;

  const restartStep = await runStep("rollback: compose up", () =>
    shell(`docker compose -f '${config.compose_file}' up -d`, appDir),
  );
  steps.push(restartStep);
}

async function runStep(
  name: string,
  fn: () => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<DeployStep> {
  const start = Date.now();
  try {
    const r = await fn();
    return {
      name,
      status: r.exitCode === 0 ? "success" : "failure",
      output: (r.stdout + "\n" + r.stderr).trim(),
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      name,
      status: "failure",
      output: err.message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function getCurrentCommit(appDir: string): Promise<string> {
  const r = await shell("git rev-parse HEAD", appDir);
  return r.stdout.trim() || "unknown";
}

function result(
  success: boolean,
  commitBefore: string,
  commitAfter: string,
  steps: DeployStep[],
  start: number,
): DeployResult {
  return {
    success,
    durationMs: Date.now() - start,
    commitBefore,
    commitAfter,
    steps,
  };
}
