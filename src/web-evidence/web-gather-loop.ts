import type { AppConfig } from "../config";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { runTypeSupportsWebGather } from "../domain/run-types";
import type {
  SourceGap,
  SourceGapAttempts,
  WebGatherToolName,
  JsonToolLoopAuditEntry,
} from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { isRecord } from "../guards";
import { DEFAULT_RETRY_DELAYS_MS } from "../sources/retry-utils";
import { createCollectContext } from "../sources/source-request";
import type { CollectedSources } from "../sources/types";
import { executeWebGatherTool, WEB_GATHER_TOOL_UNITS } from "../sources/web-gather-tools";
import {
  aggregateSanitizerAudit,
  type WebGatherSubject,
  type WebGatherToolOutput,
} from "../sources/web-gather-emit";
import { dedupeWebSourcesByHeadline } from "./web-headline-dedupe";
import { webSubjectProfileSubjectForCommand } from "./web-subject-profile";
import {
  parseModelRequests,
  runJsonToolLoop,
  type JsonToolLoopRoundState,
} from "../research/json-tool-loop";
import { withStaleFallbackGaps } from "../research/json-tool-loop-support";
import type { ResearchContext, WebGatherContext } from "../research/research-context-types";
import {
  AVAILABLE_TOOLS,
  MAX_PARSE_FAILURE_ECHO_LENGTH,
  type ModelWebGatherRequest,
  type ValidationState,
  type WebGatherExecutionAudit,
  type WebGatherLoopInput,
  type WebGatherLoopResult,
  type WebGatherStageOutput,
} from "./web-gather-types";
import { secFilingCoverageFromSources } from "./web-gather-coverage";
import { subjectLabelForRun, subjectTermsForRun, validateRequests } from "./web-gather-validation";
import {
  executionRejectedEntry,
  mergeGaps,
  mergeToolOutput,
  webGatherMalformedGap,
} from "./web-gather-merge";

export type { WebGatherLoopResult, WebGatherStageOutput } from "./web-gather-types";

export async function runWebGatherLoop(input: WebGatherLoopInput): Promise<WebGatherLoopResult> {
  if (!isWebGatherLoopEnabled(input.command, input.config)) {
    const unavailableGap = webGatherSearchUnavailableGap(input.command, input.config);
    return {
      collectedSources:
        unavailableGap === undefined
          ? input.collectedSources
          : mergeGaps(input.command, input.collectedSources, [unavailableGap]),
      stageOutputs: [],
    };
  }
  const { command } = input;
  const surfacedUrls = new Set<string>();
  const seenKeys = new Set<string>();
  const thematicListSearchWidened = { value: false };
  const subject = webGatherSubjectForRun(command, input.collectedSources);
  if (subject === undefined) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }
  const webGatherOptions = effectiveWebGatherOptions(command, input.config);
  const config: AppConfig =
    webGatherOptions === input.config.webGatherOptions
      ? input.config
      : { ...input.config, webGatherOptions };
  const subjectTerms = subjectTermsForRun(command, input.collectedSources, subject);
  const secFilingCoverage = secFilingCoverageFromSources(
    subject,
    input.collectedSources.extendedSources,
  );
  const collectContext = createCollectContext(
    command,
    input.config.sourceOptions,
    input.now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  const executionAudits: WebGatherExecutionAudit[] = [];
  const executionRejections: {
    readonly acceptedRequestIndex: number;
    readonly reason: string;
    readonly attempts?: SourceGapAttempts;
  }[] = [];
  const toolContext =
    input.collectedSources.resolvedInstrumentIdentity !== undefined
      ? {
          ...collectContext.context,
          instrumentIdentity: input.collectedSources.resolvedInstrumentIdentity,
        }
      : collectContext.context;
  const acquireRequest = (request: ModelWebGatherRequest) =>
    withStaleFallbackGaps(collectContext, () =>
      executeWebGatherTool(request.tool, request.args, toolContext, surfacedUrls, subject),
    );
  const mergeRequestOutput = (
    currentSources: CollectedSources,
    outputWithStale: Awaited<ReturnType<typeof acquireRequest>>,
  ): { readonly state: CollectedSources; readonly gaps: readonly SourceGap[] } => {
    const headlineDedupe = dedupeWebSourcesByHeadline(
      currentSources.extendedSources,
      outputWithStale.sources,
    );
    if (outputWithStale.failedExaRequest !== undefined) {
      executionRejections.push({
        acceptedRequestIndex: executionAudits.length,
        reason: outputWithStale.failedExaRequest.reason,
        ...(outputWithStale.failedExaRequest.attempts !== undefined
          ? { attempts: outputWithStale.failedExaRequest.attempts }
          : {}),
      });
    }
    executionAudits.push({
      sanitizer: outputWithStale.sanitizer,
      ...(outputWithStale.freshness !== undefined ? { freshness: outputWithStale.freshness } : {}),
      ...(outputWithStale.fallback !== undefined ? { fallback: outputWithStale.fallback } : {}),
      ...(headlineDedupe.rejected.length > 0 ? { duplicateResults: headlineDedupe.rejected } : {}),
    });
    return {
      state: mergeToolOutput(command, currentSources, {
        ...outputWithStale,
        sources: headlineDedupe.kept,
      }),
      gaps: outputWithStale.gaps,
    };
  };
  if (
    isInstrumentCommand(command) &&
    command.jobType === "equity" &&
    command.assetClass === "equity" &&
    command.depth === "deep"
  ) {
    return runDeepEquityWebGatherBatch({
      input,
      command,
      config,
      webGatherOptions,
      subjectTerms,
      secFilingCoverage,
      surfacedUrls,
      seenKeys,
      thematicListSearchWidened,
      acquireRequest,
      mergeRequestOutput,
      executionAudits,
      executionRejections,
    });
  }

  const loop = await runJsonToolLoop<
    CollectedSources,
    ModelWebGatherRequest,
    WebGatherToolName,
    WebGatherStageOutput,
    JsonToolLoopAuditEntry
  >({
    options: webGatherOptions,
    initialState: input.collectedSources,
    invalidJsonMessage: "Web gather stage returned invalid JSON",
    invalidShapeMessage: "Web gather stage must return JSON object with requests array",
    malformedGap: (message) => webGatherMalformedGap(message, input.context.runParams.quickModel),
    generateRound: (currentSources, roundState) =>
      input.generateRound(
        currentSources,
        withWebGatherContext(input.context, {
          round: roundState.round,
          availableTools: AVAILABLE_TOOLS,
          toolUnits: WEB_GATHER_TOOL_UNITS,
          sourceUnitsUsed: roundState.sourceUnitsUsed,
          toolCallsUsed: roundState.toolCallsUsed,
          maxRounds: webGatherOptions.maxRounds,
          maxToolCalls: webGatherOptions.maxToolCalls,
          sourceBudget: webGatherOptions.sourceBudget,
          surfacedUrls: [...surfacedUrls].toSorted(),
          subjectTerms,
          ...(secFilingCoverage !== undefined ? { secFilingCoverage } : {}),
          ...(input.reusedProfileCoverage !== undefined
            ? { reusedProfileCoverage: input.reusedProfileCoverage }
            : {}),
        }),
        roundState.priorStages,
      ),
    validateRequests: (requests, roundState) =>
      validateRequests(
        requests,
        {
          seenKeys,
          surfacedUrls,
          thematicListSearchWidened,
          subject,
          subjectTerms,
          command,
          secFilingCoverage,
          reusedProfileCoverage: input.reusedProfileCoverage,
          acceptancePolicy: input.acceptancePolicy,
          config,
          round: roundState.round,
        },
        roundState,
      ),
    mergeGaps: (currentSources, gaps) => mergeGaps(command, currentSources, gaps),
    executeRequest: async (currentSources, request) => {
      const outputWithStale = await acquireRequest(request);
      return mergeRequestOutput(currentSources, outputWithStale);
    },
  });

  return {
    collectedSources: loop.state,
    stageOutputs: loop.stageOutputs,
    audit: {
      ...loop.audit,
      acceptedRequests: loop.audit.acceptedRequests.map((entry, index) => ({
        ...entry,
        ...executionAudits[index]!,
      })),
      rejectedRequests: [
        ...loop.audit.rejectedRequests,
        ...executionRejections.map(({ acceptedRequestIndex, reason, attempts }) =>
          executionRejectedEntry(
            loop.audit.acceptedRequests[acceptedRequestIndex]!,
            reason,
            attempts,
          ),
        ),
      ],
      sanitizer: aggregateSanitizerAudit(executionAudits.map((audit) => audit.sanitizer)),
      ...(input.acceptancePolicy !== undefined ? { acceptancePolicy: input.acceptancePolicy } : {}),
    },
  };
}

async function runDeepEquityWebGatherBatch(input: {
  readonly input: WebGatherLoopInput;
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly webGatherOptions: AppConfig["webGatherOptions"];
  readonly subjectTerms: readonly string[];
  readonly secFilingCoverage: WebGatherContext["secFilingCoverage"];
  readonly surfacedUrls: Set<string>;
  readonly seenKeys: Set<string>;
  readonly thematicListSearchWidened: { value: boolean };
  readonly acquireRequest: (request: ModelWebGatherRequest) => Promise<WebGatherToolOutput>;
  readonly mergeRequestOutput: (
    currentSources: CollectedSources,
    output: WebGatherToolOutput,
  ) => { readonly state: CollectedSources; readonly gaps: readonly SourceGap[] };
  readonly executionAudits: WebGatherExecutionAudit[];
  readonly executionRejections: {
    readonly acceptedRequestIndex: number;
    readonly reason: string;
    readonly attempts?: SourceGapAttempts;
  }[];
}): Promise<WebGatherLoopResult> {
  const generateRound = (
    round: number,
    priorStages: readonly WebGatherStageOutput[],
  ): Promise<WebGatherStageOutput> =>
    input.input.generateRound(
      input.input.collectedSources,
      withWebGatherContext(input.input.context, {
        round,
        availableTools: AVAILABLE_TOOLS,
        toolUnits: WEB_GATHER_TOOL_UNITS,
        sourceUnitsUsed: 0,
        toolCallsUsed: 0,
        maxRounds: 1,
        maxToolCalls: input.webGatherOptions.maxToolCalls,
        sourceBudget: input.webGatherOptions.sourceBudget,
        surfacedUrls: [],
        subjectTerms: input.subjectTerms,
        ...(input.secFilingCoverage !== undefined
          ? { secFilingCoverage: input.secFilingCoverage }
          : {}),
        ...(input.input.reusedProfileCoverage !== undefined
          ? { reusedProfileCoverage: input.input.reusedProfileCoverage }
          : {}),
      }),
      priorStages,
    );
  let round = 1;
  const stageOutputs = [await generateRound(round, [])];
  let parsed = parseModelRequests(
    stageOutputs[0]!.content,
    "Web gather stage returned invalid JSON",
    "Web gather stage must return JSON object with requests array",
  );
  // The configured maxRounds is only a gate for this batch path's single reprompt, not a loop.
  // The model always sees maxRounds: 1, and configured maxRounds: 1 disables the reprompt.
  if (typeof parsed === "string" && input.webGatherOptions.maxRounds > 1) {
    const failedStage = stageOutputs[0]!;
    round = 2;
    stageOutputs.push(
      await generateRound(round, [
        {
          ...failedStage,
          content: `${failedStage.content.slice(0, MAX_PARSE_FAILURE_ECHO_LENGTH)}\n\nParse failure: ${parsed}`,
        },
      ]),
    );
    parsed = parseModelRequests(
      stageOutputs[1]!.content,
      "Web gather stage returned invalid JSON",
      "Web gather stage must return JSON object with requests array",
    );
  }
  if (typeof parsed === "string") {
    const gap = webGatherMalformedGap(parsed, input.input.context.runParams.quickModel);
    return {
      collectedSources: mergeGaps(input.command, input.input.collectedSources, [gap]),
      stageOutputs,
      audit: {
        rounds: stageOutputs.length,
        acceptedRequests: [],
        rejectedRequests: [],
        sourceUnitsUsed: 0,
        executedTools: [],
        emittedGaps: [gap],
        sanitizer: aggregateSanitizerAudit([]),
        ...(input.input.acceptancePolicy !== undefined
          ? { acceptancePolicy: input.input.acceptancePolicy }
          : {}),
      },
    };
  }
  const priorStages = stageOutputs.slice(0, -1);
  const roundState: JsonToolLoopRoundState<WebGatherStageOutput> = {
    round,
    sourceUnitsUsed: 0,
    toolCallsUsed: 0,
    priorStages,
  };
  const searchRequests = parsed.filter(
    (request) => !isRecord(request) || request.tool !== "web_fetch",
  );
  const fetchRequests = parsed.filter(
    (request) => isRecord(request) && request.tool === "web_fetch",
  );
  const validationState: ValidationState = {
    seenKeys: input.seenKeys,
    surfacedUrls: input.surfacedUrls,
    thematicListSearchWidened: input.thematicListSearchWidened,
    subject: webGatherSubjectForRun(
      input.command,
      input.input.collectedSources,
    ) as WebGatherSubject,
    subjectTerms: input.subjectTerms,
    command: input.command,
    secFilingCoverage: input.secFilingCoverage,
    reusedProfileCoverage: input.input.reusedProfileCoverage,
    acceptancePolicy: input.input.acceptancePolicy,
    config: input.config,
    round,
  };
  const searchValidation = validateRequests(searchRequests, validationState, roundState);
  const searchOutputs = await Promise.all(
    searchValidation.requests.map((request) => input.acquireRequest(request.request)),
  );
  let collectedSources =
    searchValidation.gaps.length === 0
      ? input.input.collectedSources
      : mergeGaps(input.command, input.input.collectedSources, searchValidation.gaps);
  const emittedGaps = [...searchValidation.gaps];
  for (const output of searchOutputs) {
    const merged = input.mergeRequestOutput(collectedSources, output);
    collectedSources = merged.state;
    emittedGaps.push(...merged.gaps);
  }
  const searchSourceUnits = searchValidation.requests.reduce(
    (total, request) => total + request.sourceUnits,
    0,
  );
  const fetchValidation = validateRequests(fetchRequests, validationState, {
    round,
    sourceUnitsUsed: searchSourceUnits,
    toolCallsUsed: searchValidation.requests.length,
    priorStages,
  });
  const fetchOutputs = await Promise.all(
    fetchValidation.requests.map((request) => input.acquireRequest(request.request)),
  );
  if (fetchValidation.gaps.length > 0) {
    collectedSources = mergeGaps(input.command, collectedSources, fetchValidation.gaps);
    emittedGaps.push(...fetchValidation.gaps);
  }
  for (const output of fetchOutputs) {
    const merged = input.mergeRequestOutput(collectedSources, output);
    collectedSources = merged.state;
    emittedGaps.push(...merged.gaps);
  }
  const acceptedRequests = [...searchValidation.requests, ...fetchValidation.requests];
  return {
    collectedSources,
    stageOutputs,
    audit: {
      rounds: stageOutputs.length,
      acceptedRequests: acceptedRequests.map((entry, index) => ({
        ...entry.audit,
        ...input.executionAudits[index]!,
      })),
      rejectedRequests: [
        ...searchValidation.rejected,
        ...fetchValidation.rejected,
        ...input.executionRejections.map(({ acceptedRequestIndex, reason, attempts }) =>
          executionRejectedEntry(acceptedRequests[acceptedRequestIndex]!.audit, reason, attempts),
        ),
      ],
      sourceUnitsUsed: acceptedRequests.reduce((total, request) => total + request.sourceUnits, 0),
      executedTools: acceptedRequests.map((request) => request.tool),
      emittedGaps,
      sanitizer: aggregateSanitizerAudit(input.executionAudits.map((audit) => audit.sanitizer)),
      ...(input.input.acceptancePolicy !== undefined
        ? { acceptancePolicy: input.input.acceptancePolicy }
        : {}),
    },
  };
}

export function isWebGatherLoopEnabled(command: ResearchCommand, config: AppConfig): boolean {
  const webGatherOptions = effectiveWebGatherOptions(command, config);
  return (
    isWebGatherScope(command) &&
    config.sourceOptions.exaApiKey !== undefined &&
    !config.webGatherDisabled &&
    webGatherOptions.maxRounds > 0 &&
    webGatherOptions.maxToolCalls > 0 &&
    webGatherOptions.sourceBudget > 0
  );
}

function effectiveWebGatherOptions(
  command: ResearchCommand,
  config: AppConfig,
): AppConfig["webGatherOptions"] {
  if (command.jobType === "research" && config.webGatherOptions.themeOverrides !== undefined) {
    if (webGatherBudgetDisabled(config.webGatherOptions)) {
      return config.webGatherOptions;
    }
    return config.webGatherOptions.themeOverrides;
  }
  return config.webGatherOptions;
}

function webGatherBudgetDisabled(options: AppConfig["webGatherOptions"]): boolean {
  return options.maxRounds <= 0 || options.maxToolCalls <= 0 || options.sourceBudget <= 0;
}

function isWebGatherScope(command: ResearchCommand): boolean {
  return (
    command.jobType === "research" ||
    (runTypeSupportsWebGather(command.jobType) && command.depth === "deep")
  );
}

function webGatherSearchUnavailableGap(
  command: ResearchCommand,
  config: AppConfig,
): SourceGap | undefined {
  const webGatherOptions = effectiveWebGatherOptions(command, config);
  if (
    !isWebGatherScope(command) ||
    config.webGatherDisabled ||
    config.sourceOptions.exaApiKey !== undefined ||
    webGatherBudgetDisabled(webGatherOptions)
  ) {
    return undefined;
  }
  return sourceGap({
    source: "web-gather",
    message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
    provider: "exa",
    capability: "web-gather",
    cause: "missing-credential",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function webGatherSubjectForRun(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): WebGatherSubject | undefined {
  const label = subjectLabelForRun(command, collectedSources);
  return webSubjectProfileSubjectForCommand(command, label);
}

function withWebGatherContext(
  context: ResearchContext,
  webGather: WebGatherContext,
): ResearchContext {
  return { ...context, webGather };
}
