import type { ResearchCommand } from "../cli/args";
import {
  NEAR_BASE_RATE_BAND,
  type Prediction,
  type PredictionCompletionAudit,
  type ResearchReport,
  type Source,
} from "../domain/types";
import type { CollectedSources } from "../sources/types";
import type { CostPricing } from "../model/pricing";
import type { StageLabel } from "./prompt-loader";
import type { PredictionCompletionPrompt, ResearchContext } from "./research-context";
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
}

export type StageRepromptReason = Omit<StageReprompt, "allowedSourceIds">;

export interface StageOutput {
  readonly stage: StageLabel;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
  readonly attempt?: number;
  readonly repromptReason?: StageRepromptReason;
}

interface FinalSynthesisState {
  readonly output: StageOutput;
  readonly payload: ModelReportPayload;
  readonly predResult: ReturnType<typeof readPredictions>;
}

interface SynthesisProgress {
  readonly state: FinalSynthesisState;
  readonly stageOutputs: readonly StageOutput[];
  readonly predictionRetryErrors: readonly string[];
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
    predictionTrimWarnings: predictionTrimWarnings(validated.progress.state.predResult),
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
      ? { predictionCompletion: reprompt.predictionCompletion }
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
  const validationState = await runAndReadFinalSynthesis(input, {
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
  };

  const postReportPredictionErrors = validationProgress.state.predResult.errors;
  if (postReportPredictionErrors.length > 0) {
    const state = await runAndReadFinalSynthesis(input, {
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
    };
  }

  return {
    progress: validationProgress,
    report: buildReport(input, validationProgress.state),
    reportValidationErrors,
  };
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

      const state = await runAndReadFinalSynthesis(input, { predictionErrors: retryErrors });
      return {
        state,
        stageOutputs: [...progress.stageOutputs, state.output],
        predictionRetryErrors: uniqueStrings([...progress.predictionRetryErrors, ...retryErrors]),
      };
    },
    Promise.resolve(initial),
  );
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
  const predResult = readPredictions(
    payload.predictions,
    input.knownSourceIds,
    input.allowedSubjects,
  );
  return { output, payload, predResult };
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

  for (const rawCandidate of candidates) {
    if (accepted.length >= input.targetCount) {
      rejectedCandidateCount += 1;
      rejectionReasons.push("prediction completion target already met");
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
      },
    });
    const payload = parseModelPayload(output.content);
    const merged = mergeCompletionCandidates({
      candidates: payload.predictions,
      existing: report.predictions,
      targetCount,
      knownSourceIds: input.knownSourceIds,
      allowedSubjects,
    });
    const state: FinalSynthesisState = {
      output,
      payload: progress.state.payload,
      predResult: {
        predictions: merged.predictions,
        errors: progress.state.predResult.errors,
        issues: progress.state.predResult.issues,
      },
    };
    return {
      progress: {
        state,
        stageOutputs: [...progress.stageOutputs, output],
        predictionRetryErrors: progress.predictionRetryErrors,
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
