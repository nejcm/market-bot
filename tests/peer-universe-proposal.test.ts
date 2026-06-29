import { describe, expect, mock, test } from "bun:test";
import { createPeerUniverseProposer } from "../src/research/peer-universe-proposal";
import type { ModelProvider, ModelRequest } from "../src/model/types";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

const generatedAt = "2026-06-29T00:00:00.000Z";

// SEC company_tickers.json directory used for findSecTicker validation.
const SEC_TICKERS = {
  "0": { cik_str: 1, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 2, ticker: "MSFT", title: "Microsoft Corp" },
  "2": { cik_str: 3, ticker: "GOOGL", title: "Alphabet Inc." },
  "3": { cik_str: 4, ticker: "AMZN", title: "Amazon.com Inc." },
  "4": { cik_str: 5, ticker: "SPY", title: "SPDR S&P 500 ETF Trust" },
  "5": { cik_str: 6, ticker: "QQQ", title: "Invesco QQQ Trust" },
};

function rawJson(adapter: string, payload: unknown): FetchJsonResult {
  return {
    rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt: generatedAt, payload },
    payload,
  };
}

function secTickersExecutor(available = true): SourceRequestExecutor {
  return {
    json: async ({ adapter }) => {
      if (adapter === "sec-tickers") {
        if (!available) {
          return {
            source: "sec-edgar",
            message: "SEC tickers unavailable",
            capability: "extended-evidence",
            cause: "fetch-failed",
            evidenceQualityImpact: "extended-evidence-cap",
          };
        }
        return rawJson(adapter, SEC_TICKERS);
      }
      throw new Error(`unexpected adapter ${adapter}`);
    },
    text: async () => {
      throw new Error("unexpected text request");
    },
  };
}

function modelProvider(content: string): ModelProvider {
  return {
    name: "test-provider",
    generate: mock(async (_request: ModelRequest) => ({
      content,
      tokenEstimate: 10,
      costEstimateUsd: 0,
    })),
  };
}

function peersJson(peers: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ peers });
}

describe("createPeerUniverseProposer", () => {
  test("proposes a validated universe when all candidates pass", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "tech peer" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "software peer" },
          { symbol: "GOOGL", name: "Alphabet", role: "secondary", rationale: "platform peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
      targetName: "Some Company",
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe).toBeDefined();
    expect(universe?.provenance).toBe("model-proposed-validated");
    expect(universe?.peers.map((p) => p.symbol)).toEqual(["AAPL", "MSFT", "GOOGL"]);
    expect(universe?.peers.every((p) => p.sourceIds.includes("sec-company-tickers"))).toBe(true);
    // SEC title overrides proposed name
    expect(universe?.peers[0]?.name).toBe("Apple Inc.");
    expect(audit).toMatchObject({ proposed: 3, survived: 3, modelId: "test-model" });
  });

  test("rejects a hallucinated ticker not in the SEC directory", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "peer" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "peer" },
          { symbol: "GOOGL", name: "Alphabet", role: "secondary", rationale: "peer" },
          { symbol: "FAKE", name: "Fake Corp", role: "secondary", rationale: "peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe?.peers.map((p) => p.symbol)).not.toContain("FAKE");
    expect(audit.rejectedByDirectory).toBe(1);
    expect(audit.survived).toBe(3);
  });

  test("rejects an ETF by the name filter", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "peer" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "peer" },
          { symbol: "GOOGL", name: "Alphabet", role: "secondary", rationale: "peer" },
          { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", role: "secondary", rationale: "peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe?.peers.map((p) => p.symbol)).not.toContain("SPY");
    expect(audit.rejectedByEtf).toBe(1);
  });

  test("rejects a foreign-suffixed symbol by the US-listing gate", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "peer" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "peer" },
          { symbol: "GOOGL", name: "Alphabet", role: "secondary", rationale: "peer" },
          { symbol: "RY.TO", name: "Royal Bank", role: "secondary", rationale: "peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe?.peers.map((p) => p.symbol)).not.toContain("RY.TO");
    // RY.TO has a non-US suffix, fails SYMBOL_RE-after-uppercase or isUsListing;
    // Either way it does not survive.
    expect(audit.survived).toBe(3);
  });

  test("drops the target and duplicate proposals", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "ZZZZ", name: "Target", role: "core", rationale: "self" },
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "peer" },
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "dup" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "peer" },
          { symbol: "GOOGL", name: "Alphabet", role: "secondary", rationale: "peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
    });

    // ZZZZ is the target; it is not in the SEC directory, but target check runs first.
    const { universe } = await propose("ZZZZ");

    expect(universe?.peers.map((p) => p.symbol)).toEqual(["AAPL", "MSFT", "GOOGL"]);
  });

  test("returns no universe when fewer than 3 survivors", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider(
        peersJson([
          { symbol: "AAPL", name: "Apple Inc.", role: "core", rationale: "peer" },
          { symbol: "MSFT", name: "Microsoft", role: "core", rationale: "peer" },
        ]),
      ),
      model: "test-model",
      request: secTickersExecutor(),
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe).toBeUndefined();
    expect(audit.survived).toBe(2);
  });

  test("returns no universe on malformed JSON without throwing", async () => {
    const propose = createPeerUniverseProposer({
      provider: modelProvider("not json at all {{{"),
      model: "test-model",
      request: secTickersExecutor(),
    });

    const { universe, audit } = await propose("ZZZZ");

    expect(universe).toBeUndefined();
    expect(audit.proposed).toBe(0);
  });

  test("returns no universe when SEC directory fetch fails", async () => {
    const generateMock = mock(async () => ({
      content: peersJson([]),
      tokenEstimate: 0,
      costEstimateUsd: 0,
    }));
    const propose = createPeerUniverseProposer({
      provider: { name: "test", generate: generateMock },
      model: "test-model",
      request: secTickersExecutor(false),
    });

    const { universe } = await propose("ZZZZ");

    expect(universe).toBeUndefined();
    // Model is never called when the SEC directory is unavailable.
    expect(generateMock).not.toHaveBeenCalled();
  });

  test("caps survivors at MAX_PEERS (8)", async () => {
    const directory: Record<string, { cik_str: number; ticker: string; title: string }> = {};
    const peers: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const ticker = `PEER${String(i)}`;
      directory[String(i)] = { cik_str: i + 1, ticker, title: `Peer ${String(i)} Inc.` };
      peers.push({ symbol: ticker, name: `Peer ${String(i)}`, role: "secondary", rationale: "p" });
    }
    const request: SourceRequestExecutor = {
      json: async ({ adapter }) =>
        adapter === "sec-tickers"
          ? rawJson(adapter, directory)
          : (() => {
              throw new Error("unexpected");
            })(),
      text: async () => {
        throw new Error("unexpected");
      },
    };
    const propose = createPeerUniverseProposer({
      provider: modelProvider(peersJson(peers)),
      model: "test-model",
      request,
    });

    const { universe } = await propose("ZZZZ");

    expect(universe?.peers).toHaveLength(8);
  });
});
