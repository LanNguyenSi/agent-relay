---
type: invariant
title: Exec trust boundary — runExec vs runShell, plus a residual not in docs/security.md
description: docker/git calls go through execFile-backed runExec everywhere; only .relay.yml's command/pre_update/post_update go through shell-backed runShell. docs/security.md documents that boundary but not a same-tier residual — config.health is string-interpolated into a node -e JS snippet run via docker compose exec (engine.ts), a different injection mechanism than runShell.
tags: [security, trust-boundary, exec, shell, health-check]
timestamp: 2026-09-01T06:41:00Z
sources:
  - src/deploy/exec.ts
  - src/deploy/engine.ts
  - src/config/relay.ts
  - docs/security.md
---

# Exec trust boundary — runExec vs runShell, plus a residual not in docs/security.md

`src/deploy/exec.ts` exposes two ways to run a subprocess (`exec.ts:43-93`), and which one a call site uses is the whole ballgame for shell-injection exposure:

- **`runExec(command, args, cwd, opts?)`** — `execFile` with a discrete argument array (`exec.ts:43-76`). Each element is passed to the OS as a literal argv entry; there is no shell to break out of. The optional `opts` (`ExecOptions`: `timeoutMs`, `maxBufferBytes`) overrides the exec-level timeout and per-stream buffer cap per call; it carries no bearing on the trust boundary below, since it only tunes how long the call may run and how much output it may buffer, not what gets executed.
- **`runShell(command, cwd, opts?)`** — `runExec("/bin/sh", ["-c", command], cwd, opts)` (`exec.ts:87-93`): the entire `command` string is handed to `/bin/sh -c`, so anything shell-metacharacter-shaped in it executes. The JSDoc states the trust boundary explicitly: only call this for `.relay.yml` fields under operator control (`pre_update`, `post_update`, `command`) — never for user-supplied or network-derived input.

## Where each is actually used

Every `docker` and `git` invocation in the deploy path goes through `runExec` with an arg array: `src/deploy/preflight.ts` (git status/ls-remote, docker compose ps/exec), `src/deploy/engine.ts` (git pull/reset/rev-parse, docker compose build/up/exec), `src/services/apps.ts` (git rev-parse, docker compose ps/logs). `src/config/relay.ts`'s header comment reiterates why: `compose_file` is passed as a literal `runExec` arg-array element in both `engine.ts` and `services/apps.ts`, so shell injection via `compose_file` is not possible regardless of its charset — the regex there is path hygiene and containment, not a shell-escape guard (`relay.ts:6-12`).

`runShell` has exactly three call sites, all `.relay.yml` fields, all commented with the same trust-boundary pointer (`// runShell: ... (trust boundary — see runShell JSDoc in exec.ts)`): `pre_update` commands (`engine.ts:156-157`), `post_update` commands (`engine.ts:260-261`), and the command-mode `command` field (`engine.ts:324-326`). Each of these three call sites now passes `stepExecOptions(config)` as the trailing `opts` argument (derived from `.relay.yml`'s optional `step_timeout_seconds`); that only tunes the exec-level timeout, not which fields are trusted. `docs/security.md` covers this split under "`.relay.yml` shell-exec trust boundary": the implicit trust boundary is push access to the deploy branch, since anyone who can land a `.relay.yml` edit already has arbitrary-shell RCE via these three fields.

## The residual `docs/security.md` does not mention: `config.health` interpolated into a `node -e` snippet

The inline health check in `engine.ts` (`runHealthCheck`, `engine.ts:384-460`) builds a JavaScript source string per port/service attempt:

```
const jsSnippet = `fetch('http://localhost:${port}${healthPath}').then(r=>{process.stdout.write('HTTP_STATUS='+r.status+'\n',()=>process.exit(r.ok?0:1))}).catch(e=>{process.stdout.write('PROBE_ERROR='+(e&&e.message?e.message:String(e))+'\n',()=>process.exit(1))})`;
```

and runs it via `runExec("docker", ["compose", "-f", config.compose_file, "exec", "-T", service, "node", "-e", jsSnippet], appDir)` (`engine.ts:428-432`). This goes through `runExec`, not `runShell` — there is no `/bin/sh -c` here, so this is not the same mechanism as the three `runShell` call sites above. But `healthPath` (`config.health`, from `.relay.yml`) is string-interpolated directly into a JS string literal with no escaping: a `health` value containing `'); require('child_process')...; //` breaks out of the JS string and runs as code inside the `node -e` process, executed inside the target service's container via `docker compose exec`. The code comment at the site names this explicitly: "Trust boundary: healthPath (config.health) is operator-controlled and interpolated here — pre-existing residual, not a regression introduced by the runExec migration" (`engine.ts:420`).

This is the **same trust tier** as the three `runShell` fields — the same actor (whoever has push access to `.relay.yml`) is already trusted with equivalent RCE via `command`/`pre_update`/`post_update` — but a **different mechanism**: JS-string-literal injection into `node -e`, not shell-metacharacter injection via `/bin/sh -c`. `docs/security.md`'s "`.relay.yml` shell-exec trust boundary" section enumerates `command`, `pre_update`, and `post_update` as the fields that "execute as arbitrary shell"; it does not mention `health`, which reaches arbitrary *code* execution through a different code path. Since the trust tier is identical (operator-with-push-access, already has RCE through the three documented fields), this is not a new privilege escalation — but it is an undocumented additional avenue for the same actor, and a fix (e.g. passing `healthPath` as an env var read inside the snippet rather than interpolating it into the JS source) has not been made.
