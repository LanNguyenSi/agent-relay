---
type: module
title: Health check reality — the wired inline check vs the dead exponential-backoff module
description: src/deploy/health.ts's checkHealth (exponential backoff, direct HTTP, fully tested) is imported only by its own test — dead code from the deploy path's perspective. The deploy path actually runs engine.ts's inline runHealthCheck (fixed 5 retries / 5000ms delay, docker compose exec + node -e fetch inside each service container, hardcoded ports unless health_port is set). README.md's "exponential backoff" description matches the dead code, not the wired one — flagged as a maintainer decision, not fixed here.
tags: [health-check, dead-code, docs-drift, deploy]
timestamp: 2026-07-16T05:52:00Z
sources:
  - src/deploy/health.ts
  - src/deploy/engine.ts
  - src/deploy/health.test.ts
  - README.md
---

# Health check reality — the wired inline check vs the dead exponential-backoff module

There are two independent, structurally different health-check implementations in this repo. Only one of them ever runs during a deploy.

## `src/deploy/health.ts` — fully tested, imported by nothing but its own test

`checkHealth({ url, retries = 5, initialDelayMs = 2000, maxDelayMs = 15000 })` (`health.ts:8-26`) does a direct `fetch(url)` with exponential backoff between attempts (`initialDelayMs * 2 ** (attempt - 1)`, capped at `maxDelayMs`) and a 5-second per-attempt timeout via `AbortSignal.timeout`. `src/deploy/health.test.ts` covers it thoroughly (177 lines: backoff math, max-delay cap, the `retries + 1` loop bound, network-error swallowing, per its own header comment). Grepping every import of `checkHealth` or `deploy/health` across `src/` turns up exactly two files: `health.ts` itself and `health.test.ts`. **No deploy-path code imports it.** From the deploy engine's perspective this module is dead code — well-tested dead code, but dead.

## `engine.ts`'s inline `runHealthCheck` — what actually gates every deploy

`runHealthCheck` (`engine.ts:356-400`) is called from both `defaultFlowDeploy` (`:255`) and `customCommandDeploy` (`:344`) — this is the only health check that ever runs during a real deploy. Its shape is entirely different from `checkHealth`:

- **Fixed retry count and delay, not exponential backoff**: `maxRetries = 5` (`:365`), flat `delayMs = 5000` between every attempt (`:366`, `0` under `NODE_ENV=test`) — no growing interval, no cap-on-growth logic at all.
- **No direct HTTP fetch from the relay process.** For each attempt, it lists the compose project's running services (`docker compose -f <compose_file> ps --services --status running`, `:371-375`), then for each service tries each candidate port — `config.health_port` if set, otherwise the hardcoded list `[3000, 3001, 4000, 5000, 8000, 8080]` (`:379`) — by running `docker compose exec -T <service> node -e <jsSnippet>` (`:383-387`), where `jsSnippet` does the actual `fetch('http://localhost:<port><healthPath>')` **from inside the service's own container**, not from the relay. First `exitCode === 0` wins (`:388-389`); after exhausting every service/port combination `maxRetries` times, it reports failure (`:395`).

The two implementations don't just differ in retry shape — they check health from different network vantage points (relay process vs. inside each candidate container) and differ in port-selection strategy (single URL vs. a fixed port list swept per running service).

## `README.md`'s description matches the dead code, not the wired one

`README.md:76` describes the deploy lifecycle's health-check step as: "HTTP probe against the configured `health` path with **exponential backoff retries**." That phrase — direct HTTP probe, exponential backoff — is an accurate description of `checkHealth` in `health.ts`. It does not describe what actually runs: `runHealthCheck` in `engine.ts` is fixed-interval, not exponential, and execs into containers rather than probing directly. Whether `README.md` was written to describe an earlier version of the wired check that has since diverged, or was always describing the module that never got wired in, was not determined from history available while writing this doc.

## This is presented as a discrepancy needing a maintainer decision, not resolved here

Per this task's scope, neither `README.md` nor any source file was edited to close this gap. Three ways it could be closed, left to a maintainer:

1. Delete `health.ts` (and its test) as genuinely dead code, and correct `README.md` to describe `runHealthCheck`'s actual fixed-retry, exec-into-container behavior.
2. Wire `checkHealth` into the deploy path in place of (or ahead of) `runHealthCheck`, if the direct-HTTP exponential-backoff behavior is actually the intended design and `runHealthCheck` is the drift.
3. Leave both as-is but fix `README.md` to describe current wired reality, and leave `health.ts` explicitly marked as an alternate/experimental implementation not on the critical path.

Tracked as a follow-up decision, not resolved in this bundle.
