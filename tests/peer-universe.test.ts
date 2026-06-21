import { describe, expect, test } from "bun:test";
import {
  MAX_PEERS,
  resolvePeerUniverse,
  validatePeerUniverse,
  type PeerUniverse,
} from "../src/research/peer-universe";

describe("peer universe", () => {
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
});
