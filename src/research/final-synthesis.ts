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
      predictionErrors: predictionProgress.state.predResult.errors,
      reportValidationErrors,
    };
  } catch (error: unknown) {
    reportValidationErrors = [errorMessage(error)];
  }

  const reportRetryPredictionErrors = predictionRetryReasons(
    predictionProgress.state.predResult,
    input.context.depthProfile.minimumPredictions,
  );
  const validationState = await runAndReadFinalSynthesis(input, {
    predictionErrors: reportRetryPredictionErrors,
    reportValidationErrors,
    allowedSourceIds: [...input.knownSourceIds].toSorted(),
  });
  let validationProgress: SynthesisProgress = {
    state: validationState,
    stageOutputs: [...predictionProgress.stageOutputs, validationState.output],
    predictionRetryErrors: uniqueStrings([
      ...predictionProgress.predictionRetryErrors,
      ...reportRetryPredictionErrors,
    ]),
  };

  const postReportPredictionErrors = predictionRetryReasons(
    validationProgress.state.predResult,
    input.context.depthProfile.minimumPredictions,
  );
  if (postReportPredictionErrors.length > 0) {
    const state = await runAndReadFinalSynthesis(input, {
      predictionErrors: postReportPredictionErrors,
      reportValidationErrors,
      allowedSourceIds: [...input.knownSourceIds].toSorted(),
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
      const retryErrors = predictionRetryReasons(
        progress.state.predResult,
        input.context.depthProfile.minimumPredictions,
      );
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
  const output = await input.runFinalSynthesis(input.priorStages, reprompt);
  const payload = parseModelPayload(output.content);
  const predResult = readPredictions(payload.predictions, input.knownSourceIds);
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

function predictionRetryReasons(
  predResult: ReturnType<typeof readPredictions>,
  minimumPredictions: number,
): readonly string[] {
  if (predResult.predictions.length >= minimumPredictions) {
    return [];
  }
  return [
    ...predResult.errors,
    `predictionShortfall: required ${String(minimumPredictions)}, received ${String(predResult.predictions.length)}`,
  ];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
