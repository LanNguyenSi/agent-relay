export interface HealthCheckOptions {
  url: string;
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export async function checkHealth(options: HealthCheckOptions): Promise<boolean> {
  const { url, retries = 5, initialDelayMs = 2000, maxDelayMs = 15000 } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return true;
    } catch {
      // Network error or timeout — retry
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
