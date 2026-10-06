import { runExec } from "../deploy/exec.js";

/**
 * Per-app upstream info: is the deployed checkout still at the head of the
 * branch a deploy would pull? Read-only against the checkout: only
 * `git rev-parse` and `git ls-remote` run, never fetch or pull.
 */
export type UpstreamState = "current" | "behind" | "unknown";

export interface UpstreamInfo {
  /** The branch a deploy pulls (the checkout's current branch), or null. */
  branch: string | null;
  /** Full sha of the app checkout's HEAD, or null. */
  deployedCommit: string | null;
  /** Full sha of `origin/<branch>` as reported by `git ls-remote`, or null. */
  remoteHead: string | null;
  /** ISO-8601 UTC time `remoteHead` was obtained, or null. */
  checkedAt: string | null;
  state: UpstreamState;
  /** Present only when `state` is "unknown". */
  reason?: string;
}

/** Tunables, exported as a mutable object so tests can shrink the waits. */
export const upstreamTuning = {
  /** How long a ls-remote outcome (success or failure) is reused per app+branch. */
  cacheTtlMs: 60_000,
  /** Hard bound on one `git ls-remote` call. */
  lsRemoteTimeoutMs: 5_000,
  /** Hard bound on the local `git rev-parse` calls. */
  localGitTimeoutMs: 5_000,
  /** Max concurrent ls-remote calls across apps. */
  maxConcurrentLsRemote: 4,
  /** Max time a list request waits for upstream info before reporting "pending". */
  listBudgetMs: 6_000,
};

const BRANCH_NAME = /^[a-zA-Z0-9._/-]+$/;
const SHA = /^[0-9a-f]{40}$/;

interface RemoteOutcome {
  remoteHead: string | null;
  checkedAt: string | null;
  reason?: string;
  expiresAt: number;
}

const cache = new Map<string, RemoteOutcome>();
const inflight = new Map<string, Promise<RemoteOutcome>>();

/** Test hook: drop all cached outcomes. */
export function clearUpstreamCache(): void {
  cache.clear();
  inflight.clear();
  active = 0;
  waiters.length = 0;
}

let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= upstreamTuning.maxConcurrentLsRemote) {
    await new Promise<void>((res) => waiters.push(res));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function lsRemote(appDir: string, branch: string): Promise<RemoteOutcome> {
  const ref = `refs/heads/${branch}`;
  const res = await withSlot(() =>
    runExec("git", ["ls-remote", "origin", ref], appDir, { timeoutMs: upstreamTuning.lsRemoteTimeoutMs }),
  );
  const expiresAt = Date.now() + upstreamTuning.cacheTtlMs;
  if (res.killReason === "timeout") {
    return { remoteHead: null, checkedAt: null, reason: `git ls-remote timed out after ${upstreamTuning.lsRemoteTimeoutMs} ms`, expiresAt };
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim().split("\n")[0]?.slice(0, 200);
    return { remoteHead: null, checkedAt: null, reason: `git ls-remote failed (exit ${res.exitCode})${detail ? `: ${detail}` : ""}`, expiresAt };
  }
  for (const line of res.stdout.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) {
      return { remoteHead: sha, checkedAt: new Date().toISOString(), expiresAt };
    }
  }
  return { remoteHead: null, checkedAt: null, reason: `branch '${branch}' not found on remote origin`, expiresAt };
}

function remoteFor(appDir: string, branch: string): Promise<RemoteOutcome> {
  const key = `${appDir}\0${branch}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = lsRemote(appDir, branch)
    .then((o) => {
      cache.set(key, o);
      return o;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function unknown(
  partial: Pick<UpstreamInfo, "branch" | "deployedCommit"> & Partial<Pick<UpstreamInfo, "remoteHead" | "checkedAt">>,
  reason: string,
): UpstreamInfo {
  return { remoteHead: null, checkedAt: null, ...partial, state: "unknown", reason };
}

/** Upstream info for one app checkout. Never throws. */
export async function getUpstream(appDir: string): Promise<UpstreamInfo> {
  try {
    const local = { timeoutMs: upstreamTuning.localGitTimeoutMs };
    // The deploy engine pulls the checkout's current branch (`rev-parse
    // --abbrev-ref HEAD`, falling back to "main" on empty output).
    const b = await runExec("git", ["rev-parse", "--abbrev-ref", "HEAD"], appDir, local);
    const branchRaw = b.exitCode === 0 ? b.stdout.trim() || "main" : "";
    const d = await runExec("git", ["rev-parse", "HEAD"], appDir, local);
    const deployedRaw = d.exitCode === 0 ? d.stdout.trim() : "";
    const deployedCommit = SHA.test(deployedRaw) ? deployedRaw : null;

    if (!branchRaw) return unknown({ branch: null, deployedCommit }, "could not determine the checkout branch");
    if (branchRaw === "HEAD") return unknown({ branch: null, deployedCommit }, "checkout is on a detached HEAD, no branch to compare");
    if (!BRANCH_NAME.test(branchRaw)) return unknown({ branch: null, deployedCommit }, "checkout branch name is not a valid branch name");
    const branch = branchRaw;
    if (!deployedCommit) return unknown({ branch, deployedCommit }, "could not determine the deployed commit");

    const remote = await remoteFor(appDir, branch);
    if (!remote.remoteHead) return unknown({ branch, deployedCommit }, remote.reason ?? "remote head unavailable");
    return {
      branch,
      deployedCommit,
      remoteHead: remote.remoteHead,
      checkedAt: remote.checkedAt,
      state: remote.remoteHead === deployedCommit ? "current" : "behind",
    };
  } catch (err) {
    return unknown({ branch: null, deployedCommit: null }, `upstream check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Like getUpstream, but gives up waiting after `listBudgetMs` and reports
 * "unknown" (check pending). The underlying ls-remote keeps running and fills
 * the cache, so the next request is fast. Keeps the app list latency bounded
 * regardless of remote latency or app count.
 */
export async function getUpstreamWithin(appDir: string): Promise<UpstreamInfo> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<UpstreamInfo>((res) => {
    timer = setTimeout(
      () => res(unknown({ branch: null, deployedCommit: null }, "upstream check still pending, retry shortly")),
      upstreamTuning.listBudgetMs,
    );
  });
  try {
    return await Promise.race([getUpstream(appDir), budget]);
  } finally {
    clearTimeout(timer);
  }
}
