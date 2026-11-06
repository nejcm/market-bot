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

  test("reads a figure whole from a table cell that wraps across lines", () => {
    const snippet = "| Reported revenue for the quarter | MYR 125.5\nmillion |\n| Units | 2.0 |";
    const claim = (text: string) =>
      unverifiedWebFigure(
        {
          text,
          sourceIds: ["web-vitrox"],
          figureQuotes: [
            {
              sourceId: "web-vitrox",
              quote: "Reported revenue for the quarter | MYR 125.5\nmillion",
            },
          ],
        },
        webSourceTexts([webSource({ snippet })]),
      );
    expect(claim("Reported revenue was MYR 125.5 million.")).toBeUndefined();
    expect(claim("Reported revenue was MYR 125.5.")).toMatchObject({ reason: "scale-mismatch" });
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

  test("keeps the sign of a negative or parenthesized amount", () => {
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
    expect(claim("Reported operating cash flow was -MYR 125.5 million.", positive)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(claim("Reported operating cash flow was (MYR 125.5 million).", positive)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(claim("Reported operating cash flow was MYR −125.5 million.", positive)).toMatchObject({
      reason: "figure-not-in-quote",
    });
    expect(
      claim(
        "Reported operating cash flow was MYR 125.5 million.",
        "Operating cash flow was -MYR 125.5 million.",
      ),
    ).toMatchObject({ reason: "figure-not-in-quote" });
    expect(
      claim(
        "Reported operating cash flow was (MYR 125.5 million).",
        "Operating cash flow was -MYR 125.5 million.",
      ),
    ).toBeUndefined();
    expect(
      claim(
        "Reported operating cash flow in Q3 (Q3 2026) was MYR 125.5 million (2025: MYR 100 million).",
        "Operating cash flow was MYR 125.5 million against MYR 100 million.",
      ),
    ).toBeUndefined();
    expect(
      claim("Reported margin was 12.5% - 2.5% lower on the year.", "Margin was 12.5%, 2.5% lower."),
    ).toBeUndefined();
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
