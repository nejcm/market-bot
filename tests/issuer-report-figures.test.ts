import { describe, expect, test } from "bun:test";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import { exchangeProfileFor, issuerReportHostKind } from "../src/domain/exchange-profile";
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
import { collectedSources } from "./support/fixtures";

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
    expect(read(mapping(["profit-attributable-to-owners", "t3:r11:c1"]))?.figures).toMatchObject([
      { value: 254_821_000, periodMonths: 9, unitText: "RM'000" },
    ]);
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
