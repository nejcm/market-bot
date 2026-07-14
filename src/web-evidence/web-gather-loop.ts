import type { AppConfig } from "../config";
import type { CostPricing } from "../model/pricing";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { runTypeSupportsWebGather } from "../domain/run-types";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  WebGatherSanitizerAudit,
  WebGatherLoopAudit,
  WebGatherDuplicateResultAudit,
  WebGatherToolName,
  WebSearchType,
  JsonToolLoopAuditEntry,
} from "../domain/types";
import { extendedEvidenceGap, sourceGap } from "../domain/source-gaps";
import { isRecord, readString } from "../guards";
import { mergeModelInputSanitization } from "../sources/model-input-sanitizer";
import { canonicalizeUrl } from "../sources/news-utils";
import { DEFAULT_RETRY_DELAYS_MS } from "../sources/retry-utils";
import { createCollectContext } from "../sources/source-request";
import type { CollectedSources, FetchLike } from "../sources/types";
import {
  executeWebGatherTool,
  MAX_WEB_GATHER_SEARCH_RESULTS,
  REUSED_PROFILE_DEFAULT_SEARCH_RESULTS,
  WEB_GATHER_TOOL_UNITS,
} from "./web-gather-tools";
import {
  WEB_GATHER_DUPLICATE_REQUEST_REASON,
  WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON,
  WEB_GATHER_OFF_SUBJECT_REASON,
  WEB_GATHER_SOURCE_BUDGET_EXCEEDED_REASON,
  WEB_GATHER_TOOL_CALL_BUDGET_EXCEEDED_REASON,
} from "./web-gather-rejection-reasons";
import {
  aggregateSanitizerAudit,
  isSurfacedUrl,
  type WebGatherSubject,
  type WebGatherToolOutput,
} from "./web-gather-emit";
import { dedupeWebSourcesByHeadline } from "./web-headline-dedupe";
import {
  isCompanyProfileSecSource,
  webSubjectProfileSubjectForCommand,
} from "./web-subject-profile";
import {
  runJsonToolLoop,
  type JsonToolLoopAccepted,
  type JsonToolLoopRoundState,
} from "../research/json-tool-loop";
import {
  acceptedJsonToolAuditEntry,
  budgetRejectionReason,
  rejectedJsonToolRequest,
  withStaleFallbackGaps,
} from "../research/json-tool-loop-support";
import type { ResearchContext, WebGatherContext } from "../research/research-context-types";

export interface WebGatherStageOutput {
  readonly stage: "web-gather";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly durationMs?: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
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
  readonly reusedProfileCoverage?: WebGatherContext["reusedProfileCoverage"];
  readonly generateRound: (
    collectedSources: CollectedSources,
    context: ResearchContext,
    priorStages: readonly WebGatherStageOutput[],
  ) => Promise<WebGatherStageOutput>;
}

type ModelWebGatherRequest =
  | {
      readonly tool: "web_search";
      readonly args: {
        readonly query: string;
        readonly searchType: WebSearchType;
        readonly numResults?: number;
      };
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
  readonly thematicListSearchWidened: { value: boolean };
  readonly subject: WebGatherSubject;
  readonly subjectTerms: readonly string[];
  readonly command: ResearchCommand;
  readonly secFilingCoverage: WebGatherContext["secFilingCoverage"];
  readonly reusedProfileCoverage: WebGatherContext["reusedProfileCoverage"];
  readonly config: AppConfig;
  readonly round: number;
}

const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(WEB_GATHER_TOOL_UNITS));
const AVAILABLE_TOOLS: readonly WebGatherToolName[] = ["web_search", "web_fetch"];
const MAX_RATIONALE_TRACE_LENGTH = 500;
// Section markers emitted by `secFilingSectionPacket` (see evidence-request-tools.ts). Detecting coverage from the packet's own markers avoids hard-coding a separate question-key map and stays honest about partial packets.
const SEC_FILING_SECTION_MARKERS = [
  "Business",
  "Risk Factors",
  "MD&A",
  "Segments",
  "Notes",
] as const;
// Keyword signals tying a background web_search query to a durable-profile area the SEC packet already covers. Deliberately conservative: only queries matching these topics are eligible for rejection, so genuinely uncovered background research is never blocked.
const SEC_COVERED_TOPIC_PATTERNS: Readonly<
  Record<(typeof SEC_FILING_SECTION_MARKERS)[number], RegExp>
> = {
  Business:
    /business model|business overview|what (it|the company) does|core business|products? and services|how it makes money/iu,
  "Risk Factors": /risk factors|key risks|business risks/iu,
  "MD&A": /md&a|management discussion|results of operations/iu,
  Segments: /segments?|segment revenue|geographic (revenue|breakdown|mix)|geography/iu,
  Notes: /notes to (the )?financial statements|financial statement notes/iu,
};
// Rationale/query language that signals a background search is not merely duplicating filed facts (recency, corroboration, or an explicit gap the filing does not cover).
const SEC_COVERAGE_ESCAPE_RE =
  /recent|latest|current|update|corroborat|verify|confirm|\bgap\b|not covered|uncovered|missing/iu;
const REUSED_PROFILE_TOPIC_PATTERNS: Readonly<Record<string, RegExp>> = {
  whatItDoes:
    /what (it|the company) does|business model|business overview|protocol overview|network overview|products? and services/iu,
  howItMakesMoney: /how it makes money|revenue model|revenue streams?|monetization/iu,
  customers: /customers?|customer base|end markets?/iu,
  geography: /geograph|regional mix|countries|international exposure/iu,
  purchaseRecurrence:
    /purchase recurrence|repeat purchases?|recurring purchases?|replacement cycle/iu,
  pricingPower: /pricing power|price increases?|pricing strategy/iu,
  recessionCyclicality: /recession|cyclicality|economic cycle|downturn/iu,
  managementTrackRecord: /management track record|leadership track record|executive team/iu,
  capitalAllocation: /capital allocation|buybacks?|dividends?|acquisitions?/iu,
  companyKpis: /company kpis?|key performance indicators?|operating metrics?/iu,
  riskFactors: /risk factors?|key risks?|business risks?/iu,
  valueAccrual: /value accrual|token value|value capture/iu,
  supplyIssuance: /token supply|issuance|emissions?|inflation schedule/iu,
  usageAdoption: /usage|adoption|active (users|addresses)|network activity/iu,
  governanceBuilders: /governance|developers?|builders?|contributors?/iu,
  competitionMoat: /competition|competitors?|moat|competitive advantage/iu,
  keyRisks: /key risks?|protocol risks?|network risks?/iu,
  whatItIs: /what it is|theme overview|definition|industry overview/iu,
  whyNow: /why now|theme drivers?|current tailwinds?/iu,
  beneficiaries: /beneficiar|companies? exposed|industry winners?/iu,
  headwinds: /headwinds?|barriers?|constraints?/iu,
  keyDebates: /key debates?|controvers|open questions?/iu,
  howItPlaysOut: /how it plays out|adoption path|scenario|outlook/iu,
};
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

// Derives which durable business-profile sections a company's SEC 10-K/10-Q packet already covers, from the section markers `secFilingSectionPacket` embeds in the packet snippet. Company subjects only; crypto/theme subjects and companies without a gathered packet return undefined, identical to today's behavior (no coverage signal, no rejections).
function secFilingCoverageFromSources(
  subject: WebGatherSubject,
  extendedSources: readonly Source[],
): WebGatherContext["secFilingCoverage"] {
  if (subject.subjectKind !== "company") {
    return undefined;
  }
  const secSources = extendedSources.filter((source) => isCompanyProfileSecSource(source));
  if (secSources.length === 0) {
    return undefined;
  }
  const sections = new Set<string>();
  for (const source of secSources) {
    const snippet = source.snippet ?? "";
    for (const marker of SEC_FILING_SECTION_MARKERS) {
      if (snippet.includes(`[${marker}]`)) {
        sections.add(marker);
      }
    }
  }
  return { present: true, sections: [...sections].toSorted() };
}

// Rejects a background web_search that targets a durable-profile topic the SEC filing packet already covers and whose rationale gives no recency, corroboration, or explicit gap justification. Returns undefined (accept) for every other case, including when no coverage was derived, non-background searches, and off-topic background searches.
function secCoverageRejectionReason(
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
  rationale: string,
  coverage: WebGatherContext["secFilingCoverage"],
): string | undefined {
  if (
    parsedArgs.searchType !== "background" ||
    coverage === undefined ||
    !coverage.present ||
    coverage.sections.length === 0
  ) {
    return undefined;
  }
  const targetsCoveredTopic = coverage.sections.some((section) =>
    SEC_COVERED_TOPIC_PATTERNS[section as keyof typeof SEC_COVERED_TOPIC_PATTERNS]?.test(
      parsedArgs.query,
    ),
  );
  if (!targetsCoveredTopic || SEC_COVERAGE_ESCAPE_RE.test(rationale)) {
    return undefined;
  }
  return "web_search duplicates SEC filing coverage (sec-covered-durable-profile); add a recency, corroboration, or explicit gap rationale for background queries";
}

function reusedProfileCoverageRejectionReason(
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
  rationale: string,
  coverage: WebGatherContext["reusedProfileCoverage"],
): string | undefined {
  if (
    parsedArgs.searchType !== "background" ||
    coverage === undefined ||
    !coverage.present ||
    coverage.topics.length === 0 ||
    SEC_COVERAGE_ESCAPE_RE.test(rationale)
  ) {
    return undefined;
  }
  const targetsCoveredTopic = coverage.topics.some((topic) =>
    REUSED_PROFILE_TOPIC_PATTERNS[topic]?.test(parsedArgs.query),
  );
  return targetsCoveredTopic
    ? "web_search duplicates reused profile coverage (profile-covered-durable-topic); add a recency, corroboration, or explicit gap rationale for background queries"
    : undefined;
}

// Sets effective per-query ingestion when the model leaves numResults to the default. Thematic list screens widen one search surface because a later provider call can fail and leave the run with only one result page. Reused profiles stay narrow for the remaining recency/corroboration/gap-fill searches.
function withDefaultSearchNumResults(
  parsedArgs: {
    readonly query: string;
    readonly searchType: WebSearchType;
    readonly numResults?: number;
  },
  command: ResearchCommand,
  coverage: WebGatherContext["reusedProfileCoverage"],
  thematicListSearchWidened: boolean,
): { readonly query: string; readonly searchType: WebSearchType; readonly numResults?: number } {
  if (parsedArgs.numResults !== undefined) {
    return parsedArgs;
  }
  if (!thematicListSearchWidened && isThematicListSearch(command, parsedArgs)) {
    return { ...parsedArgs, numResults: MAX_WEB_GATHER_SEARCH_RESULTS };
  }
  if (coverage?.present === true) {
    return { ...parsedArgs, numResults: REUSED_PROFILE_DEFAULT_SEARCH_RESULTS };
  }
  return parsedArgs;
}

function isThematicListSearch(
  command: ResearchCommand,
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
): boolean {
  if (
    command.jobType !== "research" ||
    command.assetClass !== "equity" ||
    parsedArgs.searchType !== "current-subject"
  ) {
    return false;
  }
  const text = `${command.subject} ${parsedArgs.query}`.toLowerCase();
  return /\b(top|best|list|ranking|ranked|screen|screening|picks?|promising|stocks? to buy)\b/u.test(
    text,
  );
}

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
  const executionAudits: {
    readonly sanitizer: WebGatherSanitizerAudit;
    readonly freshness?: NonNullable<WebGatherToolOutput["freshness"]>;
    readonly fallback?: NonNullable<WebGatherToolOutput["fallback"]>;
    readonly duplicateResults?: readonly WebGatherDuplicateResultAudit[];
  }[] = [];

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
          config,
          round: roundState.round,
        },
        roundState,
      ),
    mergeGaps: (currentSources, gaps) => mergeGaps(command, currentSources, gaps),
    executeRequest: async (currentSources, request) => {
      const toolContext =
        input.collectedSources.resolvedInstrumentIdentity !== undefined
          ? {
              ...collectContext.context,
              instrumentIdentity: input.collectedSources.resolvedInstrumentIdentity,
            }
          : collectContext.context;
      const outputWithStale = await withStaleFallbackGaps(collectContext, () =>
        executeWebGatherTool(request.tool, request.args, toolContext, surfacedUrls, subject),
      );
      // Every rejection points to accepted coverage or an earlier kept candidate in this batch,
      // So dedupe cannot empty web coverage and deliberately emits no source gap.
      const headlineDedupe = dedupeWebSourcesByHeadline(
        currentSources.extendedSources,
        outputWithStale.sources,
      );
      executionAudits.push({
        sanitizer: outputWithStale.sanitizer,
        ...(outputWithStale.freshness !== undefined
          ? { freshness: outputWithStale.freshness }
          : {}),
        ...(outputWithStale.fallback !== undefined ? { fallback: outputWithStale.fallback } : {}),
        ...(headlineDedupe.rejected.length > 0
          ? { duplicateResults: headlineDedupe.rejected }
          : {}),
      });
      return {
        state: mergeToolOutput(command, currentSources, {
          ...outputWithStale,
          sources: headlineDedupe.kept,
        }),
        gaps: outputWithStale.gaps,
      };
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
      sanitizer: aggregateSanitizerAudit(executionAudits.map((audit) => audit.sanitizer)),
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
        audit: acceptedJsonToolAuditEntry(
          state.round,
          result.request.tool,
          result.request.args,
          result.request.rationale,
          sourceUnits,
        ),
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
      return reject(state.round, tool, args, rationale, WEB_GATHER_OFF_SUBJECT_REASON);
    }
    const secCoverageReason = secCoverageRejectionReason(
      parsedArgs,
      rationale,
      state.secFilingCoverage,
    );
    if (secCoverageReason !== undefined) {
      return reject(state.round, tool, args, rationale, secCoverageReason);
    }
    const reusedProfileCoverageReason = reusedProfileCoverageRejectionReason(
      parsedArgs,
      rationale,
      state.reusedProfileCoverage,
    );
    if (reusedProfileCoverageReason !== undefined) {
      return reject(state.round, tool, args, rationale, reusedProfileCoverageReason);
    }
    const requestArgs = withDefaultSearchNumResults(
      parsedArgs,
      state.command,
      state.reusedProfileCoverage,
      state.thematicListSearchWidened.value,
    );
    const acceptedRequest = validateAcceptedRequest(
      { tool: typedTool, args: requestArgs, rationale },
      state,
      sourceUnitsUsed,
      toolCallsUsed,
      args,
    );
    if (
      "request" in acceptedRequest &&
      requestArgs.numResults === MAX_WEB_GATHER_SEARCH_RESULTS &&
      isThematicListSearch(state.command, parsedArgs)
    ) {
      state.thematicListSearchWidened.value = true;
    }
    return acceptedRequest;
  }
  const parsedArgs = webFetchArgs(args);
  if (typeof parsedArgs === "string") {
    return reject(state.round, tool, args, rationale, parsedArgs);
  }
  if (!isSurfacedUrl(parsedArgs.url, state.surfacedUrls)) {
    return reject(state.round, tool, args, rationale, WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON);
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
      WEB_GATHER_DUPLICATE_REQUEST_REASON,
    );
  }
  const budgetReason = budgetRejectionReason({
    maxToolCalls: state.config.webGatherOptions.maxToolCalls,
    sourceBudget: state.config.webGatherOptions.sourceBudget,
    toolCallsUsed,
    sourceUnitsUsed,
    requestSourceUnits: WEB_GATHER_TOOL_UNITS[request.tool],
    toolCallExceededReason: WEB_GATHER_TOOL_CALL_BUDGET_EXCEEDED_REASON,
    sourceBudgetExceededReason: WEB_GATHER_SOURCE_BUDGET_EXCEEDED_REASON,
  });
  if (budgetReason !== undefined) {
    return reject(state.round, request.tool, auditArgs, request.rationale, budgetReason);
  }
  return { request };
}

function webSearchArgs(args: Record<string, unknown>):
  | {
      readonly query: string;
      readonly searchType: WebSearchType;
      readonly numResults?: number;
    }
  | string {
  const keys = Object.keys(args).toSorted();
  if (!keys.every((key) => key === "query" || key === "searchType" || key === "numResults")) {
    return "web_search args may contain only query, searchType, and numResults";
  }
  const query = readString(args, "query");
  if (query === undefined) {
    return "web_search requires a non-empty query";
  }
  const searchType = readString(args, "searchType");
  if (
    searchType !== "news" &&
    searchType !== "market" &&
    searchType !== "current-subject" &&
    searchType !== "background"
  ) {
    return "web_search searchType must be news, market, current-subject, or background";
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
    searchType,
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
    const resolved = collectedSources.resolvedSubject;
    if (resolved?.subjectKey !== undefined) {
      return [
        ...new Set(
          [resolved.subjectKey, resolved.displayName, ...(resolved.aliases ?? [])].flatMap((term) =>
            term === undefined ? [] : significantSubjectTerms(term),
          ),
        ),
      ];
    }
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
    return collectedSources.resolvedSubject?.subjectKey ?? command.subjectKey ?? command.subject;
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

function requestKey(request: ModelWebGatherRequest): string {
  if (request.tool === "web_search") {
    return `web_search:${request.args.searchType}:${normalizeTerm(request.args.query)}`;
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
  const gapMessage = webGatherRejectionGapMessage(reason);
  return rejectedJsonToolRequest(round, tool, args, rationale, reason, {
    source: "web-gather",
    provider: "exa",
    capability: "web-gather",
    ...(gapMessage !== undefined ? { gapMessage } : {}),
  });
}

function webGatherRejectionGapMessage(reason: string): string | undefined {
  switch (reason) {
    case WEB_GATHER_OFF_SUBJECT_REASON: {
      return "a model web query was rejected for drifting off-subject";
    }
    case WEB_GATHER_TOOL_CALL_BUDGET_EXCEEDED_REASON:
    case WEB_GATHER_SOURCE_BUDGET_EXCEEDED_REASON: {
      return "a model web request was skipped because the web-gather budget was exhausted";
    }
    case WEB_GATHER_DUPLICATE_REQUEST_REASON: {
      return "a repeated model web request was skipped";
    }
    case WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON: {
      return "a model web fetch was rejected because the site is not on the fetch allowlist";
    }
    default: {
      return undefined;
    }
  }
}

function webGatherMalformedGap(message: string): SourceGap {
  return sourceGap({
    source: "web-gather",
    message,
    provider: "exa",
    capability: "web-gather",
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
  // Web source IDs are sha256(url)-derived, so a URL already present via a reused profile digest collides deterministically with a fresh gather of the same URL. Keeping the first occurrence (the profile copy, already cited by its digest) keeps report.json sources unique.
  const existingSourceIds = new Set(collectedSources.extendedSources.map((source) => source.id));
  const freshSources = output.sources.filter((source) => {
    if (existingSourceIds.has(source.id)) {
      return false;
    }
    existingSourceIds.add(source.id);
    return true;
  });
  return {
    ...collectedSources,
    rawSnapshots: [...collectedSources.rawSnapshots, ...output.rawSnapshots],
    extendedSources: [...collectedSources.extendedSources, ...freshSources],
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
    sourceGaps: [...collectedSources.sourceGaps, ...gaps],
    ...(output.modelInputSanitization !== undefined
      ? {
          modelInputSanitization: mergeModelInputSanitization(
            collectedSources.modelInputSanitization,
            output.modelInputSanitization,
          ),
        }
      : {}),
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
