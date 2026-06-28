import type { AppConfig } from "../config";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { runTypeSupportsWebGather } from "../domain/run-types";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  SourceGap,
  WebGatherLoopAudit,
  WebGatherToolName,
  JsonToolLoopAuditEntry,
} from "../domain/types";
import { extendedEvidenceGap, sourceGap } from "../domain/source-gaps";
import { isRecord, readString } from "../sources/guards";
import { canonicalizeUrl } from "../sources/news-utils";
import { createCollectContext, DEFAULT_RETRY_DELAYS_MS } from "../sources/collector";
import type { CollectedSources, FetchLike } from "../sources/types";
import {
  executeWebGatherTool,
  MAX_WEB_GATHER_SEARCH_RESULTS,
  WEB_GATHER_TOOL_UNITS,
  type WebGatherSubject,
  type WebGatherToolOutput,
} from "../sources/web-gather-tools";
import { webSubjectProfileSubjectForCommand } from "../sources/extended-evidence/web-subject-profile";
import {
  runJsonToolLoop,
  type JsonToolLoopAccepted,
  type JsonToolLoopRoundState,
} from "./json-tool-loop";
import type { ResearchContext, WebGatherContext } from "./research-context";

export interface WebGatherStageOutput {
  readonly stage: "web-gather";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface WebGatherLoopResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly WebGatherStageOutput[];
  readonly audit?: WebGatherLoopAudit;
}

interface WebGatherLoopInput {
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
    priorStages: readonly WebGatherStageOutput[],
  ) => Promise<WebGatherStageOutput>;
}

type ModelWebGatherRequest =
  | {
      readonly tool: "web_search";
      readonly args: { readonly query: string; readonly numResults?: number };
      readonly rationale: string;
    }
  | {
      readonly tool: "web_fetch";
      readonly args: { readonly url: string };
      readonly rationale: string;
    };

interface ValidationState {
  readonly seenKeys: Set<string>;
  readonly surfacedUrls: Set<string>;
  readonly subject: WebGatherSubject;
  readonly subjectTerms: readonly string[];
  readonly config: AppConfig;
  readonly round: number;
}

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(WEB_GATHER_TOOL_UNITS));
const AVAILABLE_TOOLS: readonly WebGatherToolName[] = ["web_search", "web_fetch"];
const MAX_RATIONALE_TRACE_LENGTH = 500;
const COMMON_COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "class",
  "ordinary",
  "shares",
]);
const THEME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export async function runWebGatherLoop(input: WebGatherLoopInput): Promise<WebGatherLoopResult> {
  if (!isWebGatherLoopEnabled(input.command, input.config)) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }
  const { command } = input;
  const surfacedUrls = new Set<string>();
  const seenKeys = new Set<string>();
  const subject = webGatherSubjectForRun(command, input.collectedSources);
  if (subject === undefined) {
    return { collectedSources: input.collectedSources, stageOutputs: [] };
  }
  const subjectTerms = subjectTermsForRun(command, input.collectedSources, subject);
  const collectContext = createCollectContext(
    command,
    input.config.sourceOptions,
    input.now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );

  const loop = await runJsonToolLoop<
    CollectedSources,
    ModelWebGatherRequest,
    WebGatherToolName,
    WebGatherStageOutput,
    JsonToolLoopAuditEntry
  >({
    options: input.config.webGatherOptions,
    initialState: input.collectedSources,
    invalidJsonMessage: "Web gather stage returned invalid JSON",
    invalidShapeMessage: "Web gather stage must return JSON object with requests array",
    malformedGap: webGatherMalformedGap,
    generateRound: (currentSources, roundState) =>
      input.generateRound(
        currentSources,
        withWebGatherContext(input.context, {
          round: roundState.round,
          availableTools: AVAILABLE_TOOLS,
          toolUnits: WEB_GATHER_TOOL_UNITS,
          sourceUnitsUsed: roundState.sourceUnitsUsed,
          toolCallsUsed: roundState.toolCallsUsed,
          maxRounds: input.config.webGatherOptions.maxRounds,
          maxToolCalls: input.config.webGatherOptions.maxToolCalls,
          sourceBudget: input.config.webGatherOptions.sourceBudget,
          surfacedUrls: [...surfacedUrls].toSorted(),
          subjectTerms,
        }),
        roundState.priorStages,
      ),
    validateRequests: (requests, roundState) =>
      validateRequests(
        requests,
        {
          seenKeys,
          surfacedUrls,
          subject,
          subjectTerms,
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
      const output = await executeWebGatherTool(
        request.tool,
        request.args,
        toolContext,
        surfacedUrls,
        subject,
      );
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

export function isWebGatherLoopEnabled(command: ResearchCommand, config: AppConfig): boolean {
  return (
    runTypeSupportsWebGather(command.jobType) &&
    command.depth === "deep" &&
    config.sourceOptions.exaApiKey !== undefined &&
    !config.webGatherDisabled &&
    config.webGatherOptions.maxRounds > 0 &&
    config.webGatherOptions.maxToolCalls > 0 &&
    config.webGatherOptions.sourceBudget > 0
  );
}

export function webGatherSubjectForRun(
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

function validateRequests(
  requests: readonly unknown[],
  state: ValidationState,
  roundState: JsonToolLoopRoundState<WebGatherStageOutput>,
): {
  readonly requests: readonly JsonToolLoopAccepted<
    ModelWebGatherRequest,
    WebGatherToolName,
    JsonToolLoopAuditEntry
  >[];
  readonly rejected: readonly JsonToolLoopAuditEntry[];
  readonly gaps: readonly SourceGap[];
} {
  const accepted: JsonToolLoopAccepted<
    ModelWebGatherRequest,
    WebGatherToolName,
    JsonToolLoopAuditEntry
  >[] = [];
  const rejected: JsonToolLoopAuditEntry[] = [];
  const gaps: SourceGap[] = [];
  let { sourceUnitsUsed, toolCallsUsed } = roundState;

  for (const raw of requests) {
    const result = validateRequest(raw, state, sourceUnitsUsed, toolCallsUsed);
    if ("request" in result) {
      const sourceUnits = WEB_GATHER_TOOL_UNITS[result.request.tool];
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
  | { readonly request: ModelWebGatherRequest }
  | { readonly audit: JsonToolLoopAuditEntry; readonly gap: SourceGap } {
  if (!isRecord(raw)) {
    return reject(state.round, "unknown", undefined, undefined, "request must be an object");
  }
  const tool = typeof raw.tool === "string" ? raw.tool : "unknown";
  const args = isRecord(raw.args) ? raw.args : undefined;
  const rationale =
    typeof raw.rationale === "string" ? truncateRationale(raw.rationale) : undefined;
  if (!ALLOWED_TOOLS.has(tool)) {
    return reject(state.round, tool, args, rationale, "tool is not an allowed web gather tool");
  }
  const typedTool = tool as WebGatherToolName;
  if (args === undefined) {
    return reject(state.round, tool, args, rationale, "args must be an object");
  }
  if (rationale === undefined || rationale.trim() === "") {
    return reject(state.round, tool, args, rationale, "rationale is required");
  }
  if (typedTool === "web_search") {
    const parsedArgs = webSearchArgs(args);
    if (typeof parsedArgs === "string") {
      return reject(state.round, tool, args, rationale, parsedArgs);
    }
    if (!isOnSubjectQuery(parsedArgs.query, state.subject, state.subjectTerms)) {
      return reject(
        state.round,
        tool,
        args,
        rationale,
        "web_search query must mention the run subject",
      );
    }
    return validateAcceptedRequest(
      { tool: typedTool, args: parsedArgs, rationale },
      state,
      sourceUnitsUsed,
      toolCallsUsed,
      args,
    );
  }
  const parsedArgs = webFetchArgs(args);
  if (typeof parsedArgs === "string") {
    return reject(state.round, tool, args, rationale, parsedArgs);
  }
  if (!isSurfacedUrl(parsedArgs.url, state.surfacedUrls)) {
    return reject(
      state.round,
      tool,
      args,
      rationale,
      "web_fetch url was not returned by web_search in this run",
    );
  }
  return validateAcceptedRequest(
    { tool: typedTool, args: parsedArgs, rationale },
    state,
    sourceUnitsUsed,
    toolCallsUsed,
    args,
  );
}

function validateAcceptedRequest(
  request: ModelWebGatherRequest,
  state: ValidationState,
  sourceUnitsUsed: number,
  toolCallsUsed: number,
  auditArgs: unknown,
):
  | { readonly request: ModelWebGatherRequest }
  | { readonly audit: JsonToolLoopAuditEntry; readonly gap: SourceGap } {
  if (state.seenKeys.has(requestKey(request))) {
    return reject(
      state.round,
      request.tool,
      auditArgs,
      request.rationale,
      "duplicate web gather request",
    );
  }
  if (toolCallsUsed + 1 > state.config.webGatherOptions.maxToolCalls) {
    return reject(
      state.round,
      request.tool,
      auditArgs,
      request.rationale,
      "web gather tool-call budget exceeded",
    );
  }
  if (
    sourceUnitsUsed + WEB_GATHER_TOOL_UNITS[request.tool] >
    state.config.webGatherOptions.sourceBudget
  ) {
    return reject(
      state.round,
      request.tool,
      auditArgs,
      request.rationale,
      "web gather source budget exceeded",
    );
  }
  return { request };
}

function webSearchArgs(
  args: Record<string, unknown>,
): { readonly query: string; readonly numResults?: number } | string {
  const keys = Object.keys(args).toSorted();
  if (!keys.every((key) => key === "query" || key === "numResults")) {
    return "web_search args may contain only query and numResults";
  }
  const query = readString(args, "query");
  if (query === undefined) {
    return "web_search requires a non-empty query";
  }
  if (
    args.numResults !== undefined &&
    (typeof args.numResults !== "number" ||
      !Number.isInteger(args.numResults) ||
      args.numResults <= 0)
  ) {
    return "web_search numResults must be a positive integer";
  }
  if (typeof args.numResults === "number" && args.numResults > MAX_WEB_GATHER_SEARCH_RESULTS) {
    return `web_search numResults must be at most ${MAX_WEB_GATHER_SEARCH_RESULTS}`;
  }
  return {
    query,
    ...(typeof args.numResults === "number" ? { numResults: args.numResults } : {}),
  };
}

function webFetchArgs(args: Record<string, unknown>): { readonly url: string } | string {
  if (Object.keys(args).toSorted().join(",") !== "url") {
    return "web_fetch args must contain only url";
  }
  const url = readString(args, "url");
  return url === undefined ? "web_fetch requires a non-empty url" : { url };
}

function subjectTermsForRun(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  subject: WebGatherSubject,
): readonly string[] {
  if (command.jobType === "research") {
    return significantSubjectTerms(command.subject);
  }
  if (!isInstrumentCommand(command)) {
    return [];
  }
  const displayName =
    collectedSources.resolvedInstrumentIdentity?.displayName ??
    collectedSources.marketSnapshots.find(
      (snapshot) => snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
    )?.name;
  let labelTerms: readonly string[] = [];
  if (displayName !== undefined) {
    labelTerms =
      subject.subjectKind === "company"
        ? companyTerms(displayName)
        : significantSubjectTerms(displayName);
  }
  const terms = [command.symbol, ...labelTerms];
  return [...new Set(terms.map((term) => normalizeTerm(term)).filter((term) => term !== ""))];
}

function subjectLabelForRun(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): string | undefined {
  if (command.jobType === "research") {
    return command.subject;
  }
  if (!isInstrumentCommand(command)) {
    return undefined;
  }
  return (
    collectedSources.resolvedInstrumentIdentity?.displayName ??
    collectedSources.marketSnapshots.find(
      (snapshot) => snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
    )?.name
  );
}

function companyTerms(name: string): readonly string[] {
  const normalized = normalizeTerm(name);
  const significant = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !COMMON_COMPANY_SUFFIXES.has(token));
  return [normalized, significant.join(" "), significant[0] ?? ""].filter((term) => term !== "");
}

function significantSubjectTerms(subject: string): readonly string[] {
  const normalized = normalizeTerm(subject);
  const significant = normalized
    .split(" ")
    .filter((token) => token.length > 1 && !THEME_STOPWORDS.has(token));
  return [normalized, ...significant].filter((term) => term !== "");
}

function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function isOnSubjectQuery(
  query: string,
  subject: WebGatherSubject,
  subjectTerms: readonly string[],
): boolean {
  const normalized = normalizeTerm(query);
  const tokens = new Set(normalized.split(" "));
  if (subject.subjectKind === "theme") {
    const label = normalizeTerm(subject.subjectLabel ?? subject.subjectId);
    const significant = label
      .split(" ")
      .filter((token) => token.length > 1 && !THEME_STOPWORDS.has(token));
    if (label.includes(" ") && ` ${normalized} `.includes(` ${label} `)) {
      return true;
    }
    return significant.length > 0 && significant.every((term) => tokens.has(term));
  }
  return subjectTerms.some((term) =>
    term.includes(" ") ? ` ${normalized} `.includes(` ${term} `) : tokens.has(term),
  );
}

function isSurfacedUrl(url: string, surfacedUrls: ReadonlySet<string>): boolean {
  return surfacedUrls.has(url) || surfacedUrls.has(canonicalizeUrl(url) ?? "");
}

function requestKey(request: ModelWebGatherRequest): string {
  if (request.tool === "web_search") {
    return `web_search:${normalizeTerm(request.args.query)}`;
  }
  return `web_fetch:${canonicalizeUrl(request.args.url) ?? request.args.url}`;
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
): { readonly audit: JsonToolLoopAuditEntry; readonly gap: SourceGap } {
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
      source: "web-gather",
      message: `${tool}: ${reason}`,
      provider: "exa",
      capability: "evidence-request",
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
    }),
  };
}

function webGatherMalformedGap(message: string): SourceGap {
  return sourceGap({
    source: "web-gather",
    message,
    provider: "exa",
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function mergeToolOutput(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  output: WebGatherToolOutput,
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
