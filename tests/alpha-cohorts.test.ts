import { describe, expect, test } from "bun:test";
import {
  buildAlphaLeadCohortSummary,
  renderAlphaLeadCohortMarkdown,
} from "../src/alpha-search/cohorts";
import type { AlphaSearchRejectedCandidate } from "../src/alpha-search/report-extras";
import type { AlphaCandidateWatchlist } from "../src/alpha-search/candidate-state";
import type { AlphaValidationFile } from "../src/alpha-search/validation";

function rejected(
  overrides: Partial<AlphaSearchRejectedCandidate> = {},
): AlphaSearchRejectedCandidate {
  return {
    symbol: "ALFA",
    discoverySources: ["apewisdom"],
    reason: "Market cap above configured maximum",
    sourceIds: ["apewisdom-ALFA"],
    ...overrides,
  };
}

function validationFile(overrides: Partial<AlphaValidationFile> = {}): AlphaValidationFile {
  return {
    runId: "alpha-run-validated",
    generatedAt: "2026-05-08T00:00:00.000Z",
    validatedAt: "2026-06-01T00:00:00.000Z",
    benchmarkSymbol: "IWM",
    horizons: [5],
    leads: [
      {
        symbol: "ALFA",
        discoverySources: ["apewisdom"],
        sourceGroup: "apewisdom-only",
        sourceIds: ["apewisdom-ALFA"],
        horizons: [
          {
            status: "resolved",
            horizonTradingDays: 5,
            benchmarkSymbol: "IWM",
            candidateClose0: 10,
            candidateCloseN: 12,
            benchmarkClose0: 100,
            benchmarkCloseN: 105,
            candidateDate0: "2026-05-08",
            candidateDateN: "2026-05-15",
            benchmarkDate0: "2026-05-08",
            benchmarkDateN: "2026-05-15",
            candidateReturn: 0.2,
            benchmarkReturn: 0.05,
            excessReturn: 0.15,
            outcome: "outperformed",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function watchlist(): AlphaCandidateWatchlist {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    candidateCount: 2,
    candidates: [
      {
        symbol: "ALFA",
        firstSeenAt: "2026-05-01T00:00:00.000Z",
        lastSeenAt: "2026-05-08T00:00:00.000Z",
        seenCount: 1,
        runIds: ["alpha-run-1"],
        latestProfile: {
          symbol: "ALFA",
          runId: "alpha-run-1",
          generatedAt: "2026-05-01T00:00:00.000Z",
          discoverySources: ["apewisdom"],
          sourceGroup: "apewisdom-only",
          sourceIds: ["apewisdom-ALFA"],
          exchange: "NMS",
          price: 10,
          volume: 1_000_000,
          marketCap: 500_000_000,
        },
        latestValidation: [],
      },
      {
        symbol: "BRAV",
        firstSeenAt: "2026-05-25T00:00:00.000Z",
        lastSeenAt: "2026-05-25T00:00:00.000Z",
        seenCount: 1,
        runIds: ["alpha-run-2"],
        latestProfile: {
          symbol: "BRAV",
          runId: "alpha-run-2",
          generatedAt: "2026-05-25T00:00:00.000Z",
          discoverySources: ["sec-filings"],
          sourceGroup: "sec-only",
          sourceIds: ["sec-BRAV"],
          exchange: "NMS",
          price: 12,
          volume: 1_200_000,
          marketCap: 600_000_000,
        },
        latestValidation: [],
      },
    ],
  };
}

describe("alpha lead cohorts", () => {
  test("aggregates rejection buckets and unbriefed lead decay", () => {
    const summary = buildAlphaLeadCohortSummary({
      rejectedCandidates: [
        rejected(),
        rejected({ symbol: "BRAV", reason: "Yahoo validation unavailable" }),
      ],
      validations: [validationFile()],
      watchlist: watchlist(),
      tickerBriefSymbols: new Set(["BRAV"]),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rejectedCandidateCount: 2,
      rejectedUniqueSymbolCount: 2,
      watchlistCandidateCount: 2,
      tickerBriefedLeadCount: 1,
      unbriefedLeadCount: 1,
    });
    expect(summary.rejectionBuckets).toEqual([
      expect.objectContaining({
        reason: "Market cap above configured maximum",
        rejectedCount: 1,
        uniqueSymbolCount: 1,
        laterValidatedSymbolCount: 1,
        validation: {
          "5": expect.objectContaining({
            resolvedCount: 1,
            outperformedCount: 1,
            hitRate: 1,
            averageExcessReturn: 0.15,
          }),
        },
      }),
      expect.objectContaining({
        reason: "Yahoo validation unavailable",
        laterValidatedSymbolCount: 0,
        validation: {},
      }),
    ]);
    expect(summary.staleLeadDecay).toEqual([
      expect.objectContaining({
        ageBucket: "31+d",
        unbriefedLeadCount: 1,
        validation: {
          "5": expect.objectContaining({ resolvedCount: 1, outperformedCount: 1 }),
        },
      }),
    ]);
  });

  test("renders research-only cohort markdown", () => {
    const markdown = renderAlphaLeadCohortMarkdown(
      buildAlphaLeadCohortSummary({
        rejectedCandidates: [rejected()],
        validations: [validationFile()],
        now: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    expect(markdown).toContain("# Alpha Lead Cohorts");
    expect(markdown).toContain("Market cap above configured maximum");
    expect(markdown).not.toMatch(/\b(buy|sell|hold|position|portfolio)\b/iu);
  });
});
