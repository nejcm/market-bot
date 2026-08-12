import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../app/types";
import {
  buildRunWorkspaceView,
  equityHeaderView,
  equitySnapshotView,
  peerImpliedRangeView,
  valuationWorkbenchView,
  reverseDcfView,
  type RunWorkspaceView,
} from "../app/client/run-workspace-view";
import { VERIFIED_SNAPSHOT_PATH } from "../app/client/view-model";
import type { MarketSnapshot, ResearchReport, VerifiedMarketSnapshot } from "../src/domain/types";
import {
  deriveFundamentalHistory,
  type FundamentalHistoryArtifact,
  type FundamentalHistoryPoint,
  type FundamentalHistorySeriesKey,
} from "../src/sources/extended-evidence/fundamental-history";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { derivePeerImpliedRange } from "../src/sources/extended-evidence/valuation-comps";
import { violatesResearchOnly } from "../src/domain/research-language";
import { renderFinancialTrends, renderMarkdownReport } from "../src/report/markdown";
import { projectEquityReader } from "../src/report/equity-reader";
import { reverseDcfArtifact, valuationWorkbench } from "./support/fixtures";

async function renderRunWorkspaceComponent(
  detail: RunDetail,
  reportDetail: "simple" | "advanced" = "simple",
  activeTab = "report",
  showSources = false,
): Promise<string> {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "run",
      resolve(import.meta.dir, "support/render-run-workspace.ts"),
      reportDetail,
      activeTab,
      ...(showSources ? ["sources"] : []),
    ],
    {
      stdin: new Blob([JSON.stringify(detail)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [body, error, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(error);
  }
  return body;
}

function financialTrendReport(sourceId: string): ResearchReport {
  return {
    runId: "run-1",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    generatedAt: "2026-07-04T12:00:00.000Z",
    summary: "Equity summary.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [
      {
        id: sourceId,
        title: "SEC fundamentals",
        fetchedAt: "2026-07-04T12:00:00.000Z",
        kind: "extended-evidence",
      },
    ],
    notFinancialAdvice: true,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    findingCount: 0,
    predictionCount: 0,
    sourceCount: 0,
    dataGapCount: 0,
    hasScore: false,
    availableFiles: [],
    ...overrides,
  };
}

function snapshot(): VerifiedMarketSnapshot {
  return {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-07-04",
    fetchedAt: "2026-07-04T12:00:00.000Z",
    latestSessionDate: "2026-07-03",
    ohlcv: {
      date: "2026-07-03",
      open: 208,
      high: 212,
      low: 207,
      close: 211,
      volume: 1000,
    },
    indicators: {
      ema10: 209,
      sma50: 205,
      sma200: 190,
      rsi14: 58,
      macd: 2,
      macdSignal: 1.5,
      macdHistogram: 0.5,
      bollUpper: 216,
      bollMiddle: 207,
      bollLower: 198,
      atr14: 4,
    },
    recentCloses: [
      { date: "2026-07-02", close: 209 },
      { date: "2026-07-03", close: 211 },
    ],
  };
}

function marketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    sourceId: "market-yahoo-equity-aapl",
    assetClass: "equity",
    symbol: "AAPL",
    name: "Apple",
    identity: { displayName: "Apple Inc.", quoteCurrency: "USD" },
    price: 211.25,
    changePercent24h: 1.4,
    volume: 62_000_000,
    marketCap: 3_000_000_000_000,
    fundamentals: {
      trailingPE: 31,
      forwardPE: 28,
      dividendYield: 0.36,
      sharesOutstanding: 15_000_000_000,
    },
    observedAt: "2026-07-04T12:00:00.000Z",
    ...overrides,
  };
}

function peerImpliedRange(currentPrice = 79) {
  return derivePeerImpliedRange({
    supportability: "supported",
    usablePeerCount: 3,
    peerP25EvToAnnualizedRevenue: 1,
    peerMedianEvToAnnualizedRevenue: 2,
    peerP75EvToAnnualizedRevenue: 3,
    annualizedRevenue: 400,
    netDebt: 10,
    sharesOutstanding: 10,
    currentPrice,
    quoteCurrency: "USD",
    quoteObservedAt: "2026-07-04T12:00:00.000Z",
  });
}

function renderedStrings(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => renderedStrings(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((entry) => renderedStrings(entry));
  }
  return [];
}

const BANNED_SNAPSHOT_CONSOLE_TOKENS =
  /\b(?:buy|sell|hold|price target|target price|fair value|intrinsic value|margin of safety|undervalued|overvalued|sizing|allocation|execution)\b|\bimplied price\b/iu;

function withoutPermittedPeerPhrase(text: string): string {
  return text
    .replaceAll(/peer-implied price reference range/giu, "")
    .replaceAll(/peer-derived reference range for context only; not a target price\./giu, "");
}

function fundamentalHistoryAnnualFacts(values: readonly number[]) {
  return values.map((val, index) => {
    const fy = 2022 + index;
    return {
      val,
      form: "10-K",
      fp: "FY",
      fy,
      filed: `${String(fy)}-11-01`,
      start: `${String(fy - 1)}-10-01`,
      end: `${String(fy)}-09-30`,
    };
  });
}

function balanceSheetAnnualFacts(values: readonly number[]) {
  return values.map((val, index) => {
    const fy = 2023 + index;
    return {
      val,
      form: "10-K",
      fp: "FY",
      fy,
      filed: `${String(fy + 1)}-02-01`,
      end: `${String(fy)}-12-31`,
    };
  });
}

function balanceSheetHistoryFixture() {
  return deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          CashAndCashEquivalentsAtCarryingValue: {
            units: { USD: balanceSheetAnnualFacts([30_000_000_000, 32_000_000_000]) },
          },
          LongTermDebt: {
            units: { USD: balanceSheetAnnualFacts([90_000_000_000, 85_000_000_000]) },
          },
          WeightedAverageNumberOfDilutedSharesOutstanding: {
            units: { shares: balanceSheetAnnualFacts([15_500_000_000, 15_000_000_000]) },
          },
        },
      },
    },
    {
      symbol: "AAPL",
      generatedAt: "2025-02-01T00:00:00.000Z",
      analysisAsOf: "2025-02-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

function fundamentalHistoryFixture(epsValues: readonly number[] = [2, 2.5, 6.13]) {
  return deriveFundamentalHistory(
    {
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: fundamentalHistoryAnnualFacts([100, 120, 150]) } },
          GrossProfit: { units: { USD: fundamentalHistoryAnnualFacts([40, 50, 66]) } },
          OperatingIncomeLoss: {
            units: { USD: fundamentalHistoryAnnualFacts([25, 32, 42]) },
          },
          NetIncomeLoss: { units: { USD: fundamentalHistoryAnnualFacts([20, 25, 33]) } },
          EarningsPerShareDiluted: {
            units: { "USD/shares": fundamentalHistoryAnnualFacts(epsValues) },
          },
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: fundamentalHistoryAnnualFacts([30, 36, 45]) },
          },
          PaymentsToAcquirePropertyPlantAndEquipment: {
            units: { USD: fundamentalHistoryAnnualFacts([8, 9, 10]) },
          },
        },
      },
    },
    {
      symbol: "AAPL",
      generatedAt: "2025-08-01T00:00:00.000Z",
      analysisAsOf: "2025-08-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

function fundamentalHistoryWithEpsTtm() {
  const epsFacts = [
    ...fundamentalHistoryAnnualFacts([2, 2.5, 3]),
    {
      val: 2.2,
      form: "10-Q",
      fp: "Q3",
      fy: 2024,
      filed: "2024-08-01",
      start: "2023-10-01",
      end: "2024-06-30",
    },
    {
      val: 2.4,
      form: "10-Q",
      fp: "Q3",
      fy: 2025,
      filed: "2025-08-01",
      start: "2024-10-01",
      end: "2025-06-30",
    },
  ];
  return deriveFundamentalHistory(
    {
      facts: {
        "us-gaap": {
          EarningsPerShareDiluted: { units: { "USD/shares": epsFacts } },
        },
      },
    },
    {
      symbol: "AAPL",
      generatedAt: "2025-08-02T00:00:00.000Z",
      analysisAsOf: "2025-08-02T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

function snapshotHistoryPoint(
  base: FundamentalHistoryPoint,
  value: number,
): FundamentalHistoryPoint {
  return {
    ...base,
    value,
    form: "TTM",
    fp: "TTM",
    periodStart: "2024-07-01",
    periodEnd: "2025-06-30",
    periodMonths: 12,
    filedAt: "2025-08-01",
  };
}

function snapshotFundamentalHistory(
  overrides: Partial<Record<FundamentalHistorySeriesKey, readonly number[]>> = {},
  ttmOverrides: Partial<Record<FundamentalHistorySeriesKey, number>> = {},
): FundamentalHistoryArtifact {
  const artifact = fundamentalHistoryFixture();
  const keys: readonly FundamentalHistorySeriesKey[] = [
    "revenue",
    "freeCashFlowProxy",
    "dilutedEps",
    "operatingMargin",
  ];
  const series = { ...artifact.series };
  for (const key of keys) {
    const original = artifact.series[key];
    const annualValues = overrides[key] ?? original.annual.map((point) => point.value);
    const annual = original.annual.map((point, index) => ({
      ...point,
      value: annualValues[index] ?? point.value,
    }));
    const latest = annual.at(-1);
    if (latest === undefined) {
      continue;
    }
    series[key] = {
      ...original,
      annual,
      ttm: snapshotHistoryPoint(latest, ttmOverrides[key] ?? latest.value),
    };
  }
  return { ...artifact, series };
}

function completenessReport() {
  const dimension = {
    status: "complete",
    reasonCodes: ["annual-as-current"],
    asOf: "2026-07-04T12:00:00.000Z",
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
  };
  return {
    summary: "Equity summary.",
    equityAnalysisCompleteness: {
      version: 1,
      financialCoreStatus: "complete",
      coverageLevel: "comprehensive",
      asOf: "2026-07-04T12:00:00.000Z",
      dimensions: {
        primaryFinancials: dimension,
        valuation: dimension,
        expectations: dimension,
        capitalOwnership: dimension,
        operatingKpis: dimension,
      },
    },
    bullCase: [{ text: "Revenue growth persists.", sourceIds: ["source-bull"] }],
    bearCase: [{ text: "Operating costs rise.", sourceIds: ["source-bear"] }],
    sources: [
      {
        id: "market-yahoo-equity-aapl",
        title: "Yahoo quote",
        kind: "market-data",
        provider: "yahoo",
        url: "https://example.com/yahoo",
      },
      {
        id: "extended-sec-edgar-aapl-fundamentals",
        title: "SEC fundamentals",
        kind: "filing",
        provider: "sec-edgar",
        url: "https://example.com/sec",
      },
      {
        id: "verified-snapshot-AAPL",
        title: "Verified snapshot",
        kind: "market-data",
        provider: "yahoo",
        url: "https://example.com/snapshot",
      },
      {
        id: "source-bull",
        title: "Bull evidence",
        kind: "filing",
        provider: "sec-edgar",
        url: "https://example.com/bull",
      },
      {
        id: "source-bear",
        title: "Bear evidence",
        kind: "filing",
        provider: "sec-edgar",
        url: "https://example.com/bear",
      },
    ],
  };
}

function tocKeys(view: RunWorkspaceView): readonly string[] {
  return view.tableOfContents.map((entry) => entry.key);
}

function tableOfContentsFixture(summaryOverrides: Partial<RunSummary> = {}): RunDetail {
  return {
    summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH], ...summaryOverrides }),
    report: {
      ...completenessReport(),
      symbol: "AAPL",
      keyFindings: [{ text: "Durable demand sentinel.", sourceIds: ["source-bull"] }],
      catalysts: [{ text: "Reader catalyst sentinel.", sourceIds: ["source-bull"] }],
      risks: [{ text: "Reader risk sentinel.", sourceIds: ["source-bear"] }],
      scenarios: [
        {
          name: "Base scenario sentinel",
          description: "Steady demand.",
          sourceIds: ["source-bull"],
        },
      ],
      predictions: [
        {
          id: "prediction-1",
          claim: "AAPL rises.",
          kind: "direction",
          subject: "AAPL",
          measurableAs: "AAPL close > 211",
          probability: 0.6,
          horizonTradingDays: 5,
          sourceIds: ["source-bull"],
        },
      ],
      dataGaps: ["Primary revenue evidence missing.", "tradier: API token missing"],
      extras: {
        earningsSetup: {
          event: {
            date: "2026-08-01",
            timing: "after-market",
            eventDateStatus: "provider-estimated",
            epsEstimate: 1.25,
            revenueEstimate: 12_000_000_000,
            sourceIds: ["source-bull"],
          },
        },
        businessFramework: {
          phase: "capital-return",
          sections: [
            {
              name: "Business",
              posture: "criteria-supported",
              text: "Apple designs devices and digital services.",
              sourceIds: ["source-bull"],
            },
          ],
          sourceIds: ["source-bull"],
          gaps: [],
        },
        webSubjectProfile: {
          subjectKind: "company",
          subjectLabel: "Apple Inc.",
          questions: {
            whatItDoes: {
              answer: "Apple designs devices and digital services.",
              sourceIds: ["source-bull"],
            },
          },
        },
      },
      extendedEvidence: {
        items: [
          {
            category: "analyst-estimates",
            title: "Analyst consensus sentinel",
            summary: "Distribution detail.",
            metrics: { mean: 1.2, median: 1.1, high: 1.5, low: 0.8, period: "FY 2027", count: 12 },
            sourceIds: ["source-bull"],
          },
          {
            category: "institutional-ownership",
            title: "Institutional detail sentinel",
            summary: "Ownership detail.",
            sourceIds: ["source-bear"],
          },
        ],
      },
    },
    markdown: "# Raw report sentinel",
    trace: { historicalContext: {} },
    marketSnapshots: [marketSnapshot()],
    verifiedMarketSnapshot: snapshot(),
    fundamentalHistory: snapshotFundamentalHistory(),
    financialStatements: balanceSheetHistoryFixture(),
    peerImpliedRange: peerImpliedRange(),
    valuationWorkbench: valuationWorkbench(),
    reverseDcf: reverseDcfArtifact(),
    financialLenses: {
      version: 1,
      generatedAt: "2026-07-04T12:00:00.000Z",
      symbol: "AAPL",
      lenses: [
        {
          name: "Quality",
          posture: "criteria-supported",
          metrics: [],
          sourceIds: ["source-bull"],
        },
      ],
      sourceIds: ["source-bull"],
    },
  };
}

function elementHtml(html: string, tag: "article" | "aside"): string {
  const element = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "u").exec(html)?.[0];
  expect(element).toBeDefined();
  return element ?? "";
}

function htmlText(html: string): string {
  return (
    html
      // Section navigation repeats section titles; it is chrome, not article prose.
      .replaceAll(/<aside\b[\s\S]*?<\/aside>/gu, " ")
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll("&amp;", "&")
      .replaceAll(/\s+/gu, " ")
  );
}

describe("run workspace view", () => {
  test("emits the exact mode-aware table of contents for a deep equity run", () => {
    const entries = buildRunWorkspaceView(tableOfContentsFixture()).tableOfContents;

    expect(entries.map((entry) => entry.key)).toEqual([
      "equityOverview",
      "summary",
      "financialTrends",
      "findings",
      "cases",
      "earningsConsensus",
      "advancedSummary",
      "equityCompleteness",
      "equityMetrics",
      "financialLensStats",
      "fundamentalHistory",
      "balanceSheetHistory",
      "valuationWorkbench",
      "reverseDcf",
      "peerImpliedRange",
      "scenarios",
      "snapshot",
      "history",
      "webSubjectProfile",
      "businessFramework",
      "analystEstimateDistributions",
      "extendedEvidence",
      "forecasts",
      "gaps",
      "rawMarkdown",
    ]);
    expect(entries.map((entry) => entry.advancedOnly)).toEqual([
      ...Array.from({ length: 6 }, () => false),
      ...Array.from({ length: 17 }, () => true),
      false,
      true,
    ]);
  });

  test("does not restore the removed advanced table-of-contents catch-all", () => {
    const entries = buildRunWorkspaceView(tableOfContentsFixture()).tableOfContents;

    expect(entries.some((entry) => entry.key === "advanced")).toBeFalse();
  });

  test("keeps the populated non-equity table of contents unchanged", () => {
    const detail = tableOfContentsFixture({
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
    });
    const entries = buildRunWorkspaceView({
      ...detail,
      verifiedMarketSnapshot: { ...snapshot(), symbol: "BTC" },
    }).tableOfContents;

    expect(entries.map((entry) => entry.key)).toEqual([
      "summary",
      "financialLensStats",
      "findings",
      "cases",
      "scenarios",
      "snapshot",
      "fundamentalHistory",
      "valuationWorkbench",
      "reverseDcf",
      "peerImpliedRange",
      "history",
      "webSubjectProfile",
      "businessFramework",
      "extendedEvidence",
      "forecasts",
      "gaps",
    ]);
    expect(entries.map((entry) => entry.advancedOnly)).toEqual(
      Array.from({ length: 16 }, () => false),
    );
  });

  test("hides source chips until the sources toggle is on", async () => {
    const detail = tableOfContentsFixture();

    const hidden = await renderRunWorkspaceComponent(detail, "advanced");
    const shown = await renderRunWorkspaceComponent(detail, "advanced", "report", true);

    expect(hidden).toContain('aria-label="Source chips"');
    expect(hidden).not.toContain("source-bull");
    expect(shown).toContain("source-bull");
  }, 20_000);

  test("filters rendered equity table-of-contents labels by report detail", async () => {
    const detail = tableOfContentsFixture();

    const simpleToc = elementHtml(await renderRunWorkspaceComponent(detail, "simple"), "aside");
    const advancedToc = elementHtml(await renderRunWorkspaceComponent(detail, "advanced"), "aside");

    expect(simpleToc).not.toContain("Detailed equity metrics");
    expect(simpleToc).not.toContain("Completeness diagnostics");
    expect(advancedToc).toContain("Detailed equity metrics");
    expect(advancedToc).toContain("Completeness diagnostics");
    // The strip is capped, so the appendix tail navigates by scrolling.
    expect(advancedToc).not.toContain("Reverse DCF input sensitivity");
    expect(advancedToc.match(/<button/gu)?.length).toBeLessThanOrEqual(15);
  }, 15_000);

  test("renders and binds every Advanced equity table-of-contents target", async () => {
    const detail = tableOfContentsFixture();
    const entries = buildRunWorkspaceView(detail).tableOfContents;
    const html = await renderRunWorkspaceComponent(detail, "advanced");
    const articleText = htmlText(elementHtml(html, "article"));
    const consoleSource = readFileSync(
      new URL("../app/client/components/run-workspace.svelte", import.meta.url),
      "utf8",
    );
    const articleStart = consoleSource.indexOf('<article class="min-w-0">');
    const simpleOnlyStart = consoleSource.indexOf('{#if reportDetail === "simple"}', articleStart);
    // The advanced sections live in the snippets rendered inside the ledger
    // Sheet ({#snippet reportBody()}) and in the trailing box ({#snippet
    // ReportTail()}), both declared after the article markup.
    const advancedStart = consoleSource.indexOf("{#snippet reportBody()}", articleStart);
    const advancedEnd = consoleSource.indexOf('<aside class="sticky top-6', advancedStart);
    const advancedSource = [
      consoleSource.slice(articleStart, simpleOnlyStart),
      consoleSource.slice(advancedStart, advancedEnd),
      ...[
        "equity-ledger.svelte",
        "web-subject-profile.svelte",
        "business-framework.svelte",
        "observable-forecasts.svelte",
      ].map((file) =>
        readFileSync(new URL(`../app/client/components/${file}`, import.meta.url), "utf8"),
      ),
    ].join("\n");
    const renderedMarkerByKey: Readonly<Record<string, string>> = {
      equityOverview: "Valuation context",
      summary: "Company summary",
      financialTrends: "Financial trends",
      findings: "Key findings",
      cases: "Reader catalyst sentinel.",
      earningsConsensus: "Upcoming earnings & consensus",
      gaps: "Coverage & material gaps",
      advancedSummary: "Report summary",
      equityCompleteness: "Completeness diagnostics",
      equityMetrics: "Detailed equity metrics",
      financialLensStats: "Financial Lens stats",
      fundamentalHistory: "Fundamental history",
      balanceSheetHistory: "Balance sheet & share count",
      valuationWorkbench: "Valuation workbench",
      reverseDcf: "Reverse DCF input sensitivity",
      peerImpliedRange: "peer-implied price reference range",
      snapshot: "Market snapshot · AAPL",
      analystEstimateDistributions: "Analyst estimate distributions",
      extendedEvidence: "Extended evidence",
      scenarios: "Scenarios",
      history: "Historical context audit",
      webSubjectProfile: "Web Subject Profile",
      businessFramework: "Business framework",
      forecasts: "Observable forecasts",
      rawMarkdown: "Raw markdown",
    };

    for (const entry of entries) {
      const renderedMarker = renderedMarkerByKey[entry.key];
      if (renderedMarker === undefined) {
        throw new Error(`Missing rendered marker for ${entry.key}`);
      }
      expect(articleText, entry.key).toContain(renderedMarker);
      if (entry.key === "advancedSummary") {
        expect(consoleSource).toContain(
          'equityPresentation === undefined ? "summary" : "advancedSummary"',
        );
        expect(consoleSource).toContain("bindSection(reportSummarySectionKey)");
        continue;
      }
      expect(advancedSource, entry.key).toMatch(
        new RegExp(
          `(?:bindSection\\("${entry.key}"\\)|(?:summarySectionKey|sectionKey)="${entry.key}")`,
          "u",
        ),
      );
    }
  }, 15_000);

  test("projects equity completeness without changing dimension evidence", () => {
    const primaryFinancials = {
      status: "complete",
      reasonCodes: ["cadence-quarterly", "ttm-reconciled"],
      asOf: "2026-07-04T12:00:00.000Z",
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    };
    const partialDimension = {
      status: "partial",
      reasonCodes: ["provider-evidence-missing"],
      asOf: "2026-07-04T12:00:00.000Z",
      sourceIds: [],
    };
    const detail: RunDetail = {
      summary: summary(),
      report: {
        equityAnalysisCompleteness: {
          version: 1,
          financialCoreStatus: "complete",
          coverageLevel: "limited",
          asOf: "2026-07-04T12:00:00.000Z",
          dimensions: {
            primaryFinancials,
            valuation: partialDimension,
            expectations: partialDimension,
            capitalOwnership: partialDimension,
            operatingKpis: partialDimension,
          },
        },
      },
    };

    const workspace = buildRunWorkspaceView(detail);

    expect(workspace.equityPresentation?.defaultView.financialCoreStatus).toBe("complete");
    expect(workspace.equityPresentation?.advanced.completeness).toMatchObject({
      coverageLevel: "limited",
      dimensions: [
        {
          key: "primaryFinancials",
          status: "complete",
          reasonCodes: primaryFinancials.reasonCodes,
          sourceIds: primaryFinancials.sourceIds,
        },
        { key: "valuation", status: "partial" },
        { key: "expectations", status: "partial" },
        { key: "capitalOwnership", status: "partial" },
        { key: "operatingKpis", status: "partial" },
      ],
    });
    expect(tocKeys(workspace)).toEqual([
      "equityOverview",
      "summary",
      "equityCompleteness",
      "equityMetrics",
      "gaps",
    ]);
  });

  test("suppresses completeness for historical reports without the field", () => {
    const detail: RunDetail = { summary: summary(), report: { summary: "Historical" } };

    const workspace = buildRunWorkspaceView(detail);
    expect(workspace.equityPresentation?.defaultView.financialCoreStatus).toBeUndefined();
    expect(workspace.equityPresentation?.advanced.completeness).toBeUndefined();
  });

  test("projects fundamental history into pre-scaled sparkline cards", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryFixture(),
    });
    const subDollarView = buildRunWorkspaceView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryFixture([2, 1, 0.5]),
    });

    expect(view.fundamentalHistory?.cards.map((card) => card.key)).toEqual([
      "revenue",
      "freeCashFlowProxy",
      "dilutedEps",
      "grossMargin",
      "operatingMargin",
      "netMargin",
    ]);
    expect(view.fundamentalHistory?.cards[0]).toMatchObject({
      value: "$150",
      trendLabel: expect.stringContaining("CAGR"),
      periodRange: "FY 2022–FY 2024 · 2022-09-30 to 2024-09-30",
      sourceCaption: "SEC EDGAR · companyfacts",
    });
    expect(view.fundamentalHistory?.cards.find((card) => card.key === "dilutedEps")?.value).toBe(
      "$6.13",
    );
    expect(
      subDollarView.fundamentalHistory?.cards.find((card) => card.key === "dilutedEps")?.value,
    ).toBe("$0.50");
    expect(
      view.fundamentalHistory?.cards.every(
        (card) =>
          card.geometry.baseline >= 0 &&
          card.geometry.baseline <= 1 &&
          card.geometry.bars.every(
            (bar) =>
              bar.x >= 0 &&
              bar.x <= 1 &&
              bar.y >= 0 &&
              bar.y <= 1 &&
              bar.width >= 0 &&
              bar.width <= 1 &&
              bar.height >= 0 &&
              bar.height <= 1,
          ),
      ),
    ).toBe(true);
    expect(tocKeys(view)).toContain("financialTrends");
  });

  test("omits the fundamental-history projection for old runs without the sidecar", () => {
    const view = buildRunWorkspaceView({ summary: summary() });

    expect(view.fundamentalHistory).toBeUndefined();
    expect(tocKeys(view)).not.toContain("fundamentalHistory");
  });

  test("surfaces the diluted-EPS TTM approximation on its console card", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryWithEpsTtm(),
    });

    expect(view.fundamentalHistory?.cards.find((card) => card.key === "dilutedEps")).toMatchObject({
      valuePeriod: "TTM through 2025-06-30",
      disclosure:
        "Approximation: diluted EPS TTM adds per-share periods without reweighting diluted shares.",
    });
  });

  test("builds populated report, forecast, evidence, gap, source, and snapshot sections", () => {
    const detail: RunDetail = {
      summary: summary({
        availableFiles: [VERIFIED_SNAPSHOT_PATH, "score.json"],
        hasScore: true,
      }),
      report: {
        summary: "Apple research summary.",
        keyFindings: [{ text: "Demand remains durable.", sourceIds: ["source-1"] }],
        bullCase: [{ text: "Margins expand.", sourceIds: ["source-1"] }],
        scenarios: [
          {
            name: "Base",
            description: "Steady demand.",
            sourceIds: ["source-1"],
          },
        ],
        predictions: [
          {
            id: "prediction-1",
            claim: "AAPL rises.",
            kind: "direction",
            subject: "AAPL",
            measurableAs: "AAPL close > 211",
            probability: 0.6,
            horizonTradingDays: 5,
            sourceIds: ["source-1"],
          },
        ],
        predictionShortfall: { emittedCount: 1, targetCount: 3, missingCount: 2 },
        dataGaps: ["tradier-options: Persisted override"],
        sources: [
          {
            id: "source-1",
            title: "Market data",
            kind: "market-data",
            provider: "test",
            url: "https://example.com/market",
          },
        ],
        extendedEvidence: {
          items: [
            {
              category: "valuation",
              title: "Valuation",
              summary: "Multiples remain elevated.",
              sourceIds: ["source-1"],
            },
            {
              category: "valuation",
              title: "Market-cap timing",
              summary: "market cap as of 2026-07-04; market cap (quote 2026-07-04).",
              sourceIds: ["market-yahoo-equity-aapl"],
            },
          ],
        },
      },
      score: {
        scores: [
          {
            predictionId: "prediction-1",
            resolved: true,
            outcome: "hit",
            evidence: { close0: 211, closeN: 215 },
          },
        ],
      },
      analytics: {
        predictions: { count: 1, targetCount: 3, targetMet: false },
      },
      sourceGaps: [
        {
          source: "tradier-options",
          provider: "tradier",
          message: "Persisted override",
          cause: "missing-credential",
          triage: "material",
        },
      ],
      marketSnapshots: [marketSnapshot()],
      verifiedMarketSnapshot: snapshot(),
    };

    const view = buildRunWorkspaceView(detail);

    expect(view.report.summary).toBe("Apple research summary.");
    expect(view.report.findings).toEqual([
      { text: "Demand remains durable.", sourceIds: ["source-1"] },
    ]);
    expect(view.report.cases[0]?.title).toBe("Bull case");
    expect(view.report.scenarios[0]?.name).toBe("Base");
    expect(view.forecasts.items[0]?.score?.outcome).toBe("hit");
    expect(view.forecasts.stats).toMatchObject({ total: 1, resolved: 1, hits: 1 });
    expect(view.forecasts.targetHealth).toEqual({ count: 1, target: 3, targetMet: false });
    expect(view.evidence.extendedItems[0]?.title).toBe("Valuation");
    expect(view.evidence.extendedItems[1]?.summary).toBe(
      "market cap fetch time 2026-07-04T12:00:00.000Z; market cap (fetch time 2026-07-04T12:00:00.000Z).",
    );
    expect(view.gaps).toMatchObject({
      shortfalls: [],
      otherGaps: [
        "tradier-options: Persisted override",
        "emitted 1 of 3 target predictions; evidence did not support more",
      ],
      triagedGaps: [
        { text: "tradier-options: Persisted override", triage: "material" },
        {
          text: "emitted 1 of 3 target predictions; evidence did not support more",
          triage: "material",
        },
      ],
      visible: true,
    });
    expect(view.sources.items[0]?.id).toBe("source-1");
    expect(view.snapshot?.value.symbol).toBe("AAPL");
    expect(view.snapshot?.tradingViewUrl).toContain("AAPL");
    expect(tocKeys(view)).toEqual([
      "equityOverview",
      "summary",
      "findings",
      "advancedSummary",
      "equityMetrics",
      "scenarios",
      "snapshot",
      "extendedEvidence",
      "forecasts",
      "gaps",
    ]);
  });

  test("ignores sparse or malformed optional artifacts", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      report: {
        summary: 42,
        keyFindings: "broken",
        scenarios: [null, { name: "Incomplete" }],
        predictions: "broken",
        dataGaps: [null, 42],
        sources: [{ id: "missing-title" }],
        extendedEvidence: "broken",
      },
      analytics: { predictions: "broken" },
      trace: { historicalContext: "broken" },
      score: { scores: "broken" },
      missAutopsy: { autopsies: "broken" },
    });

    expect(view.report).toMatchObject({
      summary: "",
      findings: [],
      cases: [],
      scenarios: [],
    });
    expect(view.forecasts).toMatchObject({ items: [], groups: [], visible: false });
    expect(view.evidence.extendedItems).toEqual([]);
    expect(view.gaps).toMatchObject({
      shortfalls: [],
      otherGaps: [],
      triagedGaps: [],
      visible: false,
    });
    expect(view.sources.items).toEqual([]);
    expect(view.snapshot).toBeUndefined();
    expect(tocKeys(view)).toEqual(["equityOverview", "summary", "equityMetrics", "gaps"]);
  });

  test("projects a matching equity snapshot into an unassessed header", () => {
    const header = equityHeaderView({
      summary: summary(),
      marketSnapshots: [marketSnapshot()],
    });

    expect(header).toEqual({
      displayName: "Apple Inc.",
      symbol: "AAPL",
      price: "$211",
      quoteCurrency: "USD",
      dailyChange: "+1.4%",
      changeDirection: "positive",
      observedAt: "2026-07-04T12:00:00.000Z",
      priceAsOf: { kind: "fetch-time-only", instant: "2026-07-04T12:00:00.000Z" },
      sourceIds: ["market-yahoo-equity-aapl"],
      financials: [
        {
          key: "marketCap",
          label: "Market cap",
          value: "$3000.0B",
          caption: "Yahoo quote · point in time · fetch time 2026-07-04T12:00:00.000Z",
          sourceIds: ["market-yahoo-equity-aapl"],
        },
        {
          key: "trailingPE",
          label: "Trailing P/E",
          value: "31.00x",
          caption: "Yahoo quote · trailing 12M · fetch time 2026-07-04T12:00:00.000Z",
          sourceIds: ["market-yahoo-equity-aapl"],
        },
        {
          key: "forwardPE",
          label: "Forward P/E",
          value: "28.00x",
          caption: "Yahoo quote · forward · fetch time 2026-07-04T12:00:00.000Z",
          sourceIds: ["market-yahoo-equity-aapl"],
        },
        {
          key: "dividendYield",
          label: "Dividend yield",
          value: "0.4%",
          caption: "Yahoo quote · quote snapshot · fetch time 2026-07-04T12:00:00.000Z",
          sourceIds: ["market-yahoo-equity-aapl"],
        },
        {
          key: "sharesOutstanding",
          label: "Shares outstanding",
          value: "15.0B",
          caption: "Yahoo quote · point in time · fetch time 2026-07-04T12:00:00.000Z",
          sourceIds: ["market-yahoo-equity-aapl"],
        },
      ],
    });
  });

  test("renders negative-earnings P/E header tiles with the value and a caveat", () => {
    const header = equityHeaderView({
      summary: summary(),
      marketSnapshots: [
        marketSnapshot({
          fundamentals: {
            trailingPE: -40,
            epsTrailingTwelveMonths: -2,
            forwardPE: -222.14,
            epsForward: -0.47,
          },
        }),
      ],
    });

    expect(header?.financials).toEqual([
      expect.objectContaining({ key: "marketCap" }),
      expect.objectContaining({ key: "trailingPE", value: "-40.00x (negative earnings)" }),
      expect.objectContaining({ key: "forwardPE", value: "-222.14x (negative earnings)" }),
      expect.objectContaining({ key: "forwardEPS", value: "$-0.47" }),
    ]);
  });

  test("passes through GBp quote currency formatting", () => {
    const {
      marketCap: _marketCap,
      fundamentals: _fundamentals,
      ...gbpSnapshot
    } = marketSnapshot({
      symbol: "rr.l",
      identity: { displayName: "Rolls-Royce Holdings", quoteCurrency: "GBp" },
      price: 912.4,
    });
    const header = equityHeaderView({
      summary: summary({ symbol: "RR.L" }),
      marketSnapshots: [gbpSnapshot],
    });

    expect(header).toMatchObject({ price: "912.4p", quoteCurrency: "GBp" });
  });

  test("omits the equity header without snapshots or without an asset and symbol match", () => {
    expect(equityHeaderView({ summary: summary() })).toBeUndefined();

    const researchHeader = equityHeaderView({
      summary: summary({ jobType: "research", assetClass: "research", symbol: "AI" }),
      marketSnapshots: [marketSnapshot()],
    });
    expect(researchHeader).toBeUndefined();

    const mismatchedHeader = equityHeaderView({
      summary: summary(),
      marketSnapshots: [marketSnapshot({ symbol: "MSFT" })],
    });
    expect(mismatchedHeader).toBeUndefined();
  });

  test("falls back from identity display name to snapshot name and symbol", () => {
    const named = equityHeaderView({
      summary: summary(),
      marketSnapshots: [marketSnapshot({ identity: { quoteCurrency: "USD" } })],
    });
    const { name: _name, ...unnamedSnapshot } = marketSnapshot({
      identity: { quoteCurrency: "USD" },
    });
    const symbolOnly = equityHeaderView({
      summary: summary(),
      marketSnapshots: [unnamedSnapshot],
    });

    expect(named?.displayName).toBe("Apple");
    expect(symbolOnly?.displayName).toBe("AAPL");
  });

  test("renders a disclosed equity forecast shortfall as material and forecast context", async () => {
    const shortfall = "emitted 0 of 3 target predictions; evidence did not support more";
    const detail = {
      summary: summary(),
      report: {
        ...completenessReport(),
        predictionShortfall: { emittedCount: 0, targetCount: 3, missingCount: 3 },
        dataGaps: [],
      },
    };
    const view = buildRunWorkspaceView(detail);

    expect(view.forecasts.visible).toBe(true);
    expect(view.forecasts.items).toEqual([]);
    expect(view.gaps.triagedGaps).toContainEqual({ text: shortfall, triage: "material" });
    expect(tocKeys(view)).toEqual([
      "equityOverview",
      "summary",
      "advancedSummary",
      "equityCompleteness",
      "equityMetrics",
      "forecasts",
      "gaps",
    ]);
    const simpleHtml = await renderRunWorkspaceComponent(detail, "simple");
    expect(simpleHtml).toContain("MATERIAL");
    expect(simpleHtml).toContain(shortfall);
    expect(simpleHtml).not.toContain("coverage · comprehensive");
    expect(simpleHtml.split(shortfall)).toHaveLength(2);

    const advancedHtml = await renderRunWorkspaceComponent(detail, "advanced");
    expect(advancedHtml).toContain("coverage · comprehensive");
    expect(advancedHtml.split(shortfall)).toHaveLength(2);
  }, 15_000);

  test("renders a non-equity shortfall in its dedicated block exactly once", async () => {
    const detail: RunDetail = {
      summary: summary({ jobType: "crypto", assetClass: "crypto", symbol: "BTC" }),
      report: {
        predictionShortfall: { emittedCount: 0, targetCount: 3, missingCount: 3 },
        dataGaps: ["Options evidence unavailable."],
      },
    };

    const view = buildRunWorkspaceView(detail);
    expect(view.gaps.shortfalls).toEqual(["emitted 0 of 3"]);
    expect(view.gaps.triagedGaps).toEqual([
      { text: "Options evidence unavailable.", triage: "material" },
    ]);
    expect(view.forecasts.targetHealth).toEqual({ count: 0, target: 3, targetMet: false });

    const html = await renderRunWorkspaceComponent(detail);
    expect(html).toContain("Prediction shortfall");
    expect(html.split("emitted 0 of 3")).toHaveLength(2);
    expect(await renderRunWorkspaceComponent(detail, "advanced")).toBe(html);
  }, 15_000);

  test("keeps conflicting legacy shortfalls visible without the protocol prefix", () => {
    const view = buildRunWorkspaceView({
      summary: summary({ jobType: "crypto", assetClass: "crypto", symbol: "BTC" }),
      report: {
        predictionShortfall: { emittedCount: 2, targetCount: 5, missingCount: 3 },
        dataGaps: ["predictionShortfall: emitted 1 of 5"],
      },
    });

    expect(view.gaps.shortfalls).toEqual(["emitted 2 of 5"]);
    expect(view.gaps.triagedGaps).toContainEqual({
      text: "emitted 1 of 5 target predictions; evidence did not support more",
      triage: "material",
    });
    expect(JSON.stringify(view)).not.toContain("predictionShortfall:");
  });

  test("groups legacy financial lens metrics by lens and retains posture", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      financialLenses: {
        version: 1,
        generatedAt: "2026-06-22T00:00:00.000Z",
        symbol: "AAPL",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-supported",
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            metrics: [
              {
                key: "grossMargin",
                label: "Gross margin",
                value: 0.42,
                unit: "ratio-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
            ],
          },
          {
            name: "Momentum",
            posture: "criteria-mixed",
            sourceIds: ["verified-snapshot-AAPL"],
            metrics: [
              {
                key: "rsi14",
                label: "RSI14",
                value: 58,
                unit: "number",
                sourceIds: ["verified-snapshot-AAPL"],
              },
            ],
          },
        ],
        sourceIds: ["extended-sec-edgar-aapl-fundamentals", "verified-snapshot-AAPL"],
      },
    });

    expect(view.report.financialLensGroups).toEqual([
      {
        lens: "Quality",
        posture: "criteria-supported",
        sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        tiles: [expect.objectContaining({ key: "grossMargin", lens: "Quality", tone: "strong" })],
      },
      {
        lens: "Momentum",
        posture: "criteria-mixed",
        sourceIds: ["verified-snapshot-AAPL"],
        tiles: [expect.objectContaining({ key: "rsi14", lens: "Momentum", tone: "strong" })],
      },
    ]);
    expect(tocKeys(view)).toEqual([
      "equityOverview",
      "summary",
      "equityMetrics",
      "financialLensStats",
      "gaps",
    ]);
  });

  test("requires snapshot job type and valid content", () => {
    const eligible: RunDetail = {
      summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH] }),
      verifiedMarketSnapshot: snapshot(),
    };
    expect(buildRunWorkspaceView(eligible).snapshot?.value.symbol).toBe("AAPL");

    expect(
      buildRunWorkspaceView({
        ...eligible,
        summary: summary({
          jobType: "market-overview",
          availableFiles: [VERIFIED_SNAPSHOT_PATH],
        }),
      }).snapshot,
    ).toBeUndefined();

    expect(
      buildRunWorkspaceView({
        ...eligible,
        summary: summary({ availableFiles: [] }),
      }).snapshot?.value.symbol,
    ).toBe("AAPL");

    expect(
      buildRunWorkspaceView({
        summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH] }),
      }).snapshot,
    ).toBeUndefined();

    expect(
      buildRunWorkspaceView({
        ...eligible,
        verifiedMarketSnapshot: {
          ...snapshot(),
          recentCloses: [{ date: "2026-07-03", close: 211 }],
        },
      }).snapshot,
    ).toBeUndefined();
  });

  test("projects a derived peer-implied price reference range", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      peerImpliedRange: peerImpliedRange(),
    });

    expect(view.peerImpliedRange).toMatchObject({
      status: "derived",
      label: "peer-implied price reference range",
      position: "within-range",
      positionLabel: "Within range",
      lowLabel: "Low $39.00",
      midLabel: "Mid $79.00",
      highLabel: "High $119.00",
      currentLabel: "Current price $79.00",
      geometry: { mid: 0.5, current: 0.5 },
    });
    expect(view.peerImpliedRange).toMatchObject({
      methodDisclosure: expect.stringContaining("impliedPrice(m)"),
      boundaryDisclosure: "Boundary rule: prices equal to low or high are within range.",
    });
    expect(tocKeys(view)).toEqual([
      "equityOverview",
      "summary",
      "equityMetrics",
      "peerImpliedRange",
      "gaps",
    ]);
  });

  test("projects historical multiples and the peer table from the valuation workbench", () => {
    const workbench = valuationWorkbench({
      peerComparison: {
        status: "available",
        valuationComps: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          target: {
            symbol: "AAPL",
            evToAnnualizedRevenue: 8.5,
            quoteCurrency: "USD",
            quoteObservedAt: "2026-05-19T00:00:00.000Z",
            revenuePeriodEnd: "2025-12-31",
            cashPeriodEnd: "2025-12-31",
            debtPeriodEnd: "2025-12-31",
            sourceIds: ["sec-fixture", "market-aapl"],
            usable: true,
          },
          peers: [
            {
              symbol: "MSFT",
              role: "core",
              evToAnnualizedRevenue: 10,
              quoteCurrency: "USD",
              quoteObservedAt: "2026-05-19T00:00:00.000Z",
              revenuePeriodEnd: "2026-03-31",
              sourceIds: ["sec-msft", "market-msft"],
              usable: true,
            },
          ],
          excludedPeers: [
            {
              symbol: "GOOG",
              role: "core",
              reason: "revenue period is stale",
              sourceIds: ["sec-goog"],
            },
          ],
          peerUniverseSourceIds: [],
          summary: {
            corePeerCount: 1,
            secondaryPeerCount: 0,
            usablePeerCount: 1,
            valuationSupportability: "screening-only",
          },
          sourceIds: ["sec-fixture", "market-aapl", "sec-msft", "market-msft"],
          freshnessFlags: {
            targetQuoteFresh: true,
            targetSecFresh: true,
            peerQuoteFresh: true,
            peerSecFresh: true,
          },
        },
      },
    });

    const view = valuationWorkbenchView({ summary: summary(), valuationWorkbench: workbench });
    const workspace = buildRunWorkspaceView({
      summary: summary(),
      valuationWorkbench: workbench,
    });

    expect(view).toMatchObject({
      reportingCurrency: "USD",
      quoteCurrency: "USD",
      trailingDisclosure: expect.stringContaining("Canonical reconciled TTM is unavailable"),
      rows: [
        {
          basis: "ANNUAL",
          periodEnd: "2025-12-31",
          publicAt: "2026-02-01",
          price: "200.00 USD · 2026-02-02",
          priceToEarnings: { status: "populated", display: "100.00x" },
        },
      ],
      peerSupportability: "screening-only",
      peerRows: [
        {
          symbol: "AAPL",
          role: "target",
          multiple: "8.50x",
          currency: "USD",
        },
        {
          symbol: "MSFT",
          role: "core",
          multiple: "10.00x",
          currency: "USD",
        },
      ],
      excludedPeerRows: [
        {
          symbol: "GOOG",
          role: "core",
          reason: "revenue period is stale",
          sourceIds: ["sec-goog"],
        },
      ],
    });
    expect(tocKeys(workspace)).toEqual([
      "equityOverview",
      "summary",
      "equityMetrics",
      "valuationWorkbench",
      "gaps",
    ]);
  });

  test("projects the solved-input matrix and disclosed assumptions", () => {
    const artifact = reverseDcfArtifact();
    const detail = { summary: summary(), reverseDcf: artifact };
    const view = reverseDcfView(detail);
    const workspace = buildRunWorkspaceView(detail);

    expect(view).toMatchObject({
      status: "computed",
      startingFcf: "8 USD",
      startingFcfDates: "period 2025-12-31 · public 2026-02-01",
      enterpriseValue: "1,000 USD",
      enterpriseValueDate: "fetch time 2026-02-02",
      horizonYears: 5,
      terminalGrowthRatesPct: [0, 1, 2, 3, 4],
    });
    expect(view?.status === "computed" ? view.rows : []).toHaveLength(9);
    expect(view?.status === "computed" && view.rows.every((row) => row.cells.length === 5)).toBe(
      true,
    );
    expect(tocKeys(workspace)).toEqual([
      "equityOverview",
      "summary",
      "equityMetrics",
      "reverseDcf",
      "gaps",
    ]);
  });

  test("keeps every populated reverse DCF view string inside the research-only boundary", () => {
    const view = reverseDcfView({
      summary: summary(),
      reverseDcf: reverseDcfArtifact(),
    });

    for (const text of renderedStrings(view)) {
      expect(violatesResearchOnly(text)).toBeNull();
    }
  });

  test("scales large peer-implied range disclosure inputs", () => {
    const view = peerImpliedRangeView({
      summary: summary(),
      peerImpliedRange: derivePeerImpliedRange({
        supportability: "supported",
        usablePeerCount: 3,
        peerP25EvToAnnualizedRevenue: 1,
        peerMedianEvToAnnualizedRevenue: 2,
        peerP75EvToAnnualizedRevenue: 3,
        annualizedRevenue: 391_035_000_000,
        netDebt: 40_000_000_000,
        sharesOutstanding: 15_000_000_000,
        currentPrice: 198.5,
        quoteCurrency: "USD",
        quoteObservedAt: "2026-07-04T12:00:00.000Z",
      }),
    });

    expect(view).toMatchObject({
      methodDisclosure: expect.stringContaining(
        "annualized revenue $391.0B, net debt $40.0B, shares 15.0B",
      ),
    });
  });

  test("renders peer suppression and omits an absent range block", async () => {
    const suppressed = derivePeerImpliedRange({
      supportability: "screening-only",
      usablePeerCount: 2,
    });
    const detail = { summary: summary(), peerImpliedRange: suppressed };

    expect(buildRunWorkspaceView(detail).peerImpliedRange).toEqual({
      status: "suppressed",
      label: "peer-implied price reference range",
      sourceIds: [],
      suppressionReason: "peer supportability is not supported",
      message: "Reference range suppressed: peer supportability is not supported.",
    });
    expect(buildRunWorkspaceView({ summary: summary() }).peerImpliedRange).toBeUndefined();
    const html = await renderRunWorkspaceComponent(detail);
    const text = html
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    expect(text).toContain("N/M — peer evidence unavailable: peer supportability is not supported");
  }, 15_000);

  test("keeps every peer-implied range view string inside the research-only boundary", () => {
    const derivedViews = [20, 79, 140].map((currentPrice) =>
      peerImpliedRangeView({
        summary: summary(),
        peerImpliedRange: peerImpliedRange(currentPrice),
      }),
    );
    const baseInput = {
      supportability: "supported" as const,
      usablePeerCount: 3,
      peerP25EvToAnnualizedRevenue: 1,
      peerMedianEvToAnnualizedRevenue: 2,
      peerP75EvToAnnualizedRevenue: 3,
      annualizedRevenue: 400,
      netDebt: 10,
      sharesOutstanding: 10,
      currentPrice: 79,
      quoteCurrency: "USD",
      quoteObservedAt: "2026-07-04T12:00:00.000Z",
    };
    const { netDebt: _netDebt, ...withoutNetDebt } = baseInput;
    const { currentPrice: _currentPrice, ...withoutCurrentPrice } = baseInput;
    const suppressedInputs: readonly Parameters<typeof derivePeerImpliedRange>[0][] = [
      { ...baseInput, supportability: "screening-only" },
      { ...baseInput, usablePeerCount: 2 },
      { ...baseInput, annualizedRevenue: 0 },
      withoutNetDebt,
      { ...baseInput, netDebt: "mixed-period" },
      { ...baseInput, sharesOutstanding: 0 },
      { ...baseInput, quoteCurrency: "EUR" },
      { ...baseInput, peerP25EvToAnnualizedRevenue: 0 },
      withoutCurrentPrice,
    ];
    const suppressedViews = suppressedInputs.map((input) =>
      peerImpliedRangeView({
        summary: summary(),
        peerImpliedRange: derivePeerImpliedRange(input),
      }),
    );

    for (const text of renderedStrings([...derivedViews, ...suppressedViews])) {
      expect(violatesResearchOnly(text)).toBeNull();
    }
  });

  test("builds five live snapshot projections and renders completeness by its canonical route", async () => {
    const detail: RunDetail = {
      summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH] }),
      report: completenessReport(),
      marketSnapshots: [
        marketSnapshot({
          fundamentals: {
            trailingPE: 31,
            forwardPE: 28,
            epsForward: 7.25,
            dividendYield: 0.36,
            sharesOutstanding: 15_000_000_000,
          },
        }),
      ],
      verifiedMarketSnapshot: snapshot(),
      fundamentalHistory: snapshotFundamentalHistory(
        {
          revenue: [100, 120, 150],
          freeCashFlowProxy: [-10, -5, -2],
          operatingMargin: [-0.1, 0, 0.2],
          dilutedEps: [2, 2.5, 6.13],
        },
        {
          revenue: 170,
          freeCashFlowProxy: -1,
          operatingMargin: 0.25,
          dilutedEps: 6.5,
        },
      ),
      peerImpliedRange: peerImpliedRange(),
      financialLenses: {
        version: 1,
        generatedAt: "2026-07-04T12:00:00.000Z",
        symbol: "AAPL",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-supported",
            metrics: [],
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          },
          {
            name: "Growth",
            posture: "criteria-mixed",
            metrics: [],
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          },
          {
            name: "Financial Strength",
            posture: "criteria-not-supported",
            metrics: [],
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          },
          {
            name: "Value",
            posture: "insufficient-data",
            metrics: [],
            sourceIds: [],
          },
          {
            name: "Momentum",
            posture: "criteria-supported",
            metrics: [],
            sourceIds: ["verified-snapshot-AAPL"],
          },
        ],
        sourceIds: ["extended-sec-edgar-aapl-fundamentals", "verified-snapshot-AAPL"],
      },
    };

    const view = equitySnapshotView(detail);

    expect(view?.pricePerformance).toMatchObject({
      state: "available",
      price: "$211",
      change24h: "+1.4%",
      quoteCurrency: "USD",
      observedAt: "2026-07-04T12:00:00.000Z",
      priceAsOf: { kind: "fetch-time-only", instant: "2026-07-04T12:00:00.000Z" },
      sourceIds: ["market-yahoo-equity-aapl"],
    });
    expect(view?.peerReferenceRange).toMatchObject({
      state: "available",
      display: "Low $39.00 · Mid $79.00 · High $119.00",
      positionLabel: "Within range",
      disclosure: "Peer-derived reference range for context only; not a target price.",
    });
    expect(view?.keyDatedMetrics.metrics.map((metric) => metric.key)).toEqual([
      "ttmRevenue",
      "ttmFreeCashFlowProxy",
      "ttmDilutedEps",
      "ttmOperatingMargin",
      "forwardPE",
      "forwardEPS",
    ]);
    expect(view?.keyDatedMetrics.metrics.slice(0, 4)).toEqual([
      expect.objectContaining({
        value: "$170",
        dateBasis: "period 2025-06-30 · filed 2025-08-01",
      }),
      expect.objectContaining({
        value: "$-1",
        dateBasis: "period 2025-06-30 · filed 2025-08-01",
      }),
      expect.objectContaining({
        value: "$6.50",
        dateBasis: "period 2025-06-30 · filed 2025-08-01",
      }),
      expect.objectContaining({
        value: "25.0%",
        dateBasis: "period 2025-06-30 · filed 2025-08-01",
      }),
    ]);
    expect(view?.keyDatedMetrics.metrics.slice(4)).toEqual([
      expect.objectContaining({
        value: "28.00x",
        dateBasis: "fetch time 2026-07-04T12:00:00.000Z",
      }),
      expect.objectContaining({
        value: "$7.25",
        dateBasis: "fetch time 2026-07-04T12:00:00.000Z",
      }),
    ]);
    expect(view?.keyDatedMetrics.foldedYahooMetrics.map((metric) => metric.key)).toEqual([
      "marketCap",
      "trailingPE",
      "dividendYield",
      "sharesOutstanding",
    ]);
    expect(view?.miniCharts.charts.map((chart) => chart.key)).toEqual([
      "revenue",
      "freeCashFlowProxy",
      "operatingMargin",
      "dilutedEps",
    ]);
    expect(view?.miniCharts.charts[0]?.geometry?.baseline).toBe(1);
    expect(view?.miniCharts.charts[1]?.geometry?.baseline).toBe(0);
    expect(view?.miniCharts.charts[2]?.geometry?.baseline).toBeCloseTo(5 / 7);
    expect(view?.miniCharts.charts.every((chart) => chart.geometry?.bars.length === 4)).toBeTrue();
    expect(view?.financialLensDrivers.postures.items.map((posture) => posture.posture)).toEqual([
      "criteria-supported",
      "criteria-mixed",
      "criteria-not-supported",
      "insufficient-data",
      "criteria-supported",
    ]);
    expect(view?.financialLensDrivers.bullCase).toMatchObject({
      items: [{ text: "Revenue growth persists.", sourceIds: ["source-bull"] }],
    });
    expect(view?.financialLensDrivers.bearCase).toMatchObject({
      items: [{ text: "Operating costs rise.", sourceIds: ["source-bear"] }],
    });
    const html = await renderRunWorkspaceComponent(detail, "advanced");
    const text = html
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    expect(text).toContain("financial core · complete");
    expect(text).toContain("coverage · comprehensive");
    expect(text).toContain("Annual statement remains current");
  }, 15_000);

  test("partitions the equity reader view from Advanced without dropping content", () => {
    const report = {
      ...completenessReport(),
      symbol: "AAPL",
      keyFindings: [{ text: "Reader finding sentinel.", sourceIds: ["source-bull"] }],
      catalysts: [{ text: "Reader catalyst sentinel.", sourceIds: ["source-bull"] }],
      risks: [{ text: "Reader risk sentinel.", sourceIds: ["source-bear"] }],
      scenarios: [
        {
          name: "Advanced scenario sentinel",
          description: "Scenario detail.",
          sourceIds: ["source-bear"],
        },
      ],
      dataGaps: ["Primary revenue evidence missing.", "tradier: API token missing"],
      extras: {
        earningsSetup: {
          event: {
            date: "2026-08-01",
            timing: "after-market",
            eventDateStatus: "provider-estimated",
            epsEstimate: 1.25,
            revenueEstimate: 12_000_000_000,
            sourceIds: ["source-bull"],
          },
        },
        businessFramework: {
          phase: "capital-return",
          sections: [
            {
              name: "Business",
              posture: "criteria-supported",
              text: "Apple designs devices and digital services.",
              sourceIds: ["source-bull"],
            },
          ],
          sourceIds: ["source-bull"],
          gaps: [],
        },
      },
      extendedEvidence: {
        items: [
          {
            category: "analyst-estimates",
            title: "Analyst consensus sentinel",
            summary: "Distribution detail.",
            metrics: {
              mean: 1.2,
              median: 1.1,
              high: 1.5,
              low: 0.8,
              period: "FY 2027",
              count: 12,
            },
            sourceIds: ["source-bull"],
          },
          {
            category: "institutional-ownership",
            title: "Institutional detail sentinel",
            summary: "Ownership detail.",
            sourceIds: ["source-bear"],
          },
          {
            category: "options-iv",
            title: "Options detail sentinel",
            summary: "Options detail.",
            sourceIds: ["source-bear"],
          },
        ],
      },
    };
    const financialLenses = {
      version: 1 as const,
      generatedAt: "2026-07-04T12:00:00.000Z",
      symbol: "AAPL",
      lenses: [
        {
          name: "Quality" as const,
          posture: "criteria-supported" as const,
          metrics: [],
          sourceIds: ["source-bull"],
        },
        {
          name: "Growth" as const,
          posture: "criteria-mixed" as const,
          metrics: [],
          sourceIds: ["source-bull"],
        },
        {
          name: "Financial Strength" as const,
          posture: "criteria-not-supported" as const,
          metrics: [],
          sourceIds: ["source-bear"],
        },
        {
          name: "Value" as const,
          posture: "insufficient-data" as const,
          metrics: [],
          sourceIds: [],
        },
      ],
      sourceIds: ["source-bull", "source-bear"],
    };
    const view = buildRunWorkspaceView({
      summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH] }),
      report,
      marketSnapshots: [marketSnapshot()],
      verifiedMarketSnapshot: snapshot(),
      fundamentalHistory: snapshotFundamentalHistory(
        {},
        { revenue: 170, freeCashFlowProxy: 35, operatingMargin: 0.25 },
      ),
      financialStatements: balanceSheetHistoryFixture(),
      peerImpliedRange: peerImpliedRange(),
      valuationWorkbench: valuationWorkbench(),
      financialLenses,
      reverseDcf: reverseDcfArtifact(),
    });

    const reader = view.equityPresentation?.defaultView;
    const advanced = view.equityPresentation?.advanced;
    expect(reader?.financialTrends?.columns).toEqual([
      "Period",
      "Revenue",
      "Net income",
      "Operating margin",
      "FCF",
    ]);
    expect(reader?.financialTrends?.rows[0]).toEqual({
      period: "FY ending 2022-09-30 (filed 2022-11-01)",
      revenue: "100",
      netIncome: "20",
      operatingMargin: "25.0%",
      freeCashFlow: "22",
    });
    expect(reader?.financialTrends?.rows.at(-1)).toMatchObject({
      period: "TTM (2025-06-30; filed 2025-08-01)",
      revenue: "170",
      operatingMargin: "25.0%",
      freeCashFlow: "35",
    });
    expect(reader?.cases.map((section) => section.key)).toEqual(["risks", "catalysts"]);
    expect(advanced?.cases.map((section) => section.key)).toEqual(["bullCase", "bearCase"]);
    expect(reader?.materialGaps).toEqual(["Primary revenue evidence missing."]);
    expect(advanced?.diagnosticGaps).toEqual(["tradier: API token missing"]);
    expect(advanced?.financialLensGroups).toHaveLength(financialLenses.lenses.length);
    expect(advanced?.valuationWorkbench).toBeDefined();
    expect(advanced?.reverseDcf).toBeDefined();
    expect(advanced?.peerImpliedRange).toBeDefined();
    expect(advanced?.extendedItems).toHaveLength(report.extendedEvidence.items.length);
    expect(advanced?.balanceSheetHistory?.rows).toEqual([
      {
        period: "FY ending 2023-12-31 (filed 2024-02-01)",
        cash: "$30.0B",
        debt: "$90.0B",
        dilutedShares: "15.5B",
      },
      {
        period: "FY ending 2024-12-31 (filed 2025-02-01)",
        cash: "$32.0B",
        debt: "$85.0B",
        dilutedShares: "15.0B",
      },
    ]);
    expect(reader?.earningsConsensus.items.map((item) => item.label)).toEqual([
      "Upcoming earnings",
      "EPS consensus",
      "Revenue consensus",
      "Analyst consensus sentinel",
    ]);
    expect(advanced?.analystEstimateDistributions).toEqual([
      {
        title: "Analyst consensus sentinel",
        period: "FY 2027",
        mean: "1.2",
        median: "1.1",
        high: "1.5",
        low: "0.8",
        count: "12",
        sourceIds: ["source-bull"],
      },
    ]);
    expect(reader?.companySummary).toEqual({
      text: "Apple designs devices and digital services.",
      sourceIds: ["source-bull"],
    });
    expect(advanced?.reportSummary).toBe("Equity summary.");

    const readerText = renderedStrings(reader).join("\n");
    const advancedText = renderedStrings(advanced).join("\n");
    expect(readerText).not.toContain("Equity summary.");
    expect(advancedText).toContain("Equity summary.");
    for (const readerOnly of [
      "Reader finding sentinel.",
      "Reader catalyst sentinel.",
      "Reader risk sentinel.",
      "Primary revenue evidence missing.",
      "2026-08-01 · after-market · provider-estimated",
    ]) {
      expect(readerText).toContain(readerOnly);
      expect(advancedText).not.toContain(readerOnly);
    }
    for (const advancedOnly of [
      "criteria-supported",
      "criteria-mixed",
      "criteria-not-supported",
      "insufficient-data",
      "Advanced scenario sentinel",
      "Institutional detail sentinel",
      "Options detail sentinel",
      "tradier: API token missing",
    ]) {
      expect(advancedText).toContain(advancedOnly);
      expect(readerText).not.toContain(advancedOnly);
    }

    const wholeViewText = renderedStrings(view).join("\n");
    for (const retained of [
      "Reader finding sentinel.",
      "Reader catalyst sentinel.",
      "Reader risk sentinel.",
      "Advanced scenario sentinel",
      "Institutional detail sentinel",
      "Options detail sentinel",
      "Primary revenue evidence missing.",
      "tradier: API token missing",
    ]) {
      expect(wholeViewText).toContain(retained);
    }
    expect(view.report.financialLensGroups).toHaveLength(financialLenses.lenses.length);
    expect(view.evidence.extendedItems).toHaveLength(report.extendedEvidence.items.length);
  });

  test("server-renders Simple cases and gaps as the Advanced subset", async () => {
    const materialGap = "Primary revenue evidence missing.";
    const diagnosticGap = "tradier: API token missing";
    const detail = {
      summary: summary(),
      report: {
        ...completenessReport(),
        catalysts: [{ text: "Reader catalyst sentinel.", sourceIds: ["source-bull"] }],
        risks: [{ text: "Reader risk sentinel.", sourceIds: ["source-bear"] }],
        dataGaps: [materialGap, diagnosticGap],
      },
    };

    const simpleHtml = await renderRunWorkspaceComponent(detail, "simple");
    expect(simpleHtml).toContain("Reader catalyst sentinel.");
    expect(simpleHtml).toContain("Reader risk sentinel.");
    expect(simpleHtml).not.toContain("Revenue growth persists.");
    expect(simpleHtml).not.toContain("Operating costs rise.");
    expect(simpleHtml.indexOf("Reader risk sentinel.")).toBeLessThan(
      simpleHtml.indexOf("Reader catalyst sentinel."),
    );
    expect(simpleHtml.split(materialGap)).toHaveLength(2);
    expect(simpleHtml).not.toContain(diagnosticGap);
    expect(simpleHtml).toContain("financial core · complete");
    // The ledger's KPI strip and lens rail are appendix data, so Simple omits them.
    expect(simpleHtml).not.toContain("Financial Lens postures");
    expect(simpleHtml).not.toContain("Trailing P/E");

    const advancedHtml = await renderRunWorkspaceComponent(detail, "advanced");
    const casePositions = [
      "Reader risk sentinel.",
      "Reader catalyst sentinel.",
      "Revenue growth persists.",
      "Operating costs rise.",
    ].map((text) => advancedHtml.indexOf(text));
    expect(casePositions.every((position) => position >= 0)).toBeTrue();
    expect(casePositions).toEqual(casePositions.toSorted((left, right) => left - right));
    expect(advancedHtml.split(materialGap)).toHaveLength(2);
    expect(advancedHtml.split(diagnosticGap)).toHaveLength(2);
    expect(advancedHtml).toContain("MATERIAL");
    expect(advancedHtml).toContain("DIAGNOSTIC");
    const advancedArticle = elementHtml(advancedHtml, "article");
    expect(advancedArticle).toContain("Company summary");
    expect(advancedArticle).toContain("Report summary");
    expect(advancedArticle.indexOf("Company summary")).toBeLessThan(
      advancedArticle.indexOf("Report summary"),
    );
  }, 15_000);

  test("uses identical financial-trend rows in Console and report markdown", () => {
    const history = snapshotFundamentalHistory(
      {
        revenue: [100, 120, 140],
        operatingMargin: [0.2, 0.22, 0.24],
        freeCashFlowProxy: [20, 25, 30],
      },
      { revenue: 170, operatingMargin: 0.25, freeCashFlowProxy: 35 },
    );
    const report = financialTrendReport(history.sourceId);
    const consoleRows = buildRunWorkspaceView({
      summary: summary(),
      report: { ...report },
      fundamentalHistory: history,
    }).equityPresentation?.defaultView.financialTrends?.rows;
    const markdown = renderFinancialTrends(report, { fundamentalHistory: history });

    expect(consoleRows).not.toBeUndefined();
    expect(consoleRows?.length).toBeGreaterThan(0);
    for (const row of consoleRows ?? []) {
      expect(markdown).toContain(
        [row.period, row.revenue, row.netIncome, row.operatingMargin, row.freeCashFlow].join(" | "),
      );
    }
    expect(markdown.split("\n").filter((line) => line.split(" | ").length === 5)).toHaveLength(
      (consoleRows?.length ?? 0) + 2,
    );
  });

  // Balance sheet is deliberately out of scope here. Markdown formats those cells with
  // `compactNumber`, the Console uses `scaleCurrency` (K tier, toFixed(0), currency prefix).
  // Unifying them needs a ladder/currency decision that would churn goldens.
  test("uses identical consensus and estimate-distribution numbers in Console and report markdown", () => {
    const report: ResearchReport = {
      ...financialTrendReport("source-bull"),
      extras: {
        earningsSetup: {
          event: {
            date: "2026-08-01",
            timing: "after-market",
            eventDateStatus: "provider-estimated",
            epsEstimate: 1.715,
            revenueEstimate: 123_456.75,
            sourceIds: ["source-bull"],
          },
        },
      },
      extendedEvidence: {
        gaps: [],
        items: [
          {
            category: "analyst-estimates",
            title: "Analyst consensus sentinel",
            summary: "Distribution detail.",
            observedAt: "2026-07-04T12:00:00.000Z",
            metrics: {
              mean: 1.715,
              median: 0.125,
              high: 123_456.75,
              low: 0.875,
              period: "FY 2027",
              count: 12,
            },
            sourceIds: ["source-bull"],
          },
        ],
      },
    };
    const presentation = buildRunWorkspaceView({
      summary: summary(),
      report: { ...report },
    }).equityPresentation;
    const markdown = renderMarkdownReport(report);

    const distributions = presentation?.advanced.analystEstimateDistributions ?? [];
    expect(distributions).toHaveLength(1);
    for (const distribution of distributions) {
      for (const value of [
        distribution.mean,
        distribution.median,
        distribution.high,
        distribution.low,
      ]) {
        expect(markdown).toContain(value);
      }
    }

    const consensusItems = presentation?.defaultView.earningsConsensus.items ?? [];
    expect(consensusItems.length).toBeGreaterThan(0);
    for (const item of consensusItems) {
      for (const numeric of item.value.match(/[\d,]+(?:\.\d+)?[TBM]?/gu) ?? []) {
        expect(markdown).toContain(numeric);
      }
    }
  });

  test("ignores annual periods from non-column fundamental series", () => {
    const history = fundamentalHistoryFixture();
    const annualPoint = history.series.dilutedEps.annual.at(-1);
    expect(annualPoint).not.toBeUndefined();
    if (annualPoint === undefined) {
      return;
    }
    const annualPeriodEnd = "2026-09-30";
    const nonColumnAnnual = {
      ...annualPoint,
      periodEnd: annualPeriodEnd,
      filedAt: "2026-11-01",
    };
    const rows = projectEquityReader({
      report: {},
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          grossProfit: {
            ...history.series.grossProfit,
            annual: [...history.series.grossProfit.annual, nonColumnAnnual],
          },
        },
      },
    }).defaultView.financialTrends?.rows;

    expect(rows?.some((row) => row.period.includes(annualPeriodEnd))).toBe(false);
  });

  test("ignores the TTM period from non-column fundamental series", () => {
    const history = fundamentalHistoryFixture();
    const annualPoint = history.series.dilutedEps.annual.at(-1);
    expect(annualPoint).not.toBeUndefined();
    if (annualPoint === undefined) {
      return;
    }
    const ttmPeriodEnd = "2026-12-31";
    const nonColumnTtm = {
      ...snapshotHistoryPoint(annualPoint, annualPoint.value),
      periodEnd: ttmPeriodEnd,
      filedAt: "2027-02-01",
    };
    const rows = projectEquityReader({
      report: {},
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          dilutedEps: {
            ...history.series.dilutedEps,
            ttm: nonColumnTtm,
          },
        },
      },
    }).defaultView.financialTrends?.rows;

    expect(rows?.some((row) => row.period.includes(ttmPeriodEnd))).toBe(false);
  });

  test("labels each trend row with the latest filing among its displayed values", () => {
    const history = fundamentalHistoryFixture();
    const latestRevenue = history.series.revenue.annual.at(-1);
    expect(latestRevenue).not.toBeUndefined();
    if (latestRevenue === undefined) {
      return;
    }
    const { periodEnd } = latestRevenue;
    const rows = projectEquityReader({
      report: {},
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          revenue: {
            ...history.series.revenue,
            annual: history.series.revenue.annual.map((point) =>
              point.periodEnd === periodEnd ? { ...point, filedAt: "2025-11-02" } : point,
            ),
          },
          netIncome: {
            ...history.series.netIncome,
            annual: history.series.netIncome.annual.map((point) =>
              point.periodEnd === periodEnd ? { ...point, filedAt: "2025-11-03" } : point,
            ),
          },
          dilutedEps: {
            ...history.series.dilutedEps,
            annual: history.series.dilutedEps.annual.map((point) =>
              point.periodEnd === periodEnd ? { ...point, filedAt: "2026-01-15" } : point,
            ),
          },
        },
      },
    }).defaultView.financialTrends?.rows;

    expect(rows?.find((row) => row.period.includes(periodEnd))?.period).toBe(
      `FY ending ${periodEnd} (filed 2025-11-03)`,
    );
  });

  test("surfaces missing revenue history as a material reader gap", () => {
    const history = fundamentalHistoryFixture();
    const view = buildRunWorkspaceView({
      summary: summary(),
      report: completenessReport(),
      fundamentalHistory: {
        ...history,
        series: {
          ...history.series,
          revenue: { ...history.series.revenue, annual: [], notes: [] },
          operatingMargin: { ...history.series.operatingMargin, annual: [], notes: [] },
        },
      },
    });

    expect(view.equityPresentation?.defaultView.materialGaps).toContain(
      "fundamental-history-revenue: SEC revenue history is unavailable for 3 rendered period(s); affected revenue and derived operating-margin values are shown as unavailable",
    );
  });

  test("uses the cited company-description fallback instead of report summary", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      report: {
        ...completenessReport(),
        summary: "Advanced narrative summary.",
        extras: {
          businessFramework: {
            sections: [
              {
                name: "Business",
                posture: "criteria-supported",
                text: "Business criteria-supported",
                sourceIds: ["source-bull"],
              },
            ],
          },
        },
      },
    });

    expect(view.equityPresentation?.defaultView.companySummary).toEqual({
      text: "No cited plain-language company description is available.",
      sourceIds: [],
    });
    expect(view.equityPresentation?.advanced.reportSummary).toBe("Advanced narrative summary.");
  });

  test("preserves GBp price formatting in the snapshot", () => {
    const view = equitySnapshotView({
      summary: summary({ symbol: "RR.L" }),
      marketSnapshots: [
        marketSnapshot({
          symbol: "rr.l",
          identity: { displayName: "Rolls-Royce Holdings", quoteCurrency: "GBp" },
          price: 912.4,
          changePercent24h: -1.25,
        }),
      ],
    });

    expect(view?.pricePerformance).toMatchObject({
      price: "912.4p",
      quoteCurrency: "GBp",
      change24h: "-1.3%",
      observedAt: "2026-07-04T12:00:00.000Z",
      priceAsOf: { kind: "fetch-time-only", instant: "2026-07-04T12:00:00.000Z" },
      sourceIds: ["market-yahoo-equity-aapl"],
    });
  });

  test("does not substitute zero for a missing 24h change", () => {
    const view = equitySnapshotView({
      summary: summary(),
      marketSnapshots: [
        marketSnapshot({
          changePercent24h: undefined as never,
        }),
      ],
    });

    expect(view?.pricePerformance).toMatchObject({
      state: "partial",
      price: "$211",
    });
    expect(view?.pricePerformance.change24h).toBeUndefined();
    expect(view?.pricePerformance.changeDirection).toBeUndefined();
  });

  test("keeps the first two cited case drivers in report order", () => {
    const view = equitySnapshotView({
      summary: summary(),
      report: {
        bullCase: [
          { text: "Uncited.", sourceIds: [] },
          { text: "First cited.", sourceIds: ["source-1"] },
          { text: "Second cited.", sourceIds: ["source-2"] },
          { text: "Third cited.", sourceIds: ["source-3"] },
        ],
        bearCase: [],
      },
    });

    expect(view?.financialLensDrivers.bullCase.items).toEqual([
      { text: "First cited.", sourceIds: ["source-1"] },
      { text: "Second cited.", sourceIds: ["source-2"] },
    ]);
    expect(view?.financialLensDrivers.bearCase).toMatchObject({
      state: "unavailable",
      items: [],
    });
  });

  test("requires reconciled TTM metrics while preserving legitimate zero and negative values", () => {
    const annualOnly = equitySnapshotView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryFixture(),
    });
    const populated = equitySnapshotView({
      summary: summary(),
      fundamentalHistory: snapshotFundamentalHistory({}, { dilutedEps: -0.5, operatingMargin: 0 }),
    });

    for (const metric of annualOnly?.keyDatedMetrics.metrics.slice(0, 4) ?? []) {
      expect(metric).toMatchObject({ state: "unavailable", sourceIds: [] });
      expect(metric.value).toBeUndefined();
      expect(metric.dateBasis).toBeUndefined();
    }
    expect(populated?.keyDatedMetrics.metrics[2]).toMatchObject({
      state: "available",
      value: "$-0.50",
    });
    expect(populated?.keyDatedMetrics.metrics[3]).toMatchObject({
      state: "available",
      value: "0.0%",
    });
  });

  test("keeps the operating-margin chart slot unavailable without substituting another margin", () => {
    const artifact = snapshotFundamentalHistory();
    const { ttm: _ttm, ...operatingMargin } = artifact.series.operatingMargin;
    const view = equitySnapshotView({
      summary: summary(),
      fundamentalHistory: {
        ...artifact,
        series: {
          ...artifact.series,
          operatingMargin: { ...operatingMargin, annual: [] },
        },
      },
    });

    expect(view?.miniCharts.charts).toHaveLength(4);
    expect(view?.miniCharts.charts[2]).toEqual({
      key: "operatingMargin",
      label: "Operating margin",
      state: "unavailable",
      sourceIds: [],
    });
    expect(view?.keyDatedMetrics.metrics[3]).toMatchObject({
      key: "ttmOperatingMargin",
      state: "unavailable",
    });
  });

  test("renders explicit unavailable states for historical equity runs", () => {
    const view = equitySnapshotView({
      summary: summary(),
      report: {
        bullCase: [{ text: "Uncited report text.", sourceIds: [] }],
      },
    });

    expect(view).toBeDefined();
    expect(view?.pricePerformance).toMatchObject({
      state: "unavailable",
      sourceIds: [],
    });
    expect(view?.peerReferenceRange).toMatchObject({
      state: "unavailable",
      display: "N/M — peer evidence unavailable: reference range is unavailable",
    });
    expect(
      view?.keyDatedMetrics.metrics.every((metric) => metric.state === "unavailable"),
    ).toBeTrue();
    expect(view?.miniCharts.charts.every((chart) => chart.state === "unavailable")).toBeTrue();
    expect(view?.financialLensDrivers.bullCase).toMatchObject({
      state: "unavailable",
      items: [],
    });
    expect(view?.financialLensDrivers.bearCase).toMatchObject({
      state: "unavailable",
      items: [],
    });
  });

  test("does not add the equity snapshot to non-equity workspaces", () => {
    const detail: RunDetail = {
      summary: summary({ jobType: "crypto", assetClass: "crypto", symbol: "BTC" }),
      report: { summary: "Crypto summary." },
    };
    const workspace = buildRunWorkspaceView(detail);

    expect(equitySnapshotView(detail)).toBeUndefined();
    expect(workspace.equityPresentation).toBeUndefined();
    expect(workspace.report.summary).toBe("Crypto summary.");
    expect(tocKeys(workspace)).toEqual(["summary"]);
  });

  test("does not advertise completeness when a research run has no equity presentation", () => {
    const workspace = buildRunWorkspaceView({
      summary: summary({ jobType: "research" }),
      report: completenessReport(),
    });

    expect(workspace.equityPresentation).toBeUndefined();
    expect(tocKeys(workspace)).not.toContain("equityCompleteness");
  });

  test("keeps the equity reader projection for legacy runs without assetClass", () => {
    const { assetClass: _assetClass, ...legacySummary } = summary();
    const detail: RunDetail = {
      summary: legacySummary,
      report: completenessReport(),
      marketSnapshots: [marketSnapshot()],
    };
    const workspace = buildRunWorkspaceView(detail);

    expect(equitySnapshotView(detail)).toBeDefined();
    expect(workspace.equityPresentation).toBeDefined();
  });

  test("renders the equity reader projection before the mode-gated inline appendix", () => {
    const consoleSource = readFileSync(
      new URL("../app/client/components/run-workspace.svelte", import.meta.url),
      "utf8",
    );
    const advancedStart = consoleSource.indexOf("{#snippet reportBody()}");
    const readerSource = consoleSource.slice(0, advancedStart);
    const advancedSource = consoleSource.slice(advancedStart);
    // The ledger renders both modes, so its appendix data stays behind isAdvanced.
    const ledgerSource = readFileSync(
      new URL("../app/client/components/equity-ledger.svelte", import.meta.url),
      "utf8",
    );

    expect(advancedStart).toBeGreaterThan(0);
    expect(consoleSource).not.toContain("<details");
    expect(consoleSource).not.toContain("<summary");
    expect(consoleSource).toContain(
      'class="ledger-extras mt-7 border border-border bg-card px-7 pb-7 pt-6 shadow-[0_1px_0_#e4e0d6]"',
    );
    expect(readerSource).toContain("<EquityLedger");
    expect(ledgerSource).toContain("defaultView.financialTrends");
    expect(readerSource).toContain("equityPresentation.defaultView.materialGaps");
    expect(readerSource).not.toContain("equityPresentation.advanced.");
    expect(advancedSource).toContain("equityPresentation.advanced.financialLensDrivers");
    expect(advancedSource).toContain("equityPresentation.advanced.balanceSheetHistory");
    expect(advancedSource).toContain("valuationWorkbench.excludedPeerRows");
    expect(advancedSource).not.toContain("equityPresentation.defaultView.");
  });

  test("keeps bindSection keys unique across the component", () => {
    const consoleSource = readFileSync(
      new URL("../app/client/components/run-workspace.svelte", import.meta.url),
      "utf8",
    );
    const keys = [...consoleSource.matchAll(/bindSection\("([^"]+)"\)/gu)].map((match) => match[1]);

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("server-renders financial-core status and non-empty trend rows in the equity reader", async () => {
    const history = snapshotFundamentalHistory(
      {},
      { revenue: 170, freeCashFlowProxy: 35, operatingMargin: 0.25 },
    );
    const detail = {
      summary: summary(),
      report: completenessReport(),
      marketSnapshots: [marketSnapshot()],
      fundamentalHistory: history,
    };
    const html = await renderRunWorkspaceComponent(detail);
    const text = html
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    const expectedRows =
      buildRunWorkspaceView(detail).equityPresentation?.defaultView.financialTrends?.rows;

    expect(text).toContain("financial core · complete");
    expect(expectedRows?.length).toBeGreaterThan(0);
    for (const row of expectedRows ?? []) {
      expect(text).toContain(row.period);
      expect(text).toContain(row.revenue);
    }
  });

  test("server-renders the report detail control only on the Report tab", async () => {
    const detail = tableOfContentsFixture();

    const reportTab = await renderRunWorkspaceComponent(detail, "advanced", "report");
    expect(reportTab).toContain('aria-label="Report detail"');

    for (const tab of ["sources", "data", "files", "chat"]) {
      const other = await renderRunWorkspaceComponent(detail, "advanced", tab);
      expect(other, tab).not.toContain('aria-label="Report detail"');
    }
  }, 20_000);

  test("server-renders empty equity coverage in Simple and Advanced", async () => {
    const detail = {
      summary: summary(),
      report: completenessReport(),
      marketSnapshots: [marketSnapshot()],
      fundamentalHistory: snapshotFundamentalHistory(),
    };
    const view = buildRunWorkspaceView(detail);

    expect(view.equityPresentation).toBeDefined();
    expect(view.equityPresentation?.defaultView.materialGaps).toEqual([]);
    expect(view.gaps.shortfalls).toEqual([]);

    for (const reportDetail of ["simple", "advanced"] as const) {
      const article = elementHtml(
        await renderRunWorkspaceComponent(detail, reportDetail),
        "article",
      );
      const text = htmlText(article);

      expect(text.split("Coverage & material gaps")).toHaveLength(2);
      expect(text).toContain("No material gaps identified.");
      expect(text).toContain("financial core · complete");
    }
  }, 15_000);

  test("keeps deterministic snapshot and Console copy inside the research-only boundary", () => {
    const snapshotView = equitySnapshotView({
      summary: summary(),
      report: completenessReport(),
      marketSnapshots: [marketSnapshot({ fundamentals: { forwardPE: 28, epsForward: 7.25 } })],
      fundamentalHistory: snapshotFundamentalHistory(),
      peerImpliedRange: peerImpliedRange(),
    });
    for (const text of renderedStrings(snapshotView)) {
      expect(violatesResearchOnly(text), text).toBeNull();
      expect(
        withoutPermittedPeerPhrase(text).match(BANNED_SNAPSHOT_CONSOLE_TOKENS),
        text,
      ).toBeNull();
    }

    const consoleSource = readFileSync(
      new URL("../app/client/components/run-workspace.svelte", import.meta.url),
      "utf8",
    );
    expect(
      withoutPermittedPeerPhrase(consoleSource).match(BANNED_SNAPSHOT_CONSOLE_TOKENS),
    ).toBeNull();
  });

  test("server-renders the extracted observable-forecasts component with scored evidence", async () => {
    const html = await renderRunWorkspaceComponent(
      {
        summary: summary({ availableFiles: ["score.json"], hasScore: true }),
        report: {
          ...completenessReport(),
          predictions: [
            {
              id: "prediction-1",
              claim: "AAPL rises.",
              kind: "direction",
              subject: "AAPL",
              measurableAs: "AAPL close > 211",
              probability: 0.6,
              horizonTradingDays: 5,
              sourceIds: ["source-bull"],
            },
          ],
        },
        score: {
          scores: [
            {
              predictionId: "prediction-1",
              resolved: true,
              outcome: "hit",
              evidence: { close0: 211, closeN: 215 },
            },
          ],
        },
        analytics: { predictions: { count: 1, targetCount: 3, targetMet: false } },
      },
      "advanced",
    );
    const text = html
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim();

    expect(text).toContain("Observable forecasts");
    expect(text).toContain("AAPL rises.");
    expect(text).toContain("EVENT TRUE");
    expect(text).toContain("BELOW TARGET");
  });
});
