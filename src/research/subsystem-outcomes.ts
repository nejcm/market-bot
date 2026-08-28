import type {
  PredictionCompletionAudit,
  RunTrace,
  SourceGap,
  WebGatherLoopAudit,
} from "../domain/types";
import { isRecord, readNumber, readString } from "../guards";
import type { PredictionCompletionSkipCode } from "./final-synthesis";
import type { PlaybookSelectionAudit } from "./playbooks";
import type { EvidenceLanesArtifact, SourcePlanArtifact } from "./source-plan";
import type { SpotlightSelectionResult } from "./spotlights";
import type { WebGatherSkipCode } from "../web-evidence/web-gather-types";
import { SEC_PACKET_DEPENDENCY_LANES_BY_DERIVATION } from "../sources/sec-packet-dependencies";

export type SubsystemExpectation = "expected" | "optional" | "not-applicable";
export type SubsystemOutcomeStatus = "produced" | "empty" | "declined" | "failed" | "blocked";

const SUBSYSTEM_EXPECTATION_TABLE = {
  expected: true,
  optional: true,
  "not-applicable": true,
} satisfies Record<SubsystemExpectation, true>;

const SUBSYSTEM_OUTCOME_TABLE = {
  produced: true,
  empty: true,
  declined: true,
  failed: true,
  blocked: true,
} satisfies Record<SubsystemOutcomeStatus, true>;

const SUBSYSTEM_EXPECTATIONS: ReadonlySet<string> = new Set(
  Object.keys(SUBSYSTEM_EXPECTATION_TABLE),
);
const SUBSYSTEM_OUTCOMES: ReadonlySet<string> = new Set(Object.keys(SUBSYSTEM_OUTCOME_TABLE));

export interface SubsystemOutcome {
  readonly subsystem: string;
  readonly expectation: SubsystemExpectation;
  readonly outcome: SubsystemOutcomeStatus;
  readonly code: string;
  readonly stage?: string;
  readonly count?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface SubsystemOutcomeRollup {
  readonly count: number;
  readonly expectedEmptyCount: number;
  readonly byExpectation: Readonly<Record<SubsystemExpectation, number>>;
  readonly byOutcome: Readonly<Record<SubsystemOutcomeStatus, number>>;
  readonly byCode: Readonly<Record<string, number>>;
}

export type ForecastDisagreementOutcomeCode =
  | "produced"
  | "failed"
  | "not-configured"
  | "no-predictions";

interface BuildSubsystemOutcomesInput {
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceGaps: readonly SourceGap[];
  readonly webSubjectProfilePresent: boolean;
  readonly webSubjectProfileReused: boolean;
  readonly webGatherAudit?: WebGatherLoopAudit;
  readonly webGatherSkipCode?: WebGatherSkipCode;
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly playbookAudit: PlaybookSelectionAudit;
  readonly predictionCompletion?: PredictionCompletionAudit;
  readonly predictionCompletionSkipCode?: PredictionCompletionSkipCode;
  readonly reportIntegrityAudit?: RunTrace["reportIntegrityAudit"];
  readonly forecastDisagreement?: RunTrace["forecastDisagreement"];
  readonly forecastDisagreementCode?: ForecastDisagreementOutcomeCode;
  readonly finalSynthesisRejected?: true;
}

function isSubsystemExpectation(value: unknown): value is SubsystemExpectation {
  return typeof value === "string" && SUBSYSTEM_EXPECTATIONS.has(value);
}

function isSubsystemOutcomeStatus(value: unknown): value is SubsystemOutcomeStatus {
  return typeof value === "string" && SUBSYSTEM_OUTCOMES.has(value);
}

export function isSubsystemOutcome(value: unknown): value is SubsystemOutcome {
  if (!isRecord(value)) {
    return false;
  }
  const count = readNumber(value, "count");
  return (
    readString(value, "subsystem") !== undefined &&
    isSubsystemExpectation(value.expectation) &&
    isSubsystemOutcomeStatus(value.outcome) &&
    readString(value, "code") !== undefined &&
    (value.stage === undefined || readString(value, "stage") !== undefined) &&
    (value.count === undefined || (count !== undefined && Number.isInteger(count) && count >= 0)) &&
    (value.detail === undefined || isRecord(value.detail))
  );
}

function expectationForLane(
  lane: SourcePlanArtifact["lanes"][number] | undefined,
): SubsystemExpectation {
  if (lane === undefined || !lane.appliesToRun) {
    return "not-applicable";
  }
  return lane.evidenceClass === "supplemental" || lane.requirement === "optional"
    ? "optional"
    : "expected";
}

function blockedSecDependents(sourceGaps: readonly SourceGap[]): ReadonlySet<string> {
  return new Set(
    sourceGaps.flatMap((gap) =>
      gap.source.startsWith("sec-target-packet:")
        ? [gap.source.slice("sec-target-packet:".length)]
        : [],
    ),
  );
}

function evidenceLaneOutcomes(input: BuildSubsystemOutcomesInput): readonly SubsystemOutcome[] {
  const evidenceByLane = new Map(input.evidenceLanes.lanes.map((lane) => [lane.lane, lane]));
  const secDependents = blockedSecDependents(input.sourceGaps);
  const blockedLanes: ReadonlySet<string> = new Set(
    Object.entries(SEC_PACKET_DEPENDENCY_LANES_BY_DERIVATION).flatMap(([derivation, lanes]) =>
      secDependents.has(derivation) ? lanes : [],
    ),
  );
  return input.sourcePlan.lanes.map((planLane): SubsystemOutcome => {
    const subsystem = `evidence-lane:${planLane.lane}`;
    const expectation = expectationForLane(planLane);
    if (expectation === "not-applicable") {
      return { subsystem, expectation, outcome: "declined", code: "not-applicable" };
    }
    if (blockedLanes.has(planLane.lane)) {
      return {
        subsystem,
        expectation,
        outcome: "blocked",
        code: "sec-base-packet-unavailable",
        stage: "source-collection",
        count: 0,
      };
    }
    const evidence = evidenceByLane.get(planLane.lane);
    if (evidence?.status === "covered") {
      return {
        subsystem,
        expectation,
        outcome: "produced",
        code: "covered",
        stage: "source-collection",
        count: evidence.coveredSourceIds.length,
      };
    }
    return {
      subsystem,
      expectation,
      outcome: "empty",
      code: evidence === undefined ? "audit-missing" : "coverage-gap",
      stage: "source-collection",
      count: evidence?.gapIds.length ?? 0,
    };
  });
}

function webGatherOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  const subjectProfileLane = input.sourcePlan.lanes.find((lane) => lane.lane === "subject-profile");
  if (input.webGatherSkipCode !== undefined) {
    return {
      subsystem: "web-gather",
      expectation:
        input.webGatherSkipCode === "run-not-applicable"
          ? "not-applicable"
          : expectationForLane(subjectProfileLane),
      outcome: "declined",
      code: input.webGatherSkipCode,
      stage: "web-gather",
      count: 0,
    };
  }
  const acceptedCount = input.webGatherAudit?.acceptedRequests.length ?? 0;
  const failureCode = input.webGatherAudit?.failureCode;
  if (failureCode !== undefined) {
    return {
      subsystem: "web-gather",
      expectation: "expected",
      outcome: "failed",
      code: failureCode,
      stage: "web-gather",
      count: acceptedCount,
    };
  }
  return {
    subsystem: "web-gather",
    expectation: "expected",
    outcome: acceptedCount > 0 ? "produced" : "empty",
    code: acceptedCount > 0 ? "accepted-requests" : "no-accepted-requests",
    stage: "web-gather",
    count: acceptedCount,
  };
}

function webSubjectProfileOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  const expectation = expectationForLane(
    input.sourcePlan.lanes.find((lane) => lane.lane === "subject-profile"),
  );
  if (expectation === "not-applicable") {
    return {
      subsystem: "web-subject-profile",
      expectation,
      outcome: "declined",
      code: "not-applicable",
    };
  }
  if (input.webSubjectProfileReused) {
    return {
      subsystem: "web-subject-profile",
      expectation,
      outcome: "blocked",
      code: "reused-profile",
      stage: "web-subject-profile",
      count: 1,
    };
  }
  return {
    subsystem: "web-subject-profile",
    expectation,
    outcome: input.webSubjectProfilePresent ? "produced" : "empty",
    code: input.webSubjectProfilePresent ? "profile-produced" : "profile-empty",
    stage: "web-subject-profile",
    count: input.webSubjectProfilePresent ? 1 : 0,
  };
}

function spotlightOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  const selection = input.spotlightSelection;
  if (selection === undefined) {
    return {
      subsystem: "market-spotlight-selection",
      expectation: "not-applicable",
      outcome: "declined",
      code: "not-applicable",
    };
  }
  const rejectionCodes = selection.rejected.map((item) => item.reason);
  const [firstRejection] = rejectionCodes;
  let outcome: SubsystemOutcomeStatus = "empty";
  let code: string = firstRejection ?? "no-spotlights-selected";
  if (selection.audit.malformed) {
    outcome = "failed";
    code = firstRejection ?? "malformed-selection";
  } else if (selection.selected.length > 0) {
    outcome = "produced";
    code = "spotlights-selected";
  }
  return {
    subsystem: "market-spotlight-selection",
    expectation: "optional",
    outcome,
    code,
    stage: "spotlight-selection",
    count: selection.selected.length,
    ...(rejectionCodes.length > 0 ? { detail: { rejectionCodes } } : {}),
  };
}

function playbookOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  const selectedCount = input.playbookAudit.selected.reduce(
    (count, selection) => count + selection.playbookIds.length,
    0,
  );
  let outcome: SubsystemOutcomeStatus = "empty";
  let code = "no-playbooks-selected";
  if (selectedCount > 0) {
    outcome = "produced";
    code = "playbooks-selected";
  } else if (input.playbookAudit.rejected.length > 0) {
    outcome = "declined";
    code = "selection-rejected";
  }
  return {
    subsystem: "domain-playbook-selection",
    expectation: "expected",
    outcome,
    code,
    stage: "playbook-selection",
    count: selectedCount,
    ...(input.playbookAudit.rejected.length > 0
      ? { detail: { rejectedCount: input.playbookAudit.rejected.length } }
      : {}),
  };
}

function predictionCompletionOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  if (input.finalSynthesisRejected === true) {
    return {
      subsystem: "prediction-completion",
      expectation: "expected",
      outcome: "blocked",
      code: "final-synthesis-rejected",
      stage: "prediction-completion",
      count: 0,
    };
  }
  const audit = input.predictionCompletion;
  if (audit !== undefined) {
    let outcome: SubsystemOutcomeStatus = "empty";
    if (audit.outcome === "improved") {
      outcome = "produced";
    } else if (audit.outcome === "failed") {
      outcome = "failed";
    }
    return {
      subsystem: "prediction-completion",
      expectation: "expected",
      outcome,
      code: audit.outcome,
      stage: "prediction-completion",
      count: audit.acceptedPredictionIds.length,
    };
  }
  return {
    subsystem: "prediction-completion",
    expectation: "not-applicable",
    outcome: "declined",
    code: input.predictionCompletionSkipCode ?? "gate-code-missing",
    stage: "prediction-completion",
    count: 0,
  };
}

function integrityAuditOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  if (input.finalSynthesisRejected === true) {
    return {
      subsystem: "report-integrity-audit",
      expectation: "expected",
      outcome: "blocked",
      code: "final-synthesis-rejected",
      stage: "report-integrity-audit",
      count: 0,
    };
  }
  const audit = input.reportIntegrityAudit;
  return {
    subsystem: "report-integrity-audit",
    expectation: "expected",
    outcome: audit === undefined ? "empty" : "produced",
    code: audit === undefined ? "audit-missing" : "audit-complete",
    stage: "report-integrity-audit",
    count: audit?.prunedItemCount ?? 0,
  };
}

function forecastDisagreementOutcome(input: BuildSubsystemOutcomesInput): SubsystemOutcome {
  if (input.finalSynthesisRejected === true) {
    return {
      subsystem: "forecast-disagreement",
      expectation: "expected",
      outcome: "blocked",
      code: "final-synthesis-rejected",
      stage: "forecast-disagreement",
      count: 0,
    };
  }
  if (input.forecastDisagreementCode === "not-configured") {
    return {
      subsystem: "forecast-disagreement",
      expectation: "not-applicable",
      outcome: "declined",
      code: "not-configured",
      stage: "forecast-disagreement",
      count: 0,
    };
  }
  if (input.forecastDisagreementCode === "no-predictions") {
    return {
      subsystem: "forecast-disagreement",
      expectation: "expected",
      outcome: "blocked",
      code: "no-predictions",
      stage: "forecast-disagreement",
      count: 0,
    };
  }
  const audit = input.forecastDisagreement;
  let outcome: SubsystemOutcomeStatus = audit === undefined ? "empty" : "produced";
  if (input.forecastDisagreementCode === "failed") {
    outcome = "failed";
  }
  return {
    subsystem: "forecast-disagreement",
    expectation: "expected",
    outcome,
    code: input.forecastDisagreementCode ?? "audit-missing",
    stage: "forecast-disagreement",
    count: audit?.successfulParticipantCount ?? 0,
  };
}

function secDependentOutcomes(input: BuildSubsystemOutcomesInput): readonly SubsystemOutcome[] {
  return [...blockedSecDependents(input.sourceGaps)].toSorted().map((dependency) => ({
    subsystem: `deep-equity:${dependency}`,
    expectation: "expected",
    outcome: "blocked",
    code: "sec-base-packet-unavailable",
    stage: "source-collection",
    count: 0,
  }));
}

export function buildSubsystemOutcomes(
  input: BuildSubsystemOutcomesInput,
): readonly SubsystemOutcome[] {
  return [
    ...evidenceLaneOutcomes(input),
    webGatherOutcome(input),
    webSubjectProfileOutcome(input),
    spotlightOutcome(input),
    playbookOutcome(input),
    predictionCompletionOutcome(input),
    integrityAuditOutcome(input),
    forecastDisagreementOutcome(input),
    ...secDependentOutcomes(input),
  ];
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(
    keys.map((key) => [key, values.filter((value) => value === key).length]),
  ) as Record<T, number>;
}

export function rollupSubsystemOutcomes(
  outcomes: readonly SubsystemOutcome[],
): SubsystemOutcomeRollup {
  const codes = outcomes.map((item) => item.code);
  return {
    count: outcomes.length,
    expectedEmptyCount: outcomes.filter(
      (item) => item.expectation === "expected" && item.outcome === "empty",
    ).length,
    byExpectation: countBy(
      outcomes.map((item) => item.expectation),
      Object.keys(SUBSYSTEM_EXPECTATION_TABLE) as SubsystemExpectation[],
    ),
    byOutcome: countBy(
      outcomes.map((item) => item.outcome),
      Object.keys(SUBSYSTEM_OUTCOME_TABLE) as SubsystemOutcomeStatus[],
    ),
    byCode: Object.fromEntries(
      [...new Set(codes)]
        .toSorted()
        .map((code) => [code, codes.filter((item) => item === code).length]),
    ),
  };
}
