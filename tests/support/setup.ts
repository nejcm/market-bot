import { setSourceHostMinDelayMsForTests } from "../../src/sources/collector";

// Eliminate the real per-host rate-limit sleep so tests never wait on wall-clock time.
setSourceHostMinDelayMsForTests(0);

// Guard against accidental real network calls: every test must inject a FetchLike.
function describeFetchTarget(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = describeFetchTarget(input);
  throw new Error(`Real network call attempted in test: ${url}. Inject a FetchLike instead.`);
}) as typeof fetch;
