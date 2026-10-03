import type { ResearchCommand } from "../cli/args";
import type {
  JsonToolLoopAuditEntry,
  SourceGap,
  WebGatherAcceptancePolicy,
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
import type { WebGatherSubject } from "../sources/web-gather-emit";
import type { AppConfig } from "../config";
import type { WebGatherContext } from "../research/research-context-types";
import type { JsonToolLoopAccepted } from "../research/json-tool-loop";
import {
  acceptedJsonToolAuditEntry,
  budgetRejectionReason,
} from "../research/json-tool-loop-support";
import { ALLOWED_TOOLS, type ModelWebGatherRequest } from "./web-gather-types";
import {
  isThematicListSearch,
  normalizeTerm,
  reusedProfileCoverageRejectionReason,
  secCoverageRejectionReason,
  THEME_STOPWORDS,
  withDefaultSearchNumResults,
} from "./web-gather-coverage";
import { reject, requestKey, truncateRationale } from "./web-gather-merge";
import { canonicalizeUrl } from "../sources/news-utils";
import type { WebGatherSurfacedUrls } from "../sources/web-gather-tools";

export function surfacedUrlGate(surfacedUrls: Set<string>): WebGatherSurfacedUrls {
  return {
    admitSurfaced: (results) => {
      for (const result of results) {
        surfacedUrls.add(result.url);
        const canonicalUrl = canonicalizeUrl(result.url);
        if (canonicalUrl !== undefined) {
          surfacedUrls.add(canonicalUrl);
        }
      }
    },
    isAdmissible: (url) => surfacedUrls.has(url) || surfacedUrls.has(canonicalizeUrl(url) ?? ""),
  };
}

export interface WebGatherAcceptance extends WebGatherSurfacedUrls {
  readonly snapshot: () => readonly string[];
  readonly validate: (requests: readonly unknown[], round: number) => ValidationResult;
}

export function createWebGatherAcceptance(init: WebGatherAcceptanceInit): WebGatherAcceptance {
  const surfacedUrls = new Set<string>();
  const gate = surfacedUrlGate(surfacedUrls);
  const fixed = {
    ...init,
    seenKeys: new Set<string>(),
    isAdmissible: gate.isAdmissible,
    thematicListSearchWidened: { value: false },
  };
  let sourceUnitsUsed = 0;
  let toolCallsUsed = 0;
  return {
    ...gate,
    snapshot: () => [...surfacedUrls].toSorted(),
    // Budget spent by earlier calls carries over, so the batch path's fetches see searches' spend.
    validate: (requests, round) => {
      const result = validateRequests(
        requests,
        { ...fixed, round },
        { sourceUnitsUsed, toolCallsUsed },
      );
      for (const request of result.requests) {
        sourceUnitsUsed += request.sourceUnits;
        toolCallsUsed += 1;
      }
      return result;
    },
  };
}

interface ValidationState extends WebGatherAcceptanceInit {
  readonly seenKeys: Set<string>;
  readonly isAdmissible: (url: string) => boolean;
  readonly thematicListSearchWidened: { value: boolean };
  readonly round: number;
}

export interface WebGatherAcceptanceInit {
  readonly subject: WebGatherSubject;
  readonly subjectTerms: readonly string[];
  readonly command: ResearchCommand;
  readonly secFilingCoverage: WebGatherContext["secFilingCoverage"];
  readonly reusedProfileCoverage: WebGatherContext["reusedProfileCoverage"];
  readonly acceptancePolicy: WebGatherAcceptancePolicy | undefined;
  readonly budget: Pick<AppConfig["webGatherOptions"], "maxToolCalls" | "sourceBudget">;
}

interface ValidationResult {
  readonly requests: readonly JsonToolLoopAccepted<
    ModelWebGatherRequest,
    WebGatherToolName,
    JsonToolLoopAuditEntry
  >[];
  readonly rejected: readonly JsonToolLoopAuditEntry[];
  readonly gaps: readonly SourceGap[];
}

function validateRequests(
  requests: readonly unknown[],
  state: ValidationState,
  used: { readonly sourceUnitsUsed: number; readonly toolCallsUsed: number },
): ValidationResult {
  const accepted: JsonToolLoopAccepted<
    ModelWebGatherRequest,
    WebGatherToolName,
    JsonToolLoopAuditEntry
  >[] = [];
  const rejected: JsonToolLoopAuditEntry[] = [];
  const gaps: SourceGap[] = [];
  let { sourceUnitsUsed, toolCallsUsed } = used;

  for (const raw of requests) {
    const result = validateRequest(raw, state, sourceUnitsUsed, toolCallsUsed);
    if ("request" in result) {
      const sourceUnits = WEB_GATHER_TOOL_UNITS[result.request.tool];
      accepted.push({
        request: result.request,
        audit: {
          ...acceptedJsonToolAuditEntry(
            state.round,
            result.request.tool,
            result.request.args,
            result.request.rationale,
            sourceUnits,
          ),
          ...(result.numResultsOverride !== undefined
            ? { numResultsOverride: result.numResultsOverride }
            : {}),
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
  | {
      readonly request: ModelWebGatherRequest;
      readonly numResultsOverride?: NonNullable<JsonToolLoopAuditEntry["numResultsOverride"]>;
    }
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
      usedThematicListSearchAllowance(parsedArgs, requestArgs, state)
    ) {
      state.thematicListSearchWidened.value = true;
    }
    if (!("request" in acceptedRequest) || requestArgs.numResults === undefined) {
      return acceptedRequest;
    }
    const implicitCap = state.acceptancePolicy?.implicitPerQueryAcceptanceCap;
    const requested = parsedArgs.numResults;
    const effective = requestArgs.numResults;
    if (implicitCap === undefined || (requested ?? effective) <= implicitCap) {
      return acceptedRequest;
    }
    const explicitCap = state.acceptancePolicy?.explicitPerQueryAcceptanceCap;
    if (requested === undefined) {
      return {
        ...acceptedRequest,
        numResultsOverride: { kind: "thematic-widening", effectiveNumResults: effective },
      };
    }
    if (effective < requested) {
      return {
        ...acceptedRequest,
        numResultsOverride: { kind: "narrowing", requested, effectiveNumResults: effective },
      };
    }
    if (explicitCap !== undefined && requested > explicitCap) {
      return {
        ...acceptedRequest,
        numResultsOverride: {
          kind: "thematic-exemption",
          requested,
          effectiveNumResults: effective,
        },
      };
    }
    return acceptedRequest;
  }
  const parsedArgs = webFetchArgs(args);
  if (typeof parsedArgs === "string") {
    return reject(state.round, tool, args, rationale, parsedArgs);
  }
  if (!state.isAdmissible(parsedArgs.url)) {
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

function usedThematicListSearchAllowance(
  parsedArgs: {
    readonly query: string;
    readonly searchType: WebSearchType;
    readonly numResults?: number;
  },
  requestArgs: { readonly numResults?: number },
  state: ValidationState,
): boolean {
  if (!isThematicListSearch(state.command, parsedArgs)) {
    return false;
  }
  if (parsedArgs.numResults === undefined) {
    return requestArgs.numResults === MAX_WEB_GATHER_SEARCH_RESULTS;
  }
  const explicitCap = state.acceptancePolicy?.explicitPerQueryAcceptanceCap;
  return explicitCap !== undefined && parsedArgs.numResults > explicitCap;
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
    maxToolCalls: state.budget.maxToolCalls,
    sourceBudget: state.budget.sourceBudget,
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
