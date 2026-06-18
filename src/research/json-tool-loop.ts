import type { JsonToolLoopAudit, SourceGap } from "../domain/types";
import { isRecord } from "../sources/guards";

export interface JsonToolLoopOptions {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
}

export interface JsonToolLoopStageOutput {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface JsonToolLoopRoundState<TStage extends JsonToolLoopStageOutput> {
  readonly round: number;
  readonly sourceUnitsUsed: number;
  readonly toolCallsUsed: number;
  readonly priorStages: readonly TStage[];
}

export interface JsonToolLoopAccepted<TRequest, TTool extends string, TAudit> {
  readonly request: TRequest;
  readonly audit: TAudit;
  readonly sourceUnits: number;
  readonly tool: TTool;
}

export interface JsonToolLoopValidationResult<TRequest, TTool extends string, TAudit> {
  readonly requests: readonly JsonToolLoopAccepted<TRequest, TTool, TAudit>[];
  readonly rejected: readonly TAudit[];
  readonly gaps: readonly SourceGap[];
}

export interface JsonToolLoopExecutionResult<TState> {
  readonly state: TState;
  readonly gaps: readonly SourceGap[];
}

interface JsonToolLoopInput<
  TState,
  TRequest,
  TTool extends string,
  TStage extends JsonToolLoopStageOutput,
  TAudit,
> {
  readonly options: JsonToolLoopOptions;
  readonly initialState: TState;
  readonly invalidJsonMessage: string;
  readonly invalidShapeMessage: string;
  readonly malformedGap: (message: string) => SourceGap;
  readonly generateRound: (
    state: TState,
    roundState: JsonToolLoopRoundState<TStage>,
  ) => Promise<TStage>;
  readonly validateRequests: (
    requests: readonly unknown[],
    roundState: JsonToolLoopRoundState<TStage>,
  ) => JsonToolLoopValidationResult<TRequest, TTool, TAudit>;
  readonly mergeGaps: (state: TState, gaps: readonly SourceGap[]) => TState;
  readonly executeRequest: (
    state: TState,
    request: TRequest,
  ) => Promise<JsonToolLoopExecutionResult<TState>>;
}

export interface JsonToolLoopResult<
  TState,
  TTool extends string,
  TStage extends JsonToolLoopStageOutput,
  TAudit,
> {
  readonly state: TState;
  readonly stageOutputs: readonly TStage[];
  readonly audit: JsonToolLoopAudit<TTool, TAudit>;
}

export async function runJsonToolLoop<
  TState,
  TRequest,
  TTool extends string,
  TStage extends JsonToolLoopStageOutput,
  TAudit,
>(
  input: JsonToolLoopInput<TState, TRequest, TTool, TStage, TAudit>,
): Promise<JsonToolLoopResult<TState, TTool, TStage, TAudit>> {
  const { options } = input;
  let state = input.initialState;
  let sourceUnitsUsed = 0;
  let toolCallsUsed = 0;
  const stageOutputs: TStage[] = [];
  const acceptedRequests: TAudit[] = [];
  const rejectedRequests: TAudit[] = [];
  const emittedGaps: SourceGap[] = [];
  const executedTools: TTool[] = [];

  for (let round = 1; round <= options.maxRounds; round += 1) {
    const roundState = { round, sourceUnitsUsed, toolCallsUsed, priorStages: [...stageOutputs] };
    // oxlint-disable-next-line no-await-in-loop -- each round depends on prior evidence and budgets.
    const stageOutput = await input.generateRound(state, roundState);
    stageOutputs.push(stageOutput);

    const parsed = parseModelRequests(
      stageOutput.content,
      input.invalidJsonMessage,
      input.invalidShapeMessage,
    );
    if (typeof parsed === "string") {
      const gap = input.malformedGap(parsed);
      emittedGaps.push(gap);
      state = input.mergeGaps(state, [gap]);
      break;
    }
    if (parsed.length === 0) {
      break;
    }

    const validation = input.validateRequests(parsed, roundState);
    rejectedRequests.push(...validation.rejected);
    emittedGaps.push(...validation.gaps);
    if (validation.gaps.length > 0) {
      state = input.mergeGaps(state, validation.gaps);
    }

    let budgetExhausted = false;
    for (const request of validation.requests) {
      /*
       * Last-resort budget backstop: adapters are expected to enforce budgets in
       * validateRequests, so this only trips for an over-admitting adapter. Such
       * dropped requests are intentionally not recorded in the audit (neither
       * accepted nor rejected) — they were never the loop's to execute.
       */
      if (
        toolCallsUsed >= options.maxToolCalls ||
        sourceUnitsUsed + request.sourceUnits > options.sourceBudget
      ) {
        budgetExhausted = true;
        break;
      }

      acceptedRequests.push(request.audit);
      sourceUnitsUsed += request.sourceUnits;
      toolCallsUsed += 1;
      executedTools.push(request.tool);

      // oxlint-disable-next-line no-await-in-loop -- tool calls update shared budgets and merge order.
      const result = await input.executeRequest(state, request.request);
      const { gaps, state: nextState } = result;
      state = nextState;
      emittedGaps.push(...gaps);
    }

    if (
      budgetExhausted ||
      toolCallsUsed >= options.maxToolCalls ||
      sourceUnitsUsed >= options.sourceBudget
    ) {
      break;
    }
  }

  return {
    state,
    stageOutputs,
    audit: {
      rounds: stageOutputs.length,
      acceptedRequests,
      rejectedRequests,
      sourceUnitsUsed,
      executedTools,
      emittedGaps,
    },
  };
}

function parseModelRequests(
  content: string,
  invalidJsonMessage: string,
  invalidShapeMessage: string,
): readonly unknown[] | string {
  const parsed = parseJson(content);
  if (parsed === undefined) {
    return invalidJsonMessage;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.requests)) {
    return invalidShapeMessage;
  }
  return parsed.requests;
}

function parseJson(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}
