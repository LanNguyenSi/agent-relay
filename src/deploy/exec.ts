import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 300_000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

export async function shell(command: string, cwd: string): Promise<ExecResult> {
  return exec("/bin/sh", ["-c", command], cwd);
}
