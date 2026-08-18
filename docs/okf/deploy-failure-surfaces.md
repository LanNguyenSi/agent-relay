---
type: invariant
title: Deploy failure propagation across three surfaces — blocked vs failed vs success
description: SSE has a dedicated `blocked` event, non-streaming HTTP wraps a blocked result under `{ result }` (PR #45), and MCP returns a plain ok(result) — all three agree that a BLOCKED deploy never calls recordDeploy and so never enters deploy history. `rollbackApp` (task 1074feb5) now returns the same `blocked` shape as a deploy, gated on preflight after `git reset --hard`, and both rollback callers follow the identical wrap/skip-recordDeploy pattern. PR #58 resolves app config before opening the SSE stream so an unknown app is a real 404, not a mid-stream error event.
tags: [deploy, sse, mcp, api, history, blocked, rollback]
timestamp: 2026-08-18T17:55:00Z
sources:
  - src/api/routes.ts
  - src/mcp/server.ts
  - src/services/history.ts
  - src/services/apps.ts
  - CHANGELOG.md
---

# Deploy failure propagation across three surfaces — blocked vs failed vs success

A deploy call resolves to one of three outcomes: a normal `DeployResult` (`success: true` or `success: false` after a real attempt), or a `DeployBlockedResult` (`success: false, blocked: true`, preflight rejected the deploy before anything mutating happened). The three consumer surfaces — SSE, non-streaming HTTP, MCP — each represent `blocked` differently, but agree on one invariant.

## The three shapes

- **SSE stream** (`POST /api/apps/:name/deploy?stream=true`, `src/api/routes.ts`): a **dedicated `blocked` event**. `if ("blocked" in result && result.blocked) { send("blocked", result.preflight); }` (`routes.ts:101-102`), versus `send("done", result)` on the success/failure path (`:105`). A client distinguishes preflight rejection from a real deploy failure by event name alone, without inspecting the payload shape.
- **Non-streaming HTTP** (same route, no `stream` query): wraps the blocked result under `{ result }` — `return c.json({ result })` (`routes.ts:131`) — deliberately matching the happy-path response shape `{ deploy: record, result }` (`:134`) so "clients can branch on `body.result.blocked` instead of two divergent top-level shapes" (comment, `:128-130`). This is **PR #45** ("Blocked deploy response now wrapped under `result`", `CHANGELOG.md` v0.4.0): before it, `DeployBlockedResult` was returned bare at the top level while every other response type nests under `result`, so shape-based callers misidentified blocked responses. Regression-pinned by `src/api/deploy-routes.test.ts` "wraps a blocked (preflight-failed) deploy under `result`" (`deploy-routes.test.ts:23`), which asserts `body` equals `{ result: blocked }` and that `"blocked" in body` is `false` at the top level.
- **MCP** (`relay_deploy` tool, `src/mcp/server.ts`): a **plain `ok(result)`**, no special-casing at all — `if ("blocked" in result && result.blocked) { return ok(result); }` (`server.ts:38-40`), same helper used for the success path. The blocked/success distinction is left entirely to the `blocked`/`success` fields inside the JSON payload; there is no MCP-level signal analogous to the SSE event name.

## The shared invariant: a blocked deploy never enters deploy history

All three surfaces agree on one thing: **`recordDeploy` is never called on the blocked branch.** SSE's blocked branch calls `send("blocked", ...)` with no `recordDeploy` call anywhere near it (`routes.ts:101-102`, contrast with `:104` on the success path); the non-streaming HTTP blocked branch returns immediately without a `recordDeploy` call (`routes.ts:127-132`, contrast with `:133` on the non-blocked path); MCP's `relay_deploy` returns immediately on the blocked branch (`server.ts:38-40`) with `recordDeploy` only reached on the line below for the non-blocked case (`:41`). Regression coverage: `src/mcp/server.test.ts` "returns ok result but does NOT call recordDeploy when deploy is blocked" (`server.test.ts:81`, asserts `mockRecordDeploy` `not.toHaveBeenCalled()`) and `src/api/routes-extra.test.ts` "emits blocked event and does NOT call recordDeploy when deploy is blocked" (`routes-extra.test.ts:132`, same assertion for the SSE path).

Consequence: `GET /api/deploys` / `GET /api/apps/:name` (both backed by `src/services/history.ts`'s `getHistory`) never surface a blocked attempt as a deploy record — deploy history is exclusively real attempts (success or failure after preflight passed) plus rollbacks. A blocked deploy leaves no trace in `.relay-history.json`; its only record is whatever the calling surface's transient response (SSE event, HTTP body, MCP tool result) captured at call time.

`rollbackApp` (`src/services/apps.ts:342-397`, task 1074feb5) now has the same blocked-style outcome as a deploy: after `git reset --hard` to the target commit, it re-reads `.relay.yml` and runs preflight gated on the same two critical checks a forward deploy and auto-rollback are gated on (`apps_root_mount_congruence`, `compose_bind_mount_sources_exist` — see [docs/okf/deploy-phase-model.md](./deploy-phase-model.md)); a rejection returns a `RollbackBlockedResult` (`apps.ts:328-334`) — `{ success: false, blocked: true, preflight, commitBefore, commitAfter }`, mirroring `DeployBlockedResult`'s shape — instead of proceeding to `compose build`/`up`. Both callers branch on it the same way the deploy blocked branch does, and both skip `recordDeploy` on that branch: `POST /api/apps/:name/rollback` wraps it under `{ result }` (`routes.ts:147-155`), the same convention the non-streaming deploy blocked branch uses (`:127-131`); the MCP `relay_rollback` tool returns a plain `ok(result)` (`server.ts:79-85`), same as `relay_deploy`'s blocked branch (`:38-40`). `recordDeploy` is only reached on the non-blocked path in both (`routes.ts:156`, `server.ts:86`) — a blocked rollback is exactly as history-invisible as a blocked deploy, for the same reason.

## PR #58: config resolved before the SSE stream opens, so an unknown app is a real 404

Before PR #58 ("resolve config before opening SSE deploy stream so RelayConfigError is a real 404"), an unknown app name (or an app with no valid `.relay.yml`) hit in `stream=true` mode would only fail *inside* `ReadableStream`'s `start()` callback, after the response headers were already flushed at 200 — so the failure could only ever surface as an SSE `error` event, never an HTTP 404. The route now resolves `apps.safeAppDir(name)` and `loadRelayConfig(dir)` up front, before constructing the `Response`/`ReadableStream` at all (`routes.ts:78-84`); a `RelayConfigError` there returns `c.json({ error }, 404)` exactly like the non-streaming path does (`:82-84`, vs `:136`). The comment at the call site notes the outer try/catch that used to wrap `new Response(...)` was dead code, since nothing in the synchronous part of stream construction throws (`:69-77`).
