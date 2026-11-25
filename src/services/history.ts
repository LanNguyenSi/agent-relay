import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { env } from "../config/env.js";

/**
 * recordDeploy only reads these four fields off whatever deploy/rollback
 * outcome produced it. It intentionally does not import the full
 * `DeployResult`/`DeployBlockedResult` types from deploy/engine.js: those
 * require `steps`, but `rollbackApp` (services/apps.ts) returns a lighter
 * ad-hoc object without `durationMs`, and the `??` fallbacks below already
 * treat commitBefore/commitAfter/durationMs as optional.
 */
interface DeployOutcome {
  success: boolean;
  commitBefore?: string;
  commitAfter?: string;
  durationMs?: number;
}

export interface DeployRecord {
  id: string;
  app: string;
  status: string;
  commitBefore: string;
  commitAfter: string;
  durationMs: number;
  triggeredBy: string;
  createdAt: string;
  /**
   * Optional caller-supplied correlation id (X-Deploy-Id header or `deployId`
   * body field on the HTTP API). Absent on records created without one and on
   * history files written before the field existed.
   */
  deployId?: string;
}

const MAX_RECORDS = 100;
let records: DeployRecord[] | null = null;
let counter = 0;

function historyPath(): string {
  return join(env.APPS_DIR, ".relay-history.json");
}

async function load(): Promise<DeployRecord[]> {
  if (records) return records;

  try {
    const data = await readFile(historyPath(), "utf-8");
    records = JSON.parse(data) as DeployRecord[];
    counter = records.reduce((max, r) => {
      const n = parseInt(r.id.replace("d-", ""), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
  } catch {
    records = [];
  }

  return records;
}

async function save(): Promise<void> {
  if (!records) return;
  const path = historyPath();
  await mkdir(dirname(path), { recursive: true });
  // Atomic replace (same idiom as writeSelfUpdateState in deploy/self-update.ts):
  // write a uniquely named temp file in the target's own directory and rename
  // it over the target, so a crash mid-write leaves the previous file intact
  // instead of a truncated file that load() would read as empty and overwrite.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(records, null, 2), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // best effort, never mask err
    throw err;
  }
}

export async function recordDeploy(
  app: string,
  result: DeployOutcome, triggeredBy: string,
  deployId?: string,
): Promise<DeployRecord> {
  const list = await load();

  const record: DeployRecord = {
    id: `d-${++counter}`,
    app,
    status: result.success ? "success" : "failed",
    commitBefore: result.commitBefore ?? "",
    commitAfter: result.commitAfter ?? "",
    durationMs: result.durationMs ?? 0,
    triggeredBy,
    createdAt: new Date().toISOString(),
    ...(deployId !== undefined ? { deployId } : {}),
  };

  list.unshift(record);
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS;

  await save();
  return record;
}

export async function getHistory(app?: string): Promise<DeployRecord[]> {
  const list = await load();
  return app ? list.filter((r) => r.app === app) : list;
}
