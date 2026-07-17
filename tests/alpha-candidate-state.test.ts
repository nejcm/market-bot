import { describe, expect, test } from "bun:test";
import {
  buildAlphaCandidateProfiles,
  buildAlphaCandidateWatchlist,
  isAlphaCandidateProfile,
  renderAlphaCandidateWatchlistMarkdown,
  type AlphaCandidateProfile,
} from "../src/alpha-search/candidate-state";
import type { AlphaValidationFile } from "../src/alpha-search/validation";
import type { ResearchReport } from "../src/domain/types";
import { researchReport } from "./support/fixtures";

function alphaReport(leads: readonly unknown[], overrides: Partial<ResearchReport> = {}) {
  return researchReport({
    runId: "alpha-run-1",
    jobType: "alpha-search",
    assetClass: "equity",
    generatedAt: "2026-05-01T00:00:00.000Z",
    extras: {
      depth: "brief",
      socialCandidateCount: 1,
      secCandidateCount: 1,
      researchLeads: leads,
      rejectedCandidates: [],
    },
    ...overrides,
  });
}

function profile(overrides: Partial<AlphaCandidateProfile> = {}): AlphaCandidateProfile {
  return {
    symbol: "ALFA",
    name: "Alpha Co.",
    runId: "alpha-run-1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    discoverySources: ["apewisdom"],
    sourceGroup: "apewisdom-only",
    sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
    exchange: "NMS",
    price: 10,
    volume: 1_000_000,
    marketCap: 500_000_000,
    socialRank: 1,
    socialMomentumScore: 75,
    mentions: 20,
    upvotes: 60,
    ...overrides,
  };
}

function validationFile(overrides: Partial<AlphaValidationFile> = {}): AlphaValidationFile {
  return {
    runId: "alpha-run-2",
    validatedAt: "2026-06-01T00:00:00.000Z",
    generatedAt: "2026-05-08T00:00:00.000Z",
    benchmarkSymbol: "IWM",
    horizons: [5],
    leads: [
      {
        symbol: "ALFA",
        discoverySources: ["apewisdom"],
        sourceGroup: "apewisdom-only",
        sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
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

describe("buildAlphaCandidateProfiles", () => {
  test("builds ApeWisdom-only, SEC-only, and combined profiles from research leads", () => {
    const profiles = buildAlphaCandidateProfiles(
      alphaReport([
        {
          symbol: "SOC",
          exchange: "NMS",
          price: 11,
          volume: 1_100_000,
          marketCap: 600_000_000,
          discoverySources: ["apewisdom"],
          socialRank: 2,
          socialMomentumScore: 80,
          mentions: 40,
          upvotes: 100,
          sourceIds: ["apewisdom-SOC", "market-yahoo-alpha-search"],
        },
        {
          symbol: "SEC",
          exchange: "NMS",
          price: 12,
          volume: 1_200_000,
          marketCap: 700_000_000,
          discoverySources: ["sec-filings"],
          secCik: "0000000001",
          secCompanyName: "Sec Co.",
          recentSecFilings: [{ form: "8-K", filingDate: "2026-05-01", sourceIds: ["sec-1"] }],
          sourceIds: ["sec-1", "market-yahoo-alpha-search"],
        },
        {
          symbol: "BOTH",
          exchange: "NMS",
          price: 13,
          volume: 1_300_000,
          marketCap: 800_000_000,
          discoverySources: ["apewisdom", "sec-filings"],
          socialRank: 1,
          socialMomentumScore: 90,
          secCik: "0000000002",
          recentSecFilings: [{ form: "S-1", filingDate: "2026-05-02", sourceIds: ["sec-2"] }],
          sourceIds: ["apewisdom-BOTH", "sec-2", "market-yahoo-alpha-search"],
        },
      ]),
    );

    expect(profiles).toEqual([
      expect.objectContaining({
        symbol: "SOC",
        sourceGroup: "apewisdom-only",
        socialMomentumScore: 80,
      }),
      expect.objectContaining({
        symbol: "SEC",
        sourceGroup: "sec-only",
        secCik: "0000000001",
      }),
      expect.objectContaining({
        symbol: "BOTH",
        sourceGroup: "apewisdom+sec",
        socialRank: 1,
        recentSecFilings: [expect.objectContaining({ form: "S-1" })],
      }),
    ]);
  });

  test("attaches SEC fundamentals by symbol when provided", () => {
    const profiles = buildAlphaCandidateProfiles(
      alphaReport([
        {
          symbol: "SOC",
          exchange: "NMS",
          price: 11,
          volume: 1_100_000,
          marketCap: 600_000_000,
          discoverySources: ["apewisdom"],
          sourceIds: ["apewisdom-SOC", "market-yahoo-alpha-search"],
        },
      ]),
      new Map([
        [
          "SOC",
          {
            secCik: "0000320193",
            sourceIds: ["alpha-sec-fundamentals-soc"],
            metrics: { revenue: 100, revenueDeltaPercent: 12.5 },
          },
        ],
      ]),
    );

    expect(profiles[0]).toMatchObject({
      symbol: "SOC",
      fundamentals: {
        secCik: "0000320193",
        sourceIds: ["alpha-sec-fundamentals-soc"],
        metrics: { revenue: 100, revenueDeltaPercent: 12.5 },
      },
    });
    expect(isAlphaCandidateProfile(profiles[0])).toBe(true);
    expect(
      isAlphaCandidateProfile({
        ...profiles[0],
        fundamentals: { secCik: "0000320193", sourceIds: ["x"], metrics: { revenue: "bad" } },
      }),
    ).toBe(false);
  });

  test("ignores non-alpha reports and alpha reports without valid leads", () => {
    expect(buildAlphaCandidateProfiles(researchReport())).toEqual([]);
    expect(buildAlphaCandidateProfiles(alphaReport([]))).toEqual([]);
  });

  test("narrows persisted candidate profiles", () => {
    expect(isAlphaCandidateProfile(profile())).toBe(true);
    const { socialScoringVersion: _socialScoringVersion, ...legacyProfile } = profile({
      socialScoringVersion: 2,
    });
    expect(isAlphaCandidateProfile(legacyProfile)).toBe(true);
    expect(isAlphaCandidateProfile({ ...profile(), socialScoringVersion: 3 })).toBe(false);
    expect(isAlphaCandidateProfile({ ...profile(), symbol: undefined })).toBe(false);
    expect(isAlphaCandidateProfile({ ...profile(), discoverySources: ["other"] })).toBe(false);
  });

  test("rejects research leads with unsupported social scoring versions", () => {
    expect(
      buildAlphaCandidateProfiles(
        alphaReport([
          {
            symbol: "ALFA",
            exchange: "NMS",
            price: 10,
            volume: 1_000_000,
            marketCap: 500_000_000,
            discoverySources: ["apewisdom"],
            sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
            socialScoringVersion: 3,
          },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("buildAlphaCandidateWatchlist", () => {
  test("aggregates candidate sightings and computes deterministic deltas", () => {
    const watchlist = buildAlphaCandidateWatchlist({
      now: new Date("2026-06-01T00:00:00.000Z"),
      profiles: [
        profile(),
        profile({
          runId: "alpha-run-2",
          generatedAt: "2026-05-08T00:00:00.000Z",
          price: 12.5,
          marketCap: 550_000_000,
          socialRank: 3,
          socialMomentumScore: 82,
          discoverySources: ["apewisdom", "sec-filings"],
          sourceGroup: "apewisdom+sec",
          recentSecFilings: [{ form: "8-K", filingDate: "2026-05-08", sourceIds: ["sec-1"] }],
        }),
      ],
    });

    expect(watchlist).toMatchObject({
      generatedAt: "2026-06-01T00:00:00.000Z",
      candidateCount: 1,
      candidates: [
        {
          symbol: "ALFA",
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-08T00:00:00.000Z",
          seenCount: 2,
          runIds: ["alpha-run-1", "alpha-run-2"],
          latestProfile: { runId: "alpha-run-2", price: 12.5 },
          delta: {
            fromRunId: "alpha-run-1",
            toRunId: "alpha-run-2",
            priceChange: 2.5,
            marketCapChange: 50_000_000,
            socialRankChange: 2,
            socialMomentumScoreChange: 7,
            addedDiscoverySources: ["sec-filings"],
            newSecFilings: [expect.objectContaining({ form: "8-K" })],
          },
        },
      ],
    });
  });

  test("attaches latest validation horizons by symbol", () => {
    const watchlist = buildAlphaCandidateWatchlist({
      now: new Date("2026-06-01T00:00:00.000Z"),
      profiles: [profile()],
      validations: [validationFile()],
    });

    expect(watchlist.candidates[0]?.latestValidation).toEqual([
      expect.objectContaining({
        status: "resolved",
        horizonTradingDays: 5,
        excessReturn: 0.15,
      }),
    ]);
  });

  test("omits zero numeric deltas", () => {
    const watchlist = buildAlphaCandidateWatchlist({
      profiles: [
        profile(),
        profile({
          runId: "alpha-run-2",
          generatedAt: "2026-05-08T00:00:00.000Z",
        }),
      ],
    });

    expect(watchlist.candidates[0]?.delta).toEqual({
      fromRunId: "alpha-run-1",
      toRunId: "alpha-run-2",
      addedDiscoverySources: [],
      removedDiscoverySources: [],
      newSecFilings: [],
    });
  });

  test("renders markdown table without promotion verdicts", () => {
    const markdown = renderAlphaCandidateWatchlistMarkdown(
      buildAlphaCandidateWatchlist({
        now: new Date("2026-06-01T00:00:00.000Z"),
        profiles: [profile()],
        validations: [validationFile()],
      }),
    );

    expect(markdown).toContain("# Alpha Candidate Watchlist");
    expect(markdown).toContain("ALFA");
    expect(markdown).toContain("5d outperformed");
    expect(markdown).not.toMatch(/\b(promote|buy|sell|hold)\b/iu);
  });
});
