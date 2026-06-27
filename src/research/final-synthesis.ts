import type { ResearchCommand } from "../cli/args";
import type { ResearchReport, Source } from "../domain/types";
import type { CollectedSources } from "../sources/types";
import type { StageLabel } from "./prompt-loader";
import type { ResearchContext } from "./research-context";
import {
  assembleResearchReport,
  parseModelPayload,
  readPredictions,
  type ModelReportPayload,
} from "./report-assembly";

export interface StageOutput {
  readonly stage: StageLabel;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface StageReprompt {
  readonly predictionErrors?: readonly string[];
  readonly reportValidationErrors?: readonly string[];
  readonly allowedSourceIds?: readonly string[];
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
  readonly predictionReplacementAttempted: boolean;
  readonly predictionErrors: readonly string[];
  readonly reportValidationErrors: readonly string[];
}

export async function synthesizeReportUntilValid(
  input: SynthesizeReportUntilValidInput,
): Promise<SynthesizeReportUntilValidResult> {
  const initialState = await runAndReadFinalSynthesis(input);
  const predictionProgress = await runPredictionReprompts(input, {
    state: initialState,
    stageOutputs: [initialState.output],
    predictionRetryErrors: [],
  });

  /*
   * After hard-error retries settle, check whether a redundant trim dropped the
   * prediction count below target. If so, fire exactly one replacement attempt
   * through the existing predictionRepair path (ADR 0021 carve-out).
   */
  const replacementResult = await runRedundantTrimReplacement(input, predictionProgress);
  let reportValidationErrors: readonly string[] = [];

  try {
    const report = buildReport(input, replacementResult.progress.state);
    return {
      report,
      stageOutputs: replacementResult.progress.stageOutputs,
      predictionRetryErrors: replacementResult.progress.predictionRetryErrors,
      predictionTrimWarnings: predictionTrimWarnings(replacementResult.progress.state.predResult),
      predictionReplacementAttempted: replacementResult.attempted,
      predictionErrors: replacementResult.progress.state.predResult.errors,
      reportValidationErrors,
    };
  } catch (error: unknown) {
    reportValidationErrors = [errorMessage(error)];
  }

  const reportRetryPredictionErrors = replacementResult.progress.state.predResult.errors;
  const validationState = await runAndReadFinalSynthesis(input, {
    predictionErrors: reportRetryPredictionErrors,
    reportValidationErrors,
  });
  let validationProgress: SynthesisProgress = {
    state: validationState,
    stageOutputs: [...replacementResult.progress.stageOutputs, validationState.output],
    predictionRetryErrors: uniqueStrings([
      ...replacementResult.progress.predictionRetryErrors,
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

  const report = buildReport(input, validationProgress.state);
  return {
    report,
    stageOutputs: validationProgress.stageOutputs,
    predictionRetryErrors: validationProgress.predictionRetryErrors,
    predictionTrimWarnings: predictionTrimWarnings(validationProgress.state.predResult),
    predictionReplacementAttempted: replacementResult.attempted,
    predictionErrors: validationProgress.state.predResult.errors,
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
      /*
       * The prediction count is a soft target (ADR 0021), not a hard floor: a
       * below-target result is disclosed as a predictionShortfall data gap during
       * report assembly, never repaired by reprompting for more. Prediction trims
       * are telemetry, not retryable validation errors.
       */
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

interface RedundantTrimReplacementResult {
  readonly progress: SynthesisProgress;
  readonly attempted: boolean;
}

/*
 * After hard-error retries settle, fire at most one replacement attempt when a
 * redundant trim dropped the emitted prediction count below targetPredictions.
 *
 * Rules (ADR 0021 carve-out):
 * - At most one attempt — separate from maxPredictionReprompts (hard errors).
 * - Redundant trim warnings are passed as predictionErrors to trigger the
 *   existing buildPredictionRepairInstruction guidance.
 * - If the replacement re-introduces redundancy or doesn't improve, accept and stop.
 * - A clean below-target result (no redundant trim) is never retried here.
 */
async function runRedundantTrimReplacement(
  input: SynthesizeReportUntilValidInput,
  progress: SynthesisProgress,
): Promise<RedundantTrimReplacementResult> {
  const trimWarnings = predictionTrimWarnings(progress.state.predResult);
  const emittedCount = progress.state.predResult.predictions.length;
  const target = input.context.depthProfile.targetPredictions;

  if (trimWarnings.length === 0 || emittedCount >= target) {
    return { progress, attempted: false };
  }

  const state = await runAndReadFinalSynthesis(input, {
    predictionErrors: [...trimWarnings],
  });
  return {
    progress: {
      state,
      stageOutputs: [...progress.stageOutputs, state.output],
      predictionRetryErrors: uniqueStrings([...progress.predictionRetryErrors, ...trimWarnings]),
    },
    attempted: true,
  };
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
