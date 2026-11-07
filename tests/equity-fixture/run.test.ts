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
} from "../support/run-fixtures";
import { makeReplayProvider, requestStage } from "../../src/replay/llm-cassette";
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
import { exchangeProfileFor } from "../../src/domain/exchange-profile";

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
  "equity-iren-deep": ["complete", "substantial"],
  "equity-iren-brief": ["complete", "limited"],
  "clfd-zero-debt": ["complete", "limited"],
  "ebay-extension-investments": ["complete", "substantial"],
  "equity-amd-deep": ["complete", "substantial"],
  "equity-bursa-deep": ["blocked", "limited"],
  "equity-bursa-brief": ["blocked", "limited"],
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
    ["grid-range-1", null],
    ["grid-range-5", null],
    ["grid-range-20", null],
    ["grid-relative-5", 0.5],
  ],
  "equity-bursa-brief": [
    ["grid-range-1", null],
    ["grid-range-5", null],
    ["grid-range-20", null],
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
      if (expectedGrid.some(([id, baseline]) => id === "grid-relative-5" && baseline === null)) {
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
      const dps = metric("issuer-report-dividend-per-share-ytd-2026-09-30");
      if (name === "equity-bursa-brief") {
        expect(dps).toMatchObject({ value: "MYR 0.0118 or 1.18 sen", periodMonths: 9 });
      } else {
        // The deep mapping did not read the dividend row.
        expect(dps).toBeUndefined();
      }
    },
  );

  test.each([
    ["equity-bursa-deep", "Dividend per share, Net cash from operating activities"],
    ["equity-bursa-brief", "published no checked figure for: Net cash from operating activities"],
  ])("%s declares the issuer report concepts it could not publish", async (name, expected) => {
    const fixture = await loadFixture(name);
    const replayProvider = makeReplayProvider(fixture.llmCassette);
    const synthesisRequests: string[] = [];
    const result = await runFixture(name, {
      llm: "replay",
      provider: {
        name: replayProvider.name,
        generate: async (request: ModelRequest) => {
          if (requestStage(request) === "final-synthesis") {
            synthesisRequests.push(JSON.stringify(request));
          }
          return replayProvider.generate(request);
        },
      },
    });
    runResults.push(result);
    const messages = result.collectedSources.sourceGaps.map(({ message }) => message);
    expect(messages.find((message) => message.includes("published no checked figure"))).toContain(
      expected,
    );
    expect(result.report.sources.map(({ url }) => url)).toContain(
      "https://www.klsescreener.com/v2/announcements/view/11698017",
    );
    expect(messages.find((message) => message.startsWith("Yahoo trailing EPS"))).toContain(
      "Yahoo trailing EPS 0.11 MYR",
    );
    // Yahoo's trailing PE of 92.36x prices the EPS the gap above contradicts.
    expect(
      result.collectedSources.metricSections
        ?.find(({ id }) => id === "business-framework-valuation")
        ?.metrics.find(({ id }) => id === "trailingPE")?.status,
    ).toBe("not-meaningful");
    expect(result.collectedSources.marketSnapshots[0]?.fundamentals).not.toHaveProperty(
      "epsTrailingTwelveMonths",
    );
    expect(JSON.stringify(result.report)).not.toContain("92.36");
    expect(result.markdown).not.toContain("EPS TTM 0.11");
    expect(
      result.collectedSources.financialLenses?.lenses.flatMap(({ metrics }) =>
        metrics.map(({ key }) => key),
      ),
    ).not.toContainEqual(expect.stringMatching(/^(?:peRatio|payoutRatio)$/u));
    expect(
      result.collectedSources.businessFramework?.sections.find(
        (section) => section.name === "Valuation",
      )?.summary,
    ).toBe("Valuation insufficient-data (Forward PE 48.30x)");
    // The Console reads the subject quote from these artifacts.
    const artifact =
      name === "equity-bursa-deep"
        ? RUN_ARTIFACT_FILES.evidenceBundle
        : RUN_ARTIFACT_FILES.marketSnapshots;
    expect(await readFile(join(result.artifacts.runDir, artifact), "utf8")).not.toContain("92.36");
    // Replayed upstream stage outputs predate the withholding, so only code-built numbers are checked.
    expect(synthesisRequests.length).toBeGreaterThan(0);
    for (const request of synthesisRequests) {
      expect(request).not.toContain("92.36");
      expect(request).not.toContain("epsTrailingTwelveMonths");
      expect(request).not.toContain("0.10909");
      expect(request).toMatch(
        /<<metric:business-framework-valuation\.trailingPE>>[^}]*\\"status\\":\\"not-meaningful\\"/u,
      );
    }
  });

  test("bursa brief keeps a claim whose quote spans Markdown table cells", async () => {
    const result = await runFixture("equity-bursa-brief", { llm: "replay" });
    runResults.push(result);
    expect(result.report.catalysts?.[0]?.text).toMatch(
      /^Observed fact: The reported third-quarter/u,
    );
    // The model quoted 34,720 for prior-quarter attributable profit; the table says 34,716.
    expect(JSON.stringify(result.report)).not.toContain("34,720");
  });

  test("bursa deep fetches the newest issuer report page in code", async () => {
    const fixture = await loadFixture("equity-bursa-deep");
    const replayProvider = makeReplayProvider(fixture.llmCassette);
    const result = await runFixture("equity-bursa-deep", {
      llm: "replay",
      provider: {
        name: replayProvider.name,
        // Recorded pred-1 cites SPY history, which a profiled listing no longer collects.
        generate: async (request: ModelRequest) => {
          const response = await replayProvider.generate(request);
          return requestStage(request) === "final-synthesis"
            ? {
                ...response,
                content: response.content.replaceAll("price-history-SPY", "price-history-0097.KL"),
              }
            : response;
        },
      },
    });
    runResults.push(result);
    const audit = JSON.parse(
      await readFile(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.webGatherAudit), "utf8"),
    ) as { acceptedRequests: { tool: string; args: { url?: string }; rationale: string }[] };
    expect(
      audit.acceptedRequests
        .filter(({ tool }) => tool === "web_fetch")
        .map(({ args, rationale }) => [args.url, rationale.startsWith("Issuer report page")]),
    ).toEqual([
      ["https://www.klsescreener.com/v2/stock/financial-report/0097/2026-09-30", true],
      ["https://www.klsescreener.com/v2/announcements/view/11698017", true],
    ]);
    // Issuer 9-month YTD revenue 1,127,067 vs 552,728 (MYR'000) classifies the phase.
    expect(result.report.extras).toHaveProperty("businessFramework.phase", "hyper-growth");
    const revenueYoy = result.collectedSources.metricSections
      ?.find(({ id }) => id === "business-framework-growth")
      ?.metrics.find(({ id }) => id === "revenueDeltaPercent");
    expect(revenueYoy).toMatchObject({ periodEnd: "2026-09-30", periodMonths: 9 });
    expect(revenueYoy?.value).toBeCloseTo((1_127_067 / 552_728 - 1) * 100, 6);
    expect(result.markdown).toContain("Phase: hyper-growth");
    expect(result.report.predictions.map(({ id }) => id)).not.toContain("pred-1");
    expect(result.report.dataGaps.join("\n")).toContain(
      "Model prediction(s) pred-1 for 0097.KL withheld: they compare against SPY",
    );
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
