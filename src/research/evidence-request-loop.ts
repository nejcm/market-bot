import type { AppConfig } from "../config";
import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../cli/args";
import { runTypeSupportsEvidenceRequest } from "../domain/run-types";
import type {
  EvidenceRequestAuditEntry,
  EvidenceRequestLoopAudit,
  EvidenceRequestToolName,
  ExtendedEvidence,
  ExtendedEvidenceItem,
  SourceGap,
} from "../domain/types";
import { extendedEvidenceGap, sourceGap } from "../domain/source-gaps";
import { isUsListing } from "../sources/instrument-capability";
import { isRecord } from "../sources/guards";
import {
  availableEvidenceRequestTools,
  EVIDENCE_REQUEST_TOOL_UNITS,
  executeEvidenceRequestTool,
  type EvidenceRequestToolOutput,
} from "../sources/evidence-request-tools";
import { createCollectContext, DEFAULT_RETRY_DELAYS_MS } from "../sources/collector";
import type { CollectedSources, FetchLike } from "../sources/types";
import {
  runJsonToolLoop,
  type JsonToolLoopAccepted,
  type JsonToolLoopRoundState,
} from "./json-tool-loop";
import type { EvidenceRequestContext, ResearchContext } from "./research-context";

export interface EvidenceRequestStageOutput {
  readonly stage: "evidence-request";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface EvidenceRequestLoopResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly EvidenceRequestStageOutput[];
  /**
   * Absent only when the loop never ran (disabled run type, or no tools
   * available for this run). When the loop runs it always produces an audit,
   * even if zero rounds were generated.
   */
  readonly audit?: EvidenceRequestLoopAudit;
}

interface EvidenceRequestLoopInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly now: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly generateRound: (
    collectedSources: CollectedSources,
    context: ResearchContext,
    priorStages: readonly EvidenceRequestStageOutput[],
  ) => Promise<EvidenceRequestStageOutput>;
}

interface ModelEvidenceRequest {
  readonly tool: EvidenceRequestToolName;
  readonly args: { readonly symbol: string };
  readonly rationale: string;
}

interface ValidationState {
  readonly command: InstrumentCommand;
  readonly availableTools: ReadonlySet<EvidenceRequestToolName>;
  readonly seenKeys: Set<string>;
  readonly config: AppConfig;
  readonly round: number;
}

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(EVIDENCE_REQUEST_TOOL_UNITS));
const MAX_RATIONALE_TRACE_LENGTH = 500;

export async function runEvidenceRequestLoop(
  input: EvidenceRequestLoopInput,
): Promise<EvidenceRequestLoopResult> {
  if (!isEvidenceRequestLoopEnabled(input.command, input.config)) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }
  const { command } = input;

  const collectContext = createCollectContext(
    command,
    input.config.sourceOptions,
    input.now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  const availableTools = availableEvidenceRequestTools(
    collectContext.context,
    input.collectedSources.resolvedInstrumentIdentity,
  );
  if (availableTools.length === 0) {
    // The loop is enabled only for deep equity tickers; an empty tool set here means
    // The instrument is a non-US listing (US equity always exposes sec_latest_filing).
    // Emit one deterministic unsupported-coverage gap so the skip is observable.
    if (
      isInstrumentCommand(command) &&
      command.assetClass === "equity" &&
      !isUsListing(command.symbol, input.collectedSources.resolvedInstrumentIdentity)
    ) {
      const skipGap = extendedEvidenceGap(
        sourceGap({
          source: "evidence-request",
          message: `evidence-request: no applicable tools for ${command.symbol} (non-US listing)`,
          capability: "evidence-request",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      );
      return {
        collectedSources: mergeGaps(command, input.collectedSources, [skipGap]),
        stageOutputs: [],
      };
    }
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }

  // The adapter owns cross-round duplicate tracking; the generic loop only owns budgets.
  const seenKeys = new Set<string>();
  const availableToolsSet = new Set(availableTools);
  const loop = await runJsonToolLoop<
    CollectedSources,
    ModelEvidenceRequest,
    EvidenceRequestToolName,
    EvidenceRequestStageOutput,
    EvidenceRequestAuditEntry
  >({
    options: input.config.evidenceRequestOptions,
    initialState: input.collectedSources,
    invalidJsonMessage: "Evidence request stage returned invalid JSON",
    invalidShapeMessage: "Evidence request stage must return JSON object with requests array",
    malformedGap: evidenceRequestMalformedGap,
    generateRound: (currentSources, roundState) =>
      input.generateRound(
        currentSources,
        withEvidenceRequestContext(input.context, {
          round: roundState.round,
          availableTools,
          toolUnits: EVIDENCE_REQUEST_TOOL_UNITS,
          sourceUnitsUsed: roundState.sourceUnitsUsed,
          toolCallsUsed: roundState.toolCallsUsed,
          maxRounds: input.config.evidenceRequestOptions.maxRounds,
          maxToolCalls: input.config.evidenceRequestOptions.maxToolCalls,
          sourceBudget: input.config.evidenceRequestOptions.sourceBudget,
        }),
        roundState.priorStages,
      ),
    validateRequests: (requests, roundState) =>
      validateRequests(
        requests,
        {
          command,
          availableTools: availableToolsSet,
          seenKeys,
          config: input.config,
          round: roundState.round,
        },
        roundState,
      ),
    mergeGaps: (currentSources, gaps) => mergeGaps(command, currentSources, gaps),
    executeRequest: async (currentSources, request) => {
      const staleStart = collectContext.staleFallbackGaps.length;
      const toolContext =
        input.collectedSources.resolvedInstrumentIdentity !== undefined
          ? {
              ...collectContext.context,
              instrumentIdentity: input.collectedSources.resolvedInstrumentIdentity,
            }
          : collectContext.context;
      const output = await executeEvidenceRequestTool(request.tool, toolContext);
      const staleGaps = collectContext.staleFallbackGaps.slice(staleStart);
      const outputWithStale = { ...output, gaps: [...output.gaps, ...staleGaps] };
      return {
        state: mergeToolOutput(command, currentSources, outputWithStale),
        gaps: outputWithStale.gaps,
      };
    },
  });

  return {
    collectedSources: loop.state,
    stageOutputs: loop.stageOutputs,
    audit: loop.audit,
  };
}

function isEvidenceRequestLoopEnabled(
  command: ResearchCommand,
  config: AppConfig,
): command is InstrumentCommand {
  return (
    isInstrumentCommand(command) &&
    runTypeSupportsEvidenceRequest(command.jobType) &&
    command.depth === "deep" &&
    config.evidenceRequestOptions.maxRounds > 0 &&
    config.evidenceRequestOptions.maxToolCalls > 0 &&
    config.evidenceRequestOptions.sourceBudget > 0
  );
}

function withEvidenceRequestContext(
  context: ResearchContext,
  evidenceRequest: EvidenceRequestContext,
): ResearchContext {
  return { ...context, evidenceRequest };
}

function validateRequests(
  requests: readonly unknown[],
  state: ValidationState,
  roundState: JsonToolLoopRoundState<EvidenceRequestStageOutput>,
): {
  readonly requests: readonly JsonToolLoopAccepted<
    ModelEvidenceRequest,
    EvidenceRequestToolName,
    EvidenceRequestAuditEntry
  >[];
  readonly rejected: readonly EvidenceRequestAuditEntry[];
  readonly gaps: readonly SourceGap[];
} {
  const accepted: JsonToolLoopAccepted<
    ModelEvidenceRequest,
    EvidenceRequestToolName,
    EvidenceRequestAuditEntry
  >[] = [];
  const rejected: EvidenceRequestAuditEntry[] = [];
  const gaps: SourceGap[] = [];
  let { sourceUnitsUsed, toolCallsUsed } = roundState;

  for (const raw of requests) {
    const result = validateRequest(raw, state, sourceUnitsUsed, toolCallsUsed);
    if ("request" in result) {
      const sourceUnits = EVIDENCE_REQUEST_TOOL_UNITS[result.request.tool];
      accepted.push({
        request: result.request,
        audit: {
          round: state.round,
          tool: result.request.tool,
          args: result.request.args,
          rationale: result.request.rationale,
          status: "accepted",
          sourceUnits,
        },
        sourceUnits,
        tool: result.request.tool,
      });
      sourceUnitsUsed += sourceUnits;
      toolCallsUsed += 1;
      state.seenKeys.add(requestKey(result.request));
    } else {
      rejected.push(result.audit);
      gaps.push(result.gap);
    }
  }

  return { requests: accepted, rejected, gaps };
}

function validateRequest(
  raw: unknown,
  state: ValidationState,
  sourceUnitsUsed: number,
  toolCallsUsed: number,
):
  | { readonly request: ModelEvidenceRequest }
  | { readonly audit: EvidenceRequestAuditEntry; readonly gap: SourceGap } {
  if (!isRecord(raw)) {
    return reject(state.round, "unknown", undefined, undefined, "request must be an object");
  }
  const tool = typeof raw.tool === "string" ? raw.tool : "unknown";
  const args = isRecord(raw.args) ? raw.args : undefined;
  const rationale =
    typeof raw.rationale === "string" ? truncateRationale(raw.rationale) : undefined;
  if (!ALLOWED_TOOLS.has(tool)) {
    return reject(
      state.round,
      tool,
      args,
      rationale,
      "tool is not an allowed public evidence request tool",
    );
  }
  const typedTool = tool as EvidenceRequestToolName;
  if (!state.availableTools.has(typedTool)) {
    return reject(state.round, tool, args, rationale, "tool is unavailable for this run");
  }
  if (args === undefined || Object.keys(args).toSorted().join(",") !== "symbol") {
    return reject(state.round, tool, args, rationale, "args must contain only symbol");
  }
  const { symbol } = args;
  if (typeof symbol !== "string" || symbol.toUpperCase() !== state.command.symbol.toUpperCase()) {
    return reject(state.round, tool, args, rationale, "requested symbol must match run symbol");
  }
  if (rationale === undefined || rationale.trim() === "") {
    return reject(state.round, tool, args, rationale, "rationale is required");
  }
  const request = { tool: typedTool, args: { symbol }, rationale };
  if (state.seenKeys.has(requestKey(request))) {
    return reject(state.round, tool, args, rationale, "duplicate evidence request");
  }
  if (toolCallsUsed + 1 > state.config.evidenceRequestOptions.maxToolCalls) {
    return reject(state.round, tool, args, rationale, "evidence request tool-call budget exceeded");
  }
  if (
    sourceUnitsUsed + EVIDENCE_REQUEST_TOOL_UNITS[typedTool] >
    state.config.evidenceRequestOptions.sourceBudget
  ) {
    return reject(state.round, tool, args, rationale, "evidence request source budget exceeded");
  }
  return { request };
}

function requestKey(request: ModelEvidenceRequest): string {
  return `${request.tool}:${request.args.symbol.toUpperCase()}`;
}

function truncateRationale(rationale: string): string {
  const trimmed = rationale.trim();
  return trimmed.length > MAX_RATIONALE_TRACE_LENGTH
    ? `${trimmed.slice(0, MAX_RATIONALE_TRACE_LENGTH - 3)}...`
    : trimmed;
}

function reject(
  round: number,
  tool: string,
  args: unknown,
  rationale: string | undefined,
  reason: string,
): { readonly audit: EvidenceRequestAuditEntry; readonly gap: SourceGap } {
  return {
    audit: {
      round,
      tool,
      ...(args !== undefined ? { args } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      status: "rejected",
      reason,
    },
    gap: sourceGap({
      source: "evidence-request",
      message: `${tool}: ${reason}`,
      capability: "evidence-request",
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
    }),
  };
}

function evidenceRequestMalformedGap(message: string): SourceGap {
  return sourceGap({
    source: "evidence-request",
    message,
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function mergeToolOutput(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  output: EvidenceRequestToolOutput,
): CollectedSources {
  const gaps = output.gaps.map(extendedEvidenceGap);
  const extendedEvidence = mergeExtendedEvidence(command, collectedSources, output.items, gaps);
  return {
    ...collectedSources,
    rawSnapshots: [...collectedSources.rawSnapshots, ...output.rawSnapshots],
    extendedSources: [...collectedSources.extendedSources, ...output.sources],
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    sourceGaps: [...collectedSources.sourceGaps, ...gaps],
  };
}

function mergeGaps(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  gaps: readonly SourceGap[],
): CollectedSources {
  if (gaps.length === 0) {
    return collectedSources;
  }
  const extendedGaps = gaps.map((gap) => extendedEvidenceGap(gap));
  const extendedEvidence = mergeExtendedEvidence(command, collectedSources, [], extendedGaps);
  return {
    ...collectedSources,
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    sourceGaps: [...collectedSources.sourceGaps, ...extendedGaps],
  };
}

function mergeExtendedEvidence(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  items: readonly ExtendedEvidenceItem[],
  gaps: readonly SourceGap[],
): ExtendedEvidence | undefined {
  const existing = collectedSources.extendedEvidence;
  if (existing === undefined && items.length === 0 && gaps.length === 0) {
    return undefined;
  }
  return {
    instrument:
      existing?.instrument ??
      (isInstrumentCommand(command)
        ? { assetClass: command.assetClass, symbol: command.symbol }
        : { assetClass: command.assetClass, symbol: "" }),
    items: [...(existing?.items ?? []), ...items],
    gaps: [...(existing?.gaps ?? []), ...gaps],
  };
}
