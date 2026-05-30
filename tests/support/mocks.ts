import type { ModelProvider } from "../../src/model/types";

export interface RecordingFetch {
  readonly calls: string[];
  readonly fetch: typeof fetch;
}

// Records requested URLs and delegates the body to `respond`: a returned
// `Response` is passed through, anything else is wrapped with `Response.json`.
// Callers assign `.fetch` to `globalThis.fetch` and restore it in teardown.
export function recordingFetch(respond: (url: string) => unknown): RecordingFetch {
  const calls: string[] = [];
  const stub = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const result = respond(url);
    const value = result instanceof Response ? result : Response.json(result);
    return Promise.resolve(value);
  }) as typeof fetch;

  return { calls, fetch: stub };
}

export function providerReturning(content: string): ModelProvider {
  return {
    name: "mock",
    generate: async () => ({
      content,
      tokenEstimate: 100,
      costEstimateUsd: 0.01,
    }),
  };
}
