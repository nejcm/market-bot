import type { SourceGapAttemptClassification } from "../domain/types";

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

// Attempt-level failure classification. Single source of truth: `isTransientError` derives its
// Retry/no-retry boolean from this instead of re-implementing the same branching, so the two
// Can no longer drift apart. Alias of the domain vocabulary (`SourceGapAttemptClassification`)
// So gap telemetry and retry logic share one taxonomy.
export type TransientFailureClassification = SourceGapAttemptClassification;

export function classifyTransientFailure(error: unknown): TransientFailureClassification {
  if (!(error instanceof Error)) {
    return "non-transient";
  }
  // The local per-host circuit breaker (source-request.ts) refusing to send a request at all.
  // Never retried immediately, and never attributable to the remote provider.
  if (error.name === "SourceCircuitOpenError") {
    return "circuit-open";
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return "timeout";
  }
  const code = statusCode(error);
  if (code !== undefined) {
    // A parsed status code is authoritative once present: fall through to message-keyword
    // Matching only when no status code was found at all, matching the pre-existing
    // `isTransientError` branching so a 4xx-with-"network"-in-the-message case can't be
    // Classified as retryable-sounding "network" while retry logic (correctly) skips it.
    return code >= 500 && code < 600 ? "server-error" : "non-transient";
  }
  if (
    error.message.includes("fetch failed") ||
    error.message.includes("network") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT")
  ) {
    return "network";
  }
  return "non-transient";
}

export function isTransientError(error: unknown): boolean {
  const classification = classifyTransientFailure(error);
  return (
    classification === "timeout" ||
    classification === "server-error" ||
    classification === "network"
  );
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
