import { describe, expect, test } from "bun:test";
import type { MarketSnapshot, ResearchReport } from "../src/domain/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { validateResearchReport } from "../src/report/schema";
import { buildSourceList } from "../src/research/report-assembly";
import { collectedSources } from "./support/fixtures";

const report: ResearchReport = {
  runId: "run-1",
  jobType: "ticker",
  assetClass: "crypto",
  symbol: "BTC",
  generatedAt: "2026-05-19T00:00:00.000Z",
  summary: "BTC evidence is mixed.",
  keyFindings: [{ text: "BTC liquidity remains high.", sourceIds: ["source-1"] }],
  bullCase: [],
  bearCase: [],
  risks: [{ text: "Volatility remains elevated.", sourceIds: ["source-1"] }],
  catalysts: [],
  scenarios: [
    { name: "Base", description: "Range-bound conditions persist.", sourceIds: ["source-1"] },
  ],
  confidence: "medium",
  dataGaps: ["No derivatives data"],
  predictions: [],
  sources: [
    {
      id: "source-1",
      title: "BTC market snapshot",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      kind: "market-data",
      assetClass: "crypto",
      symbol: "BTC",
      identity: {
        quoteCurrency: "USD",
        providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
      },
    },
  ],
  notFinancialAdvice: true,
};

describe("report schema and rendering", () => {
  test("validates source-linked findings", () => {
    expect(validateResearchReport(report)).toEqual(report);
  });

  test("copies market snapshot identity into report sources", () => {
    const snapshot: MarketSnapshot = {
      sourceId: "market-coingecko-crypto-btc",
      assetClass: "crypto",
      symbol: "BTC",
      identity: {
        quoteCurrency: "USD",
        providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
      },
      price: 103_000,
      changePercent24h: 2,
      volume: 40_000_000_000,
      observedAt: "2026-05-19T00:00:00.000Z",
    };

    const sources = buildSourceList(
      { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [snapshot],
        newsSources: [],
      }),
    );

    expect(sources[0]?.identity).toEqual(snapshot.identity);
  });

  test("rejects missing source references", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        keyFindings: [{ text: "Unsupported finding.", sourceIds: ["missing"] }],
      }),
    ).toThrow("Unknown source ID");
  });

  test("renders Markdown with source references, gaps, and one note", () => {
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("[source-1]");
    expect(markdown).toContain("No derivatives data");
    expect(markdown.match(/Research-only note/gu)?.length).toBe(1);
  });

  test("renders ticker Extended Evidence from report contract", () => {
    const markdown = renderMarkdownReport({
      ...report,
      sources: [
        ...report.sources,
        {
          id: "extended-fred-macro",
          title: "FRED macro pack",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "extended-evidence",
        },
      ],
      extendedEvidence: {
        instrument: { assetClass: "crypto", symbol: "BTC" },
        items: [
          {
            category: "fred-macro",
            title: "FRED macro pack",
            summary: "Latest FRED macro observations captured.",
            sourceIds: ["extended-fred-macro"],
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        gaps: [],
      },
    });

    expect(markdown).toContain("## Extended Evidence");
    expect(markdown).toContain("[extended-fred-macro]");
  });

  test("renders cadence-specific market update titles", () => {
    const { symbol: _symbol, ...marketReport } = report;

    expect(renderMarkdownReport({ ...marketReport, jobType: "daily" })).toContain(
      "# crypto Daily Market Update",
    );
    expect(renderMarkdownReport({ ...marketReport, jobType: "weekly" })).toContain(
      "# crypto Weekly Market Update",
    );
  });

  test("rejects trade-action language in alpha-search reports", () => {
    expect(() =>
      validateResearchReport({
        ...report,
        jobType: "alpha-search",
        assetClass: "equity",
        summary: "Alpha search says buy this instrument.",
        keyFindings: [{ text: "AAPL was discussed.", sourceIds: ["source-1"] }],
        predictions: [],
        extras: {
          researchLeads: [],
          rejectedCandidates: [],
        },
      }),
    ).toThrow("trade-action language");
  });

  test("renders only well-shaped alpha-search extras", () => {
    const markdown = renderMarkdownReport({
      ...report,
      jobType: "alpha-search",
      assetClass: "equity",
      predictions: [],
      extras: {
        researchLeads: [
          {
            symbol: "AAPL",
            price: 190,
            volume: 80_000_000,
            instrumentKind: "stock",
            socialRank: 1,
            socialMomentumScore: 50,
            mentions: 2,
            upvotes: 10,
            sourceIds: ["source-1"],
          },
          { symbol: "BAD", price: "not-a-number", sourceIds: ["source-1"] },
        ],
        rejectedCandidates: [
          {
            symbol: "OTCM",
            socialRank: 2,
            socialMomentumScore: 30,
            reason: "OTC or pink-sheet instrument",
            sourceIds: ["source-1"],
          },
          { symbol: "BROKEN", reason: 123, sourceIds: ["source-1"] },
        ],
      },
    });

    expect(markdown).toContain("AAPL");
    expect(markdown).toContain("OTCM");
    expect(markdown).not.toContain("BAD");
    expect(markdown).not.toContain("BROKEN");
  });
});
