import { describe, expect, test } from "bun:test";
import {
  buildAlphaFeatureAttribution,
  renderAlphaFeatureAttributionMarkdown,
} from "../src/alpha-search/feature-attribution";
import type { AlphaCandidateProfile } from "../src/alpha-search/candidate-state";
import type { AlphaValidationFile } from "../src/alpha-search/validation";

function profile(overrides: Partial<AlphaCandidateProfile> = {}): AlphaCandidateProfile {
  return {
    symbol: "ALFA",
    name: "Alpha Co.",
    runId: "alpha-run-1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    discoverySources: ["apewisdom"],
    sourceGroup: "apewisdom-only",
    sourceIds: ["apewisdom-ALFA"],
    exchange: "NMS",
    price: 10,
    volume: 1_000_000,
    marketCap: 500_000_000,
    socialRank: 5,
    socialMomentumScore: 80,
    mentions: 500,
    upvotes: 1500,
    fundamentals: {
      secCik: "0000320193",
      sourceIds: ["alpha-sec-fundamentals-alfa"],
      metrics: {
        revenueDeltaPercent: 25,
        netIncome: 10,
        operatingCashFlow: 20,
        debt: 100_000_000,
      },
    },
    ...overrides,
  };
}

function validationFile(overrides: Partial<AlphaValidationFile> = {}): AlphaValidationFile {
  return {
    runId: "alpha-run-1",
    validatedAt: "2026-06-01T00:00:00.000Z",
    generatedAt: "2026-05-01T00:00:00.000Z",
    benchmarkSymbol: "IWM",
    horizons: [5],
    leads: [
      {
        symbol: "ALFA",
        name: "Alpha Co.",
        discoverySources: ["apewisdom"],
        socialRank: 5,
        socialMomentumScore: 80,
        sourceGroup: "apewisdom-only",
        sourceIds: ["apewisdom-ALFA"],
        horizons: [resolvedHorizon(5, 0.1, "outperformed")],
      },
    ],
    ...overrides,
  };
}

function resolvedHorizon(
  horizonTradingDays: number,
  excessReturn: number,
  outcome: "outperformed" | "did-not-outperform",
): AlphaValidationFile["leads"][number]["horizons"][number] {
  return {
    status: "resolved",
    horizonTradingDays,
    benchmarkSymbol: "IWM",
    candidateClose0: 10,
    candidateCloseN: 11,
    benchmarkClose0: 100,
    benchmarkCloseN: 105,
    candidateDate0: "2026-05-01",
    candidateDateN: "2026-05-08",
    benchmarkDate0: "2026-05-01",
    benchmarkDateN: "2026-05-08",
    candidateReturn: 0.1,
    benchmarkReturn: 0.05,
    excessReturn,
    outcome,
  };
}

function unresolvedHorizon(
  horizonTradingDays: number,
): AlphaValidationFile["leads"][number]["horizons"][number] {
  return {
    status: "unresolved",
    horizonTradingDays,
    benchmarkSymbol: "IWM",
    reason: "observation-unavailable",
  };
}

describe("buildAlphaFeatureAttribution", () => {
  test("buckets deterministic profile features against resolved validation outcomes", () => {
    const attribution = buildAlphaFeatureAttribution({
      profiles: [
        profile(),
        profile({
          symbol: "BETA",
          price: 30,
          volume: 3_000_000,
          marketCap: 3_000_000_000,
          socialRank: 30,
          socialMomentumScore: 40,
          mentions: 2000,
          upvotes: 20_000,
          sourceGroup: "sec-only",
          discoverySources: ["sec-filings"],
          recentSecFilings: [{ form: "8-K", filingDate: "2026-05-02", sourceIds: ["sec-BETA"] }],
          fundamentals: {
            secCik: "0000000002",
            sourceIds: ["alpha-sec-fundamentals-beta"],
            metrics: {
              revenueDeltaPercent: -5,
              netIncome: -1,
              operatingCashFlow: -2,
              debt: 2_000_000_000,
            },
          },
        }),
      ],
      validations: [
        validationFile(),
        validationFile({
          runId: "alpha-run-1",
          leads: [
            {
              symbol: "BETA",
              discoverySources: ["sec-filings"],
              sourceGroup: "sec-only",
              sourceIds: ["sec-BETA"],
              horizons: [resolvedHorizon(5, -0.02, "did-not-outperform")],
            },
          ],
        }),
      ],
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(attribution).toMatchObject({
      generatedAt: "2026-06-02T00:00:00.000Z",
      benchmarkSymbol: "IWM",
      profileCount: 2,
      validatedProfileCount: 2,
    });
    expect(
      attribution.features.sourceGroup?.buckets["apewisdom-only"]?.horizons["5"],
    ).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 1,
      hitRate: 1,
      averageExcessReturn: 0.1,
    });
    expect(attribution.features.price?.buckets["gte-20"]?.horizons["5"]).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 0,
      averageExcessReturn: -0.02,
    });
    expect(attribution.features.secFilingForm?.buckets["8-K"]?.horizons["5"]).toMatchObject({
      resolvedCount: 1,
      averageExcessReturn: -0.02,
    });
    expect(
      attribution.features.revenueDeltaPercent?.buckets["gte-20"]?.horizons["5"],
    ).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 1,
    });
    expect(attribution.features.debtToMarketCap?.buckets["lt-25pct"]?.horizons["5"]).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 1,
    });
  });

  test("counts each SEC filing form once per profile horizon", () => {
    const attribution = buildAlphaFeatureAttribution({
      profiles: [
        profile({
          recentSecFilings: [
            { form: "8-K", filingDate: "2026-05-02", sourceIds: ["sec-1"] },
            { form: "8-K", filingDate: "2026-05-03", sourceIds: ["sec-2"] },
          ],
        }),
      ],
      validations: [validationFile()],
    });

    expect(attribution.features.secFilingForm?.buckets["8-K"]?.horizons["5"]).toMatchObject({
      totalCount: 1,
      resolvedCount: 1,
    });
  });

  test("treats debt-to-market-cap as missing when market cap is zero", () => {
    const attribution = buildAlphaFeatureAttribution({
      profiles: [profile({ marketCap: 0 })],
      validations: [validationFile()],
    });

    expect(attribution.features.debtToMarketCap?.buckets.missing?.horizons["5"]).toMatchObject({
      totalCount: 1,
      resolvedCount: 1,
    });
    expect(attribution.features.debtToMarketCap?.buckets["gte-100pct"]).toBeUndefined();
  });

  test("counts unresolved horizons without including them in hit-rate metrics", () => {
    const attribution = buildAlphaFeatureAttribution({
      profiles: [profile()],
      validations: [
        validationFile({
          leads: [
            {
              symbol: "ALFA",
              discoverySources: ["apewisdom"],
              sourceGroup: "apewisdom-only",
              sourceIds: ["apewisdom-ALFA"],
              horizons: [unresolvedHorizon(20)],
            },
          ],
        }),
      ],
    });

    expect(attribution.features.sourceGroup?.buckets["apewisdom-only"]?.horizons["20"]).toEqual({
      totalCount: 1,
      resolvedCount: 0,
      unresolvedCount: 1,
      outperformedCount: 0,
    });
  });

  test("renders attribution markdown without research-only violations", () => {
    const markdown = renderAlphaFeatureAttributionMarkdown(
      buildAlphaFeatureAttribution({
        profiles: [profile()],
        validations: [validationFile()],
        now: new Date("2026-06-02T00:00:00.000Z"),
      }),
    );

    expect(markdown).toContain("# Alpha Feature Attribution");
    expect(markdown).toContain("sourceGroup");
    expect(markdown).not.toMatch(/\b(promote|buy|sell|hold)\b/iu);
  });
});
