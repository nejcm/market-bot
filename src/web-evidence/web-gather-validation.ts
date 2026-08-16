import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type {
  JsonToolLoopAuditEntry,
  SourceGap,
  WebGatherToolName,
  WebSearchType,
} from "../domain/types";
import { isRecord, readString } from "../guards";
import { MAX_WEB_GATHER_SEARCH_RESULTS, WEB_GATHER_TOOL_UNITS } from "../sources/web-gather-tools";
import {
  WEB_GATHER_DUPLICATE_REQUEST_REASON,
  WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON,
  WEB_GATHER_OFF_SUBJECT_REASON,
  WEB_GATHER_SOURCE_BUDGET_EXCEEDED_REASON,
  WEB_GATHER_TOOL_CALL_BUDGET_EXCEEDED_REASON,
} from "../sources/web-gather-rejection-reasons";
import { isSurfacedUrl, type WebGatherSubject } from "../sources/web-gather-emit";
import type { CollectedSources } from "../sources/types";
import type { JsonToolLoopAccepted, JsonToolLoopRoundState } from "../research/json-tool-loop";
import {
  acceptedJsonToolAuditEntry,
  budgetRejectionReason,
} from "../research/json-tool-loop-support";
import {
  ALLOWED_TOOLS,
  type ModelWebGatherRequest,
  type ValidationState,
  type WebGatherStageOutput,
} from "./web-gather-types";
import {
  COMMON_COMPANY_SUFFIXES,
  isThematicListSearch,
  normalizeTerm,
  reusedProfileCoverageRejectionReason,
  secCoverageRejectionReason,
  THEME_STOPWORDS,
  withDefaultSearchNumResults,
} from "./web-gather-coverage";
import { reject, requestKey, truncateRationale } from "./web-gather-merge";

export function validateRequests(
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
      state.acceptancePolicy,
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

export function subjectTermsForRun(
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

export function subjectLabelForRun(
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

// Shared by both audit-assembly sites (the generic json-tool loop and the deep-equity batch
// Path) so a rejected-by-execution entry (an Exa call that failed outright, as opposed to one
