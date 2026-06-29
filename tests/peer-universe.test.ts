import { describe, expect, mock, test } from "bun:test";
import {
  MAX_PEERS,
  MIN_PROPOSED_PEERS,
  resolvePeerUniverse,
  resolvePeerUniverseWithFallback,
  validatePeerUniverse,
  type PeerUniverse,
  type PeerUniverseFallbackContext,
  type ProposalAudit,
} from "../src/research/peer-universe";

describe("peer universe", () => {
  test("resolves AAPL to deterministic large-cap peer universe", () => {
    const result = resolvePeerUniverse("AAPL");

    expect(result.status).toBe("resolved");
    expect(result.universe).toMatchObject({
      targetSymbol: "AAPL",
      provenance: "ticker-mapping",
    });
    expect(result.universe?.peers.map((peer) => peer.symbol)).toEqual([
      "MSFT",
      "GOOGL",
      "AMZN",
      "META",
      "DELL",
    ]);
    expect(result.universe?.peers.filter((peer) => peer.role === "core")).toHaveLength(4);
    expect(result.universe?.peers.filter((peer) => peer.role === "secondary")).toHaveLength(1);
    expect(result.universe?.peers.every((peer) => peer.sourceIds.length > 0)).toBe(true);
    expect(result.universe?.peers.every((peer) => peer.rationale.trim() !== "")).toBe(true);
  });

  test("resolves checked-in ticker mapping before subject-registry fallback", () => {
    const result = resolvePeerUniverse("nvda");

    expect(result.status).toBe("resolved");
    expect(result.universe).toMatchObject({
      targetSymbol: "NVDA",
      provenance: "ticker-mapping",
    });
    expect(result.universe?.peers.map((peer) => peer.symbol)).toEqual([
      "AMD",
      "AVGO",
      "ANET",
      "VRT",
    ]);
    expect(result.universe?.peers.every((peer) => peer.sourceIds.length > 0)).toBe(true);
  });

  test("falls back to subject-registry listed-stock representatives and excludes ETFs", () => {
    const result = resolvePeerUniverse("AMGN");

    expect(result.status).toBe("resolved");
    expect(result.universe).toMatchObject({
      targetSymbol: "AMGN",
      provenance: "subject-registry",
    });
    expect(result.universe?.peers.map((peer) => peer.symbol)).toEqual(["GILD", "VRTX"]);
    expect(result.universe?.peers.map((peer) => peer.role)).toEqual(["core", "core"]);
    expect(result.universe?.peers.map((peer) => peer.symbol)).not.toContain("XBI");
  });

  test("returns unresolved for an unmapped ticker without subject match", () => {
    const result = resolvePeerUniverse("ZZZZ");

    expect(result).toMatchObject({
      targetSymbol: "ZZZZ",
      status: "unresolved",
    });
    expect(result.universe).toBeUndefined();
  });

  test("rejects subject-registry peers without valid provenance", () => {
    const result = resolvePeerUniverse("BAD", {}, [
      {
        subjectKey: "bad-subject",
        displayName: "Bad Subject",
        aliases: ["bad"],
        assetClass: "equity",
        representativeInstruments: [
          {
            symbol: "BAD",
            instrumentType: "listed-stock",
            sourceIds: ["known-source"],
          },
          {
            symbol: "PEER",
            instrumentType: "listed-stock",
            sourceIds: [],
          },
        ],
        sources: [{ sourceId: "known-source", title: "Known source" }],
      },
    ]);

    expect(result).toMatchObject({
      targetSymbol: "BAD",
      status: "unresolved",
    });
    expect(result.reason).toContain("peer PEER must cite sourceIds");
  });

  test("validates peer provenance and referenced source IDs", () => {
    const universe: PeerUniverse = {
      targetSymbol: "TEST",
      provenance: "ticker-mapping",
      peers: [
        {
          symbol: "PEER",
          role: "core",
          rationale: "same market",
          sourceIds: ["missing-source"],
        },
      ],
      sources: [{ sourceId: "known-source", title: "Known source" }],
    };

    expect(validatePeerUniverse(universe)).toEqual({
      valid: false,
      errors: ["TEST: peer PEER unknown sourceId missing-source"],
    });
  });

  test("caps resolved mappings at MAX_PEERS", () => {
    const peers = Array.from({ length: MAX_PEERS + 2 }, (_, index) => ({
      symbol: `P${index}`,
      role: "secondary" as const,
      rationale: "same category",
      sourceIds: [`source-${index}`],
    }));
    const result = resolvePeerUniverse("CAP", {
      CAP: {
        targetSymbol: "CAP",
        provenance: "ticker-mapping",
        peers,
        sources: peers.map((peer) => ({ sourceId: peer.sourceIds[0] ?? "", title: peer.symbol })),
      },
    });

    expect(result.universe?.peers).toHaveLength(MAX_PEERS);
  });

  test("validates model-proposed-validated provenance as valid", () => {
    const universe: PeerUniverse = {
      targetSymbol: "ZZZZ",
      provenance: "model-proposed-validated",
      peers: [
        {
          symbol: "AAPL",
          name: "Apple Inc.",
          role: "core",
          rationale: "large-cap tech peer",
          sourceIds: ["sec-company-tickers"],
        },
        {
          symbol: "MSFT",
          name: "Microsoft",
          role: "core",
          rationale: "enterprise software peer",
          sourceIds: ["sec-company-tickers"],
        },
        {
          symbol: "GOOGL",
          name: "Alphabet",
          role: "secondary",
          rationale: "platform peer",
          sourceIds: ["sec-company-tickers"],
        },
      ],
      sources: [
        {
          sourceId: "sec-company-tickers",
          title: "SEC company_tickers.json directory",
          url: "https://www.sec.gov/files/company_tickers.json",
        },
      ],
    };

    expect(validatePeerUniverse(universe)).toEqual({ valid: true, errors: [] });
  });
});

function makeModelProposedUniverse(targetSymbol: string): PeerUniverse {
  return {
    targetSymbol,
    provenance: "model-proposed-validated",
    peers: [
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        role: "core",
        rationale: "peer a",
        sourceIds: ["sec-company-tickers"],
      },
      {
        symbol: "MSFT",
        name: "Microsoft Corporation",
        role: "core",
        rationale: "peer b",
        sourceIds: ["sec-company-tickers"],
      },
      {
        symbol: "GOOGL",
        name: "Alphabet Inc.",
        role: "secondary",
        rationale: "peer c",
        sourceIds: ["sec-company-tickers"],
      },
    ],
    sources: [
      {
        sourceId: "sec-company-tickers",
        title: "SEC company_tickers.json directory",
        url: "https://www.sec.gov/files/company_tickers.json",
      },
    ],
  };
}

const dummyAudit: ProposalAudit = {
  proposed: 5,
  survived: 3,
  rejectedByDirectory: 1,
  rejectedByEtf: 0,
  rejectedByListing: 1,
  modelId: "test-model",
};

// Cache-reader stub that always misses, mirroring the real reader's miss result.
async function cacheMiss(): Promise<PeerUniverse | undefined> {
  return undefined;
}

describe("resolvePeerUniverseWithFallback", () => {
  test("returns deterministic tier result without calling fallback for AAPL", async () => {
    const proposeMock = mock(async (_symbol: string) => ({
      audit: dummyAudit,
    }));
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: async () => {},
      propose: proposeMock,
    };

    const result = await resolvePeerUniverseWithFallback("AAPL", fallback);

    expect(result.status).toBe("resolved");
    expect(result.universe?.provenance).toBe("ticker-mapping");
    expect(proposeMock).not.toHaveBeenCalled();
  });

  test("returns unresolved without calling fallback when no fallback provided", async () => {
    const result = await resolvePeerUniverseWithFallback("ZZZZ");

    expect(result.status).toBe("unresolved");
    expect(result.universe).toBeUndefined();
  });

  test("resolves from cache hit without calling propose", async () => {
    const cachedUniverse = makeModelProposedUniverse("ZZZZ");
    const proposeMock = mock(async (_symbol: string) => ({ audit: dummyAudit }));
    const cacheWriteMock = mock(async () => {});
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: async () => cachedUniverse,
      cacheWrite: cacheWriteMock,
      propose: proposeMock,
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(result.universe?.provenance).toBe("model-proposed-validated");
    expect(result.universe?.targetSymbol).toBe("ZZZZ");
    expect(proposeMock).not.toHaveBeenCalled();
    expect(cacheWriteMock).not.toHaveBeenCalled();
  });

  test("calls propose on cache miss, writes cache, resolves when enough survivors", async () => {
    const proposedUniverse = makeModelProposedUniverse("ZZZZ");
    const cacheWriteMock = mock(async () => {});
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: cacheWriteMock,
      propose: async () => ({ universe: proposedUniverse, audit: dummyAudit }),
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(result.universe?.provenance).toBe("model-proposed-validated");
    expect(cacheWriteMock).toHaveBeenCalledTimes(1);
    expect(cacheWriteMock).toHaveBeenCalledWith("ZZZZ", proposedUniverse, dummyAudit);
  });

  test("returns unresolved when propose returns no universe (< MIN_PROPOSED_PEERS)", async () => {
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: async () => {},
      propose: async () => ({ audit: dummyAudit }),
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("unresolved");
    expect(result.universe).toBeUndefined();
  });

  test("poisoned cache entry dropped — returns undefined from cacheRead triggers propose", async () => {
    // Poison: provenance says model-proposed-validated but peers violate validation
    // (here simulated by returning undefined from cacheRead, as if reader dropped it)
    const proposedUniverse = makeModelProposedUniverse("ZZZZ");
    let proposeCalled = false;
    // Reader returns undefined (miss/poison), so the resolver advances to propose.
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: async () => {},
      propose: async () => {
        proposeCalled = true;
        return { universe: proposedUniverse, audit: dummyAudit };
      },
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(proposeCalled).toBe(true);
  });

  test("exports MIN_PROPOSED_PEERS = 3", () => {
    expect(MIN_PROPOSED_PEERS).toBe(3);
  });
});
