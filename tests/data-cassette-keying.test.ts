import { describe, expect, test } from "bun:test";
import {
  createRecordingFetch,
  dataCassetteKey,
  makeReplayFetch,
  type DataCassette,
} from "./support/run-fixtures/data-cassette";

const QUOTE = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=BNS";

function crumbed(url: string, crumb: string): string {
  return `${url}&crumb=${crumb}`;
}

// The recorded Yahoo sequence: un-authed quote 401s, the caller fetches a crumb, the authed retry
// Succeeds. Replay has to reproduce both halves, with a crumb it minted itself.
function yahooFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    return new URL(url).searchParams.has("crumb")
      ? new Response('{"quoteResponse":{"result":[{"symbol":"BNS"}]}}', { status: 200 })
      : new Response('{"finance":{"error":"Unauthorized"}}', { status: 401 });
  };
}

describe("fixture data cassette crumb keying", () => {
  test("keeps the un-authed 401 and the authed 200 in separate entries", async () => {
    const recorder = createRecordingFetch(yahooFetch());
    expect(await recorder.fetch(QUOTE).then((response) => response.status)).toBe(401);
    expect(
      await recorder.fetch(crumbed(QUOTE, "recorded-crumb")).then((response) => response.status),
    ).toBe(200);

    const keys = Object.keys(recorder.cassette().entries);
    expect(keys).toHaveLength(2);
    expect(keys.filter((key) => key.includes("crumb="))).toHaveLength(1);
    expect(keys.some((key) => key.includes("crumb=recorded-crumb"))).toBe(false);

    // Replay mints its own crumb, which must still resolve to the recorded authed entry, while the
    // Un-authed call keeps returning the 401 that drives the credential path.
    const replay = makeReplayFetch(recorder.cassette());
    expect(await replay(QUOTE).then((response) => response.status)).toBe(401);
    expect(
      await replay(crumbed(QUOTE, "a-different-live-crumb")).then((response) => response.status),
    ).toBe(200);
  });

  test("reaches a legacy cassette's exact real-crumb entry", async () => {
    const unauthenticatedKey = await dataCassetteKey(QUOTE);
    const authenticatedKey = await dataCassetteKey(crumbed(QUOTE, "legacy-crumb"));
    const legacy: DataCassette = {
      entries: {
        [unauthenticatedKey]: { status: 401, headers: {}, body: "" },
        [authenticatedKey]: { status: 200, headers: {}, body: "" },
      },
    };
    const replay = makeReplayFetch(legacy);

    expect(await replay(QUOTE).then((response) => response.status)).toBe(401);
    expect(await replay(crumbed(QUOTE, "legacy-crumb")).then((response) => response.status)).toBe(
      200,
    );
  });
});
