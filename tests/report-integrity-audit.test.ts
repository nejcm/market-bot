import { describe, expect, test } from "bun:test";
import { auditReportIntegrity, worseQuality } from "../src/research/report-integrity-audit";
import { prediction, researchReport } from "./support/fixtures";

const CITED = ["market-yahoo-equity-aapl"];

function citedFinding(text: string) {
  return { text, sourceIds: CITED };
}

function uncitedFinding(text: string) {
  return { text, sourceIds: [] };
}

describe("auditReportIntegrity", () => {
  test("clean synthesis produces high integrity with no pruning", () => {
    const report = researchReport({
      confidence: "high",
      summary: "Evidence is sourced and caveated.",
      keyFindings: [citedFinding("Revenue grew 12% year over year.")],
      risks: [citedFinding("Margin compression of 200bps is possible.")],
      scenarios: [{ name: "Base", description: "RSI stays near 60.", sourceIds: CITED }],
      predictions: [prediction({ sourceIds: CITED })],
    });

    const result = auditReportIntegrity(report);

    expect(result.reportIntegrity).toBe("high");
    expect(result.researchQuality).toBe("high");
    expect(result.prunedItemCount).toBe(0);
    expect(result.pruned).toEqual([]);
    expect(result.report.keyFindings).toHaveLength(1);
    expect(result.report.predictions).toHaveLength(1);
    expect(result.report.reportIntegrity).toBe("high");
    expect(result.report.researchQuality).toBe("high");
  });

  test("bare years and forecast-horizon wording are not pruned", () => {
    const report = researchReport({
      keyFindings: [
        uncitedFinding("Guidance for fiscal 2026 remains qualitative."),
        uncitedFinding("The catalyst window spans a 5-trading-day horizon."),
        uncitedFinding("Momentum thesis plays out over 10 days."),
      ],
      risks: [citedFinding("Narrow coverage.")],
      scenarios: [],
    });

    const result = auditReportIntegrity(report);

    expect(result.prunedItemCount).toBe(0);
    expect(result.report.keyFindings).toHaveLength(3);
    expect(result.reportIntegrity).toBe("high");
  });

  test("year-like price levels and percentages remain numeric claims", () => {
    const report = researchReport({
      keyFindings: [
        uncitedFinding("Price target of $2050 looks stretched."),
        uncitedFinding("Growth of 2026% is implausible."),
      ],
      risks: [citedFinding("Cited risk.")],
    });

    const result = auditReportIntegrity(report);

    expect(result.pruned.map((item) => item.location)).toEqual([
      "keyFindings[0]",
      "keyFindings[1]",
    ]);
  });

  test("historical forecast outcomes with numbers are not pruned", () => {
    const report = researchReport({
      keyFindings: [
        {
          text: "Prior 5 trading day forecast resolved as a miss at $210.",
          sourceIds: ["history-report-run-0"],
        },
      ],
    });

    const result = auditReportIntegrity(report);

    expect(result.prunedItemCount).toBe(0);
    expect(result.report.keyFindings).toHaveLength(1);
  });

  test("unsupported numeric findings, scenarios, and predictions are removed", () => {
    const report = researchReport({
      keyFindings: [
        citedFinding("Cited claim: volume rose 40%."),
        uncitedFinding("Uncited claim: EPS beats by $0.12."),
      ],
      bullCase: [uncitedFinding("RSI momentum favors upside.")],
      risks: [citedFinding("Cited risk.")],
      scenarios: [
        { name: "Bear", description: "Price drops 15% on guidance.", sourceIds: [] },
        { name: "Base", description: "Conditions remain mixed.", sourceIds: CITED },
      ],
      predictions: [
        prediction({ id: "pred-cited", sourceIds: CITED }),
        prediction({
          id: "pred-uncited",
          claim: "AAPL closes above $250 within 5 trading days.",
          sourceIds: ["history-report-run-9"],
        }),
      ],
    });

    const result = auditReportIntegrity(report);

    expect(result.prunedItemCount).toBe(4);
    expect(result.pruned.map((item) => item.location)).toEqual([
      "keyFindings[1]",
      "bullCase[0]",
      "scenarios[0]",
      "predictions[1]",
    ]);
    expect(result.report.keyFindings.map((finding) => finding.text)).toEqual([
      "Cited claim: volume rose 40%.",
    ]);
    expect(result.report.bullCase).toEqual([]);
    expect(result.report.scenarios.map((scenario) => scenario.name)).toEqual(["Base"]);
    expect(result.report.predictions.map((item) => item.id)).toEqual(["pred-cited"]);
    expect(result.reportIntegrity).toBe("medium");
  });

  test("summary sentences and posture warnings are advisory only and never pruned", () => {
    const summary =
      "Revenue grew 40% with no citation available here. Evidence remains mixed overall.";
    const report = researchReport({
      summary,
      keyFindings: [uncitedFinding("Qualitative uncited claim without numbers or indicators.")],
      risks: [citedFinding("Cited risk.")],
    });

    const result = auditReportIntegrity(report);

    expect(result.prunedItemCount).toBe(0);
    expect(result.report.summary).toBe(summary);
    expect(result.report.keyFindings).toHaveLength(1);
    expect(result.advisories).toContainEqual({
      code: "uncited-numeric-summary-sentence",
      location: "summary[0]",
    });
    expect(result.advisories).toContainEqual({
      code: "weak-evidence-posture-missing",
      location: "keyFindings[0]",
    });
    expect(result.advisoryWarningCount).toBe(result.advisories.length);
  });

  test("pruning that empties a required analytical section grades low", () => {
    const report = researchReport({
      keyFindings: [uncitedFinding("Only finding cites nothing but claims 30% upside.")],
      risks: [citedFinding("Cited risk.")],
      scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: CITED }],
    });

    const result = auditReportIntegrity(report);

    expect(result.report.keyFindings).toEqual([]);
    expect(result.reportIntegrity).toBe("low");
  });

  test("sections that were already empty do not force low", () => {
    const report = researchReport({
      keyFindings: [citedFinding("Cited."), uncitedFinding("Uncited 20% claim.")],
      risks: [],
      scenarios: [],
    });

    const result = auditReportIntegrity(report);

    expect(result.reportIntegrity).toBe("medium");
  });

  test("research quality is the worse of evidence quality and report integrity", () => {
    const lowEvidence = auditReportIntegrity(
      researchReport({
        confidence: "low",
        keyFindings: [citedFinding("Cited claim at 10%.")],
      }),
    );
    expect(lowEvidence.reportIntegrity).toBe("high");
    expect(lowEvidence.researchQuality).toBe("low");

    const lowIntegrity = auditReportIntegrity(
      researchReport({
        confidence: "high",
        keyFindings: [uncitedFinding("Uncited 25% claim.")],
        risks: [citedFinding("Cited risk.")],
      }),
    );
    expect(lowIntegrity.reportIntegrity).toBe("low");
    expect(lowIntegrity.researchQuality).toBe("low");
  });

  test("worseQuality orders low < medium < high", () => {
    expect(worseQuality("high", "medium")).toBe("medium");
    expect(worseQuality("medium", "low")).toBe("low");
    expect(worseQuality("high", "high")).toBe("high");
    expect(worseQuality("low", "high")).toBe("low");
  });
});
