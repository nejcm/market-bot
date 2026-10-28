import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args";
import type { ModelRequest } from "../../src/model/types";
import {
  assertComprehensiveAnalysisPath,
  assertCurrencyConvertedValuation,
  assertDepositoryEnterpriseValueAbsent,
  assertEstimatedEarningsSuppressionPath,
  assertInvariants,
  assertMarketRegimeRendered,
  assertMetricPromptCatalog,
  assertNbisUnsupportedInputs,
  assertProviderGapRestatementsDropped,
  factForms,
  factTaxonomies,
} from "../support/run-fixtures/assertions";
import {
  EQUITY_RUN_FIXTURES,
  loadFixture,
  runFixture,
  type RunFixtureResult,
} from "../support/run-fixtures";
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
import { projectExtendedEvidenceReportExtras } from "../../src/research/extended-evidence-projections";
import { newsSource } from "../support/fixtures";
import { splitAdjustedObservationsFromYahooChart } from "../../src/sources/yahoo";

const EXPECTED_COMPLETENESS_GRADES = {
  "equity-aapl-brief": ["blocked", "limited"],
  "equity-aapl-deep": ["complete", "limited"],
  "equity-earnings-release-deep": ["complete", "substantial"],
  "equity-nbis-deep": ["partial", "limited"],
  "equity-fpi-quarterly": ["complete", "limited"],
  "equity-fpi-ifrs-semiannual": ["complete", "limited"],
  "equity-analysis-comprehensive": ["complete", "substantial"],
  "equity-analysis-estimated-suppressed": ["complete", "limited"],
  "equity-web-fallback-deep": ["complete", "substantial"],
  "equity-depository-deep": ["partial", "limited"],
} as const;

// Issued Event Grid ids with Forecast Baseline (null = declared missing-benchmark gap); [] = unpriced.
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
  "equity-aapl-deep": [],
  "equity-earnings-release-deep": [
    ["grid-range-1", 0.4911],
    ["grid-range-5", 0.374],
    ["grid-range-20", 0.3419],
    ["grid-relative-5", null],
  ],
  "equity-nbis-deep": [
    ["grid-range-1", 0.5108],
    ["grid-range-5", 0.3958],
    ["grid-range-20", 0.3641],
    ["grid-relative-5", null],
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
    ["grid-range-1", 0.4547],
    ["grid-range-5", 0.3333],
    ["grid-range-20", 0.3012],
    ["grid-relative-5", null],
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

describe("static equity run fixtures", () => {
  test("keeps the incomplete AMD recording outside the regression fixture roster", async () => {
    const fixture = await loadFixture("equity-amd-deep");
    expect(fixture.meta.replayClassification).toBe("incomplete");
    expect(EQUITY_RUN_FIXTURES.some((name) => name === fixture.name)).toBe(false);
  });

  for (const name of EQUITY_RUN_FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      expect(fixture.meta.replayClassification).toMatch(/^(?:clean|missing-source)$/u);
      const modelRequests: ModelRequest[] = [];
      const modelOutputs: string[] = [];
      const cassetteMisses: string[] = [];
      const replayProvider = makeReplayProvider(fixture.llmCassette);
      const injection: {
        metric?: { reference: string; value: string; sourceIds: readonly string[] };
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
            const prompt = JSON.parse(request.messages[1]?.content ?? "{}");
            if (name === "equity-earnings-release-deep" && prompt.stage === "final-synthesis") {
              const segments = (
                prompt.evidence.metricReferences as readonly {
                  id: string;
                  metrics: readonly { reference: string; status: string }[];
                }[]
              ).find(({ id }) => id === "segment-results");
              expect(segments?.metrics).toContainEqual(
                expect.objectContaining({
                  reference:
                    "<<metric:segment-results.aapl_AmericasSegmentMember-2026-03-29-2026-06-27-margin>>",
                  status: "value",
                  value: "47.4%",
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
            modelOutputs.push(response.content);
            return response;
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
      const benchmarkHistory = histories.find(({ id }) => id.endsWith("-SPY"));
      if (issuerHistory !== undefined && benchmarkHistory !== undefined) {
        expect(
          splitAdjustedObservationsFromYahooChart("SPY", benchmarkHistory.payload).map(
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
        expect(result.report.keyFindings).toContainEqual({
          text: `Filed metric reference: ${injectedMetric.value}.`,
          sourceIds: injectedMetric.sourceIds,
        });
        expect(result.markdown).toContain(`Filed metric reference: ${injectedMetric.value}.`);
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
      if (expectedGrid.some(([, baseline]) => baseline === null)) {
        expect(result.report.dataGaps).toContain(
          "forecast-baseline: Forecast Baseline omitted for grid-relative-5: no split-adjusted close history was collected for SPY",
        );
      }
      if (name === "equity-nbis-deep") {
        expect(factTaxonomies(result)).toContain("us-gaap");
        expect(factForms(result).has("20-F")).toBe(true);
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
            expect(gap.message).toContain("Web Subject Profile is excluded at brief depth");
          }
          expect(result.report.dataGaps).toContain(`${gap.source}: ${gap.message}`);
        }
        expect(result.markdown).toContain("Web Subject Profile is excluded at brief depth");
      }
      if (name === "equity-depository-deep") {
        assertDepositoryEnterpriseValueAbsent(result);
        assertCurrencyConvertedValuation(result);
        assertMarketRegimeRendered(result);
      }
      if (
        ["equity-depository-deep", "equity-earnings-release-deep", "equity-nbis-deep"].includes(
          name,
        )
      ) {
        expect(result.collectedSources.sourceGaps).toContainEqual(
          expect.objectContaining({
            source: "yahoo-price-history",
            symbol: "SPY",
            cause: "fetch-failed",
            message: expect.stringContaining("503"),
          }),
        );
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
      if (fixture.meta.argv.includes("--deep")) {
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
          const command = parseArgs(fixture.meta.argv);
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
    });
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
      "**EPS consensus:** 1.72 (single-provider snapshot) [extended-finnhub-events-aapl]",
    );
    expect(reader).toContain(
      "**Revenue consensus:** 98.0B (single-provider snapshot) [extended-finnhub-events-aapl]",
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
