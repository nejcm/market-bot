import { describe, expect, test } from "bun:test";
import type { Source } from "../src/domain/sources";
import { auditReportIntegrity } from "../src/research/report-integrity-audit";
import {
  figuresIn,
  unverifiedWebFigure,
  webFigureGapText,
  webSourceTexts,
} from "../src/research/web-figure-verification";
import { researchReport } from "./support/fixtures";

// ViTrox (0097.KL) Q3 2026 coverage, run 2026-11-05T11-14-53-208Z-f5a4cc80.
const VITROX_TEXT =
  "ViTrox Corp Bhd's net profit for the third quarter rose to RM118.58mil from RM95.2mil a year earlier, " +
  "while revenue grew 22.8% to RM485.1 million.";

function webSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "web-vitrox",
    title: "ViTrox Q3 results",
    url: "https://www.thestar.com.my/business/vitrox-q3",
    fetchedAt: "2026-11-05T11:00:00.000Z",
    kind: "web",
    snippet: VITROX_TEXT,
    summary: "ViTrox profit rose to about RM119 million on 23% higher revenue.",
    ...overrides,
  };
}

const SEC_SOURCE: Source = {
  id: "sec-10q",
  title: "10-Q",
  fetchedAt: "2026-11-05T11:00:00.000Z",
  kind: "extended-evidence",
};

const texts = webSourceTexts([webSource(), SEC_SOURCE]);

function check(text: string, quote?: string, sourceIds: readonly string[] = ["web-vitrox"]) {
  return unverifiedWebFigure(
    {
      text,
      sourceIds,
      ...(quote === undefined ? {} : { figureQuotes: [{ sourceId: "web-vitrox", quote }] }),
    },
    texts,
  );
}

function parsed(text: string) {
  return figuresIn(text).map(({ value, scale, currency, unit }) => [value, scale, currency, unit]);
}

describe("figure parsing", () => {
  test("reads value, scale, currency and unit", () => {
    expect(
      figuresIn("RM1.13bil, US$47.02 million, 22.8%, 1.18 sen, 3x, $5bn, 2.5 billion euros").map(
        ({ value, scale, currency, unit }) => [value, scale, currency, unit],
      ),
    ).toEqual([
      [1.13, 1e9, "MYR", ""],
      [47.02, 1e6, "USD", ""],
      [22.8, 1, "", "%"],
      [1.18, 1, "MYR-sen", ""],
      [3, 1, "", "x"],
      [5, 1e9, "USD", ""],
      [2.5, 1e9, "EUR", ""],
    ]);
  });

  test("ignores bare integers, the RM'000 unit header, and parses NFKC forms", () => {
    expect(figuresIn("iPhone 17, top 10, No. 1 supplier, 20 customers, RTX 5090")).toEqual([]);
    expect(figuresIn("Revenue was 2,649,666 (RM'000).").map(({ raw }) => raw)).toEqual([
      "2,649,666",
    ]);
    expect(
      figuresIn("＄５ million and 22.8％").map(({ value, scale, currency, unit }) => [
        value,
        scale,
        currency,
        unit,
      ]),
    ).toEqual([
      [5, 1e6, "USD", ""],
      [22.8, 1, "", "%"],
    ]);
  });

  test("reads a range's endpoints, sharing its scale, unit and currency", () => {
    expect(parsed("$1.2-1.4 billion")).toEqual([
      [1.2, 1e9, "USD", ""],
      [1.4, 1e9, "USD", ""],
    ]);
    expect(parsed("RM5m–RM6m and RM5–6m")).toEqual([
      [5, 1e6, "MYR", ""],
      [6, 1e6, "MYR", ""],
      [5, 1e6, "MYR", ""],
      [6, 1e6, "MYR", ""],
    ]);
    expect(parsed("5—6%")).toEqual([
      [5, 1, "", "%"],
      [6, 1, "", "%"],
    ]);
    expect(parsed("7%–10% and $505–$525 million")).toEqual([
      [7, 1, "", "%"],
      [10, 1, "", "%"],
      [505, 1e6, "USD", ""],
      [525, 1e6, "USD", ""],
    ]);
    expect(parsed("COVID-19 and FY2024-25, 5-6 years, [sec-8k-0001193125-26-337999]")).toEqual([]);
    expect(parsed("$739.69-0.30%")).toEqual([
      [Number.NaN, 1, "USD", "%"],
      [Number.NaN, 1, "USD", "%"],
    ]);
    expect(parsed("RM5m-RM6.5.1")).toEqual([[Number.NaN, 1e6, "MYR", ""]]);
  });

  test("keeps a figure whole before a word-joined dash, and withholds one a dash may sign", () => {
    expect(parsed("$574.9 million—up, 22.8%—up, 120% dollar-based, 5%-to 9%")).toEqual([
      [574.9, 1e6, "USD", ""],
      [22.8, 1, "", "%"],
      [120, 1, "", "%"],
      [5, 1, "", "%"],
      [9, 1, "", "%"],
    ]);
    expect(parsed("a 5-percent stake, 5-6-million, 5-per-cent, 25-basis-point, 14-ppts")).toEqual(
      Array.from({ length: 6 }, () => [Number.NaN, 1, "", ""]),
    );
    expect(parsed("a 5-Year plan, 30-Jun, 10-Q, 20-F, 8-K, 6-K, 11-K, 12-months, 3-day")).toEqual(
      [],
    );
    expect(parsed("5-M, 5-K, 5-B")).toEqual(
      Array.from({ length: 3 }, () => [Number.NaN, 1, "", ""]),
    );
    expect(parsed("Day's range 298.02 - 307.48 - 52-week range")).toEqual([
      [298.02, 1, "", ""],
      [Number.NaN, 1, "", ""],
    ]);
    expect(parsed("Revenue—7%, $5-million, results-5m-6-7, 10-K, 3-for-1")).toEqual([
      [Number.NaN, 1, "", "%"],
      [Number.NaN, 1, "USD", ""],
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1, "", ""],
      [Number.NaN, 1, "", ""],
      [Number.NaN, 1, "", ""],
    ]);
  });

  test("withholds a bare whole number with a letter scale, which may be a period or a time", () => {
    expect(parsed("9M FY2026, 3m ago, 1M 6M, 12.3M, RM9m, 9M USD, 9 million")).toEqual([
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1e6, "", ""],
      [12.3, 1e6, "", ""],
      [9, 1e6, "MYR", ""],
      [9, 1e6, "USD", ""],
      [9, 1e6, "", ""],
    ]);
    expect(parsed("16k GPUs, 9,000M, 4K racks")).toEqual([
      [16, 1e3, "", ""],
      [9000, 1e6, "", ""],
      [4, 1e3, "", ""],
    ]);
    expect(parsed("5-6M, RM5-6m")).toEqual([
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1e6, "", ""],
      [5, 1e6, "MYR", ""],
      [6, 1e6, "MYR", ""],
    ]);
  });

  test("reads a word range's low endpoint with the scale, unit and currency of its high", () => {
    expect(parsed("-9 to -3%, 1 to 2 billion, 76.5 to 81 cents, 800 to 1,000 sites")).toEqual([
      [-9, 1, "", "%"],
      [-3, 1, "", "%"],
      [1, 1e9, "", ""],
      [2, 1e9, "", ""],
      [76.5, 1, "cent", ""],
      [81, 1, "cent", ""],
      [800, 1, "", ""],
      [1000, 1, "", ""],
    ]);
    expect(parsed("between 5 and 7%, 5 and 7%")).toEqual([
      [5, 1, "", "%"],
      [7, 1, "", "%"],
      [7, 1, "", "%"],
    ]);
    expect(parsed("from 37% in fiscal 2024 to 51%, 15 to 90 days, 5 to 9M")).toEqual([
      [37, 1, "", "%"],
      [51, 1, "", "%"],
      [Number.NaN, 1e6, "", ""],
      [Number.NaN, 1e6, "", ""],
    ]);
  });

  test("ignores dates, periods, forms and bare years", () => {
    expect(
      figuresIn(
        "On Nov 5, 2026 at 10:30 am, Q3 2026, 3Q2026, 9M2026, the 10-K, a 50-day line, 2025.",
      ),
    ).toEqual([]);
  });
});

describe("Verified Web Figure", () => {
  test("passes a figure its verbatim quote holds", () => {
    expect(
      check(
        "Q3 net profit was RM118.58mil.",
        "net profit for the third quarter rose to RM118.58mil",
      ),
    ).toBeUndefined();
  });

  test("normalizes whitespace, typography and case before matching", () => {
    const source = webSource({
      snippet: "Revenue grew 22.8% to RM485.1\nmillion — the company’s best quarter.",
    });
    const result = unverifiedWebFigure(
      {
        text: "Revenue grew 22.8% to RM485.1 million.",
        sourceIds: [source.id],
        figureQuotes: [
          { sourceId: source.id, quote: "revenue  grew 22.8% to RM485.1 million - the company's" },
        ],
      },
      webSourceTexts([source]),
    );
    expect(result).toBeUndefined();
  });

  test("fails a figure the verified quote does not state (run f5a4cc80: RM118.8 vs RM118.58)", () => {
    expect(check("Q3 net profit was RM118.8 million.", "quarter rose to RM118.58mil")).toEqual({
      reason: "figure-not-in-quote",
      figure: "RM118.8 million",
      sourceIds: ["web-vitrox"],
    });
  });

  test("fails a figure quoted at another scale, never matching across scales", () => {
    expect(
      check("Revenue was RM485.1 billion.", "revenue grew 22.8% to RM485.1 million"),
    ).toMatchObject({
      reason: "scale-mismatch",
      figure: "RM485.1 billion",
    });
  });

  test("fails a figure quoted in another currency", () => {
    expect(
      check("Revenue was US$485.1 million.", "revenue grew 22.8% to RM485.1 million"),
    ).toMatchObject({
      reason: "currency-mismatch",
    });
  });

  test("fails a quote absent from the stored text", () => {
    expect(check("Revenue grew 23%.", "while revenue grew 23%")).toMatchObject({
      reason: "quote-not-in-source",
      figure: "23%",
    });
  });

  test("does not verify against the provider summary", () => {
    expect(
      check("Profit was about RM119 million.", "profit rose to about RM119 million"),
    ).toMatchObject({
      reason: "quote-not-in-source",
    });
  });

  test("fails a figure with no quote", () => {
    expect(check("Revenue grew 22.8%.")).toMatchObject({ reason: "figure-not-quoted" });
  });

  test("fails a quote from a source the claim does not cite", () => {
    expect(
      unverifiedWebFigure(
        {
          text: "Revenue grew 22.8%.",
          sourceIds: ["web-other"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: "revenue grew 22.8%" }],
        },
        webSourceTexts([webSource(), webSource({ id: "web-other", url: "https://example.com/b" })]),
      ),
    ).toMatchObject({ reason: "quote-source-not-cited", sourceIds: ["web-vitrox"] });
  });

  test("verifies only what a snippet-only source holds", () => {
    const snippetOnly = webSourceTexts([webSource({ snippet: "Quarterly revenue grew 22.8%." })]);
    const claim = (text: string, quote: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        snippetOnly,
      );
    expect(claim("Revenue grew 22.8%.", "Quarterly revenue grew 22.8%")).toBeUndefined();
    expect(claim("Profit was RM118.58mil.", "quarter rose to RM118.58mil")).toMatchObject({
      reason: "quote-not-in-source",
    });
  });

  // KLSE Screener copy of ViTrox's Q3 2026 report, run 2026-11-06T05-46-13-672Z-b7171fdf.
  test("reads Markdown table cell separators as whitespace", () => {
    const table = webSourceTexts([
      webSource({
        snippet:
          "| Quarter | 3 Qtr |\n| The figures | have not been audited |\n| 1 | Revenue | 485,101 |",
      }),
    ]);
    const claim = (text: string, quote: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        table,
      );
    expect(
      claim("The figures are unaudited.", "The figures have not been audited"),
    ).toBeUndefined();
    expect(claim("The figures are unaudited.", "The figures | were audited")).toMatchObject({
      reason: "quote-not-in-source",
    });
    expect(claim("Revenue was 485,101.", "Revenue | 485,101")).toMatchObject({
      reason: "quote-too-short",
    });
  });

  test("a quoted figure reads its scale and currency from its own table cell only", () => {
    const claim = (
      snippet: string,
      quote: string,
      text = "Reported revenue was MYR 125.5 million.",
    ) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        webSourceTexts([webSource({ snippet })]),
      );
    const quote = "Reported revenue in MYR 125.5 Million";
    expect(
      claim("| Reported revenue in MYR | 125.5 |\n| Million units sold | 2.0 |", quote),
    ).toMatchObject({ reason: "scale-mismatch", figure: "MYR 125.5 million" });
    expect(claim("Reported revenue in MYR | 125.5\nMillion units sold | 2.0", quote)).toMatchObject(
      {
        reason: "scale-mismatch",
      },
    );
    expect(
      claim("| Reported revenue in MYR | 125.5 | Million units sold | 2.0 |", quote),
    ).toMatchObject({
      reason: "scale-mismatch",
    });
    expect(
      claim(
        "| Reported revenue in MYR | 125.5 |\n| Million units sold | 2.0 |",
        "Reported revenue in MYR | 125.5 |\n| Million",
      ),
    ).toMatchObject({ reason: "scale-mismatch" });
    expect(
      claim(
        "| Revenue | MYR 125.5 million in the quarter |",
        "Revenue | MYR 125.5 million in the quarter",
      ),
    ).toBeUndefined();
    expect(
      claim(
        "Reported revenue in the quarter was MYR 125.5\nmillion, up 4%.",
        "revenue in the quarter was MYR 125.5 million",
      ),
    ).toBeUndefined();
  });

  test("withholds a figure in a cell that wraps across lines, which may instead start a new row", () => {
    const claim = (
      snippet: string,
      quote: string,
      text = "Reported revenue was MYR 125.5 million.",
    ) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        webSourceTexts([webSource({ snippet })]),
      );
    const wrapped = "| Reported revenue for the quarter | MYR 125.5\nmillion |\n| Units | 2.0 |";
    const quote = "Reported revenue for the quarter | MYR 125.5\nmillion";
    expect(claim(wrapped, quote)).toMatchObject({ reason: "figure-not-in-quote" });
    expect(claim(wrapped, quote, "Reported revenue was MYR 125.5.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(
      claim(
        "| Reported revenue for the quarter | MYR 125.5\nmillion\nin the quarter |",
        "Reported revenue for the quarter | MYR 125.5\nmillion",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(
        "| Reported revenue for the quarter | MYR 125.5\n\nmillion |",
        "Reported revenue for the quarter | MYR 125.5",
        "Reported revenue was MYR 125.5.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    const unclosed = "| Reported revenue in MYR | 125.5\nMillion units sold |";
    expect(
      claim(unclosed, "Reported revenue in MYR | 125.5", "Reported revenue was 125.5 million."),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(unclosed, "Reported revenue in MYR | 125.5", "Reported revenue was 125.5."),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(
        "| Reported revenue for the quarter | MYR 125.5 million |\n| Units | 2.0 |",
        "Reported revenue for the quarter | MYR 125.5 million",
      ),
    ).toBeUndefined();
  });

  test("a quote that cuts a source figure short is checked against the whole figure", () => {
    const claim = (snippet: string, quote: string, text: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        webSourceTexts([webSource({ snippet })]),
      );
    expect(
      claim(
        "| Reported revenue for the quarter | MYR 125,500 |",
        "Reported revenue for the quarter | MYR 125",
        "Reported revenue was MYR 125.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    const prose =
      "Reported revenue for the quarter was MYR 125.5 million, with revenue up 22.8% on the year.";
    expect(
      claim(prose, "revenue for the quarter was MYR 125.5", "Revenue was MYR 125.5."),
    ).toMatchObject({ reason: "scale-mismatch" });
    expect(
      claim(prose, "revenue for the quarter was MYR 125.5", "Revenue was MYR 125.5 million."),
    ).toBeUndefined();
    expect(claim(prose, "with revenue up 22.8", "Revenue rose 22.8.")).toMatchObject({
      reason: "unit-mismatch",
    });
  });

  test("a quote verifies when any span of its source states the figure", () => {
    const prose = "Reported revenue in MYR 125.5 million in the quarter";
    const rawSnapshots = [
      {
        id: "raw-exa-search-1",
        adapter: "exa-search",
        fetchedAt: "2026-11-05T11:00:00.000Z",
        payload: {
          results: [{ url: "https://www.thestar.com.my/business/vitrox-q3/", text: prose }],
        },
      },
    ];
    const snippet = webSource({
      snippet: "| Reported revenue in MYR | 125.5 | million in the quarter |",
    });
    const claim = (stored: ReturnType<typeof webSourceTexts>) =>
      unverifiedWebFigure(
        {
          text: "Reported revenue was MYR 125.5 million.",
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: prose }],
        },
        stored,
      );
    expect(claim(webSourceTexts([snippet], rawSnapshots))).toBeUndefined();
    expect(claim(webSourceTexts([snippet]))).toMatchObject({ reason: "scale-mismatch" });
  });

  test("withholds a figure beside a row with no closing pipe whose next line may start a new row", () => {
    const claim = (snippet: string, quote: string, text: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        webSourceTexts([webSource({ snippet })]),
      );
    const table =
      "| Reported revenue | Amount |\n| --- | --- |\n| Reported revenue in MYR | 125.5\nMillion units sold | 2.0";
    const quote = "Reported revenue in MYR | 125.5";
    expect(claim(table, quote, "Reported revenue was 125.5 million.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(claim(table, quote, "Reported revenue was 125.5.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(
      claim(
        "| Reported revenue in MYR 125.5\nMillion units sold | 2.0",
        "Reported revenue in MYR 125.5\nMillion",
        "Reported revenue was MYR 125.5 million.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
  });

  test("keeps percentage points apart from percent", () => {
    const claim = (snippet: string, quote: string, text: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        webSourceTexts([webSource({ snippet })]),
      );
    const points = "Reported operating margin expanded 2.5 percentage points.";
    const pointsQuote = "Reported operating margin expanded 2.5 percentage points";
    expect(claim(points, pointsQuote, "Operating margin expanded 2.5%.")).toMatchObject({
      reason: "unit-mismatch",
    });
    expect(claim(points, pointsQuote, "Operating margin expanded 2.5 pp.")).toBeUndefined();
    const percent = "Reported operating margin expanded 2.5% in the quarter.";
    expect(
      claim(
        percent,
        "Reported operating margin expanded 2.5%",
        "Operating margin expanded 2.5 percentage points.",
      ),
    ).toMatchObject({ reason: "unit-mismatch" });
    expect(
      claim(
        percent,
        "Reported operating margin expanded 2.5%",
        "Operating margin expanded 2.5 percent.",
      ),
    ).toBeUndefined();
  });

  test("keeps the sign of a negative amount or an accounting-parenthesized table cell", () => {
    const claim = (snippet: string, text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: snippet }],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    const positive = "Operating cash flow was MYR 125.5 million.";
    const negative = "Operating cash flow was -MYR 125.5 million.";
    expect(claim("Reported operating cash flow was -MYR 125.5 million.", positive)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(claim("Reported operating cash flow was -MYR 125.5 million.", negative)).toBeUndefined();
    expect(claim("Reported operating cash flow was MYR −125.5 million.", positive)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(
      claim(
        "Reported operating cash flow was MYR −125.5 million.",
        "Cash flow was MYR −125.5 million.",
      ),
    ).toBeUndefined();
    const margin = "Reported margin in the quarter was 5.46%.";
    for (const dash of ["–", "—", "‒"]) {
      expect(claim(margin, `Margin was ${dash}5.46%.`)).toMatchObject({
        reason: "figure-not-in-quote",
      });
      expect(
        claim(`Reported margin in the quarter was ${dash}5.46%.`, `Margin was ${dash}5.46%.`),
      ).toBeUndefined();
    }
    expect(claim("Reported operating cash flow was MYR 125.5 million.", negative)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    const cell = "| Reported operating cash flow | (MYR 125.5 million) |";
    expect(claim(cell, negative)).toBeUndefined();
    expect(claim(cell, positive)).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim("| Reported operating cash flow | ( 125.5 ) |", "Cash flow was -125.5."),
    ).toBeUndefined();
    expect(
      claim("| Reported operating cash flow | (125.5) |", "Operating cash flow was 125.5."),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(
        "Reported shares closed at 41.72, down 2.41 (-5.46%) on the day.",
        "Shares fell -5.46%.",
      ),
    ).toBeUndefined();
    expect(
      claim(
        "Reported operating cash flow in Q3 (Q3 2026) was MYR 125.5 million (2025: MYR 100 million).",
        "Operating cash flow was MYR 125.5 million against MYR 100 million.",
      ),
    ).toBeUndefined();
    expect(
      claim("Revenue was 2,649,666 (RM'000) in the reported quarter.", "Revenue was 2,649,666."),
    ).toBeUndefined();
  });

  test("withholds a figure whose sign is ambiguous", () => {
    const claim = (snippet: string, text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: snippet }],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    const positive = "Operating cash flow was MYR 125.5 million.";
    const negative = "Operating cash flow was -MYR 125.5 million.";
    for (const prose of [
      "Reported operating cash flow was (MYR 125.5 million).",
      "Reported operating cash flow was ( MYR 125.5 million ).",
      "Reported operating cash flow was - MYR 125.5 million.",
      "Reported operating cash flow was − MYR 125.5 million.",
      "Reported operating cash flow was MYR - 125.5 million.",
      "| Reported operating cash flow | MYR (125.5) million |",
    ]) {
      expect(claim(prose, positive)).toMatchObject({ reason: "figure-not-in-quote" });
      expect(claim(prose, negative)).toMatchObject({ reason: "figure-not-in-quote" });
    }
    const between = "| Metric | Value |\n| --- | --- |\n(12.5%)\n| Growth | 4.0% |";
    const betweenQuote = "Metric | Value | --- | --- | (12.5%) | Growth";
    const betweenClaim = (text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: betweenQuote }],
        },
        webSourceTexts([webSource({ snippet: between })]),
      );
    expect(betweenClaim("The metric was -12.5% in the quarter.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(betweenClaim("The metric was 12.5% in the quarter.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    const aside = "Reported quarterly revenue (RM5m) rose on the year.";
    expect(claim(aside, "Revenue was -RM5m.")).toMatchObject({ reason: "figure-not-in-quote" });
    expect(claim(aside, "Revenue was RM5m.")).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim("Reported margin was 12.5% - 2.5% lower on the year.", "Margin was 12.5%, 2.5% lower."),
    ).toMatchObject({ reason: "figure-not-in-quote", figure: "2.5%" });
    expect(
      claim(
        "Reported AI cloud revenue -- $574.9 million for the quarter.",
        "Revenue was $574.9 million.",
      ),
    ).toBeUndefined();
    expect(claim("Reported revenue was RM5m.", "Revenue was (RM5m) on the year.")).toMatchObject({
      reason: "figure-ambiguous",
    });
  });

  test("checks both endpoints of a range, whatever its dash", () => {
    const claim = (snippet: string, text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: snippet }],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    for (const dash of ["-", "–", "—"]) {
      for (const [quoted, wrong] of [
        ["RM5m-RM6m", "RM5m-RM9m"],
        ["$1.2-1.4 billion", "$1.2-1.9 billion"],
        ["5-6%", "5-9%"],
        ["1.2-1.4", "1.2-1.9"],
      ] as const) {
        const snippet = `Management guided revenue of ${quoted.replace("-", dash)} for the year.`;
        expect(claim(snippet, `Guidance is ${quoted.replace("-", dash)}.`)).toBeUndefined();
        expect(claim(snippet, `Guidance is ${quoted}.`)).toBeUndefined();
        expect(claim(snippet, `Guidance is ${wrong.replace("-", dash)}.`)).toMatchObject({
          reason: "figure-not-in-quote",
        });
      }
    }
    expect(
      claim("Management guided revenue of RM5m-RM6bnish for the year.", "Guidance is RM5m."),
    ).toMatchObject({ reason: "figure-not-in-quote", figure: "RM5m" });
  });

  test("checks a word range's low endpoint and never reads a period label as an amount", () => {
    const claim = (snippet: string, text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: snippet }],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    const guided = "Management guided a margin change of -5 to -3% for the year.";
    expect(claim(guided, "Guidance is -5 to -3%.")).toBeUndefined();
    expect(claim(guided, "Guidance is -9 to -3%.")).toMatchObject({
      reason: "figure-not-in-quote",
    });
    // ViTrox Q3 FY2026 table header, run 3f1aa431.
    const header = "| Q3 FY2026 | Q3 FY2025 | Change | 9M FY2026 | 9M FY2025 | Change |";
    expect(claim(header, "The company shipped 9M units.")).toMatchObject({
      reason: "figure-ambiguous",
    });
    expect(
      claim(
        "Capex fell from 500 to 2 million this year per filings.",
        "Capex was 500 million this year.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(
        "Segment revenue was up 100 to $5 million in the quarter.",
        "Revenue was up $100 million.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim("Management guided capex of 5 to $7-million for the year.", "Capex of $5 is guided."),
    ).toMatchObject({ reason: "figure-not-in-quote" });
  });

  test("withholds a range it cannot read whole", () => {
    const claim = (snippet: string, text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: snippet }],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    for (const [snippet, text] of [
      ["Annual guidance is 7%-12% for the year.", "Guidance is 7%-15."],
      ["Annual guidance is 5x-6x for the year.", "Guidance is 5x-9."],
      ["Annual guidance is 5m-6m for the year.", "Guidance is 5m-9."],
      ["Annual guidance is 5bn-6 for the year.", "Guidance is 5bn-9."],
      ["Annual guidance is 5-9bp for the year.", "Guidance is 5-6bp."],
      ["Annual guidance is 7% - 12 for the year.", "Guidance is 7% - 15."],
      ["Annual revenue was 1.2bn-1.4 in the year.", "The ratio was 1.4."],
      ["Cash was RM500,000-RM1m in the quarter.", "Cash was RM500,000 million."],
      ["Cash was $1,200-$1.4 billion in the quarter.", "Cash was $1,200 billion."],
      ["The stock Corp$230.80-11.5% on the day.", "The move was 230.80%."],
      ["The group revenue—$5m-$9m this year.", "Revenue—$7m-$9m."],
      ["Management guided revenue of RM5m-RM6m for the year.", "Guidance is (RM5m-RM6m)."],
      ["The net loss was (RM5m-RM6m) this year.", "The net loss was RM5m-RM6m."],
      ["| Net loss for the year | ($1.2-1.4 billion) |", "The loss was $1.2-1.4 billion."],
      ["The change was 5%+3% this year.", "The change was 5%-3%."],
      ["Annual guidance is 1-2-3% for the year.", "Guidance is 9-8-3%."],
      ["Annual guidance is $5-$6-$7 million for the year.", "Guidance is $7 million."],
      ["The stock Corp$4.50-6% on the day.", "The move was 4.5%."],
      ["Annual change was -2%-8% for the year.", "The change was 8%."],
      ["Annual change was -5m-3m for the year.", "The change was 3m."],
      ["Annual change was - 5%-3% for the year.", "The change was 3%."],
      ["Annual guidance is 7% -12% for the year.", "Guidance is 7% -15."],
      ["Annual guidance is $5m -9 for the year.", "Guidance is $5m -6."],
      ["The annual Guidance—$5-6 for the year.", "Guidance—$5-8."],
      ["The group revenue—$5m-9 this year.", "Revenue—$5m-7."],
      ["Reported Revenue—$574.9 million this quarter.", "Revenue—$600 million."],
      ["The stock Corp$ 4.50-6% on the day.", "The move was 4.5%."],
      ["The stock CorpRM 4.50-6% on the day.", "The move was 4.5%."],
      ["The group holds a 7-percent stake in the unit.", "It holds a 5-percent stake."],
      ["Output rose 7-fold over the year.", "Output rose 5-fold."],
      ["Annual guidance is $1.2 - 1.4 billion for the year.", "Guidance is $1.2."],
      ["The group holds a 5 per cent stake in the unit.", "It holds a 7-per-cent stake."],
      ["Margin guidance is (5% - 7%) for the year.", "Margin guidance is 5%."],
      ["Annual revenue was 9-M for the year.", "Revenue was 5-M."],
    ]) {
      expect(["figure-not-in-quote", "figure-ambiguous"]).toContain(
        claim(snippet ?? "", text ?? "")?.reason ?? "verified",
      );
    }
    expect(claim("The change was 5%-3% this year.", "The change was 5%-3%.")).toMatchObject({
      reason: "figure-ambiguous",
    });
    expect(claim("Annual change was -5%--3% for the year.", "Change was -5%--3%.")).toBeUndefined();
    expect(claim("Annual change was 7% -12% for the year.", "Change 7% and -12%.")).toBeUndefined();
    expect(
      claim("Revenue was $574.9 million—up strongly this year.", "Revenue was $574.9 million."),
    ).toBeUndefined();
    expect(
      claim(
        "Management guided revenue of $1.2-1.4 billion for the year.",
        "Guidance $1.2-1.9 billion.",
      ),
    ).toMatchObject({ figure: "$1.2-1.9 billion" });
  });

  test("tries overlapping matches of a quote", () => {
    const snippet =
      "| Reported revenue | MYR 125.5 |\n| Reported revenue | MYR 125.5 |\n| Reported revenue | MYR 125.5 million |";
    const claim = (stored: string) =>
      unverifiedWebFigure(
        {
          text: "Reported revenue was MYR 125.5 million.",
          sourceIds: ["web-vitrox"],
          figureQuotes: [
            {
              sourceId: "web-vitrox",
              quote: "Reported revenue | MYR 125.5 |\n| Reported revenue | MYR 125.5",
            },
          ],
        },
        webSourceTexts([webSource({ snippet: stored })]),
      );
    expect(claim(snippet)).toBeUndefined();
    expect(claim(snippet.split("\n").slice(0, 2).join("\n"))).toMatchObject({
      reason: "scale-mismatch",
    });
  });

  test("checks a quote with thousands of matches in time linear in the text", () => {
    const sentence = "Reported revenue rose to MYR 125.5 million in the quarter. ";
    const timed = (repeats: number) => {
      const stored = webSourceTexts([webSource({ snippet: sentence.repeat(repeats) })]);
      const started = performance.now();
      const failure = unverifiedWebFigure(
        {
          text: "Revenue was MYR 125.5 million.",
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: "revenue rose to MYR 125.5 million" }],
        },
        stored,
      );
      expect(failure).toBeUndefined();
      return performance.now() - started;
    };
    timed(100);
    // Quadratic span work took about 1.1 s at 25,600 matches; linear work stays far below this bound.
    expect(timed(25_600)).toBeLessThan(500);
  });

  test("verifies against stored raw page text and fails beyond its truncation", () => {
    const stored = `${"Filler sentence. ".repeat(10)}Order backlog stood at RM210.4 million.`;
    const rawSnapshots = [
      {
        id: "raw-exa-search-1",
        adapter: "exa-search",
        fetchedAt: "2026-11-05T11:00:00.000Z",
        payload: {
          results: [{ url: "https://www.thestar.com.my/business/vitrox-q3/", text: stored }],
        },
      },
    ];
    const withRaw = webSourceTexts([webSource()], rawSnapshots);
    const claim = (text: string, quote: string) =>
      unverifiedWebFigure(
        { text, sourceIds: ["web-vitrox"], figureQuotes: [{ sourceId: "web-vitrox", quote }] },
        withRaw,
      );
    expect(
      claim("Backlog was RM210.4 million.", "backlog stood at RM210.4 million"),
    ).toBeUndefined();
    expect(claim("Headcount was 1,200.", "with a headcount of 1,200")).toMatchObject({
      reason: "quote-not-in-source",
    });
  });

  test("fails every figure from a source with no stored text", () => {
    const { snippet: _snippet, ...withoutSnippet } = webSource();
    const bare = webSourceTexts([withoutSnippet]);
    expect(
      unverifiedWebFigure({ text: "Revenue grew 22.8%.", sourceIds: ["web-vitrox"] }, bare),
    ).toMatchObject({ reason: "no-stored-text" });
    expect(
      unverifiedWebFigure(
        {
          text: "Revenue grew 22.8%.",
          sourceIds: ["web-vitrox"],
          figureQuotes: [{ sourceId: "web-vitrox", quote: "revenue grew 22.8%" }],
        },
        bare,
      ),
    ).toMatchObject({ reason: "no-stored-text" });
  });

  test("leaves claims without a cited web source or without figures alone", () => {
    expect(check("Revenue grew 22.8%.", undefined, ["sec-10q"])).toBeUndefined();
    expect(check("ViTrox makes machine-vision inspection equipment.")).toBeUndefined();
    expect(check("Results for Q3 2026 were filed on Nov 5, 2026.")).toBeUndefined();
  });

  test("lets only a deterministic co-citation carry unquoted figures", () => {
    expect(check("Revenue grew 22.8%.", undefined, ["web-vitrox", "sec-10q"])).toBeUndefined();
    for (const other of ["news-vitrox", "history-report-prior", "unknown-id"]) {
      expect(check("Revenue grew 22.8%.", undefined, ["web-vitrox", other])).toMatchObject({
        reason: "figure-not-quoted",
      });
    }
  });

  test("fails a claim on any failing quote, whatever figure it holds", () => {
    expect(
      check("Revenue grew 22.8%.", "price target $300 - Buy now", ["web-vitrox", "sec-10q"]),
    ).toMatchObject({ reason: "quote-not-in-source", figure: "$300" });
    expect(
      unverifiedWebFigure(
        {
          text: "ViTrox makes inspection equipment.",
          sourceIds: ["sec-10q"],
          figureQuotes: [{ sourceId: "sec-10q", quote: "makes inspection equipment" }],
        },
        texts,
      ),
    ).toMatchObject({ reason: "no-stored-text", figure: "a quoted figure" });
  });

  test("fails a quote with too little text around its figure", () => {
    expect(check("Margin was 22.8%.", "22.8%")).toMatchObject({ reason: "quote-too-short" });
    expect(check("Margin was 22.8%.", "grew 22.8% to")).toMatchObject({
      reason: "quote-too-short",
    });
  });
});

describe("Report Integrity Audit with Verified Web Figures", () => {
  const sources = [webSource(), SEC_SOURCE];
  const report = researchReport({
    sources,
    keyFindings: [
      {
        text: "Q3 net profit rose to RM118.58mil.",
        sourceIds: ["web-vitrox"],
        figureQuotes: [{ sourceId: "web-vitrox", quote: "quarter rose to RM118.58mil" }],
      },
      { text: "Q3 net profit rose to RM118.8 million.", sourceIds: ["web-vitrox"] },
    ],
    extras: {
      earningsSetup: {
        expectationBar: [
          { text: "Revenue grew 22.8% in Q3.", sourceIds: ["web-vitrox"] },
          {
            text: "Revenue grew 22.8% in Q3.",
            sourceIds: ["web-vitrox"],
            figureQuotes: [{ sourceId: "web-vitrox", quote: "while revenue grew 22.8%" }],
          },
        ],
      },
    },
  });

  test("prunes failing claims, keeps verified ones, and declares each prune", () => {
    const result = auditReportIntegrity(
      report,
      undefined,
      undefined,
      undefined,
      webSourceTexts(sources),
    );
    expect(result.report.keyFindings.map(({ text }) => text)).toEqual([
      "Q3 net profit rose to RM118.58mil.",
    ]);
    const setup = result.report.extras?.earningsSetup as { expectationBar: unknown[] };
    expect(setup.expectationBar).toHaveLength(1);
    expect(result.report.dataGaps).toEqual([
      ...report.dataGaps,
      "Verified Web Figure check withheld keyFindings[1]: RM118.8 million has no verbatim quote from its cited web source (web-vitrox).",
      "Verified Web Figure check withheld extras.earningsSetup.expectationBar[0]: 22.8% has no verbatim quote from its cited web source (web-vitrox).",
    ]);
    expect(result.pruned.map(({ location, webFigure }) => [location, webFigure?.reason])).toEqual([
      ["keyFindings[1]", "figure-not-quoted"],
      ["extras.earningsSetup.expectationBar[0]", "figure-not-quoted"],
    ]);
    expect(result.report.reportIntegrity).toBe("medium");
  });

  test("skips the check when no web texts are supplied", () => {
    const result = auditReportIntegrity(report);
    expect(result.report.keyFindings).toHaveLength(2);
    expect(result.report.dataGaps).toEqual(report.dataGaps);
  });

  test("renders a gap naming location, figure, reason and source", () => {
    expect(
      webFigureGapText("catalysts[0]", {
        reason: "scale-mismatch",
        figure: "RM552.73 million",
        sourceIds: ["web-vitrox"],
      }),
    ).toBe(
      "Verified Web Figure check withheld catalysts[0]: RM552.73 million is quoted at a different scale (web-vitrox).",
    );
  });
});
