import type { ResearchCommand } from "../cli/args";
import {
  NEAR_BASE_RATE_BAND,
  type Prediction,
  type PredictionCompletionAudit,
  type PredictionKind,
  type ResearchReport,
  type Source,
} from "../domain/types";
import type { CollectedSources } from "../sources/types";
import type { CostPricing } from "../model/pricing";
import {
  applyEarningsForecastPolicy,
  readEarningsForecastTelemetry,
} from "../forecast/earnings-eligibility";
import type { StageLabel } from "./prompt-loader";
import type { PredictionCompletionPrompt } from "./prompts";
import type { ResearchContext } from "./research-context-types";
import { commandResearchSubjectIdentity } from "./research-subject-identity";
import {
  assembleResearchReport,
  parseModelPayload,
  readPredictions,
  type ModelReportPayload,
} from "./report-assembly";

export interface StageReprompt {
  readonly predictionErrors?: readonly string[];
  readonly reportValidationErrors?: readonly string[];
  readonly allowedSourceIds?: readonly string[];
  readonly predictionCompletion?: PredictionCompletionPrompt;
  /** Predictions from the attempt being repaired that already validated. A repair reprompt
   *  regenerates the whole report from a stateless call, so without this the model never sees the
   *  predictions it is supposed to keep and silently returns fewer than it started with. */
  readonly retainedPredictions?: readonly Prediction[];
}

export type StageRepromptReason = Omit<
  StageReprompt,
  "allowedSourceIds" | "predictionCompletion" | "retainedPredictions"
> & {
  readonly predictionCompletion?: Pick<
    PredictionCompletionPrompt,
    "requestedCount" | "existingPredictions"
  >;
};

export interface StageOutput {
  readonly stage: StageLabel;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly durationMs?: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
  readonly attempt?: number;
  readonly repromptReason?: StageRepromptReason;
  /** Steering block sent to the model for this stage (final-synthesis only); records what
   *  guidance the model actually received so prompt gaps are decidable from a run directory. */
  readonly steering?: string;
}

interface FinalSynthesisState {
  readonly output: StageOutput;
  readonly payload: ModelReportPayload;
  readonly predResult: ReturnType<typeof readPredictions>;
  readonly suppressedEarningsPredictionCountOffset?: number;
  readonly unsolicitedKindWarnings?: readonly string[];
}

interface SynthesisProgress {
  readonly state: FinalSynthesisState;
  readonly stageOutputs: readonly StageOutput[];
  readonly predictionRetryErrors: readonly string[];
  /** Best validated prediction set seen so far in this run's repair chain. Retaining the previous
   *  attempt alone lets a chain ratchet downward: if a repair returns fewer predictions despite the
   *  survivor guidance, the next repair would anchor to the shrunken set and the loss compounds. */
  readonly retainedPredictions: readonly Prediction[];
  /** Every unsolicited-kind drop seen in this run, accumulated so a drop at any attempt survives
   *  into trace.predictionTrimWarnings even when a later attempt is clean. */
  readonly unsolicitedKindWarnings: readonly string[];
}

// Survivor guidance tells the model to re-emit a forecast unchanged, so it must only ever name
// Forecasts that can actually persist. ReadPredictions validates the observable grammar, but
// AssembleResearchReport applies deterministic report-level policy on top and can still drop one:
// An earnings forecast for a provider-estimated event is removed by applyEarningsForecastPolicy.
// Reuse that policy here — with the same "confirmed-only" argument report assembly passes — rather
// Than restating it, so the guidance and assembly cannot disagree about what survives.
function retainablePredictions(
  input: SynthesizeReportUntilValidInput,
  state: FinalSynthesisState,
): readonly Prediction[] {
  return applyEarningsForecastPolicy({
    predictions: state.predResult.predictions,
    setup: input.collectedSources.earningsSetup,
    policy: "confirmed-only",
  }).predictions;
}

// Best-so-far is the largest set, not the union of every attempt. Each candidate here is a whole
// Set that already passed readPredictions, so it is validated *and* post-trim: taking one wholesale
// Cannot admit an invalid prediction, and cannot resurrect a near-duplicate that
// RejectRedundantForecasts deliberately dropped. A union would carry both risks and would need
// Re-validation to undo them. Ties prefer the newer set, which reflects the latest repair feedback.
function mergeKindWarnings(
  progress: SynthesisProgress,
  state: FinalSynthesisState,
): readonly string[] {
  return uniqueStrings([
    ...progress.unsolicitedKindWarnings,
    ...(state.unsolicitedKindWarnings ?? []),
  ]);
}

function bestRetainedPredictions(
  input: SynthesizeReportUntilValidInput,
  previous: readonly Prediction[],
  state: FinalSynthesisState,
): readonly Prediction[] {
  const candidate = retainablePredictions(input, state);
  return candidate.length >= previous.length ? candidate : previous;
}

export interface SynthesizeReportUntilValidInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly command: ResearchCommand;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly sources: readonly Source[];
  readonly knownSourceIds: ReadonlySet<string>;
  /** Subjects the model is allowed to forecast for this run type.
   *  Undefined for research runs — `researchPredictionGate` is the authority there. */
  readonly allowedSubjects?: ReadonlySet<string>;
  /** Kinds this path does not solicit. The prompt already withholds them from every surface it
   *  advertises; this is the backstop for a model that emits one anyway, so an unsupported forecast
   *  cannot reach the report. Scoped per run — other paths pass nothing and are unaffected. */
  readonly disallowedPredictionKinds?: readonly PredictionKind[];
  readonly priorStages: readonly StageOutput[];
  readonly maxPredictionReprompts: number;
  readonly runFinalSynthesis: (
    priorStages: readonly StageOutput[],
    reprompt?: StageReprompt,
  ) => Promise<StageOutput>;
}

export interface SynthesizeReportUntilValidResult {
  readonly report: ResearchReport;
  readonly stageOutputs: readonly StageOutput[];
  readonly predictionRetryErrors: readonly string[];
  readonly predictionTrimWarnings: readonly string[];
  readonly predictionCompletion?: PredictionCompletionAudit;
  readonly predictionErrors: readonly string[];
  readonly reportValidationErrors: readonly string[];
}

export async function synthesizeReportUntilValid(
  input: SynthesizeReportUntilValidInput,
): Promise<SynthesizeReportUntilValidResult> {
  let attempt = 0;
  const trackedInput: SynthesizeReportUntilValidInput = {
    ...input,
    runFinalSynthesis: async (priorStages, reprompt) => {
      attempt += 1;
      const output = await input.runFinalSynthesis(priorStages, reprompt);
      const repromptReason = stageRepromptReason(reprompt);
      return {
        ...output,
        attempt,
        ...(attempt > 1 && repromptReason !== undefined ? { repromptReason } : {}),
      };
    },
  };
  const initialState = await runAndReadFinalSynthesis(trackedInput);
  const predictionProgress = await runPredictionReprompts(trackedInput, {
    state: initialState,
    stageOutputs: [initialState.output],
    predictionRetryErrors: [],
    retainedPredictions: retainablePredictions(trackedInput, initialState),
    unsolicitedKindWarnings: initialState.unsolicitedKindWarnings ?? [],
  });
  const validated = await validateBaseReport(trackedInput, predictionProgress);
  const completion = await runPredictionCompletion(
    trackedInput,
    validated.progress,
    validated.report,
  );
  const report = buildReport(trackedInput, completion.progress.state);
  return {
    report,
    stageOutputs: completion.progress.stageOutputs,
    predictionRetryErrors: completion.progress.predictionRetryErrors,
    predictionTrimWarnings: uniqueStrings([
      ...predictionTrimWarnings(validated.progress.state.predResult),
      ...completion.progress.unsolicitedKindWarnings,
    ]),
    ...(completion.audit !== undefined ? { predictionCompletion: completion.audit } : {}),
    predictionErrors: validated.progress.state.predResult.errors,
    reportValidationErrors: validated.reportValidationErrors,
  };
}

function stageRepromptReason(reprompt: StageReprompt | undefined): StageRepromptReason | undefined {
  if (reprompt === undefined) {
    return undefined;
  }
  const reason = {
    ...(reprompt.predictionErrors !== undefined
      ? { predictionErrors: reprompt.predictionErrors }
      : {}),
    ...(reprompt.reportValidationErrors !== undefined
      ? { reportValidationErrors: reprompt.reportValidationErrors }
      : {}),
    ...(reprompt.predictionCompletion !== undefined
      ? {
          // Persist only the audit-relevant fields; the report draft is prompt-only context and must
          // Not be duplicated into the recorded reprompt reason.
          predictionCompletion: {
            requestedCount: reprompt.predictionCompletion.requestedCount,
            existingPredictions: reprompt.predictionCompletion.existingPredictions,
          },
        }
      : {}),
  };
  return Object.keys(reason).length > 0 ? reason : undefined;
}

async function validateBaseReport(
  input: SynthesizeReportUntilValidInput,
  progress: SynthesisProgress,
): Promise<{
  readonly progress: SynthesisProgress;
  readonly report: ResearchReport;
  readonly reportValidationErrors: readonly string[];
}> {
  let reportValidationErrors: readonly string[] = [];
  try {
    return {
      progress,
      report: buildReport(input, progress.state),
      reportValidationErrors,
    };
  } catch (error: unknown) {
    reportValidationErrors = [errorMessage(error)];
  }

  const reportRetryPredictionErrors = progress.state.predResult.errors;
  const validationState = await repromptFinalSynthesis(input, progress.retainedPredictions, {
    predictionErrors: reportRetryPredictionErrors,
    reportValidationErrors,
  });
  let validationProgress: SynthesisProgress = {
    state: validationState,
    stageOutputs: [...progress.stageOutputs, validationState.output],
    predictionRetryErrors: uniqueStrings([
      ...progress.predictionRetryErrors,
      ...reportRetryPredictionErrors,
    ]),
    retainedPredictions: bestRetainedPredictions(
      input,
      progress.retainedPredictions,
      validationState,
    ),
    unsolicitedKindWarnings: mergeKindWarnings(progress, validationState),
  };

  const postReportPredictionErrors = validationProgress.state.predResult.errors;
  if (postReportPredictionErrors.length > 0) {
    const state = await repromptFinalSynthesis(input, validationProgress.retainedPredictions, {
      predictionErrors: postReportPredictionErrors,
      reportValidationErrors,
    });
    validationProgress = {
      state,
      stageOutputs: [...validationProgress.stageOutputs, state.output],
      predictionRetryErrors: uniqueStrings([
        ...validationProgress.predictionRetryErrors,
        ...postReportPredictionErrors,
      ]),
      retainedPredictions: bestRetainedPredictions(
        input,
        validationProgress.retainedPredictions,
        state,
      ),
      unsolicitedKindWarnings: mergeKindWarnings(validationProgress, state),
    };
  }

  return buildReportWithRepair(
    input,
    validationProgress,
    reportValidationErrors,
    MAX_REPORT_VALIDATION_REPROMPTS,
  );
}

interface RepairedReport {
  readonly progress: SynthesisProgress;
  readonly report: ResearchReport;
  readonly reportValidationErrors: readonly string[];
}

// Extra reprompts allowed when the assembled report still fails validation (typically a research-only
// Language violation) after the first report-validation retry. Without this the final buildReport was
// Unguarded: a persistent violation crashed the whole run. Recommendation-shaped subjects reliably
// Draw reader-directed advice, so the crash point needs bounded, steered repairs.
const MAX_REPORT_VALIDATION_REPROMPTS = 2;

// Recursive rather than a loop because each repair reprompt depends on the previous attempt's error;
// The reduce/recursion form also keeps the awaits out of a bare for-loop (no-await-in-loop).
async function buildReportWithRepair(
  input: SynthesizeReportUntilValidInput,
  progress: SynthesisProgress,
  seenErrors: readonly string[],
  attemptsLeft: number,
): Promise<RepairedReport> {
  try {
    return {
      progress,
      report: buildReport(input, progress.state),
      reportValidationErrors: uniqueStrings(seenErrors),
    };
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (attemptsLeft <= 0) {
      throw new Error(
        `Report failed validation after ${String(MAX_REPORT_VALIDATION_REPROMPTS)} repair reprompt(s): ${message}`,
        { cause: error },
      );
    }
    const predictionErrors = progress.state.predResult.errors;
    const state = await repromptFinalSynthesis(input, progress.retainedPredictions, {
      ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
      reportValidationErrors: [message],
    });
    const nextProgress: SynthesisProgress = {
      state,
      stageOutputs: [...progress.stageOutputs, state.output],
      predictionRetryErrors: uniqueStrings([
        ...progress.predictionRetryErrors,
        ...predictionErrors,
      ]),
      retainedPredictions: bestRetainedPredictions(input, progress.retainedPredictions, state),
      unsolicitedKindWarnings: mergeKindWarnings(progress, state),
    };
    return buildReportWithRepair(input, nextProgress, [...seenErrors, message], attemptsLeft - 1);
  }
}

async function runPredictionReprompts(
  input: SynthesizeReportUntilValidInput,
  initial: SynthesisProgress,
): Promise<SynthesisProgress> {
  return Array.from({ length: input.maxPredictionReprompts }).reduce<Promise<SynthesisProgress>>(
    async (progressPromise) => {
      const progress = await progressPromise;
      const retryErrors = progress.state.predResult.errors;
      if (retryErrors.length === 0) {
        return progress;
      }

      const state = await repromptFinalSynthesis(input, progress.retainedPredictions, {
        predictionErrors: retryErrors,
      });
      return {
        state,
        stageOutputs: [...progress.stageOutputs, state.output],
        predictionRetryErrors: uniqueStrings([...progress.predictionRetryErrors, ...retryErrors]),
        retainedPredictions: bestRetainedPredictions(input, progress.retainedPredictions, state),
        unsolicitedKindWarnings: mergeKindWarnings(progress, state),
      };
    },
    Promise.resolve(initial),
  );
}

// Every reprompt below is a stateless whole-report regeneration, so the predictions that already
// Validated have to travel with it or the next attempt silently drops them. This helper is the only
// Place a repair reprompt is constructed: `retained` is a required positional argument, and the
// Reprompt parameter's type rejects a `retainedPredictions` key on the object literals every caller
// Passes, so a new repair site cannot quietly leave survivors out. That excess-property check fires
// On fresh literals, not on a spread of a wider variable, so this is an enforced convention rather
// Than a type-level impossibility. The initial attempt is the only caller of
// RunAndReadFinalSynthesis with no reprompt, and it has no prior attempt to retain anything from.
async function repromptFinalSynthesis(
  input: SynthesizeReportUntilValidInput,
  retained: readonly Prediction[],
  reprompt: Omit<
    StageReprompt,
    "allowedSourceIds" | "retainedPredictions" | "predictionCompletion"
  >,
): Promise<FinalSynthesisState> {
  return runAndReadFinalSynthesis(input, { ...reprompt, retainedPredictions: retained });
}

// Drops kinds this path does not solicit and reports what it dropped. The filter runs on the raw
// Candidates, before readPredictions sees the batch, because batch validation is not neutral: a
// Malformed withdrawn candidate would raise retry errors and trigger a repair for a forecast that
// Was going to be discarded, and a withdrawn candidate sharing an id with a good one would take the
// Duplicate-id slot and evict it — leaving fewer survivors than if the model had never emitted it.
//
// Dropping rather than erroring is deliberate: a withdrawn kind is not a malformed forecast, and
// Raising it as a prediction error would spend a repair attempt regenerating the whole report when
// The completion pass can refill the slot for free. Dropping silently would be worse than either —
// The warning is what makes the next investigation possible, and it lands in
// Trace.predictionTrimWarnings alongside the redundancy trims.
function withdrawnKindOf(
  candidate: unknown,
  disallowed: readonly PredictionKind[],
): PredictionKind | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { kind } = candidate as { readonly kind?: unknown };
  return typeof kind === "string" && disallowed.includes(kind as PredictionKind)
    ? (kind as PredictionKind)
    : undefined;
}

// Identifies a raw candidate for the warning. The id is model-supplied and may be missing or
// Non-string at this point, so fall back to the batch position rather than losing the record.
function candidateLabel(candidate: unknown, index: number): string {
  if (typeof candidate === "object" && candidate !== null) {
    const { id } = candidate as { readonly id?: unknown };
    if (typeof id === "string" && id.length > 0) {
      return `Prediction ${id}`;
    }
  }
  return `Prediction at index ${String(index)}`;
}

function readSolicitedPredictions(
  input: SynthesizeReportUntilValidInput,
  value: unknown,
): {
  readonly predResult: ReturnType<typeof readPredictions>;
  readonly warnings: readonly string[];
} {
  const disallowed = input.disallowedPredictionKinds ?? [];
  if (disallowed.length === 0 || !Array.isArray(value)) {
    return {
      predResult: readPredictions(value, input.knownSourceIds, input.allowedSubjects),
      warnings: [],
    };
  }
  const solicited: unknown[] = [];
  const warnings: string[] = [];
  for (const [index, candidate] of value.entries()) {
    const withdrawn = withdrawnKindOf(candidate, disallowed);
    if (withdrawn === undefined) {
      solicited.push(candidate);
      continue;
    }
    warnings.push(
      `${candidateLabel(candidate, index)}: ${withdrawn} forecasts are not solicited on this path; dropped before validation`,
    );
  }
  return {
    predResult: readPredictions(solicited, input.knownSourceIds, input.allowedSubjects),
    warnings,
  };
}

async function runAndReadFinalSynthesis(
  input: SynthesizeReportUntilValidInput,
  reprompt?: StageReprompt,
): Promise<FinalSynthesisState> {
  const output = await input.runFinalSynthesis(input.priorStages, {
    ...reprompt,
    allowedSourceIds: [...input.knownSourceIds].toSorted(),
  });
  const payload = parseModelPayload(output.content);
  const { predResult, warnings } = readSolicitedPredictions(input, payload.predictions);
  return { output, payload, predResult, unsolicitedKindWarnings: warnings };
}

interface PredictionCompletionResult {
  readonly progress: SynthesisProgress;
  readonly audit?: PredictionCompletionAudit;
}

function completionSubjects(
  input: SynthesizeReportUntilValidInput,
): ReadonlySet<string> | undefined {
  if (input.command.jobType !== "research") {
    return input.allowedSubjects !== undefined && input.allowedSubjects.size > 0
      ? input.allowedSubjects
      : undefined;
  }

  const proxy = commandResearchSubjectIdentity(input.command).predictionProxySymbol;
  const hasSnapshot =
    proxy !== undefined &&
    input.collectedSources.marketSnapshots.some(
      (snapshot) => snapshot.symbol.toUpperCase() === proxy.toUpperCase(),
    );
  return proxy !== undefined && hasSnapshot ? new Set([proxy]) : undefined;
}

function completionEligible(
  input: SynthesizeReportUntilValidInput,
  report: ResearchReport,
): ReadonlySet<string> | undefined {
  const quality = input.context.evidenceQualityAssessment?.label;
  const target = input.context.depthProfile.targetPredictions;
  if (
    (quality !== "high" && quality !== "medium") ||
    target === 0 ||
    report.predictions.length >= target
  ) {
    return undefined;
  }
  return completionSubjects(input);
}

function isNearBaseRate(prediction: Prediction): boolean {
  return Math.abs(prediction.probability - 0.5) <= NEAR_BASE_RATE_BAND + Number.EPSILON;
}

function candidateRejectionReasons(result: ReturnType<typeof readPredictions>): readonly string[] {
  return uniqueStrings([...result.errors, ...result.issues.map((issue) => issue.message)]);
}

function mergeCompletionCandidates(input: {
  readonly candidates: unknown;
  readonly existing: readonly Prediction[];
  readonly targetCount: number;
  readonly knownSourceIds: ReadonlySet<string>;
  readonly allowedSubjects: ReadonlySet<string>;
  readonly disallowedKinds: readonly PredictionKind[];
}): {
  readonly predictions: readonly Prediction[];
  readonly acceptedPredictionIds: readonly string[];
  readonly rejectedCandidateCount: number;
  readonly rejectionReasons: readonly string[];
} {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const accepted = [...input.existing];
  const acceptedPredictionIds: string[] = [];
  const rejectionReasons: string[] = [];
  let rejectedCandidateCount = 0;

  // Iterate with the raw array index: rejectedCandidateCount skips accepted candidates, so it is
  // Not a position and must never be used to identify one in the audit.
  for (const [index, rawCandidate] of candidates.entries()) {
    if (accepted.length >= input.targetCount) {
      rejectedCandidateCount += 1;
      rejectionReasons.push("prediction completion target already met");
      continue;
    }

    const withdrawnKind = withdrawnKindOf(rawCandidate, input.disallowedKinds);
    if (withdrawnKind !== undefined) {
      rejectedCandidateCount += 1;
      rejectionReasons.push(
        `${candidateLabel(rawCandidate, index)}: ${withdrawnKind} forecasts are not solicited on this path`,
      );
      continue;
    }
    const candidateResult = readPredictions(
      [rawCandidate],
      input.knownSourceIds,
      input.allowedSubjects,
    );
    const [candidate] = candidateResult.predictions;
    if (candidate === undefined) {
      rejectedCandidateCount += 1;
      rejectionReasons.push(...candidateRejectionReasons(candidateResult));
      continue;
    }
    if (isNearBaseRate(candidate)) {
      rejectedCandidateCount += 1;
      rejectionReasons.push(
        `Prediction ${candidate.id}: near-base-rate probability is not eligible for completion`,
      );
      continue;
    }

    const combined = readPredictions(
      [...accepted, candidate],
      input.knownSourceIds,
      input.allowedSubjects,
    );
    const preservesExisting = accepted.every((prediction) =>
      combined.predictions.some((combinedPrediction) => combinedPrediction.id === prediction.id),
    );
    const addsCandidate =
      combined.predictions.length === accepted.length + 1 &&
      combined.predictions.some((prediction) => prediction.id === candidate.id);
    if (!preservesExisting || !addsCandidate) {
      rejectedCandidateCount += 1;
      const reasons = candidateRejectionReasons(combined).filter((reason) =>
        reason.includes(candidate.id),
      );
      rejectionReasons.push(
        ...(reasons.length > 0
          ? reasons
          : [`Prediction ${candidate.id}: conflicts with an accepted prediction`]),
      );
      continue;
    }

    accepted.push(candidate);
    acceptedPredictionIds.push(candidate.id);
  }

  return {
    predictions: accepted,
    acceptedPredictionIds,
    rejectedCandidateCount,
    rejectionReasons: uniqueStrings(rejectionReasons),
  };
}

async function runPredictionCompletion(
  input: SynthesizeReportUntilValidInput,
  progress: SynthesisProgress,
  report: ResearchReport,
): Promise<PredictionCompletionResult> {
  const allowedSubjects = completionEligible(input, report);
  if (allowedSubjects === undefined) {
    return { progress };
  }

  const initialCount = report.predictions.length;
  const targetCount = input.context.depthProfile.targetPredictions;
  let output: StageOutput | undefined = undefined;
  try {
    output = await input.runFinalSynthesis(input.priorStages, {
      allowedSourceIds: [...input.knownSourceIds].toSorted(),
      predictionCompletion: {
        requestedCount: targetCount - initialCount,
        existingPredictions: report.predictions,
        // Distills the completion prompt to the report narrative + critique + compact source index
        // Instead of the full evidence payload and prior-stage transcript. See buildStagePrompt.
        reportDraft: report,
      },
    });
    const payload = parseModelPayload(output.content);
    const merged = mergeCompletionCandidates({
      candidates: payload.predictions,
      existing: report.predictions,
      targetCount,
      knownSourceIds: input.knownSourceIds,
      allowedSubjects,
      disallowedKinds: input.disallowedPredictionKinds ?? [],
    });
    const suppressedEarningsPredictionCountOffset =
      readEarningsForecastTelemetry(report)?.suppressedPredictionCount ?? 0;
    const state: FinalSynthesisState = {
      output,
      payload: progress.state.payload,
      predResult: {
        predictions: merged.predictions,
        errors: progress.state.predResult.errors,
        issues: progress.state.predResult.issues,
      },
      ...(suppressedEarningsPredictionCountOffset > 0
        ? { suppressedEarningsPredictionCountOffset }
        : {}),
    };
    return {
      progress: {
        state,
        stageOutputs: [...progress.stageOutputs, output],
        predictionRetryErrors: progress.predictionRetryErrors,
        // The completion pass only adds predictions to an accepted report; it never repairs, so the
        // Best-so-far set carries through untouched.
        retainedPredictions: progress.retainedPredictions,
        unsolicitedKindWarnings: progress.unsolicitedKindWarnings,
      },
      audit: {
        attempted: true,
        initialCount,
        targetCount,
        acceptedPredictionIds: merged.acceptedPredictionIds,
        rejectedCandidateCount: merged.rejectedCandidateCount,
        rejectionReasons: merged.rejectionReasons,
        outcome: merged.acceptedPredictionIds.length > 0 ? "improved" : "no-eligible-candidates",
      },
    };
  } catch (error: unknown) {
    return {
      progress: {
        ...progress,
        ...(output !== undefined ? { stageOutputs: [...progress.stageOutputs, output] } : {}),
      },
      audit: {
        attempted: true,
        initialCount,
        targetCount,
        acceptedPredictionIds: [],
        rejectedCandidateCount: 0,
        rejectionReasons: [],
        outcome: "failed",
        failureReason: errorMessage(error),
      },
    };
  }
}

function buildReport(
  input: SynthesizeReportUntilValidInput,
  state: FinalSynthesisState,
): ResearchReport {
  return assembleResearchReport({
    runId: input.runId,
    generatedAt: input.generatedAt,
    command: input.command,
    payload: state.payload,
    predResult: state.predResult,
    collectedSources: input.collectedSources,
    depthProfile: input.context.depthProfile,
    context: input.context,
    sources: input.sources,
    ...(state.suppressedEarningsPredictionCountOffset !== undefined
      ? {
          suppressedEarningsPredictionCountOffset: state.suppressedEarningsPredictionCountOffset,
        }
      : {}),
  });
}

function predictionTrimWarnings(predResult: ReturnType<typeof readPredictions>): readonly string[] {
  return predResult.issues
    .filter((issue) => issue.code === "redundant-prediction")
    .map((issue) => issue.message);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
