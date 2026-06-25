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
  let reportValidationErrors: readonly string[] = [];

  try {
    const report = buildReport(input, predictionProgress.state);
    return {
      report,
      stageOutputs: predictionProgress.stageOutputs,
      predictionRetryErrors: predictionProgress.predictionRetryErrors,
      predictionTrimWarnings: predictionTrimWarnings(predictionProgress.state.predResult),
      predictionErrors: predictionProgress.state.predResult.errors,
      reportValidationErrors,
    };
  } catch (error: unknown) {
    reportValidationErrors = [errorMessage(error)];
  }

  const reportRetryPredictionErrors = predictionRetryReasons(predictionProgress.state.predResult);
  const validationState = await runAndReadFinalSynthesis(input, {
    predictionErrors: reportRetryPredictionErrors,
    reportValidationErrors,
  });
  let validationProgress: SynthesisProgress = {
    state: validationState,
    stageOutputs: [...predictionProgress.stageOutputs, validationState.output],
    predictionRetryErrors: uniqueStrings([
      ...predictionProgress.predictionRetryErrors,
      ...reportRetryPredictionErrors,
    ]),
  };

  const postReportPredictionErrors = predictionRetryReasons(validationProgress.state.predResult);
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
      const retryErrors = predictionRetryReasons(progress.state.predResult);
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

function predictionRetryReasons(predResult: ReturnType<typeof readPredictions>): readonly string[] {
  /*
   * The prediction count is a soft target (ADR 0021), not a hard floor: a
   * below-target result is disclosed as a predictionShortfall data gap during
   * report assembly, never repaired by reprompting for more. Prediction trims
   * are telemetry, not retryable validation errors.
   */
  return predResult.errors;
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
