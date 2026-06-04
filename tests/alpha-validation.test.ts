import { describe, expect, test } from "bun:test";
import { validateAlphaSearchReport } from "../src/alpha-search/validation";
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
});
