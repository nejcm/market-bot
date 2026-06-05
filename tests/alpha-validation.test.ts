import { describe, expect, test } from "bun:test";
import {
  buildAlphaValidationSummary,
  renderAlphaValidationSummaryMarkdown,
  validateAlphaSearchReport,
  type AlphaValidationFile,
} from "../src/alpha-search/validation";
import type { AlphaSearchLead } from "../src/alpha-search/report-extras";
import type { ResearchReport } from "../src/domain/types";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import { researchReport } from "./support/fixtures";

function lead(overrides: Partial<AlphaSearchLead> = {}): AlphaSearchLead {
  return {
    symbol: "ALFA",
    name: "Alpha Co.",
    exchange: "NMS",
    price: 10,
    volume: 1_000_000,
    marketCap: 500_000_000,
    discoverySources: ["apewisdom"],
    socialRank: 1,
    socialMomentumScore: 75,
    sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
    ...overrides,
  };
}

function alphaReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return researchReport({
    runId: "alpha-run-1",
    jobType: "alpha-search",
    assetClass: "equity",
    generatedAt: "2026-05-01T00:00:00.000Z",
    extras: {
      depth: "brief",
      socialCandidateCount: 1,
      secCandidateCount: 0,
      researchLeads: [lead()],
      rejectedCandidates: [],
    },
    ...overrides,
  });
}

function observationRepository(observations: readonly Observation[]): ObservationRepository {
  return {
    async point() {
      return observations.find(() => false);
    },

    async window(subject) {
      return observations
        .filter((observation) => observation.subject === subject)
        .toSorted((left, right) => left.date.localeCompare(right.date));
    },
  };
}

function closeWindow(subject: string, values: readonly number[]): readonly Observation[] {
  return values.map((value, index) => ({
    subject,
    date: `2026-05-${String(index + 1).padStart(2, "0")}`,
    value,
  }));
}

function datedWindow(
  subject: string,
  values: readonly (readonly [string, number])[],
): readonly Observation[] {
  return values.map(([date, value]) => ({ subject, date, value }));
}

describe("validateAlphaSearchReport", () => {
  test("resolves outperformance when candidate return beats IWM", async () => {
    const result = await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository: observationRepository([
        ...closeWindow("ALFA", [10, 10, 10, 10, 10, 12]),
        ...closeWindow("IWM", [100, 100, 100, 100, 100, 105]),
      ]),
      horizons: [5],
    });

    expect(result?.leads[0]?.horizons[0]).toMatchObject({
      status: "resolved",
      horizonTradingDays: 5,
      candidateReturn: 0.2,
      benchmarkReturn: 0.05,
      excessReturn: 0.15,
      outcome: "outperformed",
    });
  });

  test("resolves underperformance when IWM return is greater or equal", async () => {
    const result = await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository: observationRepository([
        ...closeWindow("ALFA", [10, 10, 10, 10, 10, 10.5]),
        ...closeWindow("IWM", [100, 100, 100, 100, 100, 110]),
      ]),
      horizons: [5],
    });

    expect(result?.leads[0]?.horizons[0]).toMatchObject({
      status: "resolved",
      candidateReturn: 0.05,
      benchmarkReturn: 0.1,
      excessReturn: -0.05,
      outcome: "did-not-outperform",
    });
  });

  test("resolves 5 day horizon while 20 day horizon remains unavailable", async () => {
    const result = await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository: observationRepository([
        ...closeWindow("ALFA", [10, 10, 10, 10, 10, 11]),
        ...closeWindow("IWM", [100, 100, 100, 100, 100, 101]),
      ]),
      horizons: [5, 20],
    });

    expect(result?.leads[0]?.horizons).toMatchObject([
      { status: "resolved", horizonTradingDays: 5 },
      {
        status: "unresolved",
        horizonTradingDays: 20,
        reason: "observation-unavailable",
      },
    ]);
  });

  test("keeps horizon unresolved when candidate or benchmark closes are missing", async () => {
    const result = await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository: observationRepository(closeWindow("ALFA", [10, 10, 10, 10, 10, 11])),
      horizons: [5],
    });

    expect(result?.leads[0]?.horizons[0]).toMatchObject({
      status: "unresolved",
      reason: "observation-unavailable",
      missingInstruments: ["IWM"],
    });
  });

  test("fetches each close window once across horizons", async () => {
    const calls: string[] = [];
    const repository: ObservationRepository = {
      async point() {
        throw new Error("unexpected point observation request");
      },
      async window(subject) {
        calls.push(subject);
        const values =
          subject === "ALFA"
            ? Array.from({ length: 21 }, (_, index) => (index === 20 ? 12 : 10))
            : Array.from({ length: 21 }, (_, index) => (index === 20 ? 105 : 100));
        return closeWindow(subject, values);
      },
    };

    await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository,
      horizons: [5, 20],
    });

    expect(calls.toSorted()).toEqual(["ALFA", "IWM"]);
  });

  test("aligns candidate and benchmark horizon closes by common date", async () => {
    const result = await validateAlphaSearchReport({
      report: alphaReport(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      repository: observationRepository([
        ...datedWindow("ALFA", [
          ["2026-05-01", 10],
          ["2026-05-02", 10],
          ["2026-05-05", 10],
          ["2026-05-06", 10],
          ["2026-05-07", 10],
          ["2026-05-08", 50],
          ["2026-05-12", 12],
        ]),
        ...datedWindow("IWM", [
          ["2026-05-01", 100],
          ["2026-05-02", 100],
          ["2026-05-05", 100],
          ["2026-05-06", 100],
          ["2026-05-07", 100],
          ["2026-05-11", 200],
          ["2026-05-12", 105],
        ]),
      ]),
      horizons: [5],
    });

    expect(result?.leads[0]?.horizons[0]).toMatchObject({
      status: "resolved",
      candidateDateN: "2026-05-12",
      benchmarkDateN: "2026-05-12",
      candidateReturn: 0.2,
      benchmarkReturn: 0.05,
    });
  });

  test("defers horizon resolution across an exchange holiday instead of firing early", async () => {
    const repository: ObservationRepository = {
      async point() {
        throw new Error("unexpected point observation request");
      },
      async window() {
        throw new Error("unexpected window observation request");
      },
    };

    // From Wed 2026-07-01, two trading days land on Mon 2026-07-06.
    // Fri 2026-07-03 is the observed Independence Day closure and not a session.
    // The supplied `now` (Sat 2026-07-04) sits before that second session, so resolution defers.
    const result = await validateAlphaSearchReport({
      report: alphaReport({ generatedAt: "2026-07-01T00:00:00.000Z" }),
      now: new Date("2026-07-04T00:00:00.000Z"),
      repository,
      horizons: [2],
    });

    expect(result?.leads[0]?.horizons[0]).toMatchObject({
      status: "unresolved",
      horizonTradingDays: 2,
      reason: "horizon-not-elapsed",
    });
  });
});

describe("buildAlphaValidationSummary", () => {
  test("aggregates resolved outcomes by horizon overall and source group", () => {
    const summary = buildAlphaValidationSummary(
      [
        validationFile({
          leads: [
            validationLead({
              symbol: "ALFA",
              sourceGroup: "apewisdom-only",
              horizons: [resolvedHorizon(5, 0.1, "outperformed"), unresolvedHorizon(20)],
            }),
            validationLead({
              symbol: "BRAV",
              sourceGroup: "sec-only",
              discoverySources: ["sec-filings"],
              horizons: [resolvedHorizon(5, -0.02, "did-not-outperform")],
            }),
            validationLead({
              symbol: "BOTH",
              sourceGroup: "apewisdom+sec",
              discoverySources: ["apewisdom", "sec-filings"],
              horizons: [resolvedHorizon(20, 0.03, "outperformed")],
            }),
          ],
        }),
      ],
      new Date("2026-06-02T00:00:00.000Z"),
    );

    expect(summary.overall["5"]).toMatchObject({
      totalCount: 2,
      resolvedCount: 2,
      unresolvedCount: 0,
      outperformedCount: 1,
      hitRate: 0.5,
      averageExcessReturn: 0.04,
    });
    expect(summary.overall["20"]).toMatchObject({
      totalCount: 2,
      resolvedCount: 1,
      unresolvedCount: 1,
      outperformedCount: 1,
      hitRate: 1,
      averageExcessReturn: 0.03,
    });
    expect(summary.bySourceGroup["sec-only"]?.["5"]).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 0,
      averageExcessReturn: -0.02,
    });
  });

  test("labels source promotion criteria from conservative thresholds", () => {
    const leads = [
      ...Array.from({ length: 17 }, (_, index) =>
        validationLead({
          symbol: `WIN${String(index)}`,
          horizons: [resolvedHorizon(5, 0.04, "outperformed")],
        }),
      ),
      ...Array.from({ length: 13 }, (_, index) =>
        validationLead({
          symbol: `MIX${String(index)}`,
          horizons: [resolvedHorizon(5, -0.01, "did-not-outperform")],
        }),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        validationLead({
          symbol: `BAD${String(index)}`,
          sourceGroup: "sec-only",
          discoverySources: ["sec-filings"],
          horizons: [resolvedHorizon(5, -0.02, "did-not-outperform")],
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        validationLead({
          symbol: `SEC${String(index)}`,
          sourceGroup: "sec-only",
          discoverySources: ["sec-filings"],
          horizons: [resolvedHorizon(5, 0.01, "outperformed")],
        }),
      ),
      validationLead({
        symbol: "SMALL",
        sourceGroup: "apewisdom+sec",
        discoverySources: ["apewisdom", "sec-filings"],
        horizons: [resolvedHorizon(5, 0.1, "outperformed")],
      }),
    ];

    const summary = buildAlphaValidationSummary(
      [validationFile({ leads })],
      new Date("2026-06-02T00:00:00.000Z"),
    );

    expect(summary.sourcePromotionCriteria.thresholds).toEqual({
      minimumResolvedCount: 30,
      promisingHitRate: 0.55,
      weakHitRate: 0.45,
    });
    expect(summary.sourcePromotionCriteria.bySourceGroup["apewisdom-only"]?.["5"]).toMatchObject({
      status: "promising",
      resolvedCount: 30,
      hitRate: 0.566_667,
      averageExcessReturn: 0.018_333,
    });
    expect(summary.sourcePromotionCriteria.bySourceGroup["sec-only"]?.["5"]).toMatchObject({
      status: "weak",
      resolvedCount: 30,
      hitRate: 0.333_333,
      averageExcessReturn: -0.01,
    });
    expect(summary.sourcePromotionCriteria.bySourceGroup["apewisdom+sec"]?.["5"]).toMatchObject({
      status: "insufficient-sample",
      resolvedCount: 1,
    });
  });

  test("blocks source promotion criteria when prerequisite validation fails", () => {
    const summary = buildAlphaValidationSummary(
      [
        validationFile({
          leads: Array.from({ length: 30 }, (_, index) =>
            validationLead({
              symbol: `WIN${String(index)}`,
              horizons: [resolvedHorizon(5, 0.04, "outperformed")],
            }),
          ),
        }),
      ],
      new Date("2026-06-02T00:00:00.000Z"),
      {
        providerHealthStatus: "fail",
        blockingIssueCount: 2,
        unmetRequiredCoverage: ["daily-equity"],
      },
    );

    expect(summary.sourcePromotionCriteria.prerequisites).toEqual({
      status: "blocked",
      providerHealthStatus: "fail",
      blockingIssueCount: 2,
      unmetRequiredCoverage: ["daily-equity"],
    });
    expect(summary.sourcePromotionCriteria.bySourceGroup["apewisdom-only"]?.["5"]).toMatchObject({
      status: "blocked-prerequisite",
      resolvedCount: 30,
    });

    const malformedStatusSummary = buildAlphaValidationSummary(
      [
        validationFile({
          leads: [validationLead({ horizons: [resolvedHorizon(5, 0.04, "outperformed")] })],
        }),
      ],
      new Date("2026-06-02T00:00:00.000Z"),
      { blockingIssueCount: 1 },
    );
    expect(malformedStatusSummary.sourcePromotionCriteria.prerequisites.status).toBe("blocked");
  });

  test("renders alpha validation summary markdown", () => {
    const markdown = renderAlphaValidationSummaryMarkdown(
      buildAlphaValidationSummary(
        [
          validationFile({
            leads: [
              validationLead({
                horizons: [resolvedHorizon(5, 0.1, "outperformed")],
              }),
            ],
          }),
        ],
        new Date("2026-06-02T00:00:00.000Z"),
      ),
    );

    expect(markdown).toContain("# Alpha Validation Summary");
    expect(markdown).toContain("Benchmark: IWM");
    expect(markdown).toContain("apewisdom-only");
    expect(markdown).toContain("## Source Promotion Criteria");
    expect(markdown).toContain("insufficient-sample");
  });
});

function validationFile(overrides: Partial<AlphaValidationFile> = {}): AlphaValidationFile {
  return {
    runId: "alpha-run-1",
    validatedAt: "2026-06-01T00:00:00.000Z",
    generatedAt: "2026-05-01T00:00:00.000Z",
    benchmarkSymbol: "IWM",
    horizons: [5, 20],
    leads: [],
    ...overrides,
  };
}

function validationLead(
  overrides: Partial<AlphaValidationFile["leads"][number]> = {},
): AlphaValidationFile["leads"][number] {
  return {
    symbol: "ALFA",
    name: "Alpha Co.",
    discoverySources: ["apewisdom"],
    socialRank: 1,
    socialMomentumScore: 75,
    sourceGroup: "apewisdom-only",
    sourceIds: ["apewisdom-ALFA"],
    horizons: [],
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
