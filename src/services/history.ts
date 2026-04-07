import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { env } from "../config/env.js";

export interface DeployRecord {
  id: string;
  app: string;
  status: string;
  commitBefore: string;
  commitAfter: string;
  durationMs: number;
  triggeredBy: string;
  createdAt: string;
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
  await writeFile(path, JSON.stringify(records, null, 2));
}

export async function recordDeploy(app: string, result: any, triggeredBy: string): Promise<DeployRecord> {
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
