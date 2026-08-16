import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  SourceGap,
  SourceGapAttempts,
  JsonToolLoopAuditEntry,
} from "../domain/types";
import { extendedEvidenceGap, sourceGap } from "../domain/source-gaps";
import { mergeModelInputSanitization } from "../sources/model-input-sanitizer";
import { canonicalizeUrl } from "../sources/news-utils";
import type { CollectedSources } from "../sources/types";
import {
  WEB_GATHER_DUPLICATE_REQUEST_REASON,
  WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON,
  WEB_GATHER_OFF_SUBJECT_REASON,
  WEB_GATHER_SOURCE_BUDGET_EXCEEDED_REASON,
  WEB_GATHER_TOOL_CALL_BUDGET_EXCEEDED_REASON,
} from "../sources/web-gather-rejection-reasons";
import type { WebGatherToolOutput } from "../sources/web-gather-emit";
import { normalizeTerm } from "./web-gather-coverage";
import { rejectedJsonToolRequest } from "../research/json-tool-loop-support";
import { MAX_RATIONALE_TRACE_LENGTH, type ModelWebGatherRequest } from "./web-gather-types";

// Shared by both audit-assembly sites (the generic json-tool loop and the deep-equity batch
// Path) so a rejected-by-execution entry (an Exa call that failed outright, as opposed to one
// Rejected at validation time) is built identically in both places.
export function executionRejectedEntry<TEntry extends JsonToolLoopAuditEntry>(
  acceptedEntry: TEntry,
  reason: string,
  attempts: SourceGapAttempts | undefined,
): TEntry & { status: "rejected"; reason: string; attempts?: SourceGapAttempts } {
  return {
    ...acceptedEntry,
    status: "rejected" as const,
    reason,
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

export function requestKey(request: ModelWebGatherRequest): string {
  if (request.tool === "web_search") {
    return `web_search:${request.args.searchType}:${normalizeTerm(request.args.query)}`;
  }
  return `web_fetch:${canonicalizeUrl(request.args.url) ?? request.args.url}`;
}

export function truncateRationale(rationale: string): string {
  const trimmed = rationale.trim();
  return trimmed.length > MAX_RATIONALE_TRACE_LENGTH
    ? `${trimmed.slice(0, MAX_RATIONALE_TRACE_LENGTH - 3)}...`
    : trimmed;
}

export function reject(
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

export function webGatherMalformedGap(message: string, provider: string): SourceGap {
  return sourceGap({
    source: "web-gather",
    message,
    provider,
    capability: "web-gather",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

export function mergeToolOutput(
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

export function mergeGaps(
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
