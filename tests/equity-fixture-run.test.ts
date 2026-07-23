import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseObservableExpression } from "../src/forecast/observable";
import { isRecord } from "../src/guards";
import type { ModelRequest } from "../src/model/types";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";
import { readGoldenOutput, scrubbedRunArtifacts } from "./support/run-fixtures/artifacts";
import {
  loadFixture,
  runFixture,
  type FixtureMeta,
  type RunFixtureResult,
} from "./support/run-fixtures";
import { makeReplayProvider } from "./support/run-fixtures/llm-cassette";

const FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
] as const;

const CAPTURE_EARNINGS_FIXTURES = new Set<string>([
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
]);

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

function assertInvariants(result: RunFixtureResult, name: string, meta: FixtureMeta): void {
  const report = validateResearchReport(result.report);
  assertSafeReportLanguage(report);
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
  expect(result.sourcePlan).toBeDefined();
  expect(result.evidenceLanes.summary.plannedLaneCount).toBeGreaterThan(0);
  expect(result.analytics.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
  expect(result.collectedSources.valuationWorkbench).toMatchObject({
    version: 1,
    symbol: report.symbol,
  });
  expect(result.collectedSources.reverseDcf).toMatchObject({
    version: 1,
    symbol: report.symbol,
  });
  expect(result.stageOutputs.every((output) => (output.durationMs ?? 0) > 0)).toBe(true);
  expect(result.trace.stageRecords?.every((record) => (record.durationMs ?? 0) > 0)).toBe(true);
  expect(result.analytics.runShape.stages.every((stage) => (stage.durationMs ?? 0) > 0)).toBe(true);
  if (meta.argv.includes("--deep")) {
    expect(result.stageOutputs.map((output) => output.stage)).toEqual(
      expect.arrayContaining(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    if ((meta.challengerModels ?? []).length > 0) {
      expect(result.trace.forecastDisagreement?.challengerModelCount).toBe(
        meta.challengerModels?.length,
      );
    }
  }
}

function assertAaplPopulatedPath(result: RunFixtureResult): void {
  const history = result.collectedSources.fundamentalHistory;
  expect(history?.series.revenue.annual.map((point) => point.value)).toEqual([
    383_000_000_000, 391_000_000_000, 405_000_000_000,
  ]);
  expect(history?.series.revenue.ttm).toMatchObject({
    value: 426_000_000_000,
    form: "TTM",
    periodStart: "2025-04-01",
    periodEnd: "2026-03-31",
    currency: "USD",
  });
  expect(history?.series.dilutedEps.ttm?.value).toBeCloseTo(7.6, 10);
  expect(history?.series.freeCashFlowProxy.ttm?.value).toBe(118_000_000_000);
  expect(
    Object.values(history?.series ?? {}).map((series) => ({
      key: series.key,
      annualCount: series.annual.length,
      ttmPopulated: series.ttm !== undefined,
    })),
  ).toEqual([
    { key: "revenue", annualCount: 3, ttmPopulated: true },
    { key: "grossProfit", annualCount: 3, ttmPopulated: true },
    { key: "operatingIncome", annualCount: 3, ttmPopulated: true },
    { key: "netIncome", annualCount: 3, ttmPopulated: true },
    { key: "dilutedEps", annualCount: 3, ttmPopulated: true },
    { key: "operatingCashFlow", annualCount: 3, ttmPopulated: true },
    { key: "capex", annualCount: 3, ttmPopulated: true },
    { key: "freeCashFlowProxy", annualCount: 3, ttmPopulated: true },
    { key: "grossMargin", annualCount: 3, ttmPopulated: true },
    { key: "operatingMargin", annualCount: 3, ttmPopulated: true },
    { key: "netMargin", annualCount: 3, ttmPopulated: true },
  ]);
  expect(result.collectedSources.valuationComps?.impliedPriceRange).toMatchObject({
    status: "derived",
    low: 145.597_222_222_222_23,
    mid: 204.766_666_666_666_68,
    high: 264.733_333_333_333_35,
    position: "within-range",
    inputs: {
      annualizedRevenue: 420_000_000_000,
      netDebt: 40_000_000_000,
      sharesOutstanding: 15_000_000_000,
      currentPrice: 198.5,
      quoteCurrency: "USD",
    },
  });
  expect(result.collectedSources.earningsSetup).toBeUndefined();
  expect(result.report.predictions).toHaveLength(0);

  const statements = result.collectedSources.financialStatements;
  expect(statements).toMatchObject({
    version: 1,
    taxonomy: "us-gaap",
    reportingCurrency: "USD",
    interimCadence: "quarterly",
    shadowParity: {
      status: "matched",
      matchedCount: 33,
      explainedCount: 0,
      unexplainedCount: 0,
    },
  });
  expect(statements?.statements.incomeStatement.revenue.ttm).toMatchObject({
    value: 426_000_000_000,
    formula: "FY + latest-YTD - prior-YTD",
    components: {
      fiscalYear: { value: 405_000_000_000 },
      latestYearToDate: { value: 210_000_000_000 },
      priorYearToDate: { value: 189_000_000_000 },
    },
  });
  const workbench = result.collectedSources.valuationWorkbench;
  expect(workbench).toMatchObject({
    reportingCurrency: "USD",
    quoteCurrency: "USD",
    historicalMultiples: {
      trailingBasis: {
        status: "available",
        periodEnd: "2026-03-31",
        publicAt: "2026-05-01",
      },
    },
    peerComparison: {
      status: "available",
      valuationComps: {
        summary: { valuationSupportability: "supported", usablePeerCount: 4 },
        impliedPriceRange: { status: "derived" },
      },
    },
  });
  const ttmValuation = workbench?.historicalMultiples.observations.find(
    (observation) => observation.basis === "ttm",
  );
  expect(ttmValuation).toMatchObject({
    periodEnd: "2026-03-31",
    publicAt: "2026-05-01",
    price: { sessionDate: "2026-05-01", close: 216.6, currency: "USD" },
    metrics: {
      priceToEarnings: { status: "populated", display: "28.50x" },
      priceToSales: { status: "populated", display: "7.76x" },
      enterpriseValueToRevenue: { status: "populated", display: "7.85x" },
      priceToFreeCashFlow: { status: "populated", display: "28.02x" },
    },
  });
  expect(result.collectedSources.reverseDcf).toMatchObject({
    status: "computed",
    assumptions: {
      startingFcf: {
        value: 118_000_000_000,
        currency: "USD",
        periodEnd: "2026-03-31",
        publicAt: "2026-05-01",
      },
      enterpriseValue: {
        value: 3_040_000_000_000,
        currency: "USD",
        observedAt: "2026-06-15T14:30:00.000Z",
      },
      horizonYears: 5,
      discountRatesPct: [8, 9, 10, 11, 12, 13, 14, 15, 16],
      terminalGrowthRatesPct: [0, 1, 2, 3, 4],
    },
    grid: {
      value: "solved five-year FCF growth",
      unit: "percent",
    },
  });
  expect(
    result.collectedSources.reverseDcf?.status === "computed"
      ? result.collectedSources.reverseDcf.grid.rows
      : [],
  ).toHaveLength(9);
}

function assertStatementCapsAndParity(result: RunFixtureResult): void {
  const artifact = result.collectedSources.financialStatements;
  expect(artifact).toBeDefined();
  const series =
    artifact === undefined
      ? []
      : [
          ...Object.values(artifact.statements.incomeStatement),
          ...Object.values(artifact.statements.balanceSheet),
          ...Object.values(artifact.statements.cashFlowStatement),
          ...Object.values(artifact.statements.perShare),
        ];
  expect(series.every((item) => item.annual.length <= 10)).toBe(true);
  expect(series.every((item) => item.interim.length <= 12)).toBe(true);
  expect(
    new Set(series.flatMap((item) => item.annual.map((fact) => fact.periodKey))).size,
  ).toBeLessThanOrEqual(10);
  expect(
    new Set(series.flatMap((item) => item.interim.map((fact) => fact.periodKey))).size,
  ).toBeLessThanOrEqual(12);
  expect(artifact?.shadowParity.unexplainedCount).toBe(0);
}

function factTaxonomies(result: RunFixtureResult): readonly string[] {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  if (!isRecord(snapshot?.payload) || !isRecord(snapshot.payload.facts)) {
    return [];
  }
  return Object.keys(snapshot.payload.facts);
}

function factForms(result: RunFixtureResult): ReadonlySet<string> {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  const forms = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.form === "string") {
      forms.add(value.form);
    }
    Object.values(value).forEach((item) => visit(item));
  };
  visit(snapshot?.payload);
  return forms;
}

function populatedFinancialHistoryCount(result: RunFixtureResult): number {
  return Object.values(result.collectedSources.fundamentalHistory?.series ?? {}).filter(
    (series) => series.annual.length > 0 || series.ttm !== undefined,
  ).length;
}

function assertLegacyFpiSourceGap(result: RunFixtureResult, symbol: string): void {
  expect(
    result.collectedSources.sourceGaps.some(
      (gap) =>
        gap.cause === "unsupported-coverage" &&
        gap.message ===
          `${symbol} files as a foreign private issuer (20-F, 6-K); these forms are not yet supported`,
    ),
  ).toBe(true);
}

interface UnsupportedInputManifest {
  readonly inputs: readonly {
    readonly file: string;
    readonly form: string;
    readonly role: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly structuredSupport: string;
  }[];
}

async function assertNbisUnsupportedInputs(): Promise<void> {
  const root = join(import.meta.dir, "fixtures", "runs", "equity-nbis-deep");
  const manifest = JSON.parse(
    await readFile(join(root, "unsupported-inputs.json"), "utf8"),
  ) as UnsupportedInputManifest;
  expect(manifest.inputs.map((input) => [input.form, input.role])).toEqual([
    ["20-F", "annual-filing"],
    ["6-K", "filing-index"],
    ["6-K", "interim-filing"],
    ["6-K", "interim-exhibit"],
    ["6-K", "interim-exhibit"],
  ]);
  for (const input of manifest.inputs) {
    const body = await readFile(join(root, "unsupported-inputs", input.file));
    expect(body.byteLength).toBe(input.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(input.sha256);
    expect(["unsupported", "discovery", "phase-3-candidate"]).toContain(input.structuredSupport);
  }
}

function assertComprehensiveAnalysisPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
): void {
  expect(populatedFinancialHistoryCount(result)).toBe(11);
  expect(result.collectedSources.valuationComps?.impliedPriceRange?.status).toBe("derived");
  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: {
      symbol: "AAPL",
      date: "2026-07-10",
      eventDateStatus: "issuer-confirmed",
      dateConfirmation: {
        sourceId: "news-equity-1",
        sourceType: "issuer-press-release",
        issuerIdentity: { symbol: "AAPL", matchedBy: "official-host" },
      },
    },
    impliedMove: {
      expiration: "2026-07-17",
      strike: 200,
      spot: 198.5,
      straddleMidpoint: 7,
    },
    gaps: [],
  });
  expect(result.collectedSources.earningsSetup?.impliedMove?.impliedMovePct).toBeCloseTo(
    0.035_264_483_627_204_03,
    12,
  );
  expect(result.report.predictions).toEqual([
    expect.objectContaining({
      id: "aapl-earnings-direction",
      kind: "earnings-direction",
      eventDateStatus: "issuer-confirmed",
      measurableAs: "earningsReturn(AAPL, 2026-07-10, +1) > 0",
    }),
    expect.objectContaining({
      id: "aapl-earnings-move",
      kind: "earnings-move",
      eventDateStatus: "issuer-confirmed",
      measurableAs: "abs(earningsReturn(AAPL, 2026-07-10, +1)) > 0.035",
    }),
  ]);
  expect(result.report.dataGaps).not.toContain(
    "earningsForecastGate: earnings-return predictions suppressed because the event date is provider-estimated; official issuer or direct exchange confirmation is required",
  );
  expect(result.analytics.earningsForecasts).toEqual({
    eventDateStatus: "issuer-confirmed",
    policy: "confirmed-only",
    grammarEligible: true,
    eligiblePredictionCount: 2,
    suppressedPredictionCount: 0,
  });
  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain("earnings-direction");
  expect(finalSynthesisPrompt).toContain("earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0");
  expect(result.collectedSources.extendedEvidence?.items.map((item) => item.category)).toEqual(
    expect.arrayContaining([
      "sec-edgar",
      "equity-events",
      "options-iv",
      "valuation",
      "yahoo-fundamentals",
      "financial-lens",
      "business-framework",
    ]),
  );
}

function assertEstimatedEarningsSuppressionPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
  modelOutputs: readonly string[],
): void {
  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: {
      symbol: "AAPL",
      date: "2026-07-10",
      eventDateStatus: "provider-estimated",
    },
  });

  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain(
    "Do not emit earnings-direction, earnings-move, or earningsReturn grammar",
  );
  expect(finalSynthesisPrompt).not.toContain(
    "earnings-direction or earnings-move (event-anchored)",
  );
  expect(finalSynthesisPrompt).not.toContain("kind earnings-direction with measurableAs");
  expect(finalSynthesisPrompt).not.toContain("kind earnings-move with measurableAs");
  expect(finalSynthesisPrompt).toContain('"kind": "direction|relative|iv|range|macro|conditional"');

  expect(
    modelOutputs.some(
      (output) =>
        output.includes('"kind":"earnings-direction"') && output.includes('"kind":"earnings-move"'),
    ),
  ).toBe(true);
  expect(
    result.report.predictions.filter((prediction) => prediction.kind.startsWith("earnings-")),
  ).toEqual([]);
  expect(result.analytics.earningsForecasts).toEqual({
    eventDateStatus: "provider-estimated",
    policy: "confirmed-only",
    grammarEligible: false,
    eligiblePredictionCount: 0,
    suppressedPredictionCount: 2,
    suppressionReason: "event-date-not-confirmed",
  });
  expect(result.report.dataGaps).toContain(
    "earningsForecastGate: earnings-return predictions suppressed because the event date is provider-estimated; official issuer or direct exchange confirmation is required",
  );
}

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const modelRequests: ModelRequest[] = [];
      const modelOutputs: string[] = [];
      const replayProvider = makeReplayProvider(fixture.llmCassette);
      const result = await runFixture(name, {
        llm: "replay",
        ...(CAPTURE_EARNINGS_FIXTURES.has(name)
          ? {
              provider: {
                name: replayProvider.name,
                generate: async (request: ModelRequest) => {
                  modelRequests.push(request);
                  const response = await replayProvider.generate(request);
                  modelOutputs.push(response.content);
                  return response;
                },
              },
            }
          : {}),
      });
      runResults.push(result);

      assertInvariants(result, name, fixture.meta);
      assertStatementCapsAndParity(result);
      if (name === "equity-aapl-deep") {
        assertAaplPopulatedPath(result);
        expect(result.report.equityAnalysisCompleteness?.financialCoreStatus).toBe("complete");
      }
      if (name === "equity-nbis-deep") {
        expect(factTaxonomies(result)).toContain("us-gaap");
        expect(factForms(result).has("20-F")).toBe(true);
        assertLegacyFpiSourceGap(result, "NBIS");
        expect(populatedFinancialHistoryCount(result)).toBe(9);
        await assertNbisUnsupportedInputs();
        expect(result.collectedSources.financialStatements).toMatchObject({
          taxonomy: "us-gaap",
          reportingCurrency: "USD",
          interimCadence: "annual-only",
          shadowParity: {
            status: "explained",
            matchedCount: 0,
            explainedCount: 2,
            unexplainedCount: 0,
          },
        });
        expect(
          result.collectedSources.financialStatements?.statements.incomeStatement.revenue.annual,
        ).toHaveLength(5);
        expect(result.collectedSources.financialStatements?.structuredFinancialGaps).toContainEqual(
          expect.objectContaining({
            code: "untagged-6-k",
            sourceIds: ["extended-sec-edgar-nbis-filings"],
          }),
        );
        expect(result.collectedSources.untaggedFinancialStatements).toMatchObject({
          symbol: "NBIS",
          filing: {
            accessionNumber: "0001104659-26-064092",
            documentName: "nbis-20260331xex99d2.htm",
          },
          validation: {
            status: "accepted",
            acceptedStatements: ["incomeStatement", "balanceSheet", "cashFlowStatement"],
          },
          completenessGate: { passed: false },
        });
        expect(result.collectedSources.untaggedFinancialStatements?.validation.values).toHaveLength(
          14,
        );
        expect(
          result.collectedSources.untaggedFinancialStatements?.validation.values.every(
            (value) => value.extractionMethod === "model-validated-table",
          ),
        ).toBe(true);
        expect(result.report.equityAnalysisCompleteness).toMatchObject({
          financialCoreStatus: "partial",
          dimensions: {
            primaryFinancials: {
              reasonCodes: expect.arrayContaining([
                "cadence-unestablished",
                "untagged-interim-evidence",
              ]),
            },
          },
        });
        expect(
          result.collectedSources.extendedEvidence?.items.find(
            (item) => item.category === "valuation",
          ),
        ).toMatchObject({
          sourceIds: expect.arrayContaining(["extended-sec-edgar-nbis-fundamentals"]),
        });
      }
      if (name === "equity-fpi-quarterly") {
        expect(factTaxonomies(result)).toEqual(["us-gaap"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
        assertLegacyFpiSourceGap(result, "FPIQ");
        expect(populatedFinancialHistoryCount(result)).toBe(9);
        expect(result.collectedSources.financialStatements).toMatchObject({
          taxonomy: "us-gaap",
          reportingCurrency: "USD",
          interimCadence: "quarterly",
          shadowParity: { status: "explained", explainedCount: 2, unexplainedCount: 0 },
        });
        expect(
          result.collectedSources.financialStatements?.statements.incomeStatement.revenue.ttm,
        ).toMatchObject({
          value: 1_620_000_000,
          components: {
            fiscalYear: { value: 1_500_000_000 },
            latestYearToDate: { value: 420_000_000 },
            priorYearToDate: { value: 300_000_000 },
          },
        });
        expect(result.report.equityAnalysisCompleteness?.financialCoreStatus).toBe("complete");
        expect(
          result.collectedSources.financialLenses?.lenses.find((lens) => lens.name === "Quality"),
        ).toMatchObject({ posture: "criteria-supported" });
        expect(result.report.dataGaps).not.toContain(
          "valuation: Valuation Evidence unavailable for FPIQ: missing cash, debt",
        );
      }
      if (name === "equity-fpi-ifrs-semiannual") {
        expect(factTaxonomies(result)).toEqual(["ifrs-full"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
        assertLegacyFpiSourceGap(result, "IFRSSA");
        expect(populatedFinancialHistoryCount(result)).toBe(9);
        expect(result.collectedSources.financialStatements).toMatchObject({
          taxonomy: "ifrs-full",
          reportingCurrency: "USD",
          interimCadence: "semiannual",
          shadowParity: { status: "explained", explainedCount: 2, unexplainedCount: 0 },
        });
        expect(
          result.collectedSources.financialStatements?.statements.incomeStatement.revenue.interim,
        ).toEqual([
          expect.objectContaining({ periodStart: "2025-01-01", periodEnd: "2025-06-30" }),
        ]);
        expect(result.collectedSources.financialStatements?.validationNotes).toContainEqual(
          expect.objectContaining({ code: "unreconciled-ttm", seriesKey: "revenue" }),
        );
        expect(
          result.collectedSources.valuationWorkbench?.historicalMultiples.trailingBasis,
        ).toMatchObject({
          status: "suppressed",
          reason: "canonical-ttm-unavailable",
          detail: expect.stringContaining("not combined into an unreconciled TTM"),
        });
        expect(result.collectedSources.reverseDcf).toMatchObject({
          status: "suppressed",
          reason: "reconciled-ttm-fcf-unavailable",
        });
        expect(result.report.equityAnalysisCompleteness?.financialCoreStatus).toBe("complete");
        expect(
          result.collectedSources.financialLenses?.lenses.find((lens) => lens.name === "Quality"),
        ).toMatchObject({ posture: "criteria-supported" });
        expect(result.report.dataGaps).not.toContain(
          "valuation: Valuation Evidence unavailable for IFRSSA: missing cash, debt",
        );
      }
      if (name === "equity-analysis-comprehensive") {
        assertComprehensiveAnalysisPath(result, modelRequests);
        expect(result.report.equityAnalysisCompleteness).toMatchObject({
          financialCoreStatus: "complete",
          coverageLevel: "substantial",
          dimensions: {
            capitalOwnership: {
              status: "partial",
              reasonCodes: [
                "diluted-share-history-missing",
                "sbc-history-missing",
                "payout-evidence-missing",
              ],
            },
          },
        });
      }
      if (name === "equity-analysis-estimated-suppressed") {
        assertEstimatedEarningsSuppressionPath(result, modelRequests, modelOutputs);
        expect(result.report.equityAnalysisCompleteness).toMatchObject({
          financialCoreStatus: "complete",
          coverageLevel: "substantial",
        });
      }
      expect(await scrubbedRunArtifacts(result.artifacts.runDir)).toEqual(
        await readGoldenOutput(name),
      );
    });
  }
});
