import { setSourceHostMinDelayMsForTests } from "../../src/sources/collector";

// Eliminate the real per-host rate-limit sleep so tests never wait on wall-clock time.
setSourceHostMinDelayMsForTests(0);

// Preserve the real fetch so the few tests that must exercise a real loopback
// Transport (the MCP Streamable HTTP fixture) can inject it explicitly, keeping
// The inject-a-FetchLike convention rather than defeating the guard globally.
(globalThis as { realFetchForTests?: typeof fetch }).realFetchForTests = globalThis.fetch;

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
