import { describe, expect, test } from "bun:test";
import { collectTradierIv } from "../src/sources/extended-evidence/tradier-options";
import type { CollectContext, SourceRequestExecutor } from "../src/sources/types";

const fetchedAt = "2026-06-23T00:00:00.000Z";

function requestExecutor(overrides: Partial<SourceRequestExecutor> = {}): SourceRequestExecutor {
  return {
    json: async () => {
      throw new Error("must not fetch for a non-US listing");
    },
    text: async () => {
      throw new Error("must not fetch for a non-US listing");
    },
    ...overrides,
  };
}

function baseCtx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    command: { jobType: "equity", assetClass: "equity", symbol: "RR.L", depth: "deep" },
    fetchedAt,
    newsLimit: 2,
    cryptoMoverLimit: 2,
    request: requestExecutor(),
    ...overrides,
  };
}

describe("collectTradierIv non-US gating", () => {
  test("emits a single unsupported-coverage gap without a fetch for a suffixed non-US ticker", async () => {
    const result = await collectTradierIv(baseCtx());

    expect(result.rawSnapshots).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "tradier-options",
        cause: "unsupported-coverage",
        message: expect.stringContaining("RR.L"),
      }),
    ]);
  });

  test("uses the resolved identity to gate a suffix-less non-US symbol", async () => {
    const result = await collectTradierIv(
      baseCtx({
        command: { jobType: "equity", assetClass: "equity", symbol: "VOD", depth: "deep" },
        instrumentIdentity: { exchange: "London Stock Exchange" },
      }),
    );

    expect(result.gaps).toEqual([
      expect.objectContaining({ source: "tradier-options", cause: "unsupported-coverage" }),
    ]);
  });

  test("does not gate a US ticker (falls through to the credential check)", async () => {
    const result = await collectTradierIv(
      baseCtx({
        command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      }),
    );

    expect(result.gaps).toEqual([
      expect.objectContaining({ source: "tradier-options", cause: "missing-credential" }),
    ]);
  });
});
