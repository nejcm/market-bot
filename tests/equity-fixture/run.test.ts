import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRequest } from "../../src/model/types";
import {
  assertComprehensiveAnalysisPath,
  assertClfdTaggedZeroDebt,
  assertEbayExtensionShortTermInvestments,
  assertCurrencyConvertedValuation,
  assertDepositoryEnterpriseValueAbsent,
  assertEstimatedEarningsSuppressionPath,
  assertInvariants,
  assertIntegrityPruneInvariant,
  assertQuarterlyCapexProof,
  assertIrenExtensionCapexWithheld,
  assertMarketRegimeRendered,
  assertMetricPromptCatalog,
  assertNbisUnsupportedInputs,
  assertProviderGapRestatementsDropped,
  factForms,
  factTaxonomies,
} from "../support/run-fixtures/assertions";
import {
  EQUITY_RUN_FIXTURES,
  fixtureCommand,
  isDeepFixture,
  loadFixture,
  runFixture,
  type RunFixtureResult,
} from "../../src/replay/fixture-run";
import { makeReplayProvider } from "../../src/replay/llm-cassette";
import { countCassetteMisses, makeReplayFetch } from "../../src/replay/data-cassette";
import { violatesResearchOnly } from "../../src/domain/research-language";
import { validateResearchReport } from "../../src/report/schema";
import { deriveFundamentalHistoryFromFinancialStatements } from "../../src/sources/extended-evidence/fundamental-history-canonical";
import { deriveFinancialStatements } from "../../src/sources/extended-evidence/financial-statements";
import { addFinancialLensEvidence } from "../../src/sources/extended-evidence/financial-lens";
import { withCanonicalFinancialLensInputs } from "../../src/sources/extended-evidence/financial-lens-canonical";
import { RUN_ARTIFACT_FILES } from "../../src/run-artifact-layout";
import { renderMarkdownReport } from "../../src/report/markdown";
import type { MetricSectionsExtra } from "../../src/report/report-extras-contract";
import { projectExtendedEvidenceReportExtras } from "../../src/research/extended-evidence-projections";
import { newsSource } from "../support/fixtures";
import { splitAdjustedObservationsFromYahooChart } from "../../src/sources/yahoo-chart";
import { exchangeProfileFor } from "../../src/domain/exchange-profile";

const EXPECTED_COMPLETENESS_GRADES = {
  "equity-aapl-brief": ["blocked", "limited"],
  "equity-aapl-brief-prune": ["blocked", "limited"],
  "equity-aapl-deep": ["complete", "limited"],
  "equity-earnings-release-deep": ["complete", "substantial"],
  "equity-nbis-deep": ["partial", "limited"],
  "equity-fpi-quarterly": ["complete", "limited"],
  "equity-fpi-ifrs-semiannual": ["complete", "limited"],
  "equity-analysis-comprehensive": ["complete", "substantial"],
  "equity-analysis-estimated-suppressed": ["complete", "limited"],
  "equity-web-fallback-deep": ["complete", "substantial"],
  "equity-depository-deep": ["partial", "limited"],
  "equity-iren-deep": ["complete", "substantial"],
  "equity-iren-brief": ["complete", "limited"],
  "clfd-zero-debt": ["complete", "limited"],
  "ebay-extension-investments": ["complete", "substantial"],
  "equity-amd-deep": ["complete", "substantial"],
  "equity-bursa-deep": ["blocked", "limited"],
  "equity-bursa-brief": ["blocked", "limited"],
  "equity-reit-deep": ["complete", "limited"],
} as const;

// The recording predates figureQuotes; both spans are verbatim in the web-amd-a0601b8d (Reuters) snippet.
const AMD_OUTLOOK_QUOTES = [
  {
    sourceId: "web-amd-a0601b8d",
    quote: "fourth-quarter revenue of about $17 billion, plus or minus 3%",
  },
  { sourceId: "web-amd-a0601b8d", quote: "expects overall revenue to rise more than 80% in 2027" },
];

function withAmdOutlookQuotes(content: string): string {
  let payload: { keyFindings: readonly { sourceIds: readonly string[] }[] };
  try {
    payload = JSON.parse(content);
  } catch {
    return content;
  }
  return JSON.stringify({
    ...payload,
    keyFindings: payload.keyFindings.map((finding) =>
      finding.sourceIds.includes("web-amd-a0601b8d")
        ? { ...finding, figureQuotes: AMD_OUTLOOK_QUOTES }
        : finding,
    ),
  });
}

// Issued Event Grid ids with Forecast Baseline (null = declared forecast-baseline gap); [] = unpriced.
const EXPECTED_EVENT_GRID: Record<
  keyof typeof EXPECTED_COMPLETENESS_GRADES,
  readonly (readonly [string, number | null])[]
> = {
  // The synthetic AAPL fixtures run on 2026-06-15 against closes ending 2026-05-01, so scoring spans ~30 more sessions.
  "equity-aapl-brief": [
    ["grid-range-1", 0.8416],
    ["grid-range-5", 0.6739],
    ["grid-range-20", 0.4815],
    ["grid-relative-5", 0.5],
  ],
  "equity-aapl-brief-prune": [
    ["grid-range-1", 0.8416],
    ["grid-range-5", 0.6739],
    ["grid-range-20", 0.4815],
    ["grid-relative-5", 0.5],
  ],
  "equity-aapl-deep": [],
  "equity-earnings-release-deep": [
    ["grid-range-1", 0.3393],
    ["grid-range-5", 0.3395],
    ["grid-range-20", 0.3395],
    ["grid-relative-5", 0.5],
  ],
  "equity-nbis-deep": [
    ["grid-range-1", 0.5124],
    ["grid-range-5", 0.3978],
    ["grid-range-20", 0.3661],
    ["grid-relative-5", 0.5],
  ],
  "equity-fpi-quarterly": [],
  "equity-fpi-ifrs-semiannual": [],
  "equity-analysis-comprehensive": [
    ["grid-range-1", 0.8416],
    ["grid-range-5", 0.6739],
    ["grid-range-20", 0.4815],
    ["grid-relative-5", 0.5],
  ],
  "equity-analysis-estimated-suppressed": [],
  "equity-web-fallback-deep": [
    ["grid-range-1", 0.8416],
    ["grid-range-5", 0.6739],
    ["grid-range-20", 0.4815],
    ["grid-relative-5", 0.5],
  ],
  "equity-depository-deep": [
    ["grid-range-1", 0.3241],
    ["grid-range-5", 0.3235],
    ["grid-range-20", 0.3241],
    ["grid-relative-5", 0.5],
  ],
  "equity-iren-deep": [
    ["grid-range-1", 0.5327],
    ["grid-range-5", 0.42],
    ["grid-range-20", 0.3887],
    ["grid-relative-5", 0.5],
  ],
  "equity-iren-brief": [
    ["grid-range-1", 0.5327],
    ["grid-range-5", 0.42],
    ["grid-range-20", 0.3887],
    ["grid-relative-5", 0.5],
  ],
  "clfd-zero-debt": [
    ["grid-range-1", 0.4952],
    ["grid-range-5", 0.3785],
    ["grid-range-20", 0.3461],
    ["grid-relative-5", 0.5],
  ],
  "ebay-extension-investments": [
    ["grid-range-1", 0.4997],
    ["grid-range-5", 0.3827],
    ["grid-range-20", 0.351],
    ["grid-relative-5", 0.5],
  ],
  "equity-amd-deep": [
    ["grid-range-1", 0.541],
    ["grid-range-5", 0.4301],
    ["grid-range-20", 0.3989],
    ["grid-relative-5", 0.5],
  ],
  "equity-bursa-deep": [
    ["grid-range-1", 0.3198],
    ["grid-range-5", 0.3158],
    ["grid-range-20", 0.3126],
    ["grid-relative-5", 0.5],
  ],
  "equity-bursa-brief": [
    ["grid-range-1", 0.3198],
    ["grid-range-5", 0.3158],
    ["grid-range-20", 0.3126],
    ["grid-relative-5", 0.5],
  ],
  "equity-reit-deep": [
    ["grid-range-1", 0.4795],
    ["grid-range-5", 0.3596],
    ["grid-range-20", 0.3275],
    ["grid-relative-5", 0.5],
  ],
};

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

test.each(["<< METRIC:operating-ratios.margin>>", "<<\nMeTrIc\t:\toperating-ratios.margin>>"])(
  "fixture invariants reject raw tokens in persisted extras and markdown: %s",
  async (token) => {
    const fixture = await loadFixture("equity-aapl-brief");
    const result = await runFixture(fixture.name, { llm: "replay" });
    runResults.push(result);
    for (const surface of ["extras", "markdown"] as const) {
      const changed = {
        ...result,
        report:
          surface === "extras"
            ? {
                ...result.report,
                extras: {
                  ...result.report.extras,
                  earningsSetup: {
                    expectationBar: [{ text: token, sourceIds: [result.report.sources[0]!.id] }],
                  },
                },
              }
            : result.report,
        markdown: surface === "markdown" ? `${result.markdown}\n${token}` : result.markdown,
      };
      await writeFile(
        join(result.artifacts.runDir, RUN_ARTIFACT_FILES.report),
        JSON.stringify(changed.report),
      );
      await writeFile(
        join(result.artifacts.runDir, RUN_ARTIFACT_FILES.reportMarkdown),
        changed.markdown,
      );
      await expect(assertInvariants(changed, fixture.meta, fixture.name)).rejects.toThrow();
    }
  },
);

test("fixture invariants preserve quoted metric tokens and escape them in markdown", async () => {
  const fixture = await loadFixture("equity-web-fallback-deep");
  const result = await runFixture(fixture.name, { llm: "replay" });
  runResults.push(result);
  const token = "<<\nMeTrIc\t:operating-ratios.margin>>";
  const source = newsSource({
    id: "literal-token-source",
    title: token,
    summary: token,
    snippet: token,
  });
  const profile = result.collectedSources.webSubjectProfile!;
  expect(profile).toBeDefined();
  const collected = {
    ...result.collectedSources,
    webSubjectProfile: {
      ...profile,
      subjectSummary: { ...profile.subjectSummary, answer: token },
    },
  };
  const report = {
    ...result.report,
    extras: {
      ...result.report.extras,
      ...projectExtendedEvidenceReportExtras({
        modelExtras: result.report.extras ?? {},
        collectedSources: collected,
      }),
    },
    sources: [...result.report.sources, source],
    extendedEvidence: {
      ...result.report.extendedEvidence,
      gaps: result.report.extendedEvidence?.gaps ?? [],
      items: [
        ...(result.report.extendedEvidence?.items ?? []),
        {
          category: "sec-edgar" as const,
          title: token,
          summary: token,
          sourceIds: [source.id],
          observedAt: source.fetchedAt,
        },
      ],
    },
  };
  const markdown = renderMarkdownReport(
    report,
    result.collectedSources.marketSnapshots.find(({ symbol }) => symbol === report.symbol),
    result.collectedSources,
  );
  expect(markdown).toContain("&lt;&lt;\nMeTrIc\t:operating-ratios.margin&gt;&gt;");
  await writeFile(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.report), JSON.stringify(report));
  await writeFile(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.reportMarkdown), markdown);
  await assertInvariants(
    { ...result, report, markdown, collectedSources: collected },
    fixture.meta,
    fixture.name,
  );
});

describe("integrity prune fixture invariant", () => {
  const prune = { location: "summary[1]", text: "Uncited 52% figure." };
  const auditPrune = { ...prune, sourceIds: [] };

  test("fails a fixture without expectedIntegrityPrune that prunes", () => {
    expect(() =>
      assertIntegrityPruneInvariant([auditPrune], { reportIntegrity: "medium" }, {}),
    ).toThrow();
    expect(() => assertIntegrityPruneInvariant([], { reportIntegrity: "medium" }, {})).toThrow();
    expect(() =>
      assertIntegrityPruneInvariant(undefined, { reportIntegrity: "high" }, {}),
    ).toThrow();
    expect(() => assertIntegrityPruneInvariant([], { reportIntegrity: "high" }, {})).not.toThrow();
  });

  test("holds a flagged fixture to its exact prune and grade", () => {
    const meta = {
      expectedIntegrityPrune: { reportIntegrity: "medium" as const, pruned: [prune] },
    };

    expect(() =>
      assertIntegrityPruneInvariant([prune], { reportIntegrity: "medium" }, meta),
    ).not.toThrow();
    expect(() => assertIntegrityPruneInvariant([], { reportIntegrity: "high" }, meta)).toThrow();
    expect(() =>
      assertIntegrityPruneInvariant([prune, prune], { reportIntegrity: "medium" }, meta),
    ).toThrow();
    expect(() =>
      assertIntegrityPruneInvariant([prune], { reportIntegrity: "low" }, meta),
    ).toThrow();
  });
});

describe("static equity run fixtures", () => {
  for (const name of EQUITY_RUN_FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      expect(fixture.meta.replayClassification).toMatch(/^(?:clean|missing-source)$/u);
      for (const key of fixture.meta.syntheticLlmEntries ?? []) {
        expect(Object.keys(fixture.llmCassette.entries)).toContain(key);
      }
      const modelRequests: ModelRequest[] = [];
      const modelOutputs: string[] = [];
      const cassetteMisses: string[] = [];
      const replayProvider = makeReplayProvider(fixture.llmCassette);
      const injection: {
        metric?: { reference: string; value: string; label: string; sourceIds: readonly string[] };
      } = {};
      const result = await runFixture(name, {
        llm: "replay",
        fetchImpl: countCassetteMisses(
          makeReplayFetch(fixture.dataCassette, fixture.dir),
          cassetteMisses,
        ),
        provider: {
          name: replayProvider.name,
          generate: async (request: ModelRequest) => {
            modelRequests.push(request);
            const response = await replayProvider.generate(request);
            const prompt =
              request.stage === "peer-universe-proposal"
                ? {}
                : JSON.parse(request.messages[1]?.content ?? "{}");
            if (name === "equity-earnings-release-deep" && prompt.stage === "final-synthesis") {
              const segments = (
                prompt.evidence.metricReferences as readonly {
                  id: string;
                  metrics: readonly { reference: string; status: string }[];
                }[]
              ).find(({ id }) => id === "segment-results");
              expect(segments?.metrics).toContainEqual(
                expect.objectContaining({
                  // FY2026 10-K 0000320193-26-000026: Americas operating income 86,008 / net sales 198,083.
                  reference:
                    "<<metric:segment-results.aapl_AmericasSegmentMember-2025-09-28-2026-09-26-margin>>",
                  status: "value",
                  value: "43.4%",
                }),
              );
              const geography = (
                prompt.evidence.metricReferences as readonly {
                  id: string;
                  metrics: readonly { reference: string; status: string; unit?: string }[];
                }[]
              ).find(({ id }) => id === "geographic-revenue");
              expect(
                geography?.metrics.some(
                  ({ reference, status }) => reference.endsWith("-share>>") && status === "value",
                ),
              ).toBe(true);
              for (const item of prompt.evidence.extendedEvidence.items as readonly {
                metrics?: Record<string, unknown>;
              }[]) {
                expect(
                  Object.keys(item.metrics ?? {}).some(
                    (key) => key.startsWith("segment|") || key.startsWith("geography|"),
                  ),
                ).toBe(false);
              }
            }
            if (name === "equity-aapl-deep" && prompt.stage === "final-synthesis") {
              const catalog = prompt.evidence.metricReferences as readonly {
                id: string;
                defaults?: { unit?: string };
                metrics: readonly { reference: string; unit?: string }[];
              }[];
              expect(catalog.map(({ id }) => id)).toEqual(
                expect.arrayContaining(["capital-return", "operating-ratios", "price-performance"]),
              );
              for (const item of prompt.evidence.extendedEvidence.items as readonly {
                category: string;
                summary: string;
                metrics?: Record<string, unknown>;
              }[]) {
                if (item.category !== "business-framework" && item.category !== "financial-lens") {
                  continue;
                }
                expect(item.summary).toContain("criteria-");
                if (item.category === "financial-lens") {
                  expect(item.summary).toContain(
                    "Latest close $217, SMA50 212.51, RSI14 52.73, MACD histogram 0.08",
                  );
                  expect(item.summary).not.toContain("Gross margin 47.6%");
                }
                for (const metric of catalog
                  .filter(({ id }) => id.startsWith(`${item.category}-`))
                  .flatMap(({ defaults, metrics }) =>
                    metrics.map((row) => ({ ...defaults, ...row })),
                  )) {
                  if (metric.unit === "text") {
                    continue;
                  }
                  const id = metric.reference.split(".").at(-1)!.slice(0, -2);
                  expect(item.metrics).not.toHaveProperty(id);
                  expect(item.metrics).not.toHaveProperty(`${id}PeriodEnd`);
                }
              }
              injection.metric = prompt.evidence.metricReferences
                .flatMap(
                  (section: {
                    defaults?: Record<string, unknown>;
                    metrics: readonly {
                      status: string;
                      reference: string;
                      value: string;
                      sourceIds: readonly string[];
                    }[];
                  }) => section.metrics.map((metric) => ({ ...section.defaults, ...metric })),
                )
                .find(
                  (metric: {
                    status: string;
                    unit: string;
                    value: unknown;
                    sourceIds: readonly string[];
                  }) =>
                    metric.status === "value" &&
                    metric.unit !== "text" &&
                    typeof metric.value === "string" &&
                    metric.sourceIds.length > 0,
                );
              expect(injection.metric).toBeDefined();
              const payload = JSON.parse(response.content);
              return {
                ...response,
                content: JSON.stringify({
                  ...payload,
                  keyFindings: [
                    ...payload.keyFindings,
                    {
                      text: `Filed metric reference: ${injection.metric!.reference}.`,
                      sourceIds: [],
                    },
                  ],
                }),
              };
            }
            const content =
              name === "equity-amd-deep" && prompt.stage === "final-synthesis"
                ? withAmdOutlookQuotes(response.content)
                : response.content;
            modelOutputs.push(content);
            return { ...response, content };
          },
        },
      });
      runResults.push(result);

      expect(cassetteMisses, `${name} has unrecorded HTTP dependencies`).toEqual([]);
      await assertInvariants(result, fixture.meta, name);
      const histories = result.collectedSources.rawSnapshots.filter(
        ({ adapter }) => adapter === "yahoo-price-history",
      );
      const issuerHistory = histories.find(({ id }) => id.endsWith(`-${result.report.symbol}`));
      const benchmark = exchangeProfileFor(result.report.symbol!)?.benchmark ?? "SPY";
      const benchmarkHistory = histories.find(({ id }) => id.endsWith(`-${benchmark}`));
      if (issuerHistory !== undefined && benchmarkHistory !== undefined) {
        expect(
          splitAdjustedObservationsFromYahooChart(benchmark, benchmarkHistory.payload).map(
            ({ value }) => value,
          ),
          `${name} benchmark price history must differ from the issuer history`,
        ).not.toEqual(
          splitAdjustedObservationsFromYahooChart(result.report.symbol!, issuerHistory.payload).map(
            ({ value }) => value,
          ),
        );
      }
      assertMetricPromptCatalog(result, fixture.meta, modelRequests);
      const injectedMetric = injection.metric;
      if (injectedMetric !== undefined) {
        const rendered = `${injectedMetric.value} (${injectedMetric.label})`;
        expect(result.report.keyFindings).toContainEqual({
          text: `Filed metric reference: ${rendered}.`,
          sourceIds: injectedMetric.sourceIds,
          metricSourceIds: injectedMetric.sourceIds,
          renderedMetrics: [{ field: "text", start: 24, text: rendered }],
        });
        expect(result.markdown).toContain(`Filed metric reference: ${rendered}.`);
      }
      expect([
        result.report.equityAnalysisCompleteness?.financialCoreStatus,
        result.report.equityAnalysisCompleteness?.coverageLevel,
      ]).toEqual([...EXPECTED_COMPLETENESS_GRADES[name]]);
      const expectedGrid = EXPECTED_EVENT_GRID[name];
      expect(
        result.report.predictions
          .filter(({ origin }) => origin === "grid")
          .map(({ id, baselineProbability }) => [id, baselineProbability ?? null]),
      ).toEqual(expectedGrid.map(([id, baseline]) => [id, baseline]));
      if (expectedGrid.length === 0) {
        expect(result.report.dataGaps).toContainEqual(
          expect.stringMatching(/^event-grid: .*no valid eventGrid probability.*grid-relative-5/u),
        );
      }
      if (expectedGrid.some(([id, baseline]) => id === "grid-relative-5" && baseline === null)) {
        expect(result.report.dataGaps).toContain(
          "forecast-baseline: Forecast Baseline omitted for grid-relative-5: no split-adjusted close history was collected for SPY",
        );
      }
      if (name === "equity-nbis-deep") {
        const revenueMultiples = (result.collectedSources.metricSections ?? []).flatMap(
          ({ id: section, metrics }) =>
            metrics
              .filter(({ id }) =>
                [
                  "evToAnnualizedRevenue",
                  "marketCapToAnnualizedRevenue",
                  "priceToSales",
                  "enterpriseValueToRevenue",
                ].includes(id),
              )
              .map(({ id, status }) => `${section}/${id}: ${status}`),
        );
        // FY2025 revenue $529.8M sits below 2% of the ~$36B market cap, so no revenue multiple publishes.
        expect(revenueMultiples.filter((row) => row.endsWith(": value"))).toEqual([]);
        // The current Lens verdict waits on revenue fresher than 2025-12-31; the Workbench prices it at 2026-04-30.
        expect(revenueMultiples).toEqual(
          expect.arrayContaining([
            "financial-lens-value/marketCapToAnnualizedRevenue: missing",
            "valuation-workbench-ttm-2025-12-31-2026-04-30/priceToSales: not-meaningful",
          ]),
        );
        expect(factTaxonomies(result)).toContain("us-gaap");
        expect(factForms(result).has("20-F")).toBe(true);
        const companyFacts = result.collectedSources.rawSnapshots.find(
          ({ adapter }) => adapter === "sec-companyfacts",
        );
        expect(JSON.stringify(companyFacts?.payload)).toContain('"RUB":');
        const statements = result.collectedSources.financialStatements!;
        expect(statements.reportingCurrency).toBe("USD");
        // Yandex-era 20-Fs report RUB; their USD columns are convenience translations.
        const annual = Object.values(statements.statements)
          .flatMap((section) => Object.values(section))
          .flatMap((series) => series.annual);
        expect(
          new Set(annual.filter(({ currency }) => currency !== null).map((f) => f.accessionNumber)),
        ).toEqual(new Set(["0001558370-25-005991", "0001104659-26-052948"]));
        // USD 20-Fs tag only LongTermDebtCurrent at these instants (FY2024 20-F balance sheet, Note 12).
        expect(
          statements.statements.balanceSheet.debt.annual
            .filter(({ periodEnd }) => periodEnd < "2025-12-31")
            .map(({ periodEnd, value, currency, concept, accessionNumber }) => ({
              periodEnd,
              value,
              currency,
              concept,
              accessionNumber,
            })),
        ).toEqual([
          {
            periodEnd: "2023-12-31",
            value: 6_800_000,
            currency: "USD",
            concept: "LongTermDebtCurrent",
            accessionNumber: "0001558370-25-005991",
          },
          {
            periodEnd: "2024-12-31",
            value: 6_100_000,
            currency: "USD",
            concept: "LongTermDebtCurrent",
            accessionNumber: "0001104659-26-052948",
          },
        ]);
        expect(
          result.collectedSources.valuationWorkbench?.historicalMultiples.observations
            .find(({ basis, periodEnd }) => basis === "annual" && periodEnd === "2024-12-31")
            ?.metrics.enterpriseValueToRevenue.inputs.find(({ label }) => label === "Debt"),
        ).toMatchObject({ value: 6_100_000, currency: "USD", periodEnd: "2024-12-31" });
        expect(
          statements.statements.incomeStatement.revenue.annual.map(({ periodEnd }) => periodEnd)[0],
        ).toBe("2022-12-31");
        expect(
          statements.statements.perShare.dilutedShares.annual.some(
            ({ periodEnd }) => periodEnd === "2021-12-31",
          ),
        ).toBe(true);
        // FY2022 revenue 13.5M (0001558370-25-005991) predates the FY2025 20-F recast of FY2023-24.
        const nbisRevenue =
          result.deepEquityEvidenceBundle?.derived.fundamentalHistory?.series.revenue;
        expect(nbisRevenue?.annual.slice(0, 2).map(({ value }) => value)).toEqual([13.5e6, 9.8e6]);
        expect(nbisRevenue?.notes).toContain(
          "annual:earlier-basis: 2022-12-31 last filed 2025-04-30 (0001558370-25-005991), before the 2026-04-30 filing restated later revenue periods; not re-presented",
        );
        expect(nbisRevenue?.cagr).toBeUndefined();
        expect(result.markdown).toContain(
          "FY ending 2022-12-31 (latest filed 2025-04-30) is on an earlier presentation basis for revenue, operating income, operating margin",
        );
        expect(result.collectedSources.sourceGaps).toContainEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              /^Excluded USD convenience translations from 13 filings whose revenue is reported in RUB .*0001558370-24-005891.*starts with the period ended 2022-12-31$/u,
            ),
          }),
        );
        const valuation = result.report.extendedEvidence?.items.find(
          ({ category }) => category === "valuation",
        );
        expect(valuation?.metrics).toMatchObject({ debtPeriodEnd: "2025-12-31" });
        expect(valuation?.metrics?.enterpriseValue).toBeUndefined();
        expect(valuation?.metrics?.evToAnnualizedRevenue).toBeUndefined();
        expect(valuation?.summary).toContain(
          "enterprise value withheld (non-current balance sheet)",
        );
        expect(result.markdown).not.toContain("EV mixes");
        const peers = result.collectedSources.valuationWorkbench?.peerComparison;
        expect(peers?.status).toBe("available");
        const target = peers?.status === "available" ? peers.valuationComps.target : undefined;
        expect(target?.symbol).toBe("NBIS");
        expect(target?.enterpriseValue).toBeUndefined();
        expect(target?.evToAnnualizedRevenue).toBeUndefined();
        expect(result.collectedSources.sourceGaps).toContainEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              /^Non-current SEC balance-sheet inputs for NBIS: .*enterprise value and EV\/TTM revenue withheld$/u,
            ),
          }),
        );
        // Yahoo forward EPS -3.59783 gives forward P/E -40.02x, which is not meaningful.
        const metricRow = (section: string, id: string) =>
          (result.report.extras?.metricSections as MetricSectionsExtra | undefined)
            ?.find((row) => row.id === section)
            ?.metrics.find((row) => row.id === id);
        for (const [section, id] of [
          ["financial-lens-value", "forwardPe"],
          ["business-framework-valuation", "forwardPE"],
        ] as const) {
          expect(metricRow(section, id)).toMatchObject({
            status: "not-meaningful",
            reason: "non-positive forward earnings",
            inputs: [expect.objectContaining({ key: "forwardPE", value: -40.022_736 })],
          });
        }
        expect(result.markdown).not.toMatch(/forward P\/?E -/iu);
        expect(result.markdown).toContain("forward P/E N/M (non-positive earnings)");
        await assertNbisUnsupportedInputs();
      }
      if (name === "equity-web-fallback-deep") {
        // The +10 band scores 40 sessions out (base rate 0.62), so its 0.55 range is near; a 0.32 centre would not count it.
        expect(result.analytics.predictions.nearBaseRateCount).toBe(2);
      }
      if (name === "equity-aapl-brief") {
        assertProviderGapRestatementsDropped(result);
        const frameworkGaps = result.collectedSources.sourceGaps.filter(
          ({ source }) => source === "business-framework",
        );
        expect(frameworkGaps).toHaveLength(12);
        expect(frameworkGaps.filter(({ cause }) => cause === "suppressed-by-design")).toHaveLength(
          11,
        );
        expect(frameworkGaps.filter(({ cause }) => cause === "provider-data-missing")).toEqual([
          expect.objectContaining({ message: expect.stringContaining("analyst-consensus:") }),
        ]);
        for (const gap of frameworkGaps) {
          if (gap.cause === "suppressed-by-design") {
            expect(gap.message).toContain(
              "is not assessed at brief depth; filing prose and Web Subject Profile are excluded",
            );
          }
          expect(result.report.dataGaps).toContain(`${gap.source}: ${gap.message}`);
        }
        expect(result.markdown).toContain(
          "is not assessed at brief depth; filing prose and Web Subject Profile are excluded",
        );
      }
      if (name === "clfd-zero-debt") {
        assertClfdTaggedZeroDebt(result);
        assertQuarterlyCapexProof(
          result,
          "0001171843-26-005329",
          [
            ["duration:9|2025-06-30", 3_529_000],
            ["duration:9|2026-06-30", 2_917_000],
          ],
          ["2026-06-30", 4_131_000, 7_344_000],
        );
        // Q2 FY2026 10-Q: read for the debt face, its linkbase also proves both 6-month capex columns.
        assertQuarterlyCapexProof(result, "0001171843-26-003126", [
          ["duration:6|2025-03-31", 3_074_000],
          ["duration:6|2026-03-31", 2_007_000],
        ]);
      }
      if (name === "equity-amd-deep") {
        // AMD Q3 2026 10-Q: TTM capex 974 + 1,845 − 752 = 2,067M; FCF = OCF 8,827M − 2,067M.
        assertQuarterlyCapexProof(
          result,
          "0000002488-26-000191",
          [
            ["duration:9|2025-09-27", 752_000_000],
            ["duration:9|2026-09-26", 1_845_000_000],
          ],
          ["2026-09-26", 2_067_000_000, 6_760_000_000],
        );
        expect(
          result.report.keyFindings.find(({ sourceIds }) => sourceIds.includes("web-amd-a0601b8d")),
        ).toMatchObject({ figureQuotes: AMD_OUTLOOK_QUOTES });
      }
      if (name === "ebay-extension-investments") {
        assertEbayExtensionShortTermInvestments(result);
      }
      if (name === "equity-iren-brief") {
        assertIrenExtensionCapexWithheld(result);
        const filing = result.report.sources.find(({ id }) => id === "extended-sec-edgar-iren-10k");
        expect(filing).toEqual(expect.not.objectContaining({ snippet: expect.anything() }));
        expect(filing?.url).toBe(
          "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000052/iren-20260630.htm",
        );
        const persistedRaw = (await Bun.file(
          join(result.artifacts.runDir, RUN_ARTIFACT_FILES.rawSnapshots),
        ).json()) as readonly { id: string; adapter: string; payloadSha256?: string }[];
        expect(persistedRaw.filter(({ id }) => id === filing?.rawRef)).toEqual([
          expect.objectContaining({
            adapter: "sec-filing-text",
            payloadSha256: "cc858d776e95fdfd6b4c405c2194aa35df01918c52609b5fb0f5675db1a80565",
          }),
        ]);
        // IREN FY2026 10-K: the schema references a separate _cal.xml, read from the same accession.
        expect(
          persistedRaw
            .map(({ adapter }) => adapter)
            .filter((adapter) => adapter.startsWith("sec-xbrl") || adapter.startsWith("sec-calc")),
        ).toEqual(["sec-xbrl-schema", "sec-calculation-linkbase"]);
        expect(
          result.collectedSources.sourceGaps.filter(({ message }) =>
            message.includes("section packet"),
          ),
        ).toEqual([]);
      }
      if (name === "equity-reit-deep") {
        // Realty Income FY2025 10-K 0000726728-26-000011 and Q3 2026 10-Q 0000726728-26-000059.
        const sections = result.collectedSources.metricSections ?? [];
        const row = (id: string) =>
          sections.flatMap(({ metrics }) => metrics).find((metric) => metric.id === id);
        // Known defect: O files PaymentsForCapitalImprovements (131.8M FY2025), which the capex series does not read.
        expect(row("freeCashFlowProxy")).toMatchObject({
          status: "missing",
          reason: "capital expenditure not filed by the issuer",
          inputs: [{ series: "operatingCashFlow", value: 2_945_560_000, periodEnd: "2026-09-30" }],
        });
        expect(JSON.stringify(sections)).not.toContain("depository issuer");
        expect(row("dividendsLatestFy")).toMatchObject({
          value: 2_920_895_000,
          periodEnd: "2025-12-31",
        });
        expect(row("dpsLatestFy")).toMatchObject({ value: 3.217, periodEnd: "2025-12-31" });
        expect(row("dividendYieldFiled")).toMatchObject({ value: 0.051_414_569_730_549_93 });
        expect(row("effectiveTaxRate")).toMatchObject({
          value: 0.073_884_388_670_010_01,
          inputs: [{ value: 85_346_000 }, { value: 1_155_129_000 }],
        });
        // Quote market cap / 9-month OCF 2,945,560,000 annualized ×12/9.
        expect(
          result.report.extendedEvidence?.items.find(
            ({ metrics }) => metrics?.pcfRatio !== undefined,
          )?.metrics?.pcfRatio,
        ).toBe(14.465_156_256_874_755);
      }
      if (name === "equity-depository-deep") {
        assertDepositoryEnterpriseValueAbsent(result);
        assertCurrencyConvertedValuation(result);
        assertMarketRegimeRendered(result);
      }
      if (name === "equity-fpi-quarterly") {
        expect(factTaxonomies(result)).toEqual(["us-gaap"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-fpi-ifrs-semiannual") {
        expect(factTaxonomies(result)).toEqual(["ifrs-full"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-analysis-comprehensive") {
        assertComprehensiveAnalysisPath(result, modelRequests);
        assertMarketRegimeRendered(result);
      }
      if (name === "equity-analysis-comprehensive" || name === "equity-web-fallback-deep") {
        expect(
          result.stageOutputs.filter((output) => output.stage === "final-synthesis"),
        ).toHaveLength(1);
      }
      if (name === "equity-analysis-estimated-suppressed") {
        assertEstimatedEarningsSuppressionPath(result, modelRequests, modelOutputs);
      }
      if (name === "equity-web-fallback-deep") {
        const search = result.trace.webGatherLoop?.acceptedRequests.find(
          (request) => request.tool === "web_search",
        );
        expect(search?.fallback).toMatchObject({
          attemptedProviders: ["exa", "firecrawl"],
          servedProvider: "firecrawl",
        });
        expect(search?.duplicateResults?.length).toBeGreaterThan(0);
        expect(search?.sanitizer?.removedInstructionSpanCount).toBeGreaterThan(0);
        const webSources = result.report.sources.filter((source) => source.kind === "web");
        expect(webSources.length).toBeGreaterThan(0);
        expect(webSources.every((source) => source.provider === "firecrawl")).toBe(true);
        expect(result.deepEquityEvidenceBundle?.evidence.webSubjectProfile).toBeDefined();
        expect(result.analytics.providerEndpointAvailability).toMatchObject({
          exaSearch: { status: "degraded" },
          firecrawlSearch: { status: "available" },
        });
        expect(
          result.collectedSources.sourceGaps.filter(({ source }) => source === "exa-search"),
        ).toEqual([]);
      }
      if (isDeepFixture(fixture.meta)) {
        expect(result.deepEquityEvidenceBundle).toMatchObject({
          schemaVersion: 1,
          run: { symbol: expect.any(String), analysisAsOf: fixture.meta.now },
          evidence: {
            marketSnapshots: expect.any(Array),
            supplementalMarketSnapshots: expect.any(Array),
            newsSources: expect.any(Array),
            extendedSources: expect.any(Array),
          },
          derived: expect.any(Object),
          governance: {
            sourceGaps: expect.any(Array),
            sourcePlan: expect.any(Object),
            evidenceLanes: expect.any(Object),
            sourceLedger: expect.any(Object),
          },
          context: { historicalContext: expect.any(Object) },
        });
        expect(JSON.stringify(result.deepEquityEvidenceBundle)).not.toContain("rawSnapshots");
        const financialStatements = result.deepEquityEvidenceBundle?.derived.financialStatements;
        if (financialStatements !== undefined) {
          const fundamentalHistory = result.deepEquityEvidenceBundle?.derived.fundamentalHistory;
          if (fundamentalHistory !== undefined) {
            expect(fundamentalHistory).toEqual(
              deriveFundamentalHistoryFromFinancialStatements(financialStatements),
            );
          }
          const command = fixtureCommand(fixture.meta);
          if (command.jobType !== "equity") {
            throw new Error(`${name} financial statements require an equity command`);
          }
          const recomputedFinancialLenses = addFinancialLensEvidence(
            command,
            result.collectedSources.marketSnapshots,
            withCanonicalFinancialLensInputs(
              result.collectedSources.extendedEvidence,
              financialStatements,
            ),
            result.collectedSources.verifiedMarketSnapshot,
            financialStatements.generatedAt,
            result.collectedSources.subsequentFinancing,
            result.collectedSources.reportingFreshness,
            financialStatements,
          ).artifact;
          expect(
            result.deepEquityEvidenceBundle?.derived.financialLenses,
            "[B11] financial lenses must rederive from canonical statement inputs",
          ).toEqual(recomputedFinancialLenses);
        }
      }
    }, 30_000);
  }

  test("saved FPI companyfacts retain quarterly revenue and TTM through the parser and history projection", async () => {
    const fixture = await loadFixture("equity-fpi-quarterly");
    const entry = Object.entries(fixture.dataCassette.entries).find(([key]) =>
      key.includes("/companyfacts/"),
    )?.[1];
    expect(entry?.status).toBe(200);
    const statements = deriveFinancialStatements(JSON.parse(entry!.body), {
      symbol: "FPIQ",
      generatedAt: fixture.meta.now,
      analysisAsOf: fixture.meta.now,
      sourceId: "extended-sec-edgar-fpiq-fundamentals",
    });
    const { revenue } = statements.statements.incomeStatement;
    expect(statements.interimCadence).toBe("quarterly");
    expect(revenue.interim.at(-1)).toMatchObject({
      value: 420_000_000,
      form: "6-K",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      sourceIds: [statements.sourceId],
    });
    expect(revenue.ttm).toMatchObject({
      value: 1_620_000_000,
      formula: "FY + latest-YTD - prior-YTD",
      sourceIds: [statements.sourceId],
    });
    const history = deriveFundamentalHistoryFromFinancialStatements(statements);
    expect(history.series.revenue?.ttm?.value).toBe(1_620_000_000);
  });

  // Values checked against the KLSE Screener copy of ViTrox's Q3 2026 report, announced 2026-11-05.
  test.each(["equity-bursa-deep", "equity-bursa-brief"])(
    "%s publishes code-checked issuer report figures",
    async (name) => {
      const result = await runFixture(name, { llm: "replay" });
      runResults.push(result);
      const metrics =
        result.collectedSources.metricSections?.find(({ id }) => id === "issuer-report")?.metrics ??
        [];
      const metric = (id: string) => metrics.find((row) => row.id === id);
      expect(metric("issuer-report-revenue-quarter-2026-09-30")).toMatchObject({
        value: 485_101_000,
        currency: "MYR",
        periodMonths: 3,
        basis: expect.stringMatching(
          /mirror copy of the issuer document .* announced 2026-11-05$/u,
        ),
      });
      expect(metric("issuer-report-revenue-ytd-2026-09-30")).toMatchObject({
        value: 1_127_067_000,
        periodMonths: 9,
      });
      expect(
        metric("issuer-report-profit-attributable-to-owners-quarter-2026-09-30"),
      ).toMatchObject({
        value: 118_580_000,
        currency: "MYR",
        periodMonths: 3,
      });
      expect(metric("issuer-report-basic-eps-quarter-2026-09-30")).toMatchObject({
        value: "MYR 0.0626 or 6.26 sen",
        currency: "MYR",
      });
      expect(metric("issuer-report-revenue-yoy-quarter")?.value).toBeCloseTo(
        (485_101 - 228_567) / 228_567,
        6,
      );
      expect(metric("issuer-report-net-margin-quarter")).toMatchObject({
        basis: "profit for the period, including non-controlling interests / revenue, same period",
      });
      expect(metric("issuer-report-net-margin-quarter")?.value).toBeCloseTo(118_073 / 485_101, 6);
      expect(metric("issuer-report-net-margin-ytd")?.value).toBeCloseTo(253_351 / 1_127_067, 6);
      expect(result.markdown).toContain("### Issuer report figures");
      expect(result.collectedSources.businessFramework?.phase).toBe("hyper-growth");
      expect(result.report.dataGaps.join("\n")).not.toContain("Event Grid range events not issued");
      expect(metric("issuer-report-dividend-per-share-ytd-2026-09-30")).toMatchObject({
        value: "MYR 0.0118 or 1.18 sen",
        periodMonths: 9,
      });
    },
  );

  test.each(["equity-bursa-deep", "equity-bursa-brief"])(
    "%s declares the issuer report concepts it could not publish",
    async (name) => {
      const result = await runFixture(name, { llm: "replay" });
      runResults.push(result);
      const messages = result.collectedSources.sourceGaps.map(({ message }) => message);
      expect(messages.find((message) => message.includes("published no checked figure"))).toContain(
        "published no checked figure for: Net cash from operating activities",
      );
      expect(result.report.sources.map(({ url }) => url)).toContain(
        "https://www.klsescreener.com/v2/announcements/view/11698017",
      );
      // Yahoo's 0.16 is not below the issuer's 9-month YTD EPS of 0.1345, so it publishes flagged.
      expect(messages.find((message) => message.startsWith("Yahoo trailing EPS"))).toContain(
        "Yahoo trailing EPS 0.16 MYR (no as-of date; period, share count and basic or diluted basis undisclosed) is published unreconciled",
      );
      expect(
        result.collectedSources.metricSections
          ?.find(({ id }) => id === "business-framework-valuation")
          ?.metrics.find(({ id }) => id === "trailingPE"),
      ).toMatchObject({ status: "value", value: 61.562_504 });
      expect(
        result.collectedSources.businessFramework?.sections.find(
          (section) => section.name === "Valuation",
        )?.summary,
      ).toBe("Valuation insufficient-data (Trailing PE 61.56x, Forward PE 43.88x)");
    },
  );

  test("bursa brief keeps a claim whose quote spans Markdown table cells", async () => {
    const result = await runFixture("equity-bursa-brief", { llm: "replay" });
    runResults.push(result);
    // The bare 485,101 cell reads as RM485,101 thousand under its MYR'000 header.
    expect(result.report.extras).toHaveProperty("webSubjectProfile.recentMaterialEvents.0", {
      claim:
        "For the quarter ended 30 September 2026, revenue was RM485,101 thousand, compared with RM228,567 thousand in the prior-year quarter.",
      sourceIds: ["web-0097.kl-a11bbc9c"],
      figureQuotes: [
        {
          sourceId: "web-0097.kl-a11bbc9c",
          quote: "| 1 | Revenue | 485,101 | 228,567 |",
          unitQuote: "MYR'000",
        },
      ],
    });
  });

  test("bursa deep fetches the newest issuer report page in code", async () => {
    const result = await runFixture("equity-bursa-deep", { llm: "replay" });
    runResults.push(result);
    const audit = JSON.parse(
      await readFile(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.webGatherAudit), "utf8"),
    ) as { acceptedRequests: { tool: string; args: { url?: string }; rationale: string }[] };
    expect(
      audit.acceptedRequests
        .filter(({ tool }) => tool === "web_fetch")
        .map(({ args, rationale }) => [args.url, rationale.startsWith("Issuer report page")]),
    ).toEqual([
      ["https://www.klsescreener.com/v2/announcements/view/11698017", true],
      // The second slot reads an older report; every published figure cites the first.
      [
        "https://www.marketscreener.com/news/vitrox-quarterly-report-for-the-financial-period-ended-30-june-2026-ce7f50dad889fe22",
        true,
      ],
    ]);
    // Issuer 9-month YTD revenue 1,127,067 vs 552,728 (MYR'000) classifies the phase.
    expect(result.report.extras).toHaveProperty("businessFramework.phase", "hyper-growth");
    const revenueYoy = result.collectedSources.metricSections
      ?.find(({ id }) => id === "business-framework-growth")
      ?.metrics.find(({ id }) => id === "revenueDeltaPercent");
    expect(revenueYoy).toMatchObject({ periodEnd: "2026-09-30", periodMonths: 9 });
    expect(revenueYoy?.value).toBeCloseTo((1_127_067 / 552_728 - 1) * 100, 6);
    expect(result.markdown).toContain("Phase: hyper-growth");
    // Fixture starts with no reusable profile, so the recorded profile stage runs and stores the report date.
    expect(result.trace.webSubjectProfileReuse?.decision).toBe("regenerated");
    expect(result.collectedSources.webSubjectProfile).toHaveProperty(
      "issuerReportBasisDate",
      "2026-11-05",
    );
    expect(result.markdown).toContain("profile stage read (latest issuer report 2026-11-05)");
  });

  test("deep equity markdown partitions the reader block from preserved appendix detail", async () => {
    const name = "equity-analysis-comprehensive";
    const result = await runFixture(name, { llm: "replay" });
    runResults.push(result);

    const marker = "\n## Appendix\n";
    expect(result.markdown.match(/## Appendix/gu)).toHaveLength(1);
    const [reader, appendix] = result.markdown.split(marker);
    expect(reader).toBeDefined();
    expect(appendix).toBeDefined();

    const readerHeadings = [
      "## What the Company Does",
      "## Price and Market Date",
      "## Financial Trends",
      "## Valuation Context",
      "## Catalysts",
      "## Key Findings",
      "## Risks",
      "## Upcoming Earnings and Consensus",
      "## Material Data Gaps",
    ];
    let previous = -1;
    for (const heading of readerHeadings) {
      const index = reader!.indexOf(heading);
      expect(index, heading).toBeGreaterThan(previous);
      previous = index;
      expect(appendix, heading).not.toContain(heading);
    }

    const appendixOnly = [
      "\n### Balance Sheet and Share Count\n",
      "\n### Business Framework\n",
      "\n### Analyst Estimate Distributions\n",
      "\n### External Analyst Estimate Context\n",
      "\n### External Ownership Context\n",
      "\n### Earnings Setup\n",
      "\n### Historical Context\n",
      "\n### Scenarios\n",
      "\n### Predictions\n",
      "\n### Diagnostic Data Gaps\n",
      "\n### Valuation Workbench\n",
      "DELL | secondary | excluded",
      "\n### Reverse DCF Input Sensitivity\n",
    ];
    for (const fragment of appendixOnly) {
      expect(reader, fragment).not.toContain(fragment);
      expect(appendix, fragment).toContain(fragment);
    }
    expect(reader).not.toMatch(
      /\b(?:criteria-(?:supported|mixed|not-supported)|insufficient-data)\b/u,
    );
    expect(reader).toContain("- No cited plain-language company description is available.");
    expect(reader).toContain("Period | Revenue | Net income | Operating margin | FCF");
    expect(reader).toMatch(
      /^FY ending \d{4}-\d{2}-\d{2} \(latest filed \d{4}-\d{2}-\d{2}\) \| -?[\d]/mu,
    );
    expect(reader).not.toContain("history is unavailable");
    expect(appendix).toContain("Period | Cash | Debt | Diluted shares");
    expect(appendix).toContain(
      "Interim ending 2026-03-31 (latest filed 2026-05-01) | 60.0B | 100.0B | —",
    );
    const debtGap = String.raw`Debt/equity missing \(stockholders' equity not filed by the issuer\)`;
    expect(
      reader
        ?.split("\n")
        .find((line) => line.startsWith("- **Material:** financial-lens-financial-strength:")),
    ).toContain(debtGap);
    expect(reader).not.toContain("Cash");
    expect(reader?.replace(debtGap, "")).not.toContain("Debt");
    expect(reader).not.toContain("Diluted shares");
    expect(reader).not.toContain("60.0B | 100.0B");
    expect(reader).toContain("this is valuation context, not a target price.");
    expect(reader).toContain(
      "this is valuation context, not a target price. [market-yahoo-equity-aapl]",
    );
    expect(reader).toContain(
      "**EPS consensus:** 1.72 (currency undeclared; single-provider snapshot) [extended-finnhub-events-aapl]",
    );
    expect(reader).toContain(
      "**Revenue consensus:** 98.0B (currency undeclared; single-provider snapshot) [extended-finnhub-events-aapl]",
    );
    expect(reader).toContain("**Material:** emitted 2 of 3 target predictions");
    expect(reader).not.toContain("evidence did not support more");
    expect(appendix).not.toContain("predictionShortfall:");
    expect(reader).not.toContain("fred-macro:");
    expect(appendix).not.toContain("fred-macro:");
    expect(appendix).not.toContain("**Diagnostic:** sec-edgar: Missing SEC company facts");
    expect(appendix).toMatch(
      /\d+ diagnostic data gaps; see the Research Console Advanced view or report\.json for details\./u,
    );
    expect(reader).not.toContain("marketaux-news:");
    expect(appendix).not.toContain("marketaux-news:");
    expect(reader).not.toContain("- **Median:**");
    expect(appendix).toContain("- **Median:**");
    for (const title of [
      "AAPL external EPS estimate consensus",
      "AAPL external revenue estimate consensus",
      "AAPL external EBITDA estimate consensus",
    ]) {
      expect(appendix!).toContain(`#### ${title}`);
    }
    expect(appendix!.match(/Mean \| Median \| High \| Low \| Count/gu)).toHaveLength(3);
    expect(appendix).not.toMatch(/^## /mu);
    expect(appendix).not.toContain("### Extended Evidence");
    expect(appendix).not.toContain("#### Fact Ledger");
    expect(appendix).not.toContain("- **Business** (criteria-supported):");
    expect(appendix).not.toContain("- **Phase**:");
    expect(appendix).not.toContain("- **Growth** (criteria-supported):");
    expect(appendix).toContain("- **Moat** (criteria-supported):");
    expect(appendix).toContain("- **Management** (insufficient-data):");
    expect(appendix).toContain("- **Risk** (criteria-supported):");
    expect(appendix).toContain("- **Valuation** (criteria-supported):");
    expect(
      appendix!.match(/^\| (?:8|9|10|11|12|13|14|15|16)% \|(?: \d+\.\d{2}% \|){5}$/gmu),
    ).toHaveLength(9);

    const preservedReportContent = [
      result.report.summary,
      ...result.report.keyFindings.map((item) => item.text),
      ...result.report.bullCase.map((item) => item.text),
      ...result.report.bearCase.map((item) => item.text),
      ...result.report.risks.map((item) => item.text),
      ...result.report.catalysts.map((item) => item.text),
      ...result.report.scenarios.map((item) => item.description),
    ];
    for (const fragment of preservedReportContent) {
      expect(result.markdown, fragment).toContain(fragment);
    }
    expect(
      violatesResearchOnly(reader!.slice(reader!.indexOf("## What the Company Does"))),
    ).toBeNull();

    const framework = result.report.extras?.businessFramework;
    expect(framework).toBeObject();
    if (
      framework === null ||
      typeof framework !== "object" ||
      !("sections" in framework) ||
      !Array.isArray(framework.sections)
    ) {
      throw new Error("Fixture business framework is unavailable");
    }
    const invalidReport = {
      ...result.report,
      extras: {
        ...result.report.extras,
        businessFramework: {
          ...framework,
          sections: framework.sections.map((section, index) =>
            index === 0 && section !== null && typeof section === "object"
              ? { ...section, sourceIds: ["missing-appendix-source"] }
              : section,
          ),
        },
      },
    };
    expect(() => validateResearchReport(invalidReport)).toThrow(
      "Business Framework sections[0] (Business) cites unknown source ID: missing-appendix-source",
    );
  });
});
