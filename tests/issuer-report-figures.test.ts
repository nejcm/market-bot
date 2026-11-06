import { describe, expect, test } from "bun:test";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import { exchangeProfileFor, issuerReportHostKind } from "../src/domain/exchange-profile";
import type { MarketSnapshot } from "../src/domain/market-data";
import type { Source } from "../src/domain/sources";
import {
  datesIn,
  issuerReportMappingInput,
  issuerReportPacket,
  markdownTables,
  readIssuerReportMapping,
  runIssuerReportPhase,
} from "../src/research/issuer-report-figures";
import { issuerReportGatherContext } from "../src/web-evidence/web-gather-coverage";
import { resolveMetricReferences } from "../src/research/metric-references";
import { auditReportIntegrity } from "../src/research/report-integrity-audit";
import { webSourceTexts } from "../src/research/web-figure-verification";
import { addBusinessFrameworkEvidence } from "../src/sources/extended-evidence/business-framework";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { buildYahooFundamentals } from "../src/sources/extended-evidence/yahoo-fundamentals";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";

// Shape of the KLSE Screener copy of ViTrox (0097.KL) Q3 2026 results, fixture equity-bursa-deep.
const KLSE_TEXT = `VITROX - Quarterly rpt on consolidated results for the financial period ended 30/09/2026

| Financial Year End | 31 Dec 2026 |
| --- | --- |
| Quarter | 3 Qtr |

 Currency: Malaysian Ringgit (MYR)

| | | INDIVIDUAL PERIOD | | CUMULATIVE PERIOD | |
| --- | --- | --- | --- | --- | --- |
| | | CURRENT YEAR QUARTER | PRECEDING YEAR CORRESPONDING QUARTER | CURRENT YEAR TO DATE | PRECEDING YEAR CORRESPONDING PERIOD |
| | | 30 Sep 2026 | 30 Sep 2025 | 30 Sep 2026 | 30 Sep 2025 |
| | | MYR'000 | MYR'000 | MYR'000 | MYR'000 |
| 1 | Revenue | 485,101 | 228,567 | 1,127,067 | 552,728 |
| 4 | Profit/(loss) attributable to ordinary equity holders of the parent | 118,580 | 34,716 | 254,821 | 87,009 |
| 5 | Basic earnings/(loss) per share (Subunit) | 6.26 | 1.83 | 13.45 | 4.60 |
| 2 | Profit/(loss) before tax | 136,774 | 50,464 | 298,379 | 115,784 |
| 3 | Profit/(loss) for the period | 118,073 | 34,311 | 253,351 | 86,024 |
| | | AS AT END OF CURRENT QUARTER | | AS AT PRECEDING FINANCIAL YEAR END | |
| 7 | Net assets per share attributable to ordinary equity holders of the parent | 0.7230 | | 0.5981 | |

| Date Announced | 05 Nov 2026 |
| --- | --- |
`;

const BALANCE_TEXT = `ViTrox condensed statement of financial position

| | As at 30 Sep 2026 | As at 31 Dec 2025 |
| --- | --- | --- |
| | RM'000 | RM'000 |
| Cash and cash equivalents | 412,380 | 301,114 |
| Total current assets | 1,201,553 | 1,004,220 |
| Total current liabilities | 312,004 | 250,118 |
| Total equity attributable to owners of the parent | 900,000 | 800,000 |
| Total equity | 950,000 | 840,000 |

| | 9 months ended 30 Sep 2026 | 9 months ended 30 Sep 2025 |
| --- | --- | --- |
| | RM'000 | RM'000 |
| Net cash from operating activities | 301,200 | 120,400 |
| Purchase of property, plant and equipment | (40,100) | (35,900) |
| Basic earnings per share | 13.45 | 4.60 |
| Cash flows from operating activities | | |
| Profit before tax | 298,379 | 115,784 |
| Cost of revenue | 610,000 | 300,000 |
| Total comprehensive income attributable to owners of the parent | 251,000 | 85,000 |
| Profit for the period | | |
| attributable to: | | |
| - Owners of the Company | 254,821 | 87,009 |
| Share of profit of associates before tax | 1,200 | 900 |
| Gross profit for the period | 400,000 | 200,000 |
| Operating profit for the year | 300,000 | 120,000 |
`;

function source(overrides: Partial<Source>): Source {
  return {
    id: "web-0097.kl-klse",
    title: "VITROX - Quarterly rpt on consolidated results",
    url: "https://www.klsescreener.com/v2/announcements/view/11698017",
    fetchedAt: "2026-11-06T01:00:00.000Z",
    kind: "web",
    snippet: KLSE_TEXT,
    ...overrides,
  };
}

const KLSE = source({});
const BALANCE = source({
  id: "web-0097.kl-ms",
  title: "ViTrox quarterly statements",
  url: "https://www.marketscreener.com/quote/stock/VITROX/finances",
  fetchedAt: "2026-11-05T12:00:00.000Z",
  snippet: BALANCE_TEXT,
});

function mapping(...figures: readonly (readonly [string, string])[]): string {
  return JSON.stringify({ figures: figures.map(([concept, cell]) => ({ concept, cell })) });
}

function read(content: string, sources: readonly Source[] = [KLSE, BALANCE]) {
  return readIssuerReportMapping(content, issuerReportPacket("0097.KL", sources, []));
}

describe("issuer report hosts", () => {
  test("classifies exchange pages as primary and allowlisted copies as mirrors", () => {
    const profile = exchangeProfileFor("0097.KL");
    if (profile === undefined) {
      throw new Error("expected a Bursa profile");
    }

    expect(issuerReportHostKind(profile, "https://www.bursamalaysia.com/market/x")).toBe("primary");
    expect(issuerReportHostKind(profile, KLSE.url)).toBe("mirror");
    expect(issuerReportHostKind(profile, "https://klsescreener.com.evil.test/x")).toBeUndefined();
    expect(issuerReportHostKind(profile, "not a url")).toBeUndefined();
  });

  test("asks the web gather for report pages only on profiled equity listings", () => {
    const equity = { jobType: "equity", assetClass: "equity", depth: "brief" } as const;

    expect(issuerReportGatherContext({ ...equity, symbol: "0097.KL" })).toMatchObject({
      exchange: "Bursa Malaysia",
      primaryHosts: ["bursamalaysia.com"],
      mirrorHosts: ["klsescreener.com", "marketscreener.com"],
    });
    expect(issuerReportGatherContext({ ...equity, symbol: "AAPL" })).toBeUndefined();
  });
});

describe("issuer report packet", () => {
  test("reads dates and markdown tables", () => {
    expect(datesIn("30 Sep 2026 | 31/12/2025 | 5 Nov 26")).toEqual([
      "2026-09-30",
      "2025-12-31",
      "2026-11-05",
    ]);
    expect(datesIn("05/11/2026 | 05/05/2026 | 13/05/2026")).toEqual(["2026-05-05", "2026-05-13"]);
    expect(markdownTables("| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext")).toEqual([
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ]);
  });

  test("keeps only report-host web sources of a profiled listing and numbers tables across documents", () => {
    const press = source({ id: "web-press", url: "https://www.thestar.com.my/business/vitrox" });
    const packet = issuerReportPacket("0097.KL", [press, BALANCE, KLSE], []);

    expect(packet.documents.map((document) => [document.sourceId, document.hostKind])).toEqual([
      ["web-0097.kl-klse", "mirror"],
      ["web-0097.kl-ms", "mirror"],
    ]);
    expect(packet.documents[0]).toMatchObject({
      host: "www.klsescreener.com",
      announcedAt: "2026-11-05",
      announcedAtBasis: "announcement",
      fiscalYearEndMonth: 12,
      declaredCurrency: "MYR",
    });
    expect(packet.documents[1]).toMatchObject({
      announcedAt: "2026-11-05",
      announcedAtBasis: "source-date",
    });
    expect(
      packet.documents.flatMap((document) => document.tables.map((table) => table.id)),
    ).toEqual(["t1", "t2", "t3"]);
    expect(issuerReportPacket("AAPL", [KLSE], []).documents).toEqual([]);
  });

  test("prefers the longest stored raw text over the snippet", () => {
    const highlight = source({ snippet: "Revenue grew." });
    const raw = {
      id: "raw-exa-search",
      adapter: "exa-search",
      fetchedAt: highlight.fetchedAt,
      payload: { results: [{ url: highlight.url, text: KLSE_TEXT }] },
    };

    expect(issuerReportPacket("0097.KL", [highlight], [raw]).documents[0]?.tables).toHaveLength(1);
    expect(issuerReportPacket("0097.KL", [highlight], []).documents).toEqual([]);
  });

  test("gives the model cell refs and text, never parsed values", () => {
    const input = issuerReportMappingInput(issuerReportPacket("0097.KL", [KLSE], []));
    const rows = (input.documents as { tables: { rows: unknown[][] }[] }[])[0]?.tables[0]?.rows;

    expect(rows?.[4]).toEqual([
      { ref: "t1:r4:c0", text: "1" },
      { ref: "t1:r4:c1", text: "Revenue" },
      { ref: "t1:r4:c2", text: "485,101" },
      { ref: "t1:r4:c3", text: "228,567" },
      { ref: "t1:r4:c4", text: "1,127,067" },
      { ref: "t1:r4:c5", text: "552,728" },
    ]);
  });
});

describe("issuer report mapping check", () => {
  test("reads value, scale, currency, period and basis from the table headers", () => {
    const reading = read(
      mapping(
        ["revenue", "t1:r4:c2"],
        ["revenue", "t1:r4:c4"],
        ["basic-eps", "t1:r6:c2"],
        ["current-assets", "t2:r3:c1"],
        ["operating-cash-flow", "t3:r2:c1"],
      ),
    );
    const figures = reading?.figures.map(
      ({ concept, value, currency, periodEnd, basis, periodMonths, unitText }) => ({
        concept,
        value,
        currency,
        periodEnd,
        basis,
        periodMonths,
        unitText,
      }),
    );

    expect(reading?.failures).toEqual([]);
    expect(figures).toEqual([
      {
        concept: "revenue",
        value: 485_101_000,
        currency: "MYR",
        periodEnd: "2026-09-30",
        basis: "quarter",
        periodMonths: 3,
        unitText: "MYR'000",
      },
      {
        concept: "revenue",
        value: 1_127_067_000,
        currency: "MYR",
        periodEnd: "2026-09-30",
        basis: "ytd",
        periodMonths: 9,
        unitText: "MYR'000",
      },
      {
        concept: "basic-eps",
        value: 0.0626,
        currency: "MYR",
        periodEnd: "2026-09-30",
        basis: "quarter",
        periodMonths: 3,
        unitText: "Basic earnings/(loss) per share (Subunit)",
      },
      {
        concept: "current-assets",
        value: 1_201_553_000,
        currency: "MYR",
        periodEnd: "2026-09-30",
        basis: "instant",
        periodMonths: undefined,
        unitText: "RM'000",
      },
      {
        concept: "operating-cash-flow",
        value: 301_200_000,
        currency: "MYR",
        periodEnd: "2026-09-30",
        basis: "ytd",
        periodMonths: 9,
        unitText: "RM'000",
      },
    ]);
  });

  test("accepts a cell only under the concept its row label names", () => {
    const reading = read(
      mapping(
        ["profit-before-tax", "t1:r7:c2"],
        ["profit-for-period", "t1:r8:c2"],
        ["profit-attributable-to-owners", "t1:r5:c2"],
        ["capital-expenditure", "t3:r3:c1"],
      ),
    );

    expect(reading?.failures).toEqual([]);
    expect(reading?.figures.map(({ concept, value }) => [concept, value])).toEqual([
      ["profit-before-tax", 136_774_000],
      ["profit-for-period", 118_073_000],
      ["profit-attributable-to-owners", 118_580_000],
      ["capital-expenditure", -40_100_000],
    ]);
  });

  test("checks a row by its own label and reads captions only for sub-items", () => {
    const reasons = (concept: string, cell: string) =>
      read(mapping([concept, cell]))?.failures.map((failure) => failure.reason);

    expect(reasons("operating-cash-flow", "t3:r6:c1")).toEqual(["label-mismatch"]);
    expect(reasons("revenue", "t3:r7:c1")).toEqual(["label-mismatch"]);
    expect(reasons("profit-attributable-to-owners", "t3:r8:c1")).toEqual(["label-mismatch"]);
    expect(reasons("profit-before-tax", "t3:r12:c1")).toEqual(["label-mismatch"]);
    expect(reasons("profit-for-period", "t3:r13:c1")).toEqual(["label-mismatch"]);
    expect(reasons("profit-for-period", "t3:r14:c1")).toEqual(["label-mismatch"]);
    expect(reasons("total-equity", "t2:r5:c1")).toEqual(["label-mismatch"]);
    expect(read(mapping(["total-equity", "t2:r6:c1"]))?.figures[0]?.value).toBe(950_000_000);
    expect(read(mapping(["profit-attributable-to-owners", "t3:r11:c1"]))?.figures).toMatchObject([
      { value: 254_821_000, periodMonths: 9, unitText: "RM'000" },
    ]);
  });

  test("reads a scale from a separate header cell and withholds conflicting scales", () => {
    const split = (units: string) =>
      source({
        snippet: KLSE_TEXT.replace(
          "| | | MYR'000 | MYR'000 | MYR'000 | MYR'000 |",
          `| | | RM | RM | RM | RM |\n| | | ${units} | ${units} | ${units} | ${units} |`,
        ),
      });
    const first = (units: string) => read(mapping(["revenue", "t1:r5:c2"]), [split(units)]);

    expect(first("'000")?.figures[0]).toMatchObject({ value: 485_101_000, unitText: "RM '000" });
    expect(first("000")?.figures[0]).toMatchObject({ value: 485_101_000, unitText: "RM 000" });
    expect(first("million")?.figures[0]?.value).toBe(485_101_000_000);
    expect(
      read(mapping(["revenue", "t1:r5:c2"]), [
        source({
          snippet: KLSE_TEXT.replace(
            "| | | MYR'000 | MYR'000 |",
            "| | | MYR'000 | MYR'000 |\n| | | million | million |",
          ),
        }),
      ])?.failures.map((failure) => failure.reason),
    ).toEqual(["unit-ambiguous"]);
  });

  test("withholds every figure the table does not prove", () => {
    const usd = source({
      id: "web-usd",
      url: "https://www.klsescreener.com/v2/announcements/view/1",
      snippet: KLSE_TEXT.replace("Malaysian Ringgit (MYR)", "US Dollar (USD)"),
    });
    const early = source({
      id: "web-early",
      url: "https://www.klsescreener.com/v2/announcements/view/2",
      snippet: KLSE_TEXT.replace(
        "| Date Announced | 05 Nov 2026 |",
        "| Date Announced | 05 Aug 2026 |",
      ),
    });
    const reasons = (sources: readonly Source[], ...figures: (readonly [string, string])[]) =>
      read(mapping(...figures), sources)?.failures.map((failure) => failure.reason);

    const each = (...figures: (readonly [string, string])[]) =>
      figures.flatMap((figure) => reasons([KLSE, BALANCE], figure) ?? []);

    expect(
      each(
        ["fair-value", "t1:r4:c2"],
        ["revenue", "t9:r4:c2"],
        ["revenue", "t1:r4:c1"],
        ["revenue", "t1:r10:c2"],
        ["total-equity", "t1:r4:c2"],
        ["revenue", "t2:r2:c1"],
        ["revenue", "t1:r7:c2"],
        ["revenue", "t1:r6:c2"],
        ["basic-eps", "t1:r4:c2"],
        ["profit-attributable-to-owners", "t1:r8:c2"],
        ["profit-for-period", "t1:r5:c2"],
        ["profit-for-period", "t1:r7:c2"],
        ["current-assets", "t2:r2:c1"],
        ["capital-expenditure", "t3:r2:c1"],
        ["basic-eps", "t3:r4:c1"],
      ),
    ).toEqual([
      "unknown-concept",
      "cell-not-found",
      "cell-not-numeric",
      "period-not-declared",
      "basis-mismatch",
      "basis-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "label-mismatch",
      "unit-mismatch",
    ]);
    expect(reasons([KLSE], ["revenue", "t1:r4:c2"], ["profit-before-tax", "t1:r4:c2"])).toEqual([
      "cell-reused",
      "cell-reused",
    ]);
    expect(reasons([usd], ["revenue", "t1:r4:c2"])).toEqual(["currency-mismatch"]);
    expect(reasons([early], ["revenue", "t1:r4:c2"])).toEqual(["period-after-announcement"]);
  });

  test("drops both copies of a figure two documents disagree on", () => {
    const restated = source({
      id: "web-restated",
      url: "https://www.marketscreener.com/quote/stock/VITROX/results",
      snippet: KLSE_TEXT.replace("485,101", "485,999"),
    });
    const reading = read(mapping(["revenue", "t1:r4:c2"], ["revenue", "t2:r4:c2"]), [
      KLSE,
      restated,
    ]);

    expect(reading?.figures).toEqual([]);
    expect(reading?.failures).toEqual([
      { cell: "t2:r4:c2", concept: "revenue", reason: "conflicting-figures" },
    ]);
  });

  test("rejects a mapping that is not JSON with a figures array", () => {
    expect(read("not json")).toBeUndefined();
    expect(read('{"figure":[]}')).toBeUndefined();
  });
});

function output(content: string) {
  return { stage: "issuer-report-mapping" as const, content, tokenEstimate: 100 };
}

describe("issuer report phase", () => {
  const symbol = "0097.KL";

  describe("Yahoo trailing EPS against the issuer's year-to-date EPS", () => {
    const crossCheck = async (
      epsTrailingTwelveMonths: number,
      options: {
        readonly quoteCurrency?: string;
        readonly epsRow?: string;
        readonly cells?: readonly string[];
        readonly text?: string;
      } = {},
    ) => {
      const reportText = options.text ?? KLSE_TEXT;
      const text =
        options.epsRow === undefined
          ? reportText
          : reportText.replace("| 6.26 | 1.83 | 13.45 | 4.60 |", options.epsRow);
      const result = await runIssuerReportPhase({
        symbol,
        collectedSources: collectedSources({
          extendedSources: [source({ snippet: text })],
          marketSnapshots: [
            marketSnapshot({
              symbol,
              fundamentals: { epsTrailingTwelveMonths },
              identity: { quoteCurrency: options.quoteCurrency ?? "MYR" } as NonNullable<
                MarketSnapshot["identity"]
              >,
            }),
          ],
        }),
        generateMapping: async () =>
          output(
            mapping(
              ...(options.cells ?? ["t1:r6:c4", "t1:r6:c5"]).map(
                (cell) => ["basic-eps", cell] as const,
              ),
            ),
          ),
      });
      return result.collectedSources.sourceGaps.find(({ message }) =>
        message.startsWith("Yahoo trailing EPS"),
      )?.message;
    };

    test("discloses an unreconciled comparison against the newest period", async () => {
      const message = await crossCheck(0.11);
      expect(message).toBe(
        "Yahoo trailing EPS 0.11 MYR (no as-of date; period, share count and basic or diluted basis undisclosed) is below the issuer-reported 9-month year-to-date basic EPS of 0.1345 MYR to 2026-09-30, which a trailing twelve months to that date contains; this run reads no prior-fiscal-year EPS or weighted share counts, so the two cannot be shown to reconcile (a stale value, another share basis or a loss quarter outside the issuer period would each fit); it is withheld with the trailing PE and payout ratio derived from it",
      );
    });

    const fullYearText = KLSE_TEXT.replace("| Quarter | 3 Qtr |", "| Quarter | 4 Qtr |")
      .replace("| | | INDIVIDUAL PERIOD | | CUMULATIVE PERIOD | |\n", "")
      .replace(
        "| CURRENT YEAR QUARTER | PRECEDING YEAR CORRESPONDING QUARTER | CURRENT YEAR TO DATE | PRECEDING YEAR CORRESPONDING PERIOD |",
        "| 3 MONTHS ENDED | 3 MONTHS ENDED | FINANCIAL YEAR ENDED | FINANCIAL YEAR ENDED |",
      )
      .replaceAll("30 Sep", "31 Dec")
      .replace("30/09/2026", "31/12/2026")
      .replace("05 Nov 2026", "25 Feb 2027");

    test("checks the financial year ending at the newest period end", async () => {
      const fullYearMessage =
        "Yahoo trailing EPS 0.4 MYR (no as-of date; period, share count and basic or diluted basis undisclosed) is below the issuer-reported financial-year basic EPS of 0.8 MYR to 2026-12-31, which a trailing twelve months to that date equals; this run reads no weighted share counts, so the two cannot be shown to reconcile (a stale value or another share basis would each fit); it is withheld with the trailing PE and payout ratio derived from it";
      const annualOnly = {
        text: fullYearText,
        epsRow: "| 15.00 | 1.83 | 80.00 | 4.60 |",
        cells: ["t1:r5:c4", "t1:r5:c5"],
      };
      expect(
        await crossCheck(0.4, {
          ...annualOnly,
          cells: ["t1:r5:c2", "t1:r5:c3", "t1:r5:c4", "t1:r5:c5"],
        }),
      ).toBe(fullYearMessage);
      expect(await crossCheck(0.4, annualOnly)).toBe(fullYearMessage);
      expect(await crossCheck(0.8, annualOnly)).toBeUndefined();
    });

    test("checks a quarter-only mapping against the quarter, which any trailing twelve months contains", async () => {
      expect(await crossCheck(0.05, { cells: ["t1:r6:c2", "t1:r6:c3"] })).toContain(
        "is below the issuer-reported quarterly basic EPS of 0.0626 MYR to 2026-09-30",
      );
      expect(await crossCheck(0.11, { cells: ["t1:r6:c2", "t1:r6:c3"] })).toBeUndefined();
    });

    test("stays silent at or above the newest period, on a currency mismatch, or on a loss", async () => {
      expect(await crossCheck(0.16)).toBeUndefined();
      expect(await crossCheck(0.11, { quoteCurrency: "USD" })).toBeUndefined();
      expect(
        await crossCheck(-0.2, { epsRow: "| 6.26 | 1.83 | (13.45) | 4.60 |" }),
      ).toBeUndefined();
    });

    test("an older comparative above the Yahoo value does not trigger it", async () => {
      expect(await crossCheck(0.11, { epsRow: "| 1.83 | 6.26 | 4.60 | 13.45 |" })).toBeUndefined();
      expect(await crossCheck(0.01, { epsRow: "| 1.83 | 6.26 | 4.60 | 13.45 |" })).toContain(
        "basic EPS of 0.046 MYR to 2026-09-30",
      );
    });

    const pricedRun = async (
      epsTrailingTwelveMonths: number,
      fundamentals: MarketSnapshot["fundamentals"] = {
        forwardPE: 48.3,
        trailingAnnualDividendRate: 0.012,
      },
    ) => {
      const command = { jobType: "equity", assetClass: "equity", symbol, depth: "brief" } as const;
      const generatedAt = "2026-11-06T05:46:13.672Z";
      const snapshots = [
        marketSnapshot({
          symbol,
          sourceId: "market-yahoo-equity-0097.kl",
          fundamentals: { ...fundamentals, trailingPE: 92.36, epsTrailingTwelveMonths },
          identity: { quoteCurrency: "MYR" } as NonNullable<MarketSnapshot["identity"]>,
        }),
      ];
      const yahoo = buildYahooFundamentals(command, snapshots, generatedAt);
      const lens = addFinancialLensEvidence(
        command,
        snapshots,
        { items: yahoo === undefined ? [] : [yahoo], gaps: [] },
        undefined,
        generatedAt,
      );
      const framework = addBusinessFrameworkEvidence(
        command,
        snapshots,
        lens.extendedEvidence,
        undefined,
        generatedAt,
        undefined,
        lens.metricSections,
      );
      const input = collectedSources({
        extendedSources: [source({ snippet: KLSE_TEXT })],
        marketSnapshots: snapshots,
        supplementalMarketSnapshots: snapshots,
        ...(framework.extendedEvidence === undefined
          ? {}
          : { extendedEvidence: framework.extendedEvidence }),
        ...(lens.artifact === undefined ? {} : { financialLenses: lens.artifact }),
        ...(framework.artifact === undefined ? {} : { businessFramework: framework.artifact }),
        metricSections: framework.metricSections ?? [],
      });
      const result = await runIssuerReportPhase({
        symbol,
        collectedSources: input,
        generateMapping: async () => output(mapping(["basic-eps", "t1:r6:c4"])),
      });
      return { input, output: result.collectedSources };
    };

    test("withholds the Yahoo value and every metric priced off it", async () => {
      const { output: sources } = await pricedRun(0.11);
      expect(sources.marketSnapshots[0]?.fundamentals).toEqual({
        forwardPE: 48.3,
        trailingAnnualDividendRate: 0.012,
      });
      expect(sources.supplementalMarketSnapshots[0]?.fundamentals).toEqual(
        sources.marketSnapshots[0]?.fundamentals,
      );
      expect(
        sources.businessFramework?.sections.find(({ name }) => name === "Valuation")?.summary,
      ).toBe("Valuation insufficient-data (Forward PE 48.30x)");
      const item = (category: string) =>
        sources.extendedEvidence?.items.find((row) => row.category === category);
      expect(item("yahoo-fundamentals")?.summary).toBe(
        "Yahoo Fundamentals: forward PE 48.30x, annual dividend rate 0.012 MYR. Trailing EPS and trailing PE withheld; see the issuer-report Source Gap.",
      );
      expect(item("financial-lens")?.metrics).not.toHaveProperty("peRatio");
      expect(item("financial-lens")?.metrics).not.toHaveProperty("payoutRatio");
      expect(
        sources.financialLenses?.lenses.flatMap(({ metrics }) => metrics.map(({ key }) => key)),
      ).toEqual(["forwardPe"]);
      const trailingPe = sources.metricSections
        ?.find(({ id }) => id === "business-framework-valuation")
        ?.metrics.find(({ id }) => id === "trailingPE");
      expect(trailingPe).toMatchObject({ status: "not-meaningful", inputs: [] });
      expect(trailingPe).not.toHaveProperty("value");
      expect(trailingPe?.reason).toContain("below an issuer-reported basic EPS");
      const serialized = JSON.stringify(sources);
      expect(serialized).not.toContain("92.36");
      expect(serialized).not.toContain("0.109");
      expect(
        sources.sourceGaps.find(({ message }) => message.startsWith("Yahoo trailing EPS"))?.message,
      ).toContain("it is withheld with the trailing PE and payout ratio derived from it");
    });

    test("omits fundamentals left empty and keeps the Yahoo row with a withheld summary", async () => {
      const { output: sources } = await pricedRun(0.11, {});
      expect(sources.marketSnapshots[0]).not.toHaveProperty("fundamentals");
      expect(sources.supplementalMarketSnapshots[0]).not.toHaveProperty("fundamentals");
      expect(
        sources.extendedEvidence?.items.find((row) => row.category === "yahoo-fundamentals")
          ?.summary,
      ).toBe(
        "Yahoo Fundamentals. Trailing EPS and trailing PE withheld; see the issuer-report Source Gap.",
      );
    });

    test("keeps the Yahoo value when it is not below the issuer's year-to-date EPS", async () => {
      const { input, output: sources } = await pricedRun(0.16);
      expect(sources.marketSnapshots).toBe(input.marketSnapshots);
      expect(sources.extendedEvidence).toBe(input.extendedEvidence);
      expect(sources.financialLenses).toBe(input.financialLenses);
      expect(JSON.stringify(sources)).toContain("92.36");
    });
  });

  test("publishes checked figures and derived metrics with mirror labels", async () => {
    const result = await runIssuerReportPhase({
      symbol,
      collectedSources: collectedSources({ extendedSources: [KLSE, BALANCE] }),
      generateMapping: async () =>
        output(
          mapping(
            ["revenue", "t1:r4:c2"],
            ["revenue", "t1:r4:c3"],
            ["profit-attributable-to-owners", "t1:r5:c2"],
            ["profit-attributable-to-owners", "t1:r5:c3"],
            ["current-assets", "t2:r3:c1"],
            ["current-liabilities", "t2:r4:c1"],
            ["operating-cash-flow", "t3:r2:c1"],
            ["capital-expenditure", "t3:r3:c1"],
            ["basic-eps", "t1:r10:c2"],
          ),
        ),
    });
    const section = result.collectedSources.metricSections?.find(
      (row) => row.id === "issuer-report",
    );
    const metric = (id: string) => section?.metrics.find((row) => row.id === id);

    expect(result.stageOutputs).toHaveLength(1);
    expect(metric("issuer-report-revenue-quarter-2026-09-30")).toMatchObject({
      label: "Revenue, quarter",
      unit: "currency",
      value: 485_101_000,
      currency: "MYR",
      periodEnd: "2026-09-30",
      periodMonths: 3,
      basis: `Declared unit "MYR'000"; mirror copy of the issuer document "VITROX - Quarterly rpt on consolidated results" at www.klsescreener.com, not the exchange's own page; announced 2026-11-05`,
      inputs: [
        {
          label: "Revenue",
          value: "485,101",
          artifact: "issuerReport",
          periodType: "interim",
          unit: "MYR'000",
          sourceIds: ["web-0097.kl-klse"],
        },
      ],
      sourceIds: ["web-0097.kl-klse"],
    });
    expect(metric("issuer-report-revenue-yoy-quarter")?.value).toBeCloseTo(
      485_101 / 228_567 - 1,
      6,
    );
    expect(metric("issuer-report-net-margin-quarter")?.value).toBeCloseTo(118_580 / 485_101, 6);
    expect(metric("issuer-report-free-cash-flow-ytd")).toMatchObject({
      unit: "currency",
      value: 261_100_000,
      currency: "MYR",
    });
    expect(metric("issuer-report-current-ratio")?.value).toBeCloseTo(1_201_553 / 312_004, 6);
    expect(metric("issuer-report-current-assets-instant-2026-09-30")?.basis).toContain(
      "public by 2026-11-05 (provider published date, else fetch date)",
    );
    expect(metricSectionsView({ extras: { metricSections: [section] } })?.[0]?.sourceLabel).toBe(
      "issuer report tables, code-checked",
    );
    expect(result.collectedSources.sourceGaps).toEqual([
      expect.objectContaining({
        source: "issuer-report",
        cause: "validation-failed",
        message: expect.stringContaining("basic-eps at t1:r10:c2 (period-not-declared)"),
      }),
      expect.objectContaining({
        source: "issuer-report",
        cause: "provider-data-missing",
        message: expect.stringContaining(
          "published no checked figure for: Profit before tax, Profit for the period, Basic EPS",
        ),
      }),
    ]);
  });

  test("declares a gap when no report text reached the run", async () => {
    let called = false;
    const result = await runIssuerReportPhase({
      symbol,
      collectedSources: collectedSources(),
      generateMapping: async () => {
        called = true;
        return output("{}");
      },
    });

    expect(called).toBe(false);
    expect(result.stageOutputs).toEqual([]);
    expect(result.collectedSources.metricSections).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([
      expect.objectContaining({
        source: "issuer-report",
        provider: "web-gather",
        cause: "provider-data-missing",
        message: expect.stringContaining("klsescreener.com, marketscreener.com"),
      }),
    ]);
  });

  test("declares a gap for an unreadable mapping or one with no checked figure", async () => {
    const run = (content: string) =>
      runIssuerReportPhase({
        symbol,
        collectedSources: collectedSources({ extendedSources: [KLSE] }),
        generateMapping: async () => output(content),
      });
    const invalid = await run("[]");
    const empty = await run(mapping());

    expect(invalid.stageOutputs).toHaveLength(1);
    expect(invalid.collectedSources.sourceGaps[0]?.message).toContain("not valid JSON");
    expect(empty.collectedSources.metricSections).toBeUndefined();
    expect(empty.collectedSources.sourceGaps[0]?.message).toContain("passed the table check");
  });

  test("notes restated comparatives and names the subunit of the table currency", async () => {
    const usd = source({
      snippet: KLSE_TEXT.replaceAll("MYR'000", "USD'000")
        .replace("Malaysian Ringgit (MYR)", "US Dollar (USD)")
        .replace("(Subunit) | 6.26", "(cents) | 6.26")
        .replace(
          "PRECEDING YEAR CORRESPONDING QUARTER |",
          "PRECEDING YEAR CORRESPONDING QUARTER (RESTATED) |",
        ),
    });
    const result = await runIssuerReportPhase({
      symbol,
      collectedSources: collectedSources({ extendedSources: [usd] }),
      generateMapping: async () =>
        output(
          mapping(["revenue", "t1:r4:c2"], ["revenue", "t1:r4:c3"], ["basic-eps", "t1:r6:c2"]),
        ),
    });
    const metrics = result.collectedSources.metricSections?.[0]?.metrics ?? [];
    const metric = (id: string) => metrics.find((row) => row.id === id);
    const restated = "column headed as a restated or re-presented comparative";

    expect(metric("issuer-report-revenue-quarter-2025-09-30")?.basis).toContain(restated);
    expect(metric("issuer-report-revenue-quarter-2026-09-30")?.basis).not.toContain(restated);
    expect(metric("issuer-report-revenue-yoy-quarter")?.basis).toContain(restated);
    expect(metric("issuer-report-basic-eps-quarter-2026-09-30")?.value).toBe(
      "USD 0.0626 (6.26 cents)",
    );
  });

  test("a substituted issuer metric reference passes the Verified Web Figure audit", async () => {
    const { collectedSources: collected } = await runIssuerReportPhase({
      symbol,
      collectedSources: collectedSources({ extendedSources: [KLSE] }),
      generateMapping: async () =>
        output(mapping(["revenue", "t1:r4:c2"], ["revenue", "t1:r4:c3"])),
    });
    const sections = collected.metricSections ?? [];
    const report = resolveMetricReferences(
      researchReport({
        sources: [KLSE],
        keyFindings: [
          {
            text: "Quarter revenue was <<metric:issuer-report.issuer-report-revenue-quarter-2026-09-30>>, a change of <<metric:issuer-report.issuer-report-revenue-yoy-quarter>>.",
            sourceIds: [KLSE.id],
          },
          { text: "Quarter revenue was MYR 486M.", sourceIds: [KLSE.id] },
        ],
      }),
      sections,
    );
    const audit = (withSections: boolean) =>
      auditReportIntegrity(
        report,
        undefined,
        undefined,
        undefined,
        webSourceTexts([KLSE], [], withSections ? sections : []),
      ).report.keyFindings.map(({ text }) => text);

    expect(audit(true)).toEqual(["Quarter revenue was MYR 485.1M, a change of 112.2%."]);
    expect(audit(false)).toEqual([]);
  });

  test("leaves SEC listings untouched", async () => {
    const input = collectedSources({ extendedSources: [KLSE] });
    const result = await runIssuerReportPhase({
      symbol: "AAPL",
      collectedSources: input,
      generateMapping: async () => {
        throw new Error("unexpected mapping call");
      },
    });

    expect(result).toEqual({ collectedSources: input, stageOutputs: [] });
  });
});
