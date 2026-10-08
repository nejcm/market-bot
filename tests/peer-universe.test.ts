import { describe, expect, mock, test } from "bun:test";
import {
  MAX_PEERS,
  MIN_PROPOSED_PEERS,
  resolvePeerUniverse,
  resolvePeerUniverseWithFallback,
  validatePeerUniverse,
  type LearnedPeerUniverse,
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
function learned(universe: PeerUniverse): LearnedPeerUniverse {
  return { universe, generation: "2026-01-01T00:00:00.000Z", refresh: "not-needed" };
}

async function cacheMiss(): Promise<LearnedPeerUniverse | undefined> {
  return undefined;
}

describe("resolvePeerUniverseWithFallback", () => {
  test("returns deterministic tier result without calling fallback for AAPL", async () => {
    const proposeMock = mock(async (_symbol: string) => ({
      audit: dummyAudit,
    }));
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: async () => "written",
      claimRefresh: async () => false,
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
    const cacheWriteMock = mock(async () => "written");
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: async () => learned(cachedUniverse),
      cacheWrite: cacheWriteMock,
      claimRefresh: async () => false,
      propose: proposeMock,
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(result.universe?.provenance).toBe("model-proposed-validated");
    expect(result.universe?.targetSymbol).toBe("ZZZZ");
    expect(proposeMock).not.toHaveBeenCalled();
    expect(cacheWriteMock).not.toHaveBeenCalled();
  });

  test("rejects a cache hit for a different target symbol", async () => {
    const cachedUniverse = makeModelProposedUniverse("AAAA");
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: async () => learned(cachedUniverse),
      cacheWrite: async () => "written",
      claimRefresh: async () => false,
      propose: async () => ({ audit: dummyAudit }),
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("unresolved");
    expect(result.reason).toContain("target mismatch");
  });

  test("calls propose on cache miss, writes cache, resolves when enough survivors", async () => {
    const proposedUniverse = makeModelProposedUniverse("ZZZZ");
    const cacheWriteMock = mock(async () => "written");
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: cacheWriteMock,
      claimRefresh: async () => false,
      propose: async () => ({ universe: proposedUniverse, audit: dummyAudit }),
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(result.universe?.provenance).toBe("model-proposed-validated");
    expect(cacheWriteMock).toHaveBeenCalledTimes(1);
    expect(cacheWriteMock).toHaveBeenCalledWith("ZZZZ", proposedUniverse, dummyAudit, undefined);
  });

  test("does not write an invalid proposed universe to cache", async () => {
    const invalidUniverse: PeerUniverse = {
      ...makeModelProposedUniverse("ZZZZ"),
      peers: [
        {
          symbol: "AAPL",
          name: "Apple Inc.",
          role: "core",
          rationale: "peer a",
          sourceIds: ["missing-source"],
        },
      ],
    };
    const cacheWriteMock = mock(async () => "written");
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: cacheWriteMock,
      claimRefresh: async () => false,
      propose: async () => ({ universe: invalidUniverse, audit: dummyAudit }),
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("unresolved");
    expect(result.reason).toContain("Invalid Peer Universe");
    expect(cacheWriteMock).not.toHaveBeenCalled();
  });

  test("returns unresolved when propose returns no universe (< MIN_PROPOSED_PEERS)", async () => {
    const fallback: PeerUniverseFallbackContext = {
      cacheRead: cacheMiss,
      cacheWrite: async () => "written",
      claimRefresh: async () => false,
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
      cacheWrite: async () => "written",
      claimRefresh: async () => false,
      propose: async () => {
        proposeCalled = true;
        return { universe: proposedUniverse, audit: dummyAudit };
      },
    };

    const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

    expect(result.status).toBe("resolved");
    expect(proposeCalled).toBe(true);
  });

  describe("refresh of a learned universe with too few usable peers", () => {
    const inputs = { marketCap: 450e6, sic: "3661", annualizedRevenue: 150e6 };
    const dueEntry: LearnedPeerUniverse = {
      ...learned(makeModelProposedUniverse("ZZZZ")),
      refresh: "due",
    };

    function refreshFallback(overrides: Partial<PeerUniverseFallbackContext> = {}) {
      const propose = mock(async (_symbol: string) => ({
        universe: { ...makeModelProposedUniverse("ZZZZ"), peers: [] as PeerUniverse["peers"] },
        audit: dummyAudit,
      }));
      const cacheWrite = mock(async () => "2026-10-08T00:00:00.000Z");
      const claimRefresh = mock(async () => true);
      const fallback: PeerUniverseFallbackContext = {
        cacheRead: async () => dueEntry,
        cacheWrite,
        propose,
        claimRefresh,
        ...overrides,
      };
      return { fallback, propose, cacheWrite, claimRefresh };
    }

    test("claims before proposing, passes target inputs, and replaces the evaluated generation", async () => {
      const replacement = makeModelProposedUniverse("ZZZZ");
      const order: string[] = [];
      const { fallback, cacheWrite } = refreshFallback({
        claimRefresh: async () => {
          order.push("claim");
          return true;
        },
        propose: async (_symbol, target) => {
          order.push("propose");
          expect(target).toEqual(inputs);
          return { universe: replacement, audit: dummyAudit };
        },
      });

      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        inputs,
      );

      expect(order).toEqual(["claim", "propose"]);
      expect(result.reason).toContain("refreshed");
      expect(result.learnedGeneration).toBe("2026-10-08T00:00:00.000Z");
      expect(cacheWrite).toHaveBeenCalledWith("ZZZZ", replacement, dummyAudit, dueEntry.generation);
    });

    test("an insufficient or invalid refresh keeps the cached universe with a note", async () => {
      const { fallback, cacheWrite } = refreshFallback();

      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        inputs,
      );

      expect(result.status).toBe("resolved");
      expect(result.reason).toBe("Resolved from learned peer-universe cache");
      expect(result.learnedGeneration).toBe(dueEntry.generation);
      expect(result.refresh).toEqual({ outcome: "insufficient", audit: dummyAudit });
      expect(cacheWrite).not.toHaveBeenCalled();
    });

    test("a lost claim uses the cached universe without proposing", async () => {
      const { fallback, propose } = refreshFallback({ claimRefresh: async () => false });

      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        inputs,
      );

      expect(result.reason).toBe("Resolved from learned peer-universe cache");
      expect(result.refresh).toEqual({ outcome: "claim-lost" });
      expect(propose).not.toHaveBeenCalled();
    });

    test("a claim lock error is disclosed and never proposes", async () => {
      const { fallback, propose } = refreshFallback({
        claimRefresh: async () => {
          throw new Error("lock busy");
        },
      });

      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        inputs,
      );

      expect(result.status).toBe("resolved");
      expect(result.refresh).toEqual({ outcome: "claim-error" });
      expect(propose).not.toHaveBeenCalled();
    });

    test("missing or non-positive target cap, or missing SIC, never claims a refresh", async () => {
      for (const target of [
        { marketCap: 450e6 },
        { sic: "3661" },
        { marketCap: 0, sic: "3661" },
        { marketCap: -1, sic: "3661" },
        undefined,
      ]) {
        const { fallback, claimRefresh, propose } = refreshFallback();
        const result = await resolvePeerUniverseWithFallback(
          "ZZZZ",
          fallback,
          undefined,
          undefined,
          target,
        );
        expect(result.reason).toBe("Resolved from learned peer-universe cache");
        expect(result.refresh).toEqual({ outcome: "missing-target-inputs" });
        expect(claimRefresh).not.toHaveBeenCalled();
        expect(propose).not.toHaveBeenCalled();
      }
    });

    test("a used allowance keeps the cached universe and says so", async () => {
      const { fallback, claimRefresh } = refreshFallback({
        cacheRead: async () => ({ ...dueEntry, refresh: "used" }),
      });

      const result = await resolvePeerUniverseWithFallback("ZZZZ", fallback);

      expect(result.status).toBe("resolved");
      expect(result.refresh).toEqual({ outcome: "allowance-used" });
      expect(claimRefresh).not.toHaveBeenCalled();
    });

    test("an expired entry defers without inputs, then re-proposes without claiming", async () => {
      const replacement = makeModelProposedUniverse("ZZZZ");
      const expired: LearnedPeerUniverse = { generation: dueEntry.generation, refresh: "due" };
      const { fallback, claimRefresh, cacheWrite, propose } = refreshFallback({
        cacheRead: async () => expired,
      });

      const deferred = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        {
          marketCap: 450e6,
        },
      );
      expect(deferred.status).toBe("unresolved");
      expect(deferred.refresh).toEqual({ outcome: "missing-target-inputs" });
      expect(propose).not.toHaveBeenCalled();

      const restored = refreshFallback({
        cacheRead: async () => expired,
        propose: async () => ({ universe: replacement, audit: dummyAudit }),
      });
      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        restored.fallback,
        undefined,
        undefined,
        inputs,
      );
      expect(result.status).toBe("resolved");
      expect(restored.claimRefresh).not.toHaveBeenCalled();
      expect(restored.cacheWrite).toHaveBeenCalledWith(
        "ZZZZ",
        replacement,
        dummyAudit,
        dueEntry.generation,
      );
      expect(claimRefresh).not.toHaveBeenCalled();
      expect(cacheWrite).not.toHaveBeenCalled();
    });

    test("a failed renewal of an expired entry stays unresolved and spends no allowance", async () => {
      const { fallback, claimRefresh } = refreshFallback({
        cacheRead: async () => ({ generation: dueEntry.generation, refresh: "due" }),
      });

      const result = await resolvePeerUniverseWithFallback(
        "ZZZZ",
        fallback,
        undefined,
        undefined,
        inputs,
      );

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("expired or failed revalidation");
      expect(result.refresh).toEqual({ outcome: "insufficient", audit: dummyAudit });
      expect(claimRefresh).not.toHaveBeenCalled();
    });
  });

  test("exports MIN_PROPOSED_PEERS = 3", () => {
    expect(MIN_PROPOSED_PEERS).toBe(3);
  });
});
