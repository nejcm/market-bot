import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseObservableExpression } from "../src/forecast/observable";
import { isRecord } from "../src/guards";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";
import { readGoldenOutput, scrubbedRunArtifacts } from "./support/run-fixtures/artifacts";
import {
  loadFixture,
  runFixture,
  type FixtureMeta,
  type RunFixtureResult,
} from "./support/run-fixtures";

const FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
] as const;

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
    ["6-K", "interim-filing"],
    ["6-K", "interim-exhibit"],
    ["6-K", "interim-exhibit"],
  ]);
  for (const input of manifest.inputs) {
    const body = await readFile(join(root, "unsupported-inputs", input.file));
    expect(body.byteLength).toBe(input.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(input.sha256);
    expect(input.structuredSupport).toBe("unsupported");
  }
}

function assertComprehensiveAnalysisPath(result: RunFixtureResult): void {
  expect(populatedFinancialHistoryCount(result)).toBe(11);
  expect(result.collectedSources.valuationComps?.impliedPriceRange?.status).toBe("derived");
  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: {
      symbol: "AAPL",
      date: "2026-07-10",
      dateStatus: "provider-estimated",
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
  expect(result.report.predictions.map((prediction) => prediction.kind)).toEqual([
    "earnings-direction",
    "earnings-move",
  ]);
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

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const result = await runFixture(name, { llm: "replay" });
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
      }
      if (name === "equity-fpi-quarterly") {
        expect(factTaxonomies(result)).toEqual(["us-gaap"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
        assertLegacyFpiSourceGap(result, "FPIQ");
        expect(populatedFinancialHistoryCount(result)).toBe(7);
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
      }
      if (name === "equity-fpi-ifrs-semiannual") {
        expect(factTaxonomies(result)).toEqual(["ifrs-full"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
        assertLegacyFpiSourceGap(result, "IFRSSA");
        expect(populatedFinancialHistoryCount(result)).toBe(7);
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
        expect(result.report.equityAnalysisCompleteness?.financialCoreStatus).toBe("complete");
        expect(
          result.collectedSources.financialLenses?.lenses.find((lens) => lens.name === "Quality"),
        ).toMatchObject({ posture: "criteria-supported" });
      }
      if (name === "equity-analysis-comprehensive") {
        assertComprehensiveAnalysisPath(result);
        expect(result.report.equityAnalysisCompleteness).toMatchObject({
          financialCoreStatus: "complete",
          coverageLevel: "comprehensive",
        });
      }
      expect(await scrubbedRunArtifacts(result.artifacts.runDir)).toEqual(
        await readGoldenOutput(name),
      );
    });
  }
});
