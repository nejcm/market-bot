import { describe, expect, test } from "bun:test";
import { SOURCE_GAP_CAUSE_TABLE } from "../src/domain/source-gaps";
import type { SourceGapCause, WebGatherLoopAudit } from "../src/domain/types";
import {
  assertSubsystemOutcomeCode,
  buildSubsystemOutcomes,
  isSubsystemOutcome,
  rollupSubsystemOutcomes,
  type SubsystemExpectation,
  type SubsystemOutcomeCode,
  type SubsystemOutcomeStatus,
  type WrittenSubsystemOutcome,
} from "../src/research/subsystem-outcomes";
import { runSubsystemOutcomesFromSidecar } from "../src/run-artifact-projection";
import type { EvidenceLanesArtifactV2, SourcePlanArtifact } from "../src/research/source-plan";
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

const evidenceLanes: EvidenceLanesArtifactV2 = {
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
    coreLaneCount: 0,
    materialLaneCount: 1,
    supplementalLaneCount: 1,
    coveredLaneCount: 1,
    gapLaneCount: 1,
    coreGapLaneCount: 0,
    materialGapLaneCount: 1,
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

function newsLaneOutcome(gapCauses: readonly SourceGapCause[]): WrittenSubsystemOutcome {
  const outcomes = buildSubsystemOutcomes({
    ...baseWebGatherInput,
    sourcePlan: {
      ...sourcePlan,
      lanes: [
        {
          lane: "news",
          evidenceClass: "material",
          appliesToRun: true,
          capability: "news",
        },
      ],
    },
    evidenceLanes: {
      ...evidenceLanes,
      lanes: [
        {
          lane: "news",
          evidenceClass: "material",
          status: "gap",
          coveredSourceIds: [],
          gapIds: gapCauses.map((_, index) => `gap-news-${String(index)}`),
          gapText: [...gapCauses],
          ...(gapCauses.length > 0 ? { gapCauses } : {}),
          freshnessNotes: [],
        },
      ],
    },
  });
  const lane = outcomes.find((item) => item.subsystem === "evidence-lane:news");
  if (lane === undefined) {
    throw new Error("expected evidence-lane:news outcome");
  }
  return lane;
}

describe("Subsystem Outcomes", () => {
  test("rejects a non-union code at write time", () => {
    const written: SubsystemOutcomeCode = "covered";
    expect(() => assertSubsystemOutcomeCode(written)).not.toThrow();
    const illegal = "legacy Odd_code";
    expect(() => assertSubsystemOutcomeCode(illegal)).toThrow(
      `Unsupported subsystem outcome code: ${JSON.stringify(illegal)}`,
    );
    const withNewline = "not a kebab\ncode";
    expect(() => assertSubsystemOutcomeCode(withNewline)).toThrow(
      `Unsupported subsystem outcome code: ${JSON.stringify(withNewline)}`,
    );
  });

  test("reads a historically odd-but-string code", () => {
    const historical = {
      subsystem: "web-gather",
      expectation: "expected",
      outcome: "empty",
      code: "legacy Odd_code",
    };
    expect(isSubsystemOutcome(historical)).toBe(true);
    const ledger = runSubsystemOutcomesFromSidecar("run-1", {
      status: "ok",
      value: [historical],
    });
    expect(ledger.status).toBe("ok");
    expect(ledger.outcomes[0]?.code).toBe("legacy Odd_code");
  });

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

  test("maps exhausted Web Gather parse retries to failed", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      webGatherAudit: {
        ...webGatherAudit,
        acceptedRequests: [],
        sourceUnitsUsed: 0,
        executedTools: [],
        failureCode: "parse-retries-exhausted",
      },
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-gather",
        expectation: "expected",
        outcome: "failed",
        code: "parse-retries-exhausted",
        count: 0,
      }),
    );
  });

  test("keeps mixed Web Gather parse exhaustion as produced with exhaustion on detail", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      webGatherAudit: {
        ...webGatherAudit,
        failureCode: "parse-retries-exhausted",
      },
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-gather",
        expectation: "expected",
        outcome: "produced",
        code: "accepted-requests",
        count: 1,
        detail: { failureCode: "parse-retries-exhausted" },
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

  test("records in-window profile reuse as produced with reuse detail", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      webSubjectProfilePresent: true,
      webSubjectProfileReuse: {
        runDirName: "prior-aapl",
        generatedAt: "2026-05-01T00:00:00.000Z",
        ageDays: 2.2,
      },
    });

    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "web-subject-profile",
        expectation: "optional",
        outcome: "produced",
        code: "reused-profile",
        count: 1,
        detail: { ageDays: 2.2, sourceRunDirName: "prior-aapl" },
      }),
    );
  });

  test("derives coded outcomes and a text-free rollup from persisted audits", () => {
    const outcomes = buildSubsystemOutcomes({
      sourcePlan,
      evidenceLanes,
      sourceGaps: [],
      webSubjectProfilePresent: true,
      webSubjectProfileReuse: {
        runDirName: "prior-aapl",
        generatedAt: "2026-05-01T00:00:00.000Z",
        ageDays: 2.2,
      },
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
    const written: readonly WrittenSubsystemOutcome[] = outcomes;
    expect(written.every((outcome) => isSubsystemOutcome(outcome))).toBe(true);
    expect(() => {
      for (const outcome of outcomes) {
        assertSubsystemOutcomeCode(outcome.code);
      }
    }).not.toThrow();
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
        outcome: "produced",
        code: "reused-profile",
        count: 1,
        detail: { ageDays: 2.2, sourceRunDirName: "prior-aapl" },
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

  test("maps missing-credential to blocked", () => {
    expect(newsLaneOutcome(["missing-credential"])).toMatchObject({
      outcome: "blocked",
      code: "missing-credential",
    });
  });

  test("maps fetch-failed to failed", () => {
    expect(newsLaneOutcome(["fetch-failed"])).toMatchObject({
      outcome: "failed",
      code: "fetch-failed",
    });
  });

  test("maps provider-data-missing to empty", () => {
    expect(newsLaneOutcome(["provider-data-missing"])).toMatchObject({
      outcome: "empty",
      code: "provider-data-missing",
    });
  });

  test("maps unsupported-coverage to declined", () => {
    expect(newsLaneOutcome(["unsupported-coverage"])).toMatchObject({
      outcome: "declined",
      code: "unsupported-coverage",
    });
  });

  test("picks failed over blocked when a lane has both causes", () => {
    expect(newsLaneOutcome(["missing-credential", "fetch-failed"])).toMatchObject({
      outcome: "failed",
      code: "fetch-failed",
    });
  });

  test("keeps coverage-gap when an uncovered lane has no causes", () => {
    expect(newsLaneOutcome([])).toMatchObject({
      outcome: "empty",
      code: "coverage-gap",
    });
  });

  test("keeps audit-missing when the lane is absent from the audit", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      sourcePlan: {
        ...sourcePlan,
        lanes: [
          {
            lane: "news",
            evidenceClass: "material",
            appliesToRun: true,
            capability: "news",
          },
        ],
      },
      evidenceLanes: { ...evidenceLanes, lanes: [] },
    });
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "evidence-lane:news",
        outcome: "empty",
        code: "audit-missing",
      }),
    );
  });

  test("records a covered but unsupportable lane as produced with not-supportable", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      sourcePlan: {
        ...sourcePlan,
        lanes: [
          {
            lane: "target-valuation",
            evidenceClass: "material",
            appliesToRun: true,
            capability: "target-valuation",
          },
        ],
      },
      evidenceLanes: {
        ...evidenceLanes,
        lanes: [
          {
            lane: "target-valuation",
            evidenceClass: "material",
            status: "covered",
            coveredSourceIds: ["valuation-1"],
            gapIds: [],
            gapText: [],
            freshnessNotes: [],
            supportable: false,
          },
        ],
      },
    });
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "evidence-lane:target-valuation",
        outcome: "produced",
        code: "not-supportable",
        count: 1,
        detail: { supportable: false },
      }),
    );
  });

  test("keeps SEC-blocked ahead of a lane-local cause", () => {
    const outcomes = buildSubsystemOutcomes({
      ...baseWebGatherInput,
      sourcePlan: {
        ...sourcePlan,
        lanes: [
          {
            lane: "target-valuation",
            evidenceClass: "material",
            appliesToRun: true,
            capability: "target-valuation",
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
            gapCauses: ["fetch-failed"],
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
    });
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        subsystem: "evidence-lane:target-valuation",
        outcome: "blocked",
        code: "sec-base-packet-unavailable",
      }),
    );
  });

  test("maps every Source Gap cause onto a subsystem outcome status", () => {
    const causes = Object.keys(SOURCE_GAP_CAUSE_TABLE) as SourceGapCause[];
    expect(causes.length).toBeGreaterThan(0);
    for (const cause of causes) {
      expect(newsLaneOutcome([cause]).code).toBe(cause);
    }
  });
});
