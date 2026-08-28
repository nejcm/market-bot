import { describe, expect, test } from "bun:test";
import type { WebGatherLoopAudit } from "../src/domain/types";
import {
  buildSubsystemOutcomes,
  isSubsystemOutcome,
  rollupSubsystemOutcomes,
  type SubsystemExpectation,
  type SubsystemOutcomeStatus,
} from "../src/research/subsystem-outcomes";
import type { EvidenceLanesArtifact, SourcePlanArtifact } from "../src/research/source-plan";
import type { SpotlightSelectionRejectionReason } from "../src/research/spotlights";

const generatedAt = "2026-08-28T00:00:00.000Z";
const spotlightRejectionReason: SpotlightSelectionRejectionReason = "unknown-symbol";

const sourcePlan: SourcePlanArtifact = {
  version: 2,
  generatedAt,
  run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
  lanes: [
    {
      lane: "news",
      evidenceClass: "material",
      appliesToRun: true,
      capability: "news",
    },
    {
      lane: "subject-profile",
      evidenceClass: "supplemental",
      appliesToRun: true,
      capability: "subject-profile",
    },
  ],
};

const evidenceLanes: EvidenceLanesArtifact = {
  version: 2,
  generatedAt,
  lanes: [
    {
      lane: "news",
      evidenceClass: "material",
      status: "covered",
      coveredSourceIds: ["news-1"],
      gapIds: [],
      gapText: [],
      freshnessNotes: [],
    },
    {
      lane: "subject-profile",
      evidenceClass: "supplemental",
      status: "gap",
      coveredSourceIds: [],
      gapIds: ["gap-subject-profile-0"],
      gapText: ["profile extraction produced no profile"],
      freshnessNotes: [],
    },
  ],
  summary: {
    plannedLaneCount: 2,
    coveredLaneCount: 1,
    gapLaneCount: 1,
    sourceCount: 1,
    gapCount: 1,
    coverageRatio: 0.5,
  },
};

const webGatherAudit: WebGatherLoopAudit = {
  rounds: 1,
  acceptedRequests: [{ round: 1, tool: "web_search", status: "accepted" }],
  rejectedRequests: [],
  sourceUnitsUsed: 1,
  executedTools: ["web_search"],
  emittedGaps: [],
  sanitizer: {
    sourceCount: 1,
    sanitizedSourceCount: 1,
    emptyAfterSanitizeCount: 0,
    inputCharCount: 100,
    outputCharCount: 90,
    removedInstructionSpanCount: 0,
    removedChromeHtmlCount: 0,
  },
};

const baseWebGatherInput = {
  sourcePlan,
  evidenceLanes,
  sourceGaps: [],
  webSubjectProfilePresent: false,
  webSubjectProfileReused: false,
  playbookAudit: { selected: [], rejected: [] },
  predictionCompletionSkipCode: "target-met",
  reportIntegrityAudit: {
    reportIntegrity: "high",
    researchQuality: "high",
    prunedItemCount: 0,
    advisoryWarningCount: 0,
    pruned: [],
  },
  forecastDisagreementCode: "not-configured",
} satisfies Parameters<typeof buildSubsystemOutcomes>[0];

describe("Subsystem Outcomes", () => {
  test("marks an attempted Web Gather with no accepted requests expected and empty", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      webGatherAudit: {
        ...webGatherAudit,
        acceptedRequests: [],
        sourceUnitsUsed: 0,
        executedTools: [],
      },
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-gather",
        expectation: "expected",
        outcome: "empty",
        code: "no-accepted-requests",
      }),
    );
  });

  test.each([
    { skipCode: "run-not-applicable" as const, expectation: "not-applicable" },
    { skipCode: "missing-exa-credential" as const, expectation: "optional" },
  ])("maps $skipCode to $expectation from persisted gates", ({ skipCode, expectation }) => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      webGatherSkipCode: skipCode,
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-gather",
        expectation,
        outcome: "declined",
        code: skipCode,
      }),
    );
  });

  test("derives coded outcomes and a text-free rollup from persisted audits", () => {
    const outcomes = buildSubsystemOutcomes({
      sourcePlan,
      evidenceLanes,
      sourceGaps: [],
      webSubjectProfilePresent: true,
      webSubjectProfileReused: true,
      webGatherAudit,
      spotlightSelection: {
        selected: [],
        rejected: [{ reason: spotlightRejectionReason, message: "Unknown symbol" }],
        audit: {
          cap: 3,
          candidateCount: 1,
          selectedCount: 0,
          rejectedCount: 1,
          malformed: false,
        },
      },
      playbookAudit: {
        selected: [{ stage: "final-synthesis", playbookIds: ["synthesis-discipline"] }],
        rationale: "The synthesis playbook best fits this run.",
        rejected: [],
      },
      predictionCompletion: {
        attempted: true,
        initialCount: 1,
        targetCount: 2,
        acceptedPredictionIds: [],
        rejectedCandidateCount: 0,
        rejectionReasons: [],
        outcome: "declined-empty",
      },
      reportIntegrityAudit: {
        reportIntegrity: "high",
        researchQuality: "high",
        prunedItemCount: 0,
        advisoryWarningCount: 0,
        pruned: [],
      },
      forecastDisagreementCode: "not-configured",
    });

    const expected: SubsystemExpectation = "expected";
    const empty: SubsystemOutcomeStatus = "empty";
    expect(outcomes.every((outcome) => isSubsystemOutcome(outcome))).toBe(true);
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-gather",
        expectation: expected,
        outcome: "produced",
        code: "accepted-requests",
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-subject-profile",
        expectation: "optional",
        outcome: "blocked",
        code: "reused-profile",
      }),
    );
    expect(outcomes.find((item) => item.subsystem === "domain-playbook-selection")?.detail).toBe(
      undefined,
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "prediction-completion",
        expectation: expected,
        outcome: empty,
        code: "declined-empty",
      }),
    );
    expect(rollupSubsystemOutcomes(outcomes)).toMatchObject({
      count: outcomes.length,
      expectedEmptyCount: 1,
      byCode: { "declined-empty": 1, "reused-profile": 1 },
    });
  });

  test("marks SEC-dependent deep-equity work blocked", () => {
    const outcomes = buildSubsystemOutcomes({
      sourcePlan: {
        ...sourcePlan,
        lanes: [
          {
            lane: "target-valuation",
            evidenceClass: "material",
            appliesToRun: true,
            capability: "target-valuation",
          },
          {
            lane: "peer-valuation",
            evidenceClass: "supplemental",
            appliesToRun: true,
            capability: "peer-valuation",
          },
        ],
      },
      evidenceLanes: {
        ...evidenceLanes,
        lanes: [
          {
            lane: "target-valuation",
            evidenceClass: "material",
            status: "gap",
            coveredSourceIds: [],
            gapIds: ["gap-target-valuation-0"],
            gapText: ["target valuation unavailable"],
            freshnessNotes: [],
          },
          {
            lane: "peer-valuation",
            evidenceClass: "supplemental",
            status: "gap",
            coveredSourceIds: [],
            gapIds: ["gap-peer-valuation-0"],
            gapText: ["peer valuation unavailable"],
            freshnessNotes: [],
          },
        ],
      },
      sourceGaps: [
        {
          source: "sec-target-packet:valuation",
          message: "valuation suppressed: target SEC packet is unavailable",
          capability: "extended-evidence",
          cause: "provider-data-missing",
        },
      ],
      webSubjectProfilePresent: false,
      webSubjectProfileReused: false,
      webGatherSkipCode: "missing-exa-credential",
      playbookAudit: { selected: [], rejected: [] },
      predictionCompletionSkipCode: "target-met",
      reportIntegrityAudit: {
        reportIntegrity: "high",
        researchQuality: "high",
        prunedItemCount: 0,
        advisoryWarningCount: 0,
        pruned: [],
      },
      forecastDisagreementCode: "not-configured",
    });

    expect(
      outcomes
        .filter((item) => item.code === "sec-base-packet-unavailable")
        .map((item) => item.subsystem),
    ).toEqual([
      "evidence-lane:target-valuation",
      "evidence-lane:peer-valuation",
      "deep-equity:valuation",
    ]);
  });
});
