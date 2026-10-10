import type { SourceGap, SourceGapAttempts } from "./sources";

export type EvidenceRequestToolName = "sec_latest_filing" | "tradier_iv_term_structure";

export type WebGatherToolName = "web_search" | "web_fetch";
export type WebSearchType = "news" | "market" | "current-subject" | "background";

export interface JsonToolLoopAuditEntry {
  readonly round: number;
  readonly tool: string;
  readonly args?: unknown;
  readonly rationale?: string;
  readonly status: "accepted" | "rejected";
  readonly reason?: string;
  readonly sourceUnits?: number;
  readonly numResultsOverride?: {
    readonly kind: "narrowing" | "thematic-exemption" | "thematic-widening";
    readonly requested?: number;
    readonly effectiveNumResults: number;
  };
}

export interface JsonToolLoopAudit<TTool extends string = string, TAudit = JsonToolLoopAuditEntry> {
  readonly rounds: number;
  readonly acceptedRequests: readonly TAudit[];
  readonly rejectedRequests: readonly TAudit[];
  readonly sourceUnitsUsed: number;
  readonly executedTools: readonly TTool[];
  readonly emittedGaps: readonly SourceGap[];
}

export type WebGatherLoopFailureCode = "parse-retries-exhausted";

export type EvidenceRequestAuditEntry = JsonToolLoopAuditEntry;

export type EvidenceRequestLoopAudit = JsonToolLoopAudit<EvidenceRequestToolName>;

export interface WebGatherSanitizerAudit {
  readonly sourceCount: number;
  readonly sanitizedSourceCount: number;
  readonly emptyAfterSanitizeCount: number;
  readonly inputCharCount: number;
  readonly outputCharCount: number;
  readonly removedInstructionSpanCount: number;
  readonly removedChromeHtmlCount: number;
}

export type WebEvidenceUtilizationLevel = "insufficient-sample" | "low" | "medium" | "high";

export interface WebEvidenceUtilization {
  readonly version: 1;
  readonly acceptedCurrentRun: number;
  readonly usedCurrentRun: number;
  readonly profileUsed: number;
  readonly primaryReportCited: number;
  readonly structuredExtraCited: number;
  readonly unusedCurrentRun: number;
  readonly ratio: number;
  readonly level: WebEvidenceUtilizationLevel;
}

export interface WebGatherAcceptancePolicy {
  readonly version: 2;
  readonly mode: "reused-profile-default" | "reused-profile-after-low-utilization";
  readonly sourceRunDirName: string;
  readonly priorUtilizationLevel?: WebEvidenceUtilizationLevel;
  readonly priorUtilizationRatio?: number;
  readonly implicitPerQueryAcceptanceCap: 2 | 3;
  readonly explicitPerQueryAcceptanceCap?: 6;
}

export type ModelInputSanitizerProfile =
  | "open-web"
  | "news"
  | "sec-filing"
  | "short-metadata"
  | "legacy-history";

export type ModelInputFieldRole = "title" | "publisher" | "summary" | "snippet" | "prose";

export interface ModelInputSanitizerTelemetry {
  readonly inputChars: number;
  readonly outputChars: number;
  readonly removedInstructionSpanCount: number;
  readonly removedMarkupChromeCount: number;
  readonly truncatedFieldCount: number;
  readonly truncatedCharCount: number;
  readonly emptyAfterSanitizeFieldCount: number;
}

export interface ModelInputSanitizationAggregateEntry extends ModelInputSanitizerTelemetry {
  readonly provider: string;
  readonly ingress: string;
  readonly profile: ModelInputSanitizerProfile;
  readonly fieldRole: ModelInputFieldRole;
  readonly droppedItemCount: number;
}

export interface ModelInputSanitizationAggregate {
  readonly entries: readonly ModelInputSanitizationAggregateEntry[];
}

interface WebGatherAuditEntry extends JsonToolLoopAuditEntry {
  readonly sanitizer?: WebGatherSanitizerAudit;
  readonly freshness?: {
    readonly searchType: WebSearchType;
    readonly initialWindowDays?: number;
    readonly effectiveWindowDays?: number;
    readonly endPublishedDate: string;
    readonly widened: boolean;
  };
  // Present when Exa was unusable and Firecrawl fallback was attempted or unavailable.
  readonly fallback?: WebGatherFallbackAudit;
  // Present only when this request's results included near-duplicate headlines of already-accepted web sources; those results were rejected, not merged.
  readonly duplicateResults?: readonly WebGatherDuplicateResultAudit[];
  // Present on a rejected request whose Exa call retried or was size-rejected (see `SourceGap.attempts`).
  readonly attempts?: SourceGapAttempts;
}

export interface WebGatherDuplicateResultAudit {
  readonly reason: "duplicate-headline";
  readonly sourceId: string;
  readonly title: string;
  readonly duplicateOfSourceId: string;
  readonly duplicateOfTitle: string;
}

export interface WebGatherFallbackAudit {
  readonly attemptedProviders: readonly string[];
  // Omitted when neither provider served a usable result.
  readonly servedProvider?: string;
  readonly fallbackReason: "hard-failure" | "empty" | "thin";
  readonly unavailableReason?: "no-firecrawl-key";
  readonly firecrawlCreditsUsed?: number;
}

export type WebGatherLoopAudit = JsonToolLoopAudit<WebGatherToolName, WebGatherAuditEntry> & {
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly acceptancePolicy?: WebGatherAcceptancePolicy;
  readonly failureCode?: WebGatherLoopFailureCode;
};
