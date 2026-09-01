import { loadRelayConfig, RelayConfigError, type RelayConfig } from "../config/relay.js";
import { runPreflightChecks, ROLLBACK_CRITICAL_CHECKS, type PreflightReport } from "./preflight.js";
import { runExec, runShell, type ExecOptions } from "./exec.js";

// The MB figure named in a step's maxbuffer-kill annotation (see runStep
// below). No `.relay.yml` field overrides the buffer cap today, so this
// mirrors exec.ts's DEFAULT_MAX_BUFFER_BYTES (64 * 1024 * 1024) expressed in
// MB rather than bytes. Kept as a literal rather than an import so mocking
// "./exec.js" in a test (vi.mock replaces the whole module) doesn't also
// have to stub this constant.
const MAX_BUFFER_MB = 64;

/**
 * Builds the ExecOptions for a long-running deploy step (git pull, compose
 * build/up, pre_update/post_update/command hooks) from the operator's
 * `.relay.yml`. `step_timeout_seconds` overrides exec.ts's own default step
 * timeout; when the field is absent, exec.ts's default (300s) applies
 * unchanged.
 */
export function stepExecOptions(config: RelayConfig): ExecOptions {
  return config.step_timeout_seconds
    ? { timeoutMs: config.step_timeout_seconds * 1000 }
    : {};
}

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
   * param — the critical ones (`compose_file_exists`, `health_defined`,
   * `apps_root_mount_congruence`, `compose_bind_mount_sources_exist`)
   * still gate: the first two because a deploy with those failing cannot
   * succeed, the latter two because letting them through silently masks
   * a deployed app's on-host config with an empty directory (2026-07-15
   * incident class) rather than merely failing the deploy.
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
    const branchResult = await runExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], appDir);
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

  // Pre-pull preflight: dirty-tree + reachable-remote checks, plus the
  // apps-root mount congruence probe (also placed pre-pull because it
  // has signal about the host/relay APPS_DIR view, not about the app's
  // tree). If any of these trip, the deploy is blocked before any
  // working-tree mutation happens — `git pull` doesn't run, pre_update
  // doesn't fire, the operator's WIP stays intact.
  //
  // Force semantics: the dirty-tree and reachable-remote checks are
  // non-critical, and runPreflightChecks gates only on critical checks
  // when force=true, so `--force` bypasses those two — by design: "I
  // know what I'm doing, clobber my WIP" is exactly when an operator
  // reaches for force. apps_root_mount_congruence is critical and is NOT
  // bypassed by force: an undetected APPS_DIR mismatch silently masks a
  // deployed app's config with an empty directory regardless of whether
  // the operator meant to force past the git checks (2026-07-15 incident
  // class).
  const prePullPreflightStart = Date.now();
  const prePullPreflight = await runPreflightChecks({
    appDir,
    config: prePullConfig,
    force: options.force,
    phase: "pre-pull",
  });
  const prePullPreflightStep: DeployStep = {
    name: "preflight (pre-pull)",
    status: prePullPreflight.passed ? "success" : "failure",
    output: prePullPreflight.checks
      .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.message}`)
      .join("\n"),
    durationMs: Date.now() - prePullPreflightStart,
  };
  emit(prePullPreflightStep);
  if (!prePullPreflight.passed) {
    // Tree was not pulled, so commitAfter == commitBefore by definition.
    // The post-pull blocked branch below re-fetches the commit because
    // the tree DOES move there before we abort.
    return {
      success: false,
      blocked: true,
      preflight: prePullPreflight,
      durationMs: Date.now() - start,
      commitBefore,
      commitAfter: commitBefore,
      steps,
    };
  }

  // Pre-update commands run against the PRE-pull working tree, so the
  // pre-pull config is the right source of truth for them.
  // runShell: pre_update values are operator-supplied shell commands in .relay.yml
  // (trust boundary — see runShell JSDoc in exec.ts).
  for (const cmd of prePullConfig.pre_update) {
    const step = await runStep(`pre_update: ${cmd}`, () => runShell(cmd, appDir, stepExecOptions(prePullConfig)));
    emit(step);
    if (step.status === "failure") {
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Git pull
  const pullStep = await runStep("git pull", () =>
    runExec("git", ["pull", "origin", branch], appDir, stepExecOptions(prePullConfig)),
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
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps, onStep);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }
  // Safe: reload step above already validated.
  const config = await loadRelayConfig(appDir);

  // Post-pull preflight against the new on-disk state + new config.
  // Pre-PR #64 this ran in `services/apps.ts` before pull, so a commit
  // that *fixed* a broken `.relay.yml` would fail preflight against the
  // still-broken pre-pull copy on disk — the merged fix never got a
  // chance to apply. Post-pull preflight means "is the new state safe to
  // deploy?" — which is what operators actually want. No rollback on
  // failure: the tree is at the new commit but nothing else has changed;
  // the running containers are still on the old image. Phase is
  // "post-pull" because the git checks already ran (and passed) above —
  // re-running them here would just duplicate signal.
  const preflightStart = Date.now();
  const preflight = await runPreflightChecks({
    appDir,
    config,
    force: options.force,
    phase: "post-pull",
  });
  const preflightStep: DeployStep = {
    name: "preflight (post-pull)",
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
    runExec("docker", ["compose", "-f", config.compose_file, "build"], appDir, stepExecOptions(config)),
  );
  emit(buildStep);
  if (buildStep.status === "failure") {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps, onStep);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Docker compose up
  const upStep = await runStep("compose up", () =>
    runExec("docker", ["compose", "-f", config.compose_file, "up", "-d"], appDir, stepExecOptions(config)),
  );
  emit(upStep);
  if (upStep.status === "failure") {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps, onStep);
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // Post-update commands
  // runShell: post_update values are operator-supplied shell commands in .relay.yml
  // (trust boundary — see runShell JSDoc in exec.ts).
  for (const cmd of config.post_update) {
    const step = await runStep(`post_update: ${cmd}`, () => runShell(cmd, appDir, stepExecOptions(config)));
    emit(step);
    if (step.status === "failure") {
      await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps, onStep);
      return result(false, commitBefore, commitBefore, steps, start);
    }
  }

  // Health check uses the post-pull config (new health path / port).
  const healthOk = await runHealthCheck({ ...options, config }, steps);
  if (steps.length > 0) onStep?.(steps[steps.length - 1]); // emit health check step
  if (!healthOk) {
    await rollbackIfEnabled(prePullConfig, appDir, commitBefore, steps, onStep);
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
  const { appDir, config: preCommandConfig, onStep } = options;

  // Preflight in command mode runs pre-command. The command is opaque
  // — it may or may not pull — so there's no natural post-pull
  // checkpoint to gate on. This matches the behavior before PR #64 and
  // keeps command-mode deploys' first-run semantics unchanged. For the
  // common command-mode use case (`git pull && docker compose build
  // …`), this does mean preflight sees the pre-pull config; operators
  // who edit .relay.yml in command mode should expect one stale
  // preflight before the next deploy picks up the new config.
  const preflightStart = Date.now();
  const preflight = await runPreflightChecks({ appDir, config: preCommandConfig, force: options.force });
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

  // runShell: command is an operator-supplied shell command in .relay.yml
  // (trust boundary — see runShell JSDoc in exec.ts).
  const cmdStep = await runStep(`command: ${preCommandConfig.command}`, () =>
    runShell(preCommandConfig.command!, appDir, stepExecOptions(preCommandConfig)),
  );
  steps.push(cmdStep);
  onStep?.(cmdStep);
  if (cmdStep.status === "failure") {
    return result(false, commitBefore, commitBefore, steps, start);
  }

  // The custom command is opaque — it may have run `git pull` and the
  // pulled commit may have edited `.relay.yml`. Mirror the default-flow
  // reload so subsequent health and rollback steps see post-command
  // values (`health`, `health_port`, `rollback`, `compose_file`). If
  // the command did not touch `.relay.yml` this is a cheap idempotent
  // re-read. If it broke the config we fail loudly and roll back with
  // the pre-command config — the tree may already be at a new commit.
  const reloadStep = await runStep("reload .relay.yml", async () => {
    try {
      await loadRelayConfig(appDir);
      return { stdout: "Re-read .relay.yml after custom command", stderr: "", exitCode: 0 };
    } catch (err) {
      const msg = err instanceof RelayConfigError ? err.message : String(err);
      return { stdout: "", stderr: msg, exitCode: 1 };
    }
  });
  steps.push(reloadStep);
  onStep?.(reloadStep);
  if (reloadStep.status === "failure") {
    await rollbackIfEnabled(preCommandConfig, appDir, commitBefore, steps, onStep);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }
  // Safe: reload step above already validated.
  const config = await loadRelayConfig(appDir);

  const healthOk = await runHealthCheck({ ...options, config }, steps);
  if (steps.length > 0) onStep?.(steps[steps.length - 1]!); // emit health check step
  if (!healthOk) {
    await rollbackIfEnabled(preCommandConfig, appDir, commitBefore, steps, onStep);
    const commitAfter = await getCurrentCommit(appDir);
    return result(false, commitBefore, commitAfter, steps, start);
  }

  const commitAfter = await getCurrentCommit(appDir);
  return result(true, commitBefore, commitAfter, steps, start);
}

// Cap on the docker-logs excerpt appended to a failed health-check step's
// output — keeps the deploy record's step log bounded even for a chatty
// container, while still giving an operator the tail they'd otherwise have
// to SSH in and fetch by hand.
const HEALTH_FAILURE_LOG_TAIL_LINES = 50;
const HEALTH_FAILURE_LOG_MAX_CHARS = 4000;

// Symmetric cap on the last probe's own detail (HTTP status / fetch error
// text) — much smaller than the container-log cap since this is a single
// probe result, not a log tail, but still bounded rather than trusting
// whatever the in-container fetch call happened to print.
const PROBE_DETAIL_MAX_CHARS = 300;

async function runHealthCheck(
  options: DeployOptions,
  steps: DeployStep[],
): Promise<boolean> {
  const { appDir, config } = options;
  const healthPath = config.health;

  // Last probe's own result (HTTP status or the fetch error text), kept
  // across retries so a final failure can report what the LAST attempt
  // actually saw instead of just "no service responded" — that bare
  // message carries no diagnostic signal (Task 1f6895f6 / the 2026-08-18
  // project-forge incident, deploy 8ab63a36, where the health-check step
  // output was empty and debugging had to fall back to manual SSH).
  let lastProbeService = "";
  let lastProbeDetail = "";
  let lastKnownServices: string[] = [];

  // Try each running service with node fetch, with retries for startup time
  const healthStep = await runStep("health check", async () => {
    const maxRetries = 5;
    const delayMs = process.env.NODE_ENV === "test" ? 0 : 5000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));

      const services = await runExec(
        "docker",
        ["compose", "-f", config.compose_file, "ps", "--services", "--status", "running"],
        appDir,
      );
      const serviceList = services.stdout.trim().split("\n").filter(Boolean);
      if (serviceList.length > 0) lastKnownServices = serviceList;

      for (const service of serviceList) {
        const ports = config.health_port ? [config.health_port] : [3000, 3001, 4000, 5000, 8000, 8080];
        for (const port of ports) {
          // Trust boundary: healthPath (config.health) is operator-controlled and interpolated here — pre-existing residual, not a regression introduced by the runExec migration.
          // stdout is explicitly flushed (write's callback) before process.exit():
          // console.log()+process.exit() can truncate output when stdout is a
          // pipe, since exit() doesn't wait for the write to drain. Defensive
          // hardening for the probe output this file now depends on for
          // diagnostics — not confirmed as the 2026-08-18 incident's own
          // root cause.
          const jsSnippet = `fetch('http://localhost:${port}${healthPath}').then(r=>{process.stdout.write('HTTP_STATUS='+r.status+'\\n',()=>process.exit(r.ok?0:1))}).catch(e=>{process.stdout.write('PROBE_ERROR='+(e&&e.message?e.message:String(e))+'\\n',()=>process.exit(1))})`;
          const check = await runExec(
            "docker",
            ["compose", "-f", config.compose_file, "exec", "-T", service, "node", "-e", jsSnippet],
            appDir,
          );
          lastProbeService = `${service}:${port}${healthPath}`;
          lastProbeDetail = ((check.stdout + " " + check.stderr).trim() || `exit code ${check.exitCode}`).slice(
            0,
            PROBE_DETAIL_MAX_CHARS,
          );
          if (check.exitCode === 0) {
            return { stdout: `Health check passed: ${service}:${port}${healthPath} (attempt ${attempt + 1})`, stderr: "", exitCode: 0 };
          }
        }
      }
    }

    const probeDetail = lastProbeDetail
      ? ` — last probe (${lastProbeService}): ${lastProbeDetail}`
      : " — no running service was reachable to probe";
    const containerLogs = await captureContainerLogsTail(appDir, config.compose_file, lastKnownServices);
    return {
      stdout:
        `Health check failed: no service responded on ${healthPath} after ${maxRetries} attempts${probeDetail}\n\n` +
        containerLogs,
      stderr: "",
      exitCode: 1,
    };
  });
  steps.push(healthStep);

  return healthStep.status === "success";
}

/**
 * Captures a capped `docker compose logs --tail` excerpt of the app's
 * container(s) for inclusion in a failed health-check step's output, so the
 * deploy record itself carries what the relay already knows instead of
 * requiring a manual SSH + `docker logs` round-trip to debug a failure
 * (Task 1f6895f6).
 */
async function captureContainerLogsTail(
  appDir: string,
  composeFile: string,
  services: string[],
): Promise<string> {
  if (services.length === 0) {
    return "Container logs: no running services were found to inspect";
  }
  // No try/catch here: runExec (exec.ts) resolves the promise it returns
  // unconditionally — a failed child process comes back as a non-zero
  // exitCode, never a rejection — so there was nothing for a catch to ever
  // observe. A prior version of this function caught and reported a
  // "failed to fetch" case that no test could reach and no code path could
  // trigger.
  const logs = await runExec(
    "docker",
    ["compose", "-f", composeFile, "logs", "--tail", String(HEALTH_FAILURE_LOG_TAIL_LINES), ...services],
    appDir,
  );
  const combined = (logs.stdout + "\n" + logs.stderr).trim();
  const capped =
    combined.length > HEALTH_FAILURE_LOG_MAX_CHARS
      ? `...[truncated]...\n${combined.slice(-HEALTH_FAILURE_LOG_MAX_CHARS)}`
      : combined;
  return `Container logs (last ${HEALTH_FAILURE_LOG_TAIL_LINES} lines, ${services.join(", ")}):\n${capped || "(empty)"}`;
}

/**
 * Gates the auto-rollback build/up on the same critical preflight checks
 * that gate a forward deploy (Task d5e0aad9 / 2026-07-15 incident):
 * `apps_root_mount_congruence` and `compose_bind_mount_sources_exist` exist
 * specifically to catch the DooD host/relay APPS_DIR mismatch that makes
 * docker silently auto-create an empty bind-mount directory over a deployed
 * app's real config. That failure mode doesn't care whether the working
 * tree just moved via `git pull` (forward deploy) or `git reset --hard`
 * (rollback, right above) — the incident class is identical either way, so
 * rollback must not run `compose build`/`up` ungated just because it's the
 * safety-net path rather than the forward path.
 *
 * `only: ROLLBACK_CRITICAL_CHECKS` restricts the battery to exactly
 * `apps_root_mount_congruence` (bucketed "pre-pull" in preflight.ts, but it
 * only probes the host/relay APPS_DIR view — nothing about `git pull`) and
 * `compose_bind_mount_sources_exist` ("post-pull", validated against the
 * tree `git reset --hard` just moved to, same as a forward deploy validates
 * against the tree `git pull` just moved to). `phase: "all"` stays explicit
 * so both checks' phase buckets are visited before `only` narrows within
 * them.
 *
 * Unlike `force` alone (which still RUNS every check and only changes how
 * `passed` is computed), `only` means the other 6 checks are never even
 * started: `git_clean` and `git_remote_reachable` exist to protect a `git
 * pull`, which rollback never runs — it resets hard to a commit already on
 * disk, so a dirty tree or an unreachable remote have no bearing on whether
 * the rollback can proceed. `containers_running`, `traefik_labels`,
 * `compose_file_exists`, and `health_defined` are the remaining non-gating
 * or already-covered signal. This is the auto-rollback path taken when a
 * forward deploy's health check just failed — an emergency restore of the
 * last-known-good containers has no business waiting on `git ls-remote` /
 * `docker compose ps` calls (each bounded by exec.ts's 300s timeout) for
 * checks that don't gate it anyway. `force: true` is kept alongside `only`
 * for defense in depth: both remaining checks are critical, so it's
 * currently a no-op on the `passed` computation, but it keeps the intent
 * ("only critical checks gate here") explicit even if a future check name
 * were added to `ROLLBACK_CRITICAL_CHECKS` without being critical.
 */
async function rollbackIfEnabled(
  config: RelayConfig,
  appDir: string,
  commitSha: string,
  steps: DeployStep[],
  onStep?: (step: DeployStep) => void,
): Promise<void> {
  // Rollback steps used to only land in `steps` (visible in the final
  // DeployResult) without also firing `onStep`. That left the SSE stream
  // silent for the whole rollback duration (git reset + preflight + compose
  // build/up can take a while), and a stream that goes quiet for too long
  // risks a proxy/idle-timeout dropping the connection before the trailing
  // `done` event ships — which is exactly how a caller can end up with a
  // deploy record that never learned it rolled back (Task 1f6895f6 / the
  // 2026-08-18 project-forge incident, deploy 8ab63a36). Emitting here too
  // means a listener building its own step log from the stream (rather than
  // waiting for the final result) already has the rollback steps even if
  // the connection dies before `done`.
  function emit(step: DeployStep) {
    steps.push(step);
    onStep?.(step);
  }

  if (!config.rollback) {
    emit({ name: "rollback", status: "skipped", output: "Rollback disabled in config", durationMs: 0 });
    return;
  }

  const checkoutStep = await runStep("rollback: git reset", () =>
    runExec("git", ["reset", "--hard", commitSha], appDir),
  );
  emit(checkoutStep);
  if (checkoutStep.status === "failure") return;

  const preflightStart = Date.now();
  const preflight = await runPreflightChecks({
    appDir,
    config,
    phase: "all",
    force: true,
    only: ROLLBACK_CRITICAL_CHECKS,
  });
  const checksOutput = preflight.checks
    .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.message}`)
    .join("\n");
  const preflightStep: DeployStep = {
    name: "rollback: preflight",
    status: preflight.passed ? "success" : "failure",
    output: preflight.passed
      ? checksOutput
      : `ROLLBACK BLOCKED (not a deploy failure) — a critical preflight check ` +
        `rejected the rollback before compose build/up ran; the working tree ` +
        `was already reset to ${commitSha} but the running containers are ` +
        `unchanged:\n${checksOutput}`,
    durationMs: Date.now() - preflightStart,
  };
  emit(preflightStep);
  if (!preflight.passed) return;

  const rebuildStep = await runStep("rollback: compose build", () =>
    runExec("docker", ["compose", "-f", config.compose_file, "build"], appDir, stepExecOptions(config)),
  );
  emit(rebuildStep);
  if (rebuildStep.status === "failure") return;

  const restartStep = await runStep("rollback: compose up", () =>
    runExec("docker", ["compose", "-f", config.compose_file, "up", "-d"], appDir, stepExecOptions(config)),
  );
  emit(restartStep);
}

async function runStep(
  name: string,
  fn: () => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timeoutMs?: number;
    killReason?: "timeout" | "maxbuffer";
  }>,
): Promise<DeployStep> {
  const start = Date.now();
  try {
    const r = await fn();
    let output = (r.stdout + "\n" + r.stderr).trim();
    if (r.killReason === "timeout") {
      const seconds = Math.round((r.timeoutMs ?? 0) / 1000);
      output += `\n[relay] step timed out after ${seconds} s (raise step_timeout_seconds in .relay.yml)`;
    } else if (r.killReason === "maxbuffer") {
      output += `\n[relay] step output exceeded the ${MAX_BUFFER_MB} MB buffer and the process was killed`;
    }
    return {
      name,
      status: r.exitCode === 0 ? "success" : "failure",
      output,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      status: "failure",
      output: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

async function getCurrentCommit(appDir: string): Promise<string> {
  const r = await runExec("git", ["rev-parse", "HEAD"], appDir);
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
