import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import type {
  EvidenceRequestAuditEntry,
  EvidenceRequestLoopAudit,
  EvidenceRequestToolName,
  ExtendedEvidence,
  ExtendedEvidenceItem,
  SourceGap,
} from "../domain/types";
import { isRecord } from "../sources/guards";
import {
  availableEvidenceRequestTools,
  EVIDENCE_REQUEST_TOOL_UNITS,
  executeEvidenceRequestTool,
  type EvidenceRequestToolOutput,
} from "../sources/evidence-request-tools";
import { createCollectContext, DEFAULT_RETRY_DELAYS_MS } from "../sources/collector";
import type { FetchLike } from "../sources/types";
import type { CollectedSources, ResearchContext } from "./research-context";

export interface EvidenceRequestStageOutput {
  readonly stage: "evidence-request";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface EvidenceRequestLoopResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly EvidenceRequestStageOutput[];
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
  readonly command: Extract<ResearchCommand, { readonly jobType: "ticker" }>;
  readonly availableTools: ReadonlySet<EvidenceRequestToolName>;
  readonly seenKeys: Set<string>;
  readonly sourceUnitsUsed: number;
  readonly toolCallsUsed: number;
  readonly config: AppConfig;
  readonly round: number;
}

const ALLOWED_TOOLS = new Set<string>(["sec_latest_filing", "tradier_iv_term_structure"]);

export async function runEvidenceRequestLoop(
  input: EvidenceRequestLoopInput,
): Promise<EvidenceRequestLoopResult> {
  if (!isEvidenceRequestLoopEnabled(input.command, input.config)) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }

  const collectContext = createCollectContext(
    input.command,
    input.config.sourceOptions,
    input.now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  const availableTools = availableEvidenceRequestTools(collectContext.context);
  if (availableTools.length === 0) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }

  let { collectedSources } = input;
  let sourceUnitsUsed = 0;
  let toolCallsUsed = 0;
  const stageOutputs: EvidenceRequestStageOutput[] = [];
  const acceptedRequests: EvidenceRequestAuditEntry[] = [];
  const rejectedRequests: EvidenceRequestAuditEntry[] = [];
  const emittedGaps: SourceGap[] = [];
  const executedTools: EvidenceRequestToolName[] = [];
  const seenKeys = new Set<string>();

  for (let round = 1; round <= input.config.evidenceRequestOptions.maxRounds; round += 1) {
    const context = withEvidenceRequestContext(input.context, {
      round,
      availableTools,
      toolUnits: EVIDENCE_REQUEST_TOOL_UNITS,
      sourceUnitsUsed,
      toolCallsUsed,
      maxRounds: input.config.evidenceRequestOptions.maxRounds,
      maxToolCalls: input.config.evidenceRequestOptions.maxToolCalls,
      sourceBudget: input.config.evidenceRequestOptions.sourceBudget,
    });
    // oxlint-disable-next-line no-await-in-loop -- each round depends on prior evidence and budgets.
    const stageOutput = await input.generateRound(collectedSources, context, stageOutputs);
    stageOutputs.push(stageOutput);

    const parsed = parseModelRequests(stageOutput.content);
    if (typeof parsed === "string") {
      const gap = { source: "evidence-request", message: parsed };
      emittedGaps.push(gap);
      collectedSources = mergeGaps(input.command, collectedSources, [gap]);
      break;
    }
    if (parsed.length === 0) {
      break;
    }

    const validationState: ValidationState = {
      command: input.command,
      availableTools: new Set(availableTools),
      seenKeys,
      sourceUnitsUsed,
      toolCallsUsed,
      config: input.config,
      round,
    };
    const accepted = validateRequests(parsed, validationState);
    rejectedRequests.push(...accepted.rejected);
    emittedGaps.push(...accepted.gaps);
    if (accepted.gaps.length > 0) {
      collectedSources = mergeGaps(input.command, collectedSources, accepted.gaps);
    }

    for (const request of accepted.requests) {
      const auditEntry: EvidenceRequestAuditEntry = {
        round,
        tool: request.tool,
        args: request.args,
        rationale: request.rationale,
        status: "accepted",
        sourceUnits: EVIDENCE_REQUEST_TOOL_UNITS[request.tool],
      };
      acceptedRequests.push(auditEntry);
      sourceUnitsUsed += EVIDENCE_REQUEST_TOOL_UNITS[request.tool];
      toolCallsUsed += 1;
      executedTools.push(request.tool);

      const staleStart = collectContext.staleFallbackGaps.length;
      // oxlint-disable-next-line no-await-in-loop -- tool calls update shared budgets and merge order.
      const output = await executeEvidenceRequestTool(request.tool, collectContext.context);
      const staleGaps = collectContext.staleFallbackGaps.slice(staleStart);
      const outputWithStale = { ...output, gaps: [...output.gaps, ...staleGaps] };
      emittedGaps.push(...outputWithStale.gaps);
      collectedSources = mergeToolOutput(input.command, collectedSources, outputWithStale);
    }

    if (
      toolCallsUsed >= input.config.evidenceRequestOptions.maxToolCalls ||
      sourceUnitsUsed >= input.config.evidenceRequestOptions.sourceBudget
    ) {
      break;
    }
  }

  return {
    collectedSources,
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

function isEvidenceRequestLoopEnabled(
  command: ResearchCommand,
  config: AppConfig,
): command is Extract<ResearchCommand, { readonly jobType: "ticker" }> {
  return (
    command.jobType === "ticker" &&
    command.depth === "deep" &&
    command.assetClass === "equity" &&
    config.evidenceRequestOptions.maxRounds > 0 &&
    config.evidenceRequestOptions.maxToolCalls > 0 &&
    config.evidenceRequestOptions.sourceBudget > 0
  );
}

function withEvidenceRequestContext(
  context: ResearchContext,
  evidenceRequest: Record<string, unknown>,
): ResearchContext {
  return { ...context, evidenceRequest };
}

function parseModelRequests(content: string): readonly unknown[] | string {
  const parsed = parseJson(content);
  if (parsed === undefined) {
    return "Evidence request stage returned invalid JSON";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.requests)) {
    return "Evidence request stage must return JSON object with requests array";
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

function validateRequests(
  requests: readonly unknown[],
  state: ValidationState,
): {
  readonly requests: readonly ModelEvidenceRequest[];
  readonly rejected: readonly EvidenceRequestAuditEntry[];
  readonly gaps: readonly SourceGap[];
} {
  const accepted: ModelEvidenceRequest[] = [];
  const rejected: EvidenceRequestAuditEntry[] = [];
  const gaps: SourceGap[] = [];
  let { sourceUnitsUsed, toolCallsUsed } = state;

  for (const raw of requests) {
    const result = validateRequest(raw, state, sourceUnitsUsed, toolCallsUsed);
    if ("request" in result) {
      accepted.push(result.request);
      sourceUnitsUsed += EVIDENCE_REQUEST_TOOL_UNITS[result.request.tool];
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
  const rationale = typeof raw.rationale === "string" ? raw.rationale : undefined;
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
    gap: { source: "evidence-request", message: `${tool}: ${reason}` },
  };
}

function mergeToolOutput(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  output: EvidenceRequestToolOutput,
): CollectedSources {
  const extendedEvidence = mergeExtendedEvidence(
    command,
    collectedSources,
    output.items,
    output.gaps,
  );
  return {
    ...collectedSources,
    rawSnapshots: [...collectedSources.rawSnapshots, ...output.rawSnapshots],
    extendedSources: [...(collectedSources.extendedSources ?? []), ...output.sources],
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    sourceGaps: [...(collectedSources.sourceGaps ?? []), ...output.gaps],
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
  const extendedEvidence = mergeExtendedEvidence(command, collectedSources, [], gaps);
  return {
    ...collectedSources,
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    sourceGaps: [...(collectedSources.sourceGaps ?? []), ...gaps],
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
      (command.jobType === "ticker"
        ? { assetClass: command.assetClass, symbol: command.symbol }
        : { assetClass: command.assetClass, symbol: "" }),
    items: [...(existing?.items ?? []), ...items],
    gaps: [...(existing?.gaps ?? []), ...gaps],
  };
}
