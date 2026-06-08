export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function statusCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const status = /status (\d+)/u.exec(error.message)?.[1];
  return status !== undefined ? Number(status) : undefined;
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
    const code = statusCode(error);
    if (code !== undefined) {
      return code >= 500 && code < 600;
    }
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("network") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT")
    ) {
      return true;
    }
  }
  return false;
}

export function isYahooAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export async function withTransientRetries<T>(
  task: () => Promise<T>,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    const [nextDelay] = retryDelaysMs;
    if (nextDelay === undefined || !isTransientError(error)) {
      throw error;
    }
    await sleep(nextDelay);
    return withTransientRetries(task, retryDelaysMs.slice(1));
  }
}
