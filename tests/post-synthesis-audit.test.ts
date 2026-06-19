import { describe, expect, test } from "bun:test";
import type { Prediction, ResearchReport } from "../src/domain/types";
import { auditPostSynthesisReport } from "../src/research/post-synthesis-audit";

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
    jobType: "ticker",
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
});
