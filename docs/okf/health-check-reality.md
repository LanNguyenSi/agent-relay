---
type: module
title: Health check reality — the wired inline check (divergence resolved 2026-08-10)
description: >-
  The deploy path runs engine.ts's inline runHealthCheck (fixed 5 retries /
  5000ms delay, docker compose exec + node -e fetch inside each service
  container, hardcoded ports unless health_port is set). The formerly
  documented divergence — a fully tested but never-imported
  exponential-backoff module in src/deploy/health.ts — was resolved on
  2026-08-10 by operator decision, deleting health.ts and its test as dead
  code; README.md now describes the wired behavior.
tags: [health-check, dead-code, docs-drift, deploy]
timestamp: 2026-09-01T06:41:00Z
sources:
  - src/deploy/engine.ts
  - README.md
---

# Health check reality — the wired inline check (divergence resolved)

## `engine.ts`'s inline `runHealthCheck` — what gates every deploy

`runHealthCheck` (`engine.ts`, called from both `defaultFlowDeploy` and
`customCommandDeploy`) is the only health check that runs during a deploy:

- **Fixed retry count and delay**: `maxRetries = 5`, flat `delayMs = 5000`
  between attempts (`0` under `NODE_ENV=test`) — no exponential backoff.
- **No direct HTTP fetch from the relay process.** Each attempt lists the
  compose project's running services (`docker compose -f <compose_file> ps
  --services --status running`), then for each service tries each candidate
  port — `config.health_port` if set, otherwise the hardcoded list
  `[3000, 3001, 4000, 5000, 8000, 8080]` — by running `docker compose exec
  -T <service> node -e <fetch snippet>`, so the probe runs **from inside the
  service's own container**. The first `exitCode === 0` wins; after
  exhausting every service/port combination `maxRetries` times, it reports
  failure.

`README.md`'s deploy-lifecycle section describes exactly this behavior.

## Resolved divergence (history)

Until 2026-08-10 the repo also carried `src/deploy/health.ts`, a fully
tested `checkHealth` implementation (direct `fetch` with exponential
backoff, 5-second per-attempt timeout) that was imported only by its own
test — dead code from the deploy path's perspective — while `README.md`
described that dead implementation ("exponential backoff") instead of the
wired one. The maintainer decision (operator, 2026-08-10, quickwin batch
run `2026-08-10-quickwin-batch6`) resolved it as option (b) of the tracked
follow-up: delete `health.ts` and `health.test.ts` as dead code, keep the
wired in-container probe unchanged, and correct `README.md` to describe
the shipped behavior. If exponential backoff or relay-side direct HTTP
probing is ever wanted, it should be designed against `runHealthCheck`,
not resurrected from the deleted module.
