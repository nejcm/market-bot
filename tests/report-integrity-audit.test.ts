import { describe, expect, test } from "bun:test";
import type { EvidenceQualityAssessment } from "../src/domain/types";
import { auditReportIntegrity, worseQuality } from "../src/research/report-integrity-audit";
import { prediction, researchReport } from "./support/fixtures";

const CITED = ["market-yahoo-equity-aapl"];
const HISTORY_ONLY = ["history-report-run-0"];
const AMD_DATED_SUMMARY =
  "AMD's operating evidence supports a high-growth Data Center and AI infrastructure thesis, with substantial revenue, profit, and cash-flow expansion through 2026-06-27.";
const UNCITED_NUMERIC_SUMMARY = {
  code: "uncited-numeric-summary-sentence",
  location: "summary[0]",
} as const;

function citedFinding(text: string) {
  return { text, sourceIds: CITED };
}

function uncitedFinding(text: string) {
  return { text, sourceIds: [] };
}

function qualitativeThrough(token: string): string {
  return `Operating evidence remains qualitative through ${token}.`;
}

function amdSentenceWith(suffix: string): string {
  return `${AMD_DATED_SUMMARY.slice(0, -1)}${suffix}`;
}

function auditSummary(summary: string) {
  return auditReportIntegrity(researchReport({ summary }));
}

function auditUncitedFinding(text: string) {
  return auditReportIntegrity(
    researchReport({
      keyFindings: [uncitedFinding(text)],
      risks: [citedFinding("Cited risk.")],
    }),
  );
}

function auditUncitedScenario(text: string) {
  return auditReportIntegrity(
    researchReport({
      keyFindings: [citedFinding("Cited finding.")],
      risks: [citedFinding("Cited risk.")],
      scenarios: [{ name: "Base", description: text, sourceIds: [] }],
    }),
  );
}

function auditUncitedPrediction(text: string) {
  return auditReportIntegrity(
    researchReport({
      keyFindings: [citedFinding("Cited finding.")],
      risks: [citedFinding("Cited risk.")],
      scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: CITED }],
      predictions: [prediction({ claim: text, sourceIds: [] })],
    }),
  );
}

function numericSummaryAdvisories(summary: string) {
  return auditSummary(summary).advisories.filter(
    (advisory) => advisory.code === "uncited-numeric-summary-sentence",
  );
}

function summaryClassifiesAsNumeric(summary: string): boolean {
  return numericSummaryAdvisories(summary).length > 0;
}

function evidenceAssessment(label: EvidenceQualityAssessment["label"]): EvidenceQualityAssessment {
  return {
    version: 1,
    rubricVersion: 1,
    label,
    checks: [
      {
        capability: "news",
        evidenceClass: "material",
        coverage: "fail",
        freshness: "not-applicable",
        corroboration: "not-applicable",
        passed: false,
        reasons: [],
      },
    ],
    limitingReasons: [],
    advisoryReasons: [],
  };
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

  test("unsupported numeric scenario names are pruned despite qualitative descriptions", () => {
    const report = researchReport({
      keyFindings: [citedFinding("Cited claim: volume rose 40%.")],
      risks: [citedFinding("Cited risk.")],
      scenarios: [
        { name: "20% downside", description: "Guidance disappoints.", sourceIds: [] },
        { name: "20% downside", description: "Guidance disappoints.", sourceIds: CITED },
        { name: "Base", description: "Conditions remain mixed.", sourceIds: [] },
      ],
    });

    const result = auditReportIntegrity(report);

    expect(result.pruned.map((item) => item.location)).toEqual(["scenarios[0]"]);
    expect(result.report.scenarios.map((scenario) => scenario.name)).toEqual([
      "20% downside",
      "Base",
    ]);
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

  test("accepts a current-source self-declaring posture", () => {
    const result = auditReportIntegrity(
      researchReport({ keyFindings: [citedFinding("Utilization remains unverified.")] }),
    );

    expect(result.advisories).not.toContainEqual({
      code: "weak-evidence-posture-missing",
      location: "keyFindings[0]",
    });
  });

  test.each([
    ["bare weak term", citedFinding("Assume utilization improves.")],
    [
      "history-only unverified",
      { text: "Utilization remains unverified.", sourceIds: ["history-report-prior"] },
    ],
    ["explicit gap", citedFinding("A data gap leaves utilization unverified.")],
  ] as const)("advises for a %s claim", (_case, finding) => {
    const result = auditReportIntegrity(researchReport({ keyFindings: [finding] }));

    expect(result.advisories).toContainEqual({
      code: "weak-evidence-posture-missing",
      location: "keyFindings[0]",
    });
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

  test("stamps research quality driver when evidence quality binds", () => {
    const result = auditReportIntegrity(
      researchReport({
        confidence: "medium",
        keyFindings: [citedFinding("Cited claim at 10%.")],
      }),
      evidenceAssessment("medium"),
    );

    expect(result.reportIntegrity).toBe("high");
    expect(result.researchQuality).toBe("medium");
    expect(result.report.researchQualityDriver).toBe(
      "news evidence missing; remediation: configure news providers or rerun with fresh news coverage",
    );
  });

  test("worseQuality orders low < medium < high", () => {
    expect(worseQuality("high", "medium")).toBe("medium");
    expect(worseQuality("medium", "low")).toBe("low");
    expect(worseQuality("high", "high")).toBe("high");
    expect(worseQuality("low", "high")).toBe("low");
  });

  describe("ISO calendar dates", () => {
    const validStandaloneIsoDateCases = [
      ["AMD deep-equity dated summary", AMD_DATED_SUMMARY],
      ["real leap day 2024-02-29", qualitativeThrough("2024-02-29")],
      ["century leap day 2000-02-29", qualitativeThrough("2000-02-29")],
      ["multiple standalone dates", qualitativeThrough("2024-02-29 and 2026-06-27")],
      ["parenthesized date", qualitativeThrough("(2026-06-27)")],
      [
        "comma after date",
        "Operating evidence remains qualitative through 2026-06-27, per filings.",
      ],
      ["quoted date", 'Operating evidence remains qualitative through "2026-06-27".'],
      [
        "semicolon after date",
        "Operating evidence remains qualitative through 2026-06-27; filings stay qualitative.",
      ],
      ["sentence-initial date", "2026-06-27 marks the latest filing."],
      ["date at end without period", "Operating evidence remains qualitative through 2026-06-27"],
      ["date after newline", "Operating evidence remains qualitative\n2026-06-27."],
      ["fiscal year through date", "Fiscal 2025 through 2026-06-27"],
    ] as const;

    test.each([
      ["AMD deep-equity dated summary", AMD_DATED_SUMMARY, false],
      ["dated sentence plus $10 billion", amdSentenceWith(", including $10 billion."), true],
      ["dated sentence plus 12%", amdSentenceWith(", including 12%."), true],
      ["dated sentence plus 2.5x", amdSentenceWith(", including 2.5x."), true],
      ["dated sentence plus RSI", amdSentenceWith(", with RSI still elevated."), true],
      ["invalid leap day 2025-02-29", qualitativeThrough("2025-02-29"), true],
      ["invalid day 2026-02-30", qualitativeThrough("2026-02-30"), true],
      ["invalid month 2026-13-27", qualitativeThrough("2026-13-27"), true],
      ["non-leap century Feb 29", qualitativeThrough("1900-02-29"), true],
      ["April 31", qualitativeThrough("2026-04-31"), true],
      ["partial year-month 2026-06", qualitativeThrough("2026-06"), true],
      ["partial month-day 06-27", qualitativeThrough("06-27"), true],
      ["unpadded 2026-6-27", qualitativeThrough("2026-6-27"), true],
      ["two-digit year 26-06-27", qualitativeThrough("26-06-27"), true],
      ["numeric range 10-20", qualitativeThrough("10-20"), true],
      ["three-part range 10-20-30", qualitativeThrough("10-20-30"), true],
      ["currency-attached $2026-06-27", qualitativeThrough("$2026-06-27"), true],
      ["percent-attached 2026-06-27%", qualitativeThrough("2026-06-27%"), true],
      ["multiple-attached 2026-06-27x", qualitativeThrough("2026-06-27x"), true],
      ["euro-attached €2026-06-27", qualitativeThrough("€2026-06-27"), true],
      ["pound-attached £2026-06-27", qualitativeThrough("£2026-06-27"), true],
      ["spaced euro prefix € 2026-06-27", qualitativeThrough("€ 2026-06-27"), true],
      ["spaced percent 2026-06-27 %", qualitativeThrough("2026-06-27 %"), true],
      ["spaced multiple 2026-06-27 x", qualitativeThrough("2026-06-27 x"), true],
      ["unicode multiple 2026-06-27×", qualitativeThrough("2026-06-27×"), true],
      ["permille-attached 2026-06-27‰", qualitativeThrough("2026-06-27‰"), true],
      ["per-ten-thousand 2026-06-27‱", qualitativeThrough("2026-06-27‱"), true],
      ["vector-product 2026-06-27⨯", qualitativeThrough("2026-06-27⨯"), true],
      ["spaced vector-product 2026-06-27 ⨯", qualitativeThrough("2026-06-27 ⨯"), true],
      ["dollar-paren $(2026-06-27)", qualitativeThrough("$(2026-06-27)"), true],
      ["US-dollar-paren US$(2026-06-27)", qualitativeThrough("US$(2026-06-27)"), true],
      ["euro-minus €-2026-06-27", qualitativeThrough("€-2026-06-27"), true],
      ["trailing dollar 2026-06-27$", qualitativeThrough("2026-06-27$"), true],
      ["trailing euro 2026-06-27€", qualitativeThrough("2026-06-27€"), true],
      ["star-multiple 2026-06-27*", qualitativeThrough("2026-06-27*"), true],
      ["spaced uppercase X 2026-06-27 X", qualitativeThrough("2026-06-27 X"), true],
      ["tab-separated euro prefix", qualitativeThrough("€\t2026-06-27"), true],
      ["newline-separated dollar prefix", qualitativeThrough("$\n2026-06-27"), true],
      ["fractional remainder 2026-06-27.5", qualitativeThrough("2026-06-27.5"), true],
      ["euro quantity sentence", "Assumption: net proceeds €2026-06-27 million.", true],
      ["spaced percent sentence", "Assumption: margin bridge 2026-06-27 %.", true],
      ["unicode multiple sentence", "Assumption: earnings multiple bridge 2026-06-27×.", true],
      ["leading extra digit 12026-06-27", qualitativeThrough("12026-06-27"), true],
      ["trailing extra digit 2026-06-270", qualitativeThrough("2026-06-270"), true],
      ["dot-prefixed 0.2026-06-27", qualitativeThrough("0.2026-06-27"), true],
      ["iso timestamp", qualitativeThrough("2026-06-27T00:00:00Z"), true],
      ["month-name date", "Operating evidence remains qualitative through June 27, 2026.", true],
    ] as const)("summary numeric detection for %s", (_name, summary, expectBlocking) => {
      const result = auditSummary(summary);

      expect(result.report.summary).toBe(summary);
      expect(result.prunedItemCount).toBe(0);
      expect(result.advisoryWarningCount).toBe(result.advisories.length);
      if (expectBlocking) {
        expect(result.advisories).toContainEqual(UNCITED_NUMERIC_SUMMARY);
        expect(auditUncitedFinding(summary).pruned.map((item) => item.location)).toContain(
          "keyFindings[0]",
        );
        expect(auditUncitedScenario(summary).pruned.map((item) => item.location)).toContain(
          "scenarios[0]",
        );
        expect(auditUncitedPrediction(summary).pruned.map((item) => item.location)).toContain(
          "predictions[0]",
        );
      } else {
        expect(result.advisories).not.toContainEqual(UNCITED_NUMERIC_SUMMARY);
      }
    });

    test.each(validStandaloneIsoDateCases)(
      "emits no numeric summary advisory for a valid standalone ISO date: %s",
      (_name, summary) => {
        expect(numericSummaryAdvisories(summary)).toEqual([]);
      },
    );

    test.each(validStandaloneIsoDateCases)(
      "classifies date-only findings, scenarios, and Predictions with the shared helper: %s",
      (_name, text) => {
        const summaryIsNumeric = summaryClassifiesAsNumeric(text);

        expect(
          auditUncitedFinding(text).pruned.some((item) => item.location === "keyFindings[0]"),
        ).toBe(summaryIsNumeric);
        expect(
          auditUncitedScenario(text).pruned.some((item) => item.location === "scenarios[0]"),
        ).toBe(summaryIsNumeric);
        expect(
          auditUncitedPrediction(text).pruned.some((item) => item.location === "predictions[0]"),
        ).toBe(summaryIsNumeric);
      },
    );

    test.each([
      [
        "uncited numeric finding",
        (text: string) => ({ keyFindings: [uncitedFinding(text)] }),
        "keyFindings[0]",
      ],
      [
        "uncited numeric bull-case finding",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          bullCase: [uncitedFinding(text)],
        }),
        "bullCase[0]",
      ],
      [
        "uncited numeric bear-case finding",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          bearCase: [uncitedFinding(text)],
        }),
        "bearCase[0]",
      ],
      [
        "uncited numeric risk",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          risks: [uncitedFinding(text)],
        }),
        "risks[0]",
      ],
      [
        "uncited numeric catalyst",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          catalysts: [uncitedFinding(text)],
        }),
        "catalysts[0]",
      ],
      [
        "uncited numeric scenario",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          scenarios: [{ name: "Base", description: text, sourceIds: [] }],
        }),
        "scenarios[0]",
      ],
      [
        "uncited numeric scenario name",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          scenarios: [{ name: text, description: "Conditions remain mixed.", sourceIds: [] }],
        }),
        "scenarios[0]",
      ],
      [
        "uncited numeric Prediction",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: CITED }],
          predictions: [prediction({ claim: text, sourceIds: [] })],
        }),
        "predictions[0]",
      ],
      [
        "history-only numeric Prediction",
        (text: string) => ({
          keyFindings: [citedFinding("Cited finding.")],
          scenarios: [{ name: "Base", description: "Conditions remain mixed.", sourceIds: CITED }],
          predictions: [prediction({ claim: text, sourceIds: HISTORY_ONLY })],
        }),
        "predictions[0]",
      ],
    ] as const)(
      "still prunes an unsupported %s that also contains a valid date",
      (_name, makeSection, location) => {
        const text = amdSentenceWith(", including $10 billion.");
        const result = auditReportIntegrity(
          researchReport({
            risks: [citedFinding("Cited risk.")],
            ...makeSection(text),
          }),
        );

        expect(result.pruned.map((item) => item.location)).toContain(location);
        expect(result.pruned.find((item) => item.location === location)?.text).toContain(text);
      },
    );

    test("keeps cited numeric findings, scenarios, and Predictions that also contain a valid date", () => {
      const text = amdSentenceWith(", including $10 billion.");
      const result = auditReportIntegrity(
        researchReport({
          keyFindings: [citedFinding(text)],
          risks: [citedFinding("Cited risk.")],
          scenarios: [{ name: "Base", description: text, sourceIds: CITED }],
          predictions: [prediction({ claim: text, sourceIds: CITED })],
        }),
      );

      expect(result.prunedItemCount).toBe(0);
      expect(result.report.keyFindings[0]?.text).toBe(text);
      expect(result.report.keyFindings[0]?.sourceIds).toEqual(CITED);
      expect(result.report.scenarios[0]?.description).toBe(text);
      expect(result.report.scenarios[0]?.sourceIds).toEqual(CITED);
      expect(result.report.predictions[0]?.claim).toBe(text);
      expect(result.report.predictions[0]?.sourceIds).toEqual(CITED);
    });

    test.each([
      ["bare year", "Guidance for fiscal 2026 remains qualitative."],
      ["forecast-horizon", "The catalyst window spans a 5-trading-day horizon."],
      ["calendar-day horizon", "Momentum thesis plays out over 10 days."],
    ] as const)("still exempts uncited %s wording", (_name, text) => {
      const result = auditUncitedFinding(text);

      expect(result.prunedItemCount).toBe(0);
      expect(result.report.keyFindings).toHaveLength(1);
      expect(result.report.keyFindings[0]?.text).toBe(text);
    });

    test("still exempts a cited historical forecast outcome that includes a date and a price", () => {
      const text = "Prior 5 trading day forecast resolved as a miss at $210 through 2026-06-27.";
      const result = auditReportIntegrity(
        researchReport({
          keyFindings: [{ text, sourceIds: HISTORY_ONLY }],
          risks: [citedFinding("Cited risk.")],
        }),
      );

      expect(result.prunedItemCount).toBe(0);
      expect(result.report.keyFindings[0]?.text).toBe(text);
      expect(result.report.keyFindings[0]?.sourceIds).toEqual(HISTORY_ONLY);
    });

    test("does not rewrite report prose or source IDs while classifying dates", () => {
      const findingText = amdSentenceWith(", including $10 billion.");
      const finding = citedFinding(findingText);
      const scenario = { name: "Base", description: findingText, sourceIds: CITED };
      const datedPrediction = prediction({ claim: findingText, sourceIds: CITED });
      const report = researchReport({
        summary: AMD_DATED_SUMMARY,
        keyFindings: [finding],
        risks: [citedFinding("Cited risk.")],
        scenarios: [scenario],
        predictions: [datedPrediction],
      });

      const result = auditReportIntegrity(report);

      expect(report.summary).toBe(AMD_DATED_SUMMARY);
      expect(result.report.summary).toBe(AMD_DATED_SUMMARY);
      expect(result.report.keyFindings[0]?.text).toBe(findingText);
      expect(result.report.keyFindings[0]?.sourceIds).toEqual(CITED);
      expect(report.keyFindings[0]?.sourceIds).toEqual(CITED);
      expect(result.report.scenarios[0]?.description).toBe(findingText);
      expect(result.report.scenarios[0]?.sourceIds).toEqual(CITED);
      expect(result.report.predictions[0]?.claim).toBe(findingText);
      expect(result.report.predictions[0]?.sourceIds).toEqual(CITED);
      expect(result.prunedItemCount).toBe(0);
    });
  });
});
