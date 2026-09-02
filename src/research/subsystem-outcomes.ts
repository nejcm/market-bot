import type {
  PredictionCompletionAudit,
  RunTrace,
  SourceGap,
  SourceGapCause,
  WebGatherLoopAudit,
  WebGatherLoopFailureCode,
} from "../domain/types";
import { isRecord, readNumber, readString } from "../guards";
import type { PredictionCompletionSkipCode } from "./final-synthesis";
import type { PlaybookSelectionAudit } from "./playbooks";
import type { EvidenceLanesArtifactV2, SourcePlanArtifact } from "./source-plan";
import type { CollectedSources } from "../sources/types";
import type { SpotlightSelectionRejectionReason, SpotlightSelectionResult } from "./spotlights";
import type { WebGatherSkipCode } from "../web-evidence/web-gather-types";
import { SEC_PACKET_DEPENDENCY_LANES_BY_DERIVATION } from "../sources/sec-packet-dependencies";

export type SubsystemExpectation = "expected" | "optional" | "not-applicable";
export type SubsystemOutcomeStatus = "produced" | "empty" | "declined" | "failed" | "blocked";
export type ForecastDisagreementOutcomeCode =
  | "produced"
  | "failed"
  | "not-configured"
  | "no-predictions";

type NonSourceGapSubsystemOutcomeCode =
  | WebGatherSkipCode
  | WebGatherLoopFailureCode
  | SpotlightSelectionRejectionReason
  | PredictionCompletionSkipCode
  | PredictionCompletionAudit["outcome"]
  | ForecastDisagreementOutcomeCode
  | "not-applicable"
  | "sec-base-packet-unavailable"
  | "covered"
  | "audit-missing"
  | "coverage-gap"
  | "accepted-requests"
  | "no-accepted-requests"
  | "reused-profile"
  | "profile-produced"
  | "profile-empty"
  | "not-supportable"
  | "no-spotlights-selected"
  | "spotlights-selected"
  | "no-playbooks-selected"
  | "playbooks-selected"
  | "selection-rejected"
  | "final-synthesis-rejected"
  | "gate-code-missing"
  | "audit-complete";

type SourceGapCauseCollisionGuard =
  Extract<NonSourceGapSubsystemOutcomeCode, SourceGapCause> extends never
    ? unknown
    : { readonly "SourceGapCause collides with an existing subsystem outcome code": never };

export type SubsystemOutcomeCode = NonSourceGapSubsystemOutcomeCode | SourceGapCause;

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

const SUBSYSTEM_OUTCOME_CODE_TABLE = {
  "not-applicable": true,
  "sec-base-packet-unavailable": true,
  covered: true,
  "audit-missing": true,
  "coverage-gap": true,
  "run-not-applicable": true,
  "missing-exa-credential": true,
  "disabled-by-config": true,
  "round-budget-zero": true,
  "tool-call-budget-zero": true,
  "source-budget-zero": true,
  "subject-unavailable": true,
  "parse-retries-exhausted": true,
  "accepted-requests": true,
  "no-accepted-requests": true,
  "reused-profile": true,
  "profile-produced": true,
  "profile-empty": true,
  "not-supportable": true,
  "malformed-json": true,
  "malformed-selection": true,
  "unknown-symbol": true,
  "duplicate-symbol": true,
  "cap-overflow": true,
  "unknown-source-id": true,
  "no-spotlights-selected": true,
  "spotlights-selected": true,
  "no-playbooks-selected": true,
  "playbooks-selected": true,
  "selection-rejected": true,
  "final-synthesis-rejected": true,
  improved: true,
  "declined-empty": true,
  "no-parsable-candidates": true,
  "all-candidates-rejected": true,
  failed: true,
  "evidence-quality-ineligible": true,
  "target-zero": true,
  "target-met": true,
  "subject-ineligible": true,
  "gate-code-missing": true,
  "audit-complete": true,
  produced: true,
  "not-configured": true,
  "no-predictions": true,
  "missing-credential": true,
  "fetch-failed": true,
  "circuit-open": true,
  "stale-fallback": true,
  "reused-in-window": true,
  "unsupported-coverage": true,
  "repeat-fallback": true,
  "malformed-response": true,
  "validation-failed": true,
  "provider-data-missing": true,
  "session-in-progress": true,
  "suppressed-by-design": true,
} satisfies Record<SubsystemOutcomeCode, true> & SourceGapCauseCollisionGuard;

const SOURCE_GAP_CAUSE_OUTCOME_STATUS = {
  "fetch-failed": "failed",
  "malformed-response": "failed",
  "validation-failed": "failed",
  "circuit-open": "blocked",
  "missing-credential": "blocked",
  "suppressed-by-design": "declined",
  "unsupported-coverage": "declined",
  "provider-data-missing": "empty",
  "session-in-progress": "empty",
  "stale-fallback": "empty",
  "repeat-fallback": "empty",
  "reused-in-window": "empty",
} satisfies Record<SourceGapCause, SubsystemOutcomeStatus>;

const SOURCE_GAP_CAUSE_OUTCOME_ORDER: readonly SourceGapCause[] = Object.keys(
  SOURCE_GAP_CAUSE_OUTCOME_STATUS,
) as SourceGapCause[];

const OUTCOME_SEVERITY: Readonly<Record<SubsystemOutcomeStatus, number>> = {
  failed: 0,
  blocked: 1,
  declined: 2,
  empty: 3,
  produced: 4,
};

const SUBSYSTEM_EXPECTATIONS: ReadonlySet<string> = new Set(
  Object.keys(SUBSYSTEM_EXPECTATION_TABLE),
);
const SUBSYSTEM_OUTCOMES: ReadonlySet<string> = new Set(Object.keys(SUBSYSTEM_OUTCOME_TABLE));
const SUBSYSTEM_OUTCOME_CODES: ReadonlySet<string> = new Set(
  Object.keys(SUBSYSTEM_OUTCOME_CODE_TABLE),
);

export interface SubsystemOutcome {
  readonly subsystem: string;
  readonly expectation: SubsystemExpectation;
  readonly outcome: SubsystemOutcomeStatus;
  readonly code: string;
  readonly stage?: string;
  readonly count?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface WrittenSubsystemOutcome extends SubsystemOutcome {
  readonly code: SubsystemOutcomeCode;
}

export interface SubsystemOutcomeRollup {
  readonly count: number;
  readonly expectedEmptyCount: number;
  readonly byExpectation: Readonly<Record<SubsystemExpectation, number>>;
  readonly byOutcome: Readonly<Record<SubsystemOutcomeStatus, number>>;
  readonly byCode: Readonly<Record<string, number>>;
}

interface BuildSubsystemOutcomesInput {
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifactV2;
  readonly sourceGaps: readonly SourceGap[];
  readonly webSubjectProfilePresent: boolean;
  readonly webSubjectProfileReuse?: CollectedSources["webSubjectProfileReuse"];
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

export function assertSubsystemOutcomeCode(code: string): asserts code is SubsystemOutcomeCode {
  if (!SUBSYSTEM_OUTCOME_CODES.has(code)) {
    throw new Error(`Unsupported subsystem outcome code: ${JSON.stringify(code)}`);
  }
}

function winningGapCause(causes: readonly SourceGapCause[]): SourceGapCause {
  return [...causes].toSorted((left, right) => {
    const severity =
      OUTCOME_SEVERITY[SOURCE_GAP_CAUSE_OUTCOME_STATUS[left]] -
      OUTCOME_SEVERITY[SOURCE_GAP_CAUSE_OUTCOME_STATUS[right]];
    if (severity !== 0) {
      return severity;
    }
    return (
      SOURCE_GAP_CAUSE_OUTCOME_ORDER.indexOf(left) - SOURCE_GAP_CAUSE_OUTCOME_ORDER.indexOf(right)
    );
  })[0]!;
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

function evidenceLaneOutcomes(
  input: BuildSubsystemOutcomesInput,
): readonly WrittenSubsystemOutcome[] {
  const evidenceByLane = new Map(input.evidenceLanes.lanes.map((lane) => [lane.lane, lane]));
  const secDependents = blockedSecDependents(input.sourceGaps);
  const blockedLanes: ReadonlySet<string> = new Set(
    Object.entries(SEC_PACKET_DEPENDENCY_LANES_BY_DERIVATION).flatMap(([derivation, lanes]) =>
      secDependents.has(derivation) ? lanes : [],
    ),
  );
  return input.sourcePlan.lanes.map((planLane): WrittenSubsystemOutcome => {
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
      if (evidence.supportable === false) {
        return {
          subsystem,
          expectation,
          outcome: "produced",
          code: "not-supportable",
          stage: "source-collection",
          count: evidence.coveredSourceIds.length,
          detail: { supportable: false },
        };
      }
      return {
        subsystem,
        expectation,
        outcome: "produced",
        code: "covered",
        stage: "source-collection",
        count: evidence.coveredSourceIds.length,
      };
    }
    const cause =
      evidence?.gapCauses !== undefined && evidence.gapCauses.length > 0
        ? winningGapCause(evidence.gapCauses)
        : undefined;
    if (cause !== undefined) {
      return {
        subsystem,
        expectation,
        outcome: SOURCE_GAP_CAUSE_OUTCOME_STATUS[cause],
        code: cause,
        stage: "source-collection",
        count: evidence?.gapIds.length ?? 0,
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

function webGatherOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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
  if (failureCode !== undefined && acceptedCount === 0) {
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
    ...(failureCode !== undefined ? { detail: { failureCode } } : {}),
  };
}

function webSubjectProfileOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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
  if (input.webSubjectProfileReuse !== undefined) {
    return {
      subsystem: "web-subject-profile",
      expectation,
      outcome: "produced",
      code: "reused-profile",
      stage: "web-subject-profile",
      count: 1,
      detail: {
        ...(input.webSubjectProfileReuse.ageDays !== undefined
          ? { ageDays: input.webSubjectProfileReuse.ageDays }
          : {}),
        sourceRunDirName: input.webSubjectProfileReuse.runDirName,
        ...(input.webSubjectProfileReuse.originRunDirName !== undefined
          ? { originRunDirName: input.webSubjectProfileReuse.originRunDirName }
          : {}),
      },
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

function spotlightOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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
  let code: SubsystemOutcomeCode = firstRejection ?? "no-spotlights-selected";
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

function playbookOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
  const selectedCount = input.playbookAudit.selected.reduce(
    (count, selection) => count + selection.playbookIds.length,
    0,
  );
  let outcome: SubsystemOutcomeStatus = "empty";
  let code: SubsystemOutcomeCode = "no-playbooks-selected";
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

function predictionCompletionOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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

function integrityAuditOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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

function forecastDisagreementOutcome(input: BuildSubsystemOutcomesInput): WrittenSubsystemOutcome {
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

function secDependentOutcomes(
  input: BuildSubsystemOutcomesInput,
): readonly WrittenSubsystemOutcome[] {
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
): readonly WrittenSubsystemOutcome[] {
  const outcomes = [
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
  for (const outcome of outcomes) {
    assertSubsystemOutcomeCode(outcome.code);
  }
  return outcomes;
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
