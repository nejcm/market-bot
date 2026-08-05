import {
  loadOfflineCorpusCase,
  type OfflineCorpusExecution,
  type OfflineFinancialStatementInput,
} from "./offline-financial-statements-corpus";

export type OfflineCorpusFixtureName = OfflineFinancialStatementInput["fixture"];

export async function runOfflineCorpusFixture(
  fixture: OfflineCorpusFixtureName,
): Promise<OfflineCorpusExecution> {
  const corpusCase = await loadOfflineCorpusCase(fixture);
  return corpusCase.execution;
}

export function classifierPattern(prefix: string, path: string, suffix = ""): RegExp {
  return new RegExp(`${prefix}${path.replaceAll(".", String.raw`\.`)}${suffix}`, "u");
}

// Stubs fetch for the duration of `run`, counting attempts instead of letting them reach the network.
// Split offline-corpus suites use this so each file independently proves it never leaves the offline seam.
export async function countNetworkAttemptsDuring(run: () => Promise<void>): Promise<number> {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      networkAttempts += 1;
      throw new Error("Offline corpus test attempted network access");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return networkAttempts;
}
