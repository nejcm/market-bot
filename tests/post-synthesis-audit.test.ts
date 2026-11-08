import { describe, expect, test } from "bun:test";
import type { Prediction } from "../src/domain/prediction";
import type { ResearchReport } from "../src/domain/report";
import {
  auditPostSynthesisReport,
  isNumericClaim,
  isTechnicalClaim,
} from "../src/research/post-synthesis-audit";
import type { WebSourceUsage } from "../src/web-evidence";

function reportWith(
  overrides: Partial<
    Pick<
      ResearchReport,
      "keyFindings" | "bullCase" | "bearCase" | "risks" | "catalysts" | "scenarios" | "predictions"
    >
  >,
): ResearchReport {
  return {
    runId: "run-audit",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    generatedAt: "2026-05-19T00:00:00.000Z",
    summary: "Audit fixture.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [],
    notFinancialAdvice: true,
    ...overrides,
  };
}

function prediction(overrides: Partial<Prediction>): Prediction {
  return {
    id: "p1",
    claim: "AAPL closes above 200 within 5 trading days.",
    kind: "direction",
    subject: "AAPL",
    measurableAs: "AAPL.close > 200",
    horizonTradingDays: 5,
    probability: 0.55,
    sourceIds: ["market-aapl"],
    ...overrides,
  };
}

function webSourceUsage(accepted: number, used: number): WebSourceUsage {
  const currentRunIds = new Set(
    Array.from({ length: accepted }, (_, index) => `web-${String(index + 1)}`),
  );
  const currentRunUsedIds = new Set([...currentRunIds].slice(0, used));
  return {
    currentRunIds,
    reusedProfileIds: new Set(),
    profileUsedIds: new Set(),
    reportCitedIds: currentRunUsedIds,
    extrasCitedIds: new Set(),
    currentRunUsedIds,
  };
}

describe("auditPostSynthesisReport", () => {
  test("warns for numeric and technical claims supported only by history sources", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        keyFindings: [{ text: "Sector RSI14 is 70.", sourceIds: ["history-report-prior"] }],
      }),
    );

    expect(warnings.map((warning) => warning.code)).toEqual([
      "unsupported-numeric-claim",
      "weak-evidence-posture-missing",
    ]);
    expect(warnings.map((warning) => warning.location)).toEqual([
      "keyFindings[0]",
      "keyFindings[0]",
    ]);
  });

  test("does not warn for numeric claims with current source support", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        keyFindings: [{ text: "AAPL volume rose 10%.", sourceIds: ["market-aapl"] }],
      }),
    );

    expect(warnings).toEqual([]);
  });

  test("warns when a gap-shaped risk carries a citation", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [
          {
            text: "No segment disclosure was provided",
            sourceIds: ["market-yahoo-equity-aapl"],
          },
        ],
      }),
    );

    expect(warnings).toEqual([
      {
        code: "gap-shaped-claim-cited",
        location: "risks[0]",
        message: "gap-shaped claim carries source citations; review citation grounding",
        sourceIds: ["market-yahoo-equity-aapl"],
      },
    ]);
  });

  test("does not warn for an uncited gap-shaped risk", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [{ text: "No segment disclosure was provided", sourceIds: [] }],
      }),
    );

    expect(warnings.some((warning) => warning.code === "gap-shaped-claim-cited")).toBe(false);
  });

  test("does not warn for an ordinary cited risk", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [
          {
            text: "Revenue data shows no growth in the segment",
            sourceIds: ["market-yahoo-equity-aapl"],
          },
        ],
      }),
    );

    expect(warnings).toEqual([]);
  });

  test("does not warn for cited guidance-absence prose", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [
          {
            text: "No guidance was provided for FY26",
            sourceIds: ["market-yahoo-equity-aapl"],
          },
        ],
      }),
    );

    expect(warnings.some((warning) => warning.code === "gap-shaped-claim-cited")).toBe(false);
  });

  test("does not warn for cited data-center prose", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [
          {
            text: "The company has no data centers in Europe",
            sourceIds: ["market-yahoo-equity-aapl"],
          },
        ],
      }),
    );

    expect(warnings.some((warning) => warning.code === "gap-shaped-claim-cited")).toBe(false);
  });

  test("treats empty source IDs as unsupported", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [{ text: "Revenue increased 8%.", sourceIds: [] }],
      }),
    );

    expect(warnings.map((warning) => warning.code)).toEqual([
      "unsupported-numeric-claim",
      "weak-evidence-posture-missing",
    ]);
  });

  test("fiscal-period labels alone are not numeric claims", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        risks: [
          { text: "Model inference: Q2 2026 and 3Q demand stayed qualitative.", sourceIds: [] },
          { text: "Model inference: Q3 up 12%.", sourceIds: [] },
          { text: "Model inference: €3Q of backlog.", sourceIds: [] },
          { text: "Model inference: $ 3Q of backlog.", sourceIds: [] },
        ],
      }),
    );

    expect(warnings.map((warning) => [warning.code, warning.location])).toEqual([
      ["unsupported-numeric-claim", "risks[1]"],
      ["unsupported-numeric-claim", "risks[2]"],
      ["unsupported-numeric-claim", "risks[3]"],
    ]);
  });

  test("suppresses posture warning when weak claim carries a posture label", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        bearCase: [
          {
            text: "Model inference: competitive pressure may rise.",
            sourceIds: ["history-report-prior"],
          },
        ],
      }),
    );

    expect(warnings).toEqual([]);
  });

  test.each([
    ["unverified", "Utilization remains unverified."],
    ["unsupported", "The conclusion remains unsupported."],
    ["uncited", "The claim is uncited."],
    ["low-trust", "Low-trust web context assumes utilization improves."],
    ["inferred", "The relationship is inferred from current evidence."],
    ["model-inferred", "The relationship is model-inferred from current evidence."],
  ] as const)("accepts a current-source %s posture", (_posture, text) => {
    const warnings = auditPostSynthesisReport(
      reportWith({ bearCase: [{ text, sourceIds: ["market-aapl"] }] }),
    );

    expect(warnings.some((warning) => warning.code === "weak-evidence-posture-missing")).toBe(
      false,
    );
  });

  test.each([
    ["history-only", "Utilization remains unverified.", ["history-report-prior"]],
    ["empty-source", "Utilization remains unverified.", []],
    ["data gap", "A data gap leaves utilization unverified.", ["market-aapl"]],
    ["source gap", "A source gap leaves utilization unverified.", ["market-aapl"]],
    ["missing source", "A missing source leaves utilization unverified.", ["market-aapl"]],
  ] as const)("requires a canonical posture for %s claims", (_case, text, sourceIds) => {
    const warnings = auditPostSynthesisReport(reportWith({ bearCase: [{ text, sourceIds }] }));

    expect(warnings.some((warning) => warning.code === "weak-evidence-posture-missing")).toBe(true);
  });

  test("audits scenarios and predictions", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        scenarios: [
          {
            name: "Upside",
            description: "Assume liquidity improves without confirmation.",
            sourceIds: ["market-aapl"],
          },
        ],
        predictions: [
          prediction({
            claim: "AAPL closes above 200 within 5 trading days.",
            sourceIds: ["history-report-prior"],
          }),
        ],
      }),
    );

    expect(warnings.map((warning) => [warning.location, warning.code])).toEqual([
      ["scenarios[0]", "weak-evidence-posture-missing"],
      ["predictions[0]", "unsupported-numeric-claim"],
      ["predictions[0]", "weak-evidence-posture-missing"],
    ]);
  });

  test("does not treat historical forecast-outcome wording as a current numeric claim", () => {
    const warnings = auditPostSynthesisReport(
      reportWith({
        keyFindings: [
          {
            text: "Prior forecast outcome: prior 5-day misses clustered around macro reversals.",
            sourceIds: ["history-report-prior"],
          },
        ],
      }),
    );

    expect(warnings).toEqual([]);
  });

  test("warns when at least four accepted fresh web sources are all unused", () => {
    const warnings = auditPostSynthesisReport(reportWith({}), webSourceUsage(4, 0));

    expect(warnings).toEqual([
      {
        code: "fresh-web-unused",
        location: "report",
        message:
          "accepted fresh web sources were unused; review gather relevance and dataGap wording",
        sourceIds: ["web-1", "web-2", "web-3", "web-4"],
      },
    ]);
  });

  test("does not warn when fewer than four accepted fresh web sources are unused", () => {
    const warnings = auditPostSynthesisReport(reportWith({}), webSourceUsage(3, 0));

    expect(warnings).toEqual([]);
  });

  test("does not warn when any accepted fresh web source is used", () => {
    const warnings = auditPostSynthesisReport(reportWith({}), webSourceUsage(10, 1));

    expect(warnings).toEqual([]);
  });
});

describe("isNumericClaim", () => {
  test.each([
    ["T1 Energy is scaling", false],
    ["early Rev8 adoption", false],
    ["H100 and B200 demand", false],
    ["A17 chip launch", false],
    [
      "T1 Energy is scaling a U.S. solar manufacturing business while building a cell factory.",
      false,
    ],
    [
      "OUST’s recent results show rapid sales expansion, strong shipment growth and early Rev8 adoption, alongside continuing losses and heavier cash outflow.",
      false,
    ],
    ["iPhone15 launch", true],
    ["x86 and v2 servers", true],
    ["revenue of RM485 million", true],
    ["Rs500 crore", true],
    ["Rs5 billion", true],
    ["Rp500 million", true],
    ["kr500", true],
    ["rm485 million", true],
    ["myr485", true],
    ["usd500", true],
    ["MYR485", true],
    ["T1 million", true],
    ["earnings of R500 mln", true],
    ["earnings of R500 bln", true],
    ["earnings of R500 Million", true],
    ["earnings of R500 cr", true],
    ["earnings of R500 K", true],
    ["Intel N100 adoption remains strong", false],
    ["earnings of R500", false],
    ["fees of Myr500", false],
    ["H100 $", true],
    ["q3 % rise", true],
    ["h1 % rise", true],
    ["built by T1.", false],
    ["T1, Rev8 and H100", false],
    ["Rev8 revenue rose 12%", true],
    ["Rev8 shipped 9M units", true],
    ["T1.5 growth", true],
    ["Rev8,000 units", true],
    ["B200s shipped", true],
    ["T1x leverage", true],
    ["€T1 of backlog", true],
    ["USD500 of debt", true],
    ["EUR500m of debt", true],
    ["Rs5bn of debt", true],
    ["5G rollout", true],
    ["F-150 sales", false],
    ["$3.4bn", true],
    ["12%", true],
    ["1,234 units", true],
    ["9M units", true],
    ["5x leverage", true],
    ["3.2B shares", true],
    ["FY2025", true],
    ["FY2025 revenue of 9.6", true],
    ["2025 demand", true],
    ["Q3 demand", false],
    ["Q3 % rise", true],
    ["H1 demand", false],
  ])("%p classifies as numeric: %p", (text, numeric) => {
    expect(isNumericClaim(text)).toBe(numeric);
  });
});

describe("isNumericClaim names with digits", () => {
  test.each([
    "Performance versus the S&P 500 proxy is mixed.",
    "The company is in the Nasdaq 100.",
    "A Fortune 500 customer base.",
    "The latest 10-K describes three segments.",
    "Foreign filers use 20-F and 6-K forms.",
    "iPhone 17 demand is strong.",
    "Instinct MI350 Series GPUs drive growth.",
    "Section 232 tariffs apply.",
    "COVID-19 era comparisons.",
    "Segments are reported under ASC 280.",
    "Maia 200 is in production.",
  ])("%p is not numeric", (text) => {
    expect(isNumericClaim(text)).toBe(false);
  });

  test.each([
    "The top 10 customers are concentrated.",
    "IREN reported about 40 MW of operating capacity.",
    "IREN reported 5 GW of power arrangements.",
    "Sector RSI14 is 70.",
    "Shares trade at a P/E of 25.",
    "AMD closes outside 570-720 over 5 trading days",
    "Nasdaq 100 futures fell 2%.",
    "Debt was USD 500 at year end.",
    "Revenue was RM 485 for the quarter.",
    "The S&P 500 rose 1.2 points.",
    "MI350 shipped 9M units.",
    "Results are due April 31, 2026.",
  ])("%p stays numeric", (text) => {
    expect(isNumericClaim(text)).toBe(true);
  });

  test("a glued moving-average name is a technical claim", () => {
    expect(isTechnicalClaim("Price held above EMA10 and SMA50.")).toBe(true);
  });
});

describe("isNumericClaim with run currencies", () => {
  test.each([
    ["Intel N100 adoption remains strong", ["USD"], false],
    ["Cloudflare R2 and TSMC N2 capacity", ["USD"], false],
    ["earnings of R500", ["ZAR"], true],
    ["earnings of R5000", ["ZAR"], true],
    ["earnings of ZAR500", ["ZAR"], true],
    ["earnings of Zar500", ["ZAR"], true],
    ["Cloudflare R2 storage", ["ZAR"], true],
    ["fees of Myr500", ["MYR"], true],
    ["fees of RM500", ["MYR"], true],
    ["earnings of R500", ["MYR", "USD"], false],
    ["fees of Myr500", ["USD", "MYR"], true],
    ["earnings of R500", ["not-a-code"], false],
  ] as const)("%p on %p classifies as numeric: %p", (text, currencies, numeric) => {
    expect(isNumericClaim(text, currencies)).toBe(numeric);
  });
});
