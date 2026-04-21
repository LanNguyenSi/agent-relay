import { loadRelayConfig, RelayConfigError, type RelayConfig } from "../config/relay.js";
import { runPreflightChecks, type PreflightReport } from "./preflight.js";
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

/**
 * Returned when preflight rejects the deploy. Distinct shape from a
 * regular DeployResult because the HTTP / MCP surface emits a dedicated
 * `blocked` event for this case so dashboards can show a preflight UI
 * instead of a generic "deploy failed" banner.
 */
export interface DeployBlockedResult {
  success: false;
  blocked: true;
  preflight: PreflightReport;
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
  onStep?: (step: DeployStep) => void;
  /**
   * Skip non-critical preflight checks. Mirrors the API's `force` query
   * param — the critical ones (`compose_file_exists`, `health_defined`)
   * still gate because a deploy with those failing cannot succeed.
   */
  force?: boolean;
}

export async function deploy(
  options: DeployOptions,
): Promise<DeployResult | DeployBlockedResult> {
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
): Promise<DeployResult | DeployBlockedResult> {
  const { appDir, config: prePullConfig, onStep } = options;

  function emit(step: DeployStep) {
    steps.push(step);
    onStep?.(step);
  }

  // Pre-update commands run against the PRE-pull working tree, so the
  // pre-pull config is the right source of truth for them.
  for (const cmd of prePullConfig.pre_update) {
    const step = await runStep(`pre_update: ${cmd}`, () => shell(cmd, appDir));
    emit(step);
    if (step.status === "failure") {
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Git pull
  const pullStep = await runStep("git pull", () =>
    shell(`git pull origin '${branch}'`, appDir),
  );
  emit(pullStep);
  if (pullStep.status === "failure") {
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Re-load .relay.yml against the freshly-pulled tree. Anything below
  // describes the NEW desired state (compose_file, post_update, health,
  // health_port, rollback) and must see the post-pull values. Without
  // this reload, a config edit shipped in the same commit as the code
  // change it supports does not take effect until the NEXT deploy. If
  // the new config is invalid, fail loudly and roll back — the tree is
  // already at the new commit so the broken config is live.
  const reloadStep = await runStep("reload .relay.yml", async () => {
    try {
      await loadRelayConfig(appDir);
      return { stdout: "Re-read .relay.yml at new commit", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof RelayConfigError ? err.message : String(err);
      return { stdout: "", stderr: msg, exitCode: 1 };
    }
  });
  emit(reloadStep);
  if (reloadStep.status === "failure") {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }
  // Safe: reload step above already validated.
  const config = await loadRelayConfig(appDir);

  // Preflight against the POST-pull config. Pre-PR #64 this ran in
  // `services/apps.ts` before pull, so a commit that *fixed* a broken
  // `.relay.yml` would fail preflight against the still-broken pre-pull
  // copy on disk — the merged fix never got a chance to apply. Post-pull
  // preflight means "is the new state safe to deploy?" — which is what
  // operators actually want. No rollback on failure: the tree is at the
  // new commit but nothing else has changed; the running containers are
  // still on the old image.
  const preflightStart = Date.now();
  const preflight = await runPreflightChecks({ appDir, config, force: options.force });
  const preflightStep: DeployStep = {
    name: "preflight",
    status: preflight.passed ? "success" : "failure",
    output: preflight.checks
      .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.message}`)
      .join("\n"),
    durationMs: Date.now() - preflightStart,
  };
  emit(preflightStep);
  if (!preflight.passed) {
    const commitAfter = await getCurrentCommit(appDir);
    return {
      success: false,
      blocked: true,
      preflight,
      durationMs: Date.now() - start,
      commitBefore,
      commitAfter,
      steps,
    };
  }

  // Docker compose build
  const buildStep = await runStep("compose build", () =>
    shell(`docker compose -f '${config.compose_file}' build`, appDir),
  );
  emit(buildStep);
  if (buildStep.status === "failure") {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Docker compose up
  const upStep = await runStep("compose up", () =>
    shell(`docker compose -f '${config.compose_file}' up -d`, appDir),
  );
  emit(upStep);
  if (upStep.status === "failure") {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Post-update commands
  for (const cmd of config.post_update) {
    const step = await runStep(`post_update: ${cmd}`, () => shell(cmd, appDir));
    emit(step);
    if (step.status === "failure") {
      await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps);
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Health check uses the post-pull config (new health path / port).
  const healthOk = await runHealthCheck({ ...options, config }, steps);
  if (steps.length > 0) onStep?.(steps[steps.length - 1]); // emit health check step
  if (!healthOk) {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps);
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
): Promise<DeployResult | DeployBlockedResult> {
  const { appDir, config, onStep } = options;

  // Preflight in command mode runs pre-command. The command is opaque
  // — it may or may not pull — so there's no natural post-pull
  // checkpoint to gate on. This matches the behavior before PR #64 and
  // keeps command-mode deploys' first-run semantics unchanged. For the
  // common command-mode use case (`git pull && docker compose build
  // …`), this does mean preflight sees the pre-pull config; operators
  // who edit .relay.yml in command mode should expect one stale
  // preflight before the next deploy picks up the new config.
  const preflightStart = Date.now();
  const preflight = await runPreflightChecks({ appDir, config, force: options.force });
  const preflightStep: DeployStep = {
    name: "preflight",
    status: preflight.passed ? "success" : "failure",
    output: preflight.checks
      .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.message}`)
      .join("\n"),
    durationMs: Date.now() - preflightStart,
  };
  steps.push(preflightStep);
  onStep?.(preflightStep);
  if (!preflight.passed) {
    return {
      success: false,
      blocked: true,
      preflight,
      durationMs: Date.now() - start,
      commitBefore,
      commitAfter: commitBefore,
      steps,
    };
  }

  const cmdStep = await runStep(`command: ${config.command}`, () =>
    shell(config.command!, appDir),
  );
  steps.push(cmdStep);
  onStep?.(cmdStep);
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
        const ports = config.health_port ? [config.health_port] : [3000, 3001, 4000, 5000, 8000, 8080];
        for (const port of ports) {
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
